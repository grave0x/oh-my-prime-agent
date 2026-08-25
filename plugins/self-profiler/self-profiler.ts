/**
 * self-profiler — a thin in-session profiler that assists /refine.
 *
 * Records the agent's own behaviour (turn durations, per-tool latency/errors,
 * repeated shell commands, machine-pressure holds) into a small JSONL log and
 * distills it into a compact profile JSON that both the TUI dashboard and
 * /refine can consume. The distilled file is deliberately tiny (< 4 KB) so the
 * refine planner can read it without token bloat.
 *
 * Events used: turn_start / turn_end / tool_call / tool_result / agent_end.
 * Data:   ~/.local/state/ompa/profile.jsonl          (event log, rotated)
 *         ~/.local/state/ompa/profile-distilled.json (compact aggregate)
 *
 * Commands:
 *   /profile          show the distilled profile + concrete refine.run() hints
 *   /profile reset    clear the event log and distilled profile
 *
 * The distill step emits `refineHints`: short, evidence-backed instructions
 * you can pass straight to `await refine.run("<hint>")`.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const STATE_DIR = join(homedir(), ".local", "state", "ompa");
const PROFILE_LOG = join(STATE_DIR, "profile.jsonl");
const DISTILLED = join(STATE_DIR, "profile-distilled.json");
const GUARD_LOG = join(homedir(), ".local", "state", "resource-guard", "usage.jsonl");
const MAX_LOG_BYTES = 1024 * 1024; // rotate at 1 MB (houseguest: bounded state)
const MAX_LOG_LINES = 4000;         // distill reads at most this many events

interface ToolAgg {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  lastTs?: string;
}

interface Distilled {
  generated: string;
  turns: number;
  totalTurnMs: number;
  avgTurnMs: number;
  tools: Record<string, ToolAgg>;
  holds: number;
  repeatedCommands: Array<{ prefix: string; count: number }>;
  refineHints: string[];
}

function now(): string {
  return new Date().toISOString();
}

function ensureDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

function appendEvent(ev: Record<string, unknown>): void {
  try {
    ensureDir();
    // rotate: append -> keep newest half when oversized
    try {
      const st = statSync(PROFILE_LOG);
      if (st.size > MAX_LOG_BYTES) {
        const lines = readFileSync(PROFILE_LOG, "utf8").split("\n").filter(Boolean);
        const keep = Math.max(1, Math.floor(lines.length / 2));
        writeFileSync(PROFILE_LOG, lines.slice(-keep).join("\n") + "\n", "utf8");
      }
    } catch { /* no log yet */ }
    appendFileSync(PROFILE_LOG, JSON.stringify({ ts: now(), ...ev }) + "\n", "utf8");
  } catch { /* profiling must never break the session */ }
}

interface ParsedEv {
  ts: string;
  type: string;
  [k: string]: unknown;
}

function readEvents(): ParsedEv[] {
  if (!existsSync(PROFILE_LOG)) return [];
  try {
    return readFileSync(PROFILE_LOG, "utf8").split("\n").filter(Boolean).slice(-MAX_LOG_LINES)
      .map((l) => { try { return JSON.parse(l) as ParsedEv; } catch { return null; } })
      .filter((e): e is ParsedEv => e !== null);
  } catch { return []; }
}

function countHolds(): number {
  if (!existsSync(GUARD_LOG)) return 0;
  try {
    let n = 0;
    const raw = readFileSync(GUARD_LOG, "utf8").split("\n").filter(Boolean);
    for (const line of raw.slice(-2000)) {
      try { if (JSON.parse(line).action === "held") n++; } catch { /* skip */ }
    }
    return n;
  } catch { return 0; }
}

/** Normalize a bash command to a stable prefix (first 2 shell tokens). */
function commandPrefix(cmd: string): string {
  const s = (cmd || "").trim().replace(/\s+/g, " ").slice(0, 200);
  const tokens = s.split(" ");
  return tokens.slice(0, 2).join(" ");
}

function distill(): Distilled {
  const events = readEvents();
  const tools: Record<string, ToolAgg> = {};
  const cmdCounts = new Map<string, number>();
  let turns = 0;
  let totalTurnMs = 0;
  for (const ev of events) {
    if (ev.type === "turn") {
      turns++;
      totalTurnMs += typeof ev.durationMs === "number" ? ev.durationMs : 0;
      continue;
    }
    if (ev.type === "result") {
      const t = String(ev.tool || "?");
      const a = tools[t] ?? { count: 0, totalMs: 0, maxMs: 0, errors: 0, lastTs: ev.ts };
      a.count++;
      const dur = typeof ev.durationMs === "number" ? ev.durationMs : 0;
      a.totalMs += dur;
      a.maxMs = Math.max(a.maxMs, dur);
      if (ev.isError === true) a.errors++;
      tools[t] = a;
      continue;
    }
    if (ev.type === "tool" && ev.tool === "bash") {
      const p = commandPrefix(String(ev.snippet || ""));
      if (p) cmdCounts.set(p, (cmdCounts.get(p) ?? 0) + 1);
    }
  }
  const repeatedCommands = [...cmdCounts.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([prefix, count]) => ({ prefix, count }));

  // evidence-backed refine hints (deterministic, no LLM cost)
  const refineHints: string[] = [];
  for (const [tool, a] of Object.entries(tools)) {
    if (a.errors >= 3) {
      refineHints.push(`Tool ${tool} failed ${a.errors} times in this session; capture the recurring failure mode as a memory and, if it is a repeatable procedure, promote a fix to a skill.`);
    }
    if (a.count >= 5 && a.totalMs / a.count > 30_000) {
      refineHints.push(`Tool ${tool} averages ${Math.round(a.totalMs / a.count / 1000)}s per call (${a.count} calls); consider a cheaper alternative or a more specific skill to avoid slow round-trips.`);
    }
  }
  for (const r of repeatedCommands) {
    refineHints.push(`Shell pattern "${r.prefix}" repeated ${r.count} times; if this is a recurring workflow, distill it into a reusable skill or alias.`);
  }
  const holds = countHolds();
  if (holds >= 3) {
    refineHints.push(`Resource guard held heavy tool calls ${holds} times; the machine is frequently pressured — consider tightening ompr.toml [resource] or scheduling heavy work off-peak.`);
  }
  if (turns >= 5 && totalTurnMs / Math.max(1, turns) > 120_000) {
    refineHints.push(`Turns average ${Math.round(totalTurnMs / Math.max(1, turns) / 1000)}s; long turns suggest context bloat — compact earlier or split work into subagents.`);
  }
  if (refineHints.length === 0) {
    refineHints.push("No repeated failures or hot patterns detected; no refinement needed yet.");
  }

  return {
    generated: now(),
    turns,
    totalTurnMs,
    avgTurnMs: turns ? Math.round(totalTurnMs / turns) : 0,
    tools,
    holds,
    repeatedCommands,
    refineHints,
  };
}

function writeDistilled(): Distilled {
  const d = distill();
  try {
    ensureDir();
    writeFileSync(DISTILLED, JSON.stringify(d, null, 2) + "\n", "utf8");
  } catch { /* best-effort */ }
  return d;
}

function readDistilled(): Distilled | null {
  if (!existsSync(DISTILLED)) return null;
  try { return JSON.parse(readFileSync(DISTILLED, "utf8")) as Distilled; } catch { return null; }
}

function formatProfile(d: Distilled | null): string {
  if (!d) return "(no profile yet — work a few turns, then /profile)";
  const lines: string[] = [];
  lines.push(`turns=${d.turns} avgTurn=${Math.round(d.avgTurnMs / 1000)}s holds=${d.holds}`);
  const toolLine = Object.entries(d.tools)
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .map(([t, a]) => `${t}:${a.count}x ${Math.round(a.totalMs / Math.max(1, a.count) / 1000)}s${a.errors ? ` ERR${a.errors}` : ""}`)
    .join("  ");
  if (toolLine) lines.push("tools: " + toolLine);
  for (const r of d.repeatedCommands.slice(0, 3)) {
    lines.push(`repeated: "${r.prefix}" x${r.count}`);
  }
  lines.push("refine hints:");
  for (const h of d.refineHints.slice(0, 4)) lines.push("  • " + h);
  return lines.join("\n");
}

export default function selfProfiler(pi: ExtensionAPI): void {
  const toolStarts = new Map<string, { tool: string; started: number }>();
  let turnStarted = 0;
  let turnIndex = 0;

  pi.on("turn_start", async (event: any, _ctx: any) => {
    turnStarted = Date.now();
    turnIndex = typeof event.turnIndex === "number" ? event.turnIndex : turnIndex + 1;
  });

  pi.on("turn_end", async (_event: any, _ctx: any) => {
    if (turnStarted) {
      appendEvent({ type: "turn", turnIndex, durationMs: Date.now() - turnStarted });
      turnStarted = 0;
    }
  });

  pi.on("tool_call", async (event: any, _ctx: any) => {
    const id = event.toolCallId;
    if (!id) return;
    const tool = event.toolName || "?";
    const snippet = tool === "bash"
      ? String(event.input?.command || "").slice(0, 120)
      : tool === "ipython"
        ? String(event.input?.code || "").slice(0, 120)
        : "";
    toolStarts.set(id, { tool, started: Date.now() });
    appendEvent({ type: "tool", toolCallId: id, tool, snippet });
  });

  pi.on("tool_result", async (event: any, _ctx: any) => {
    const id = event.toolCallId;
    const start = id ? toolStarts.get(id) : undefined;
    toolStarts.delete(id);
    const tool = event.toolName || start?.tool || "?";
    appendEvent({
      type: "result",
      toolCallId: id,
      tool,
      durationMs: start ? Date.now() - start.started : 0,
      isError: event.isError === true,
    });
  });

  // distill once at the end of each agent loop so the profile is fresh for
  // /refine and for the TUI dashboard panel.
  pi.on("agent_end", async (_event: any, _ctx: any) => {
    try { writeDistilled(); } catch { /* ignore */ }
  });

  pi.registerCommand("profile", {
    description: "Show the self-profiler distilled profile + concrete refine.run() hints. /profile reset clears.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim().toLowerCase() === "reset") {
        try {
          if (existsSync(PROFILE_LOG)) writeFileSync(PROFILE_LOG, "", "utf8");
          if (existsSync(DISTILLED)) writeFileSync(DISTILLED, "", "utf8");
          ctx.ui.notify("profile cleared", "success");
        } catch {
          ctx.ui.notify("could not clear profile", "error");
        }
        return;
      }
      const d = writeDistilled();
      ctx.ui.notify(formatProfile(d), "info");
    },
  });
}
