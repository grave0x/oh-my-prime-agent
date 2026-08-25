/**
 * kernel-pilot — hot-swappable execution backends for the agent's Python.
 *
 * Idea (docs/stateless-kernels.md, Idea 2 + 5): most ipython calls are pure
 * computation that does NOT need the stateful kernel — no rlm, no skills, no
 * persistent variables, no magics, no await. Those calls are served by a
 * lightweight stateless `py` runner (fresh python subprocess per call from the
 * kernel venv, rlimit-style timeout, nice, output caps). The big kernel is
 * only started when a call actually needs it (it is already lazy), and stateful
 * calls still go to the real provisioner + RLM bridge.
 *
 * How the hot-swap works:
 *   • `py` is additive: a new stateless tool the model can pick for pure work.
 *   • When the small prime patch (bin/apply-kernel-pilot-patch.py) is applied,
 *     the session's base tool definitions are exposed at
 *     globalThis.__ompaKernelPilot[sessionId], and this plugin REPLACES the
 *     built-in `ipython` tool with a router:
 *         auto       → classify each call: stateless → runner, stateful → kernel
 *         stateless  → always runner (stateful code gets a guidance error)
 *         stateful   → always kernel (runner disabled)
 *     The stateful branch delegates to the base ipython execute(), so RLM,
 *     skills, magics, snapshots, busy-kernel UX and attachments behave exactly
 *     as built-in. Without the patch the plugin degrades to additive mode
 *     (`py` tool + prompt guidance only).
 *
 * Config (ompr.toml [kernel]):
 *   backend = "auto"        # auto | stateless | stateful (hot-swap: /kernel <mode>)
 *   timeoutMs = 120000
 *   maxOutputChars = 65536
 *   guidance = true         # inject backend choice guidance per turn
 *
 * Commands:
 *   /kernel                 status + stats
 *   /kernel auto|stateless|stateful   hot-swap the backend now (session-live)
 *   /kernel reset           clear stats
 *
 * Stats journal: ~/.local/state/ompa/kernel-pilot.jsonl
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const OMPA_ROOT = join(homedir(), ".prime", "oh-my-prime-agent");
const OMPR_TOML = join(OMPA_ROOT, "ompr.toml");
const KERNEL_VENV_PY = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
const STATE_DIR = join(homedir(), ".local", "state", "ompa");
const STATS_LOG = join(STATE_DIR, "kernel-pilot.jsonl");
const MAX_STATS_BYTES = 1024 * 1024;

export type KernelMode = "stateless" | "stateful";
export type Backend = "auto" | "stateless" | "stateful";

interface KernelConfig {
  backend: Backend;
  timeoutMs: number;
  maxOutputChars: number;
  guidance: boolean;
}

const DEFAULT_CONFIG: KernelConfig = {
  backend: "auto",
  timeoutMs: 120000,
  maxOutputChars: 65536,
  guidance: true,
};

function tomlSection(section: string): string[] {
  try {
    const raw = readFileSync(OMPR_TOML, "utf8").split("\n");
    const out: string[] = [];
    let inSec = false;
    for (const line of raw) {
      const m = line.match(/^\s*\[(.*)\]\s*$/);
      if (m) { inSec = m[1].trim() === section; continue; }
      if (inSec) out.push(line);
    }
    return out;
  } catch { return []; }
}

function tomlValue(section: string, key: string): string | undefined {
  for (const line of tomlSection(section)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  return undefined;
}

function loadKernelConfig(): KernelConfig {
  const backend = tomlValue("kernel", "backend");
  const timeoutMs = tomlValue("kernel", "timeoutMs");
  const maxOutputChars = tomlValue("kernel", "maxOutputChars");
  const guidance = tomlValue("kernel", "guidance");
  const cfg = { ...DEFAULT_CONFIG };
  if (backend === "stateless" || backend === "stateful" || backend === "auto") cfg.backend = backend;
  if (timeoutMs) { const n = parseInt(timeoutMs, 10); if (Number.isFinite(n) && n > 0) cfg.timeoutMs = n; }
  if (maxOutputChars) { const n = parseInt(maxOutputChars, 10); if (Number.isFinite(n) && n > 0) cfg.maxOutputChars = n; }
  if (guidance === "false") cfg.guidance = false;
  return cfg;
}

/* ------------------------------------------------------------------ */
/* Classifier (exported for tests)                                     */
/* ------------------------------------------------------------------ */

const STATEFUL_MARKERS: RegExp[] = [
  /\brlm\b/,                                            // rlm(), rlm.harness, await rlm(...)
  /from rlm import/,
  /\bimport (agent_email|websearch|task_manager|refine|compact|edit|goal|terminal_notif|agent_message|agent_observe|attach_image|rlm_heartbeat|auto_learn)\b/,
  /\bfrom (agent_email|websearch|task_manager|refine|compact|edit|goal|terminal_notif|agent_message|agent_observe|attach_image|rlm_heartbeat|auto_learn) import/,
  /%%|%time|%cd|%env|%load|%run|%who|%whos|%reset|%matplotlib|%history|get_ipython\(\)|\bIn\[|\bOut\[/,
  /\bawait\b/,                                           // top-level await needs the kernel's event loop
  /\binput\(/,                                           // interactive stdin
  /^\s*!/m,                                               // shell escape
  /\b_ipython\b/,
];

/** Pure heuristic: does this cell need the stateful kernel? Conservative. */
/** Strip string/template literals and comments before marker matching, so
 * pure code that merely mentions stateful machinery in text still runs
 * stateless. Imports, magics, and top-level awaits are still caught. */
function stripLiterals(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "");
}

export function classifyKernelMode(code: string): KernelMode {
  if (!code || !code.trim()) return "stateless";
  for (const re of STATEFUL_MARKERS) {
    if (re.test(stripLiterals(code))) return "stateful";
  }
  return "stateless";
}

/* ------------------------------------------------------------------ */
/* Stateless runner                                                    */
/* ------------------------------------------------------------------ */

export function resolveKernelPython(): string {
  return existsSync(KERNEL_VENV_PY) ? KERNEL_VENV_PY : "python3";
}

export interface StatelessRunResult {
  stdout: string;
  stderr: string;
  status: "ok" | "error" | "aborted";
  durationMs: number;
  error?: { ename: string; evalue: string; traceback: string[] };
}

/**
 * Run code in a fresh python subprocess (stateless): no ipykernel, no rlm, no
 * snapshot. A trailing top-level expression is echoed like a notebook cell
 * (IPython-style `print(repr(...))`) so the model sees the value it expects.
 */
export function runStatelessPython(code: string, opts: { cwd: string; timeoutMs: number; maxOutputChars: number; signal?: AbortSignal }): Promise<StatelessRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const python = resolveKernelPython();
    // The wrapper embeds the user code as a Python literal (repr), parses it,
    // and echoes the last top-level expression's repr like a notebook cell.
    const wrapped = [
      "import ast, sys",
      "_src = " + JSON.stringify(code),
      "try:",
      "    _tree = ast.parse(_src)",
      "    if _tree.body and isinstance(_tree.body[-1], ast.Expr):",
      "        _last = _tree.body[-1]",
      "        _rest = _tree.body[:-1]",
      "        _ns = {}",
      "        if _rest: exec(compile(ast.Module(body=_rest, type_ignores=[]), '<stateless>', 'exec'), _ns)",
      "        _val = eval(compile(ast.Expression(body=_last.value), '<stateless>', 'eval'), _ns)",
      "        print(repr(_val))",
      "    else:",
      "        exec(_src, {})",
      "except SystemExit:",
      "    raise",
      "except BaseException:",
      "    import traceback",
      "    traceback.print_exc()",
      "    sys.exit(1)",
      "",
    ].join("\n");

    let child;
    try {
      child = spawn("nice", ["-n", "19", python, "-"], {
        cwd: opts.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ stdout: "", stderr: String(e), status: "error", durationMs: Date.now() - started, error: { ename: "SpawnError", evalue: String(e), traceback: [] } });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const cap = opts.maxOutputChars;
    const finish = (result: StatelessRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, opts.timeoutMs);
    const onAbort = () => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString().slice(0, cap - stdout.length);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString().slice(0, cap - stderr.length);
    });
    child.on("error", (e) => {
      finish({ stdout, stderr, status: "error", durationMs: Date.now() - started, error: { ename: "SpawnError", evalue: String(e), traceback: [] } });
    });
    child.on("close", (code) => {
      const ok = code === 0;
      finish({
        stdout,
        stderr,
        status: ok ? "ok" : "error",
        durationMs: Date.now() - started,
        error: ok ? undefined : { ename: timedOut ? "TimeoutError" : "ExitCodeError", evalue: timedOut ? `timed out after ${opts.timeoutMs}ms` : `exit code ${code}`, traceback: [] },
      });
    });
    try {
      child.stdin.write(wrapped);
      child.stdin.end();
    } catch (e) {
      finish({ stdout, stderr, status: "error", durationMs: Date.now() - started, error: { ename: "StdinError", evalue: String(e), traceback: [] } });
    }
  });
}

function renderStatelessResult(r: StatelessRunResult, mode: KernelMode, backend: Backend, maxOutputChars: number): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  let text = r.stdout;
  if (r.stderr) text += (text ? "\n" : "") + r.stderr;
  if (r.status === "error" && r.error) {
    text += (text ? "\n" : "") + `[${r.error.ename}] ${r.error.evalue}`;
    text += "\n\n(hint: this ran in the stateless `py` runner. If you need kernel state, rlm, skills, magics, or await, use `ipython` instead.)";
  }
  return {
    content: [{ type: "text", text: text || "(no output)" }],
    details: { status: r.status, durationMs: r.durationMs, backend: "stateless", mode, elided: text.length >= maxOutputChars },
  };
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

function recordStat(entry: { tool: string; mode: KernelMode; durationMs: number; ok: boolean }): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    try {
      const st = statSync(STATS_LOG);
      if (st.size > MAX_STATS_BYTES) {
        const lines = readFileSync(STATS_LOG, "utf8").split("\n").filter(Boolean);
        const keep = Math.max(1, Math.floor(lines.length / 2));
        writeFileSync(STATS_LOG, lines.slice(-keep).join("\n") + "\n", "utf8");
      }
    } catch { /* no log yet */ }
    appendFileSync(STATS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch { /* never break execution over stats */ }
}

interface StatsSummary { py: number; ipython: number; byMode: Record<string, number>; errors: number; }

function readStats(): StatsSummary {
  const out: StatsSummary = { py: 0, ipython: 0, byMode: {}, errors: 0 };
  if (!existsSync(STATS_LOG)) return out;
  try {
    for (const line of readFileSync(STATS_LOG, "utf8").split("\n").filter(Boolean).slice(-4000)) {
      try {
        const e = JSON.parse(line);
        if (e.tool === "py") out.py++;
        else if (e.tool === "ipython") out.ipython++;
        const m = String(e.mode || "?");
        out.byMode[m] = (out.byMode[m] ?? 0) + 1;
        if (e.ok === false) out.errors++;
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return out;
}

/* ------------------------------------------------------------------ */
/* Base tool handle (prime patch)                                      */
/* ------------------------------------------------------------------ */

interface BaseToolHandle {
  execute(toolCallId: string, params: { code: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext): Promise<any>;
}

function getBaseIpython(sid: string): BaseToolHandle | undefined {
  try {
    const g = globalThis as any;
    const pilot = g.__ompaKernelPilot;
    if (!pilot) return undefined;
    const base = pilot[sid];
    if (!base) return undefined;
    return base.get?.("ipython");
  } catch { return undefined; }
}

/* ------------------------------------------------------------------ */
/* Guidance                                                            */
/* ------------------------------------------------------------------ */

const GUIDANCE = `Execution backends:
- \`py\`: stateless pure-Python runner — fast, isolated, NO persistent state, NO rlm/skills/agent_message/refine, NO magics, NO await, NO %%bash. Use for one-off computation, parsing, transforms. A trailing expression's value is echoed like a notebook; otherwise print results explicitly.
- \`ipython\`: the persistent notebook kernel. Use ONLY when you need state across calls, rlm/skills, %%bash, magics, await, or interactive input.`;

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default function kernelPilot(pi: ExtensionAPI): void {
  const cfg = loadKernelConfig();
  let backend: Backend = cfg.backend;
  let sid = "unknown";
  let baseTool: BaseToolHandle | undefined;

  const resolveBase = (ctx: ExtensionContext): BaseToolHandle | undefined => {
    const s = ctx.sessionManager?.getSessionId?.() ?? "";
    if (s) sid = s;
    return baseTool ??= getBaseIpython(s || sid);
  };

  // The prime patch (bin/apply-kernel-pilot-patch.py) sets
  // globalThis.__ompaKernelPilotLive at MODULE IMPORT (once per process) and
  // exposes the base tools per session inside _buildRuntime. Extensions load
  // BEFORE _buildRuntime, so the live marker is the only reliable signal:
  //   - fresh process with patch: marker true -> register the router; the
  //     per-session base map exists by the time any tool call runs.
  //   - old process after reload: module cached -> marker undefined -> stay
  //     additive (py tool only); the built-in ipython tool stays intact.
  // A restart is required to activate the router.
  const pilotLive = !!(globalThis as any).__ompaKernelPilotLive;

  // ---- stateless `py` tool (always additive) --------------------------
  pi.registerTool(defineTool({
    name: "py",
    label: "python (stateless)",
    description: "Execute pure Python in a stateless runner (fresh subprocess per call, no persistent state, no rlm/skills/magics/await). A trailing top-level expression's value is echoed like a notebook cell; otherwise print results explicitly. Use for one-off computation, parsing, and data transforms. Use ipython instead when you need kernel state, rlm/skills, %%bash, or await.",
    promptSnippet: "py - stateless python (no kernel state)",
    promptGuidelines: [
      "Prefer `py` for pure computation that needs no persistent state, rlm, skills, magics, await, or %%bash.",
      "Reserve `ipython` for calls that actually need the persistent kernel.",
    ],
    parameters: Type.Object({ code: Type.String() }),
    executionMode: "sequential",
    execute: async (toolCallId: string, params: { code: string }, signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      const mode = classifyKernelMode(params.code);
      if (mode === "stateful") {
        recordStat({ tool: "py", mode, durationMs: 0, ok: false });
        return {
          content: [{ type: "text", text: "This code needs the stateful kernel (rlm, skills, magics, await, or interactive input are not available in the stateless runner). Use the `ipython` tool instead." }],
          details: { status: "error", backend: "stateless", mode },
        };
      }
      const r = await runStatelessPython(params.code, { cwd: ctx.cwd, timeoutMs: cfg.timeoutMs, maxOutputChars: cfg.maxOutputChars, signal });
      recordStat({ tool: "py", mode, durationMs: r.durationMs, ok: r.status === "ok" });
      return renderStatelessResult(r, mode, backend, cfg.maxOutputChars);
    },
  }));

  // ---- ipython router override (only when the patch is live in THIS process)
  if (pilotLive) {
    pi.registerTool(defineTool({
      name: "ipython",
      label: "ipython (kernel-pilot)",
      description: "Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed. In auto backend mode, stateless code is routed to the lightweight `py` runner automatically; stateful code (rlm, skills, magics, await, %%bash) runs in the kernel.",
      promptSnippet: "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration",
      promptGuidelines: [
        "Use `py` for pure stateless computation; keep `ipython` for stateful work.",
      ],
      parameters: Type.Object({ code: Type.String() }),
      executionMode: "sequential",
      execute: async (toolCallId: string, params: { code: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) => {
        const base = resolveBase(ctx);
        const mode = classifyKernelMode(params.code);
        if (!base) {
          return {
            content: [{ type: "text", text: "kernel-pilot lost the base ipython handle; restart prime-agent to restore the router." }],
            details: { status: "error" },
          };
        }
        if (backend === "stateful" || (backend === "auto" && mode === "stateful")) {
          const started = Date.now();
          const r = await base.execute(toolCallId, params, signal, onUpdate, ctx);
          recordStat({ tool: "ipython", mode, durationMs: Date.now() - started, ok: r?.details?.status !== "error" });
          return r;
        }
        const r = await runStatelessPython(params.code, { cwd: ctx.cwd, timeoutMs: cfg.timeoutMs, maxOutputChars: cfg.maxOutputChars, signal });
        recordStat({ tool: "ipython", mode, durationMs: r.durationMs, ok: r.status === "ok" });
        return renderStatelessResult(r, mode, backend, cfg.maxOutputChars);
      },
    }));
  }

  // ---- backend guidance per turn --------------------------------------
  pi.on("before_agent_start", async (event: any, _ctx: ExtensionContext) => {
    if (!cfg.guidance || backend === "stateful") return undefined;
    const base = (event.systemPrompt || "").trim();
    if (base.includes("Execution backends:")) return undefined;
    return { systemPrompt: base + "\n\n" + GUIDANCE };
  });

  // ---- /kernel command ------------------------------------------------
  pi.registerCommand("kernel", {
    description: "Kernel-pilot status + hot-swap. /kernel auto|stateless|stateful switches the backend live; /kernel reset clears stats.",
    getArgumentCompletions: (prefix: string) => {
      const args = ["auto", "stateless", "stateful", "reset"].filter((a) => a.startsWith(prefix.toLowerCase()));
      return args.map((a) => ({ value: a, label: a }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim().toLowerCase();
      if (arg === "auto" || arg === "stateless" || arg === "stateful") {
        backend = arg;
        ctx.ui.notify(`kernel-pilot backend → ${arg} (this session; reload resets to ompr.toml)`, "success");
        return;
      }
      if (arg === "reset") {
        try { writeFileSync(STATS_LOG, "", "utf8"); ctx.ui.notify("kernel-pilot stats cleared", "success"); } catch { ctx.ui.notify("could not clear stats", "error"); }
        return;
      }
      const s = readStats();
      const base = resolveBase(ctx);
      ctx.ui.notify(
        [
          `backend: ${backend} (config default: ${cfg.backend})`,
          `patch live: ${pilotLive ? "yes" : "no (additive mode - no ipython router until prime-agent restarts)"}`,
          `router: ${base ? "active" : "inactive"}`,
          `stats: py=${s.py} ipython=${s.ipython} errors=${s.errors} byMode=${JSON.stringify(s.byMode)}`,
          `runner: ${resolveKernelPython()}`,
          "swap: /kernel auto|stateless|stateful",
        ].join("\n"),
        "info",
      );
    },
  });

  // ---- tidy up on teardown --------------------------------------------
  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    try {
      const s = ctx.sessionManager?.getSessionId?.() ?? "";
      const g = globalThis as any;
      if (g.__ompaKernelPilot && s) delete g.__ompaKernelPilot[s];
    } catch { /* ignore */ }
  });
}
