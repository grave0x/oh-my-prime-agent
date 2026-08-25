/**
 * Resource Guard — records, throttles, and holds heavy tool calls.
 *
 * Policy source: ~/.prime/agent/resource-policy.json (created on first load
 * with defaults matching grave's desktop resource policy).
 *
 * How it works:
 *   • On every bash/ipython tool_call that matches a heavy pattern
 *     (build/compile/decompile/install), sample loadavg + memory + swap.
 *   • If the machine is over the thresholds, HOLD the tool: poll until
 *     pressure drops (or a max wait passes), then run.
 *   • Throttle the command before it runs: wrap in `nice -n 19 ionice -c3`,
 *     and inject `-j 4` (or `--jobs 4`) for known build tools if absent.
 *   • Record every sample to ~/.local/state/resource-guard/usage.jsonl.
 *   • `/resource` shows current load, mem, swap, and the last entries.
 *
 * Tuning lives in the global config file, not in code.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const POLICY_PATH = join(homedir(), ".prime", "agent", "resource-policy.json");
const STATE_DIR = join(homedir(), ".local", "state", "resource-guard");
const USAGE_LOG = join(STATE_DIR, "usage.jsonl");

interface Policy {
  /** 1-minute load average over this = pressured (default nproc * 0.75) */
  maxLoad1: number;
  /** minimum MemAvailable (MB) required before starting a heavy job */
  minMemAvailMB: number;
  /** swap used over this many MB = pressured */
  maxSwapUsedMB: number;
  /** how often to re-poll while holding (ms) */
  pollMs: number;
  /** max time to hold before running anyway (ms) */
  maxHoldMs: number;
  /** extra regexes that count as heavy (joined with defaults) */
  heavyPatterns: string[];
  /** tools to guard */
  tools: string[];
  /** nice level to apply */
  niceLevel: number;
  /** ionice class */
  ioClass: number;
  /** max parallel jobs to inject (-j N) for build tools */
  maxJobs: number;
  /** per-project overrides keyed by cwd prefix (longest match wins) */
  perProject?: Record<string, Partial<Policy>>;
}

const DEFAULT_POLICY: Policy = {
  maxLoad1: 9,           // 75% of 12 cores
  minMemAvailMB: 1200,
  maxSwapUsedMB: 8000,   // 16GB swap — over half used = pressure
  pollMs: 1500,
  maxHoldMs: 240000,     // 4 min max hold
  heavyPatterns: [
    "\\b(cargo|rustc|make|ninja|cmake|gcc|g\\+\\+|clang|npm run build|tsc|webpack|vite build|go build|go install|gradle|mvn|bazel|jadx|apktool|pnpm build|yarn build)\\b",
    "\\b(opt-level|codegen-units|target/release|CMAKE_BUILD_TYPE)\\b",
    "\\b(-j\\s*\\d+|--jobs)\\b",
  ],
  tools: ["bash", "ipython"],
  niceLevel: 19,
  ioClass: 3,
  maxJobs: 4,
  perProject: {
    // Moonshell: Bevy crates are huge single compile units; -j2 avoids the OOM
    // observed at default parallelism. Keys are cwd prefixes.
    "/home/grave/Projects/Moonshell": { maxJobs: 2 },
  },
};

function ensurePolicy(): Policy {
  try {
    if (!existsSync(POLICY_PATH)) {
      mkdirSync(join(homedir(), ".prime", "agent"), { recursive: true });
      writeFileSync(POLICY_PATH, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", "utf8");
      return { ...DEFAULT_POLICY };
    }
    const raw = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
    return { ...DEFAULT_POLICY, ...raw };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function effectivePolicy(base: Policy, cwd: string): Policy {
  if (!base.perProject || !cwd) return base;
  let best: Partial<Policy> | undefined;
  let bestLen = -1;
  for (const [prefix, over] of Object.entries(base.perProject)) {
    // path-boundary match: prefix must end the segment (/repo vs /repo-evil) — F6
    const atBoundary = cwd === prefix || cwd.startsWith(prefix + "/") || cwd.startsWith(prefix + "\\");
    if (atBoundary && prefix.length > bestLen) { best = over; bestLen = prefix.length; }
  }
  return best ? { ...base, ...best } : base;
}

function systemStats(): { load1: number; memAvailMB: number; swapUsedMB: number } {
  try {
    const load = parseFloat(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) || 0;
    const mem = readFileSync("/proc/meminfo", "utf8");
    const g = (key: string) => {
      const m = mem.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? parseInt(m[1], 10) : 0;
    };
    const memAvailMB = Math.round(g("MemAvailable") / 1024);
    const swapUsedMB = Math.round((g("SwapTotal") - g("SwapFree")) / 1024);
    return { load1: load, memAvailMB, swapUsedMB };
  } catch {
    return { load1: 0, memAvailMB: 99999, swapUsedMB: 0 };
  }
}

function pressured(p: Policy): boolean {
  const s = systemStats();
  return s.load1 > p.maxLoad1 || s.memAvailMB < p.minMemAvailMB || s.swapUsedMB > p.maxSwapUsedMB;
}

function record(action: string, tool: string, extra: Record<string, unknown>): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // F6: rotate at 5MB so the log can't fill the disk (houseguest: take out the trash)
    try {
      const st = statSync(USAGE_LOG);
      if (st.size > 5 * 1024 * 1024) renameSync(USAGE_LOG, USAGE_LOG + ".1");
    } catch { /* no log yet */ }
    const s = systemStats();
    appendFileSync(USAGE_LOG, JSON.stringify({
      ts: new Date().toISOString(), action, tool,
      load1: s.load1, memAvailMB: s.memAvailMB, swapUsedMB: s.swapUsedMB, ...extra,
    }) + "\n", "utf8");
  } catch { /* never break the tool over logging */ }
}

function isHeavy(text: string, p: Policy): boolean {
  if (!text) return false;
  return p.heavyPatterns.some((pat) => {
    try { return new RegExp(pat, "i").test(text); } catch { return false; }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wrap a shell command with nice+ionice. */
function throttleShell(cmd: string, p: Policy): string {
  const nice = `nice -n ${p.niceLevel} ionice -c ${p.ioClass}`;
  // chains (&, |, ;, $(), `) or newlines rebind what nice applies to —
  // wrap the WHOLE command so nothing escapes throttling (F1 fix).
  const chains = /&&|\|\||[;&]|\$\(|`/.test(cmd);
  if (/\n/.test(cmd) || chains) {
    return `${nice} bash -c '${cmd.replace(/'/g, "'\\''")}'`;
  }
  return `${nice} ${cmd}`;
}

/** Inject -j/--jobs into a known build command if it lacks one. */
function injectJobs(cmd: string, p: Policy): string {
  if (/\n/.test(cmd)) return cmd;
  const already = /(-j\s*\d+|--jobs(\s|=)?\d+)/.test(cmd);
  if (already) return cmd;
  // process each shell segment so `cd repo && cargo build` still gets -j (F1 fix)
  const parts = cmd.split(/(&&|\|\||[;&|])/g);
  let changed = false;
  const out = parts.map((seg) => {
    const lead = /^\s*/.exec(seg)?.[0] || "";
    const s = seg.trim();
    if (!s || /^(&&|\|\||[;&|])$/.test(s)) return seg;
    const first = s.split(/\s+/)[0]?.toLowerCase() || "";
    if (first === "cargo") { const r = s.replace(/^(cargo\s+\S+)/, `$1 -j ${p.maxJobs}`); if (r !== s) { changed = true; return lead + r; } return seg; }
    if (first === "make" || first === "ninja") { changed = true; return lead + `${s} -j ${p.maxJobs}`; }
    if (first === "cmake") { changed = true; return lead + `${s} -- -j ${p.maxJobs}`; }
    // gcc/clang direct compiles: -j is a make concept; throttle via nice only.
    // npm/pnpm/yarn: parallelize internally — leave as-is.
    return seg;
  });
  return changed ? out.join("") : cmd;
}

export default function resourceGuard(pi: ExtensionAPI): void {
  const p = ensurePolicy();

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.toolName;
    if (!p.tools.includes(toolName)) return undefined;
    const cwd: string = ctx?.cwd || ctx?.sessionManager?.getCwd?.() || "";
    const eff = effectivePolicy(p, cwd);

    const text = toolName === "bash"
      ? (event.input?.command || "")
      : (event.input?.code || "");
    if (!isHeavy(text, p)) return undefined;

    let heldFor = 0;
    const started = Date.now();
    let held = false;
    while (pressured(eff)) {
      held = true;
      record("held", toolName, { snippet: text.slice(0, 120) });
      try { ctx.ui.notify(`Resource guard: holding ${toolName} (load ${systemStats().load1.toFixed(1)})…`, "info"); } catch { /* no UI */ }
      await sleep(eff.pollMs);
      heldFor += eff.pollMs;
      if (heldFor >= eff.maxHoldMs) break;
    }

    // throttle before execution
    if (toolName === "bash" && event.input?.command) {
      let cmd = event.input.command;
      cmd = injectJobs(cmd, eff);
      cmd = throttleShell(cmd, eff);
      event.input.command = cmd;
    } else if (toolName === "ipython" && event.input?.code) {
      // wrap spawned processes via env; best-effort: mark code with a note
      record("throttled", toolName, { snippet: text.slice(0, 120), heldFor });
      return undefined;
    }

    record(held ? "ran-after-hold" : "ran", toolName, { snippet: text.slice(0, 120), heldFor });
    return undefined;
  });

  // ---- inject live resource context + execution guidance each turn --------
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const s = systemStats();
    const pressuredNow = pressured(p);
    const cores = cpus().length;
    const lines = [
      `[Resource context] ${cores} cores. load1=${s.load1.toFixed(2)} (max ${p.maxLoad1}), memAvailable=${s.memAvailMB}MB (min ${p.minMemAvailMB}), swapUsed=${s.swapUsedMB}MB (max ${p.maxSwapUsedMB}).`,
      pressuredNow
        ? "The machine is UNDER PRESSURE right now. Prefer single-threaded or already-running work. Avoid starting new builds/installs unless the user explicitly asks. Use the /resource guard thresholds as your budget."
        : "The machine has headroom right now. You may proceed, but still throttle heavy builds (-j 4, nice, ionice).",
      "Tool choice guidance: for shell/text/file operations (ls, grep, sed, awk, jq, find, git, curl, mkdir, chmod, cat, env, ps), use the bash tool directly — it is usually much faster and lighter than a Python script. Use the ipython tool only when you need real logic, data structures, libraries, or multi-step stateful computation.",
    ];
    const prompt = (event.systemPrompt || "") + "\n\n" + lines.join("\n");
    return { systemPrompt: prompt };
  });

  pi.registerCommand("resource", {
    description: "Show current resource state and the guard log tail.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const s = systemStats();
      let tail = "";
      try {
        if (existsSync(USAGE_LOG)) {
          const lines = readFileSync(USAGE_LOG, "utf8").split("\n").filter(Boolean);
          tail = lines.slice(-4).map((l) => {
            try { const e = JSON.parse(l); return `${e.ts?.slice(11,19)} ${e.action} load=${e.load1} mem=${e.memAvailMB}MB`; } catch { return ""; }
          }).filter(Boolean).join("\n");
        }
      } catch { /* ignore */ }
      ctx.ui.notify(
        `load1=${s.load1.toFixed(2)} (max ${p.maxLoad1}) · memAvail=${s.memAvailMB}MB (min ${p.minMemAvailMB}) · swapUsed=${s.swapUsedMB}MB (max ${p.maxSwapUsedMB})\n${tail || "(no guard activity yet)"}`,
        "info",
      );
    },
  });
}
