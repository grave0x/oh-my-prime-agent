/**
 * Global Agent Chat — shared conversation log + cross-agent messaging in the TUI.
 *
 * What it does:
 *   • `:: hello everyone`   → posts to the GLOBAL chat (all agents + this log).
 *                             Bypasses the current single-agent conversation.
 *   • `:name: hey`          → sends only to the agent named/id'd `name`.
 *   • `/chat`               → open the shared chat log panel (right side).
 *   • `/chat off`           → close it.  Hotkey: ctrl+alt+g
 *
 * Routing uses the same agent-message channel as the kernel's agent_message
 * skill: it shells out to `prime-agent send <target> <message>` (same daemon
 * delivery the kernel uses), and the shared log lives at
 * ~/.local/state/agent-chat/chat.jsonl (JSONL, appended by every agent).
 *
 * Rooms/private: the log supports a `room` field. Default room is "global".
 * `::#room text` posts to a room. Any agent can also post to a room via the
 * same file convention (extend later).
 *
 * Keys (panel): ↑↓ scroll · r refresh · q/esc close
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const CHAT_DIR = join(homedir(), ".local", "state", "agent-chat");
const CHAT_LOG = join(CHAT_DIR, "chat.jsonl");
const SOULS_DIR = join(homedir(), ".prime", "agent", "souls");
const SOUL_EXT = ".soul.md";
const SOUL_POOL = [
  "crypt", "reaper", "shovel", "spade", "tomb", "moss", "worm", "bone",
  "skull", "urn", "vault", "grave", "dirge", "mourn", "dirt", "loam",
  "ashes", "pyre", "sepulcher", "mausoleum", "necron", "spectre", "wraith",
  "phantasm", "coffin", "epitaph", "obelisk", "sarcophagus", "torch", "keepsake",
];
const MAX_ENTRIES = 60;
const REFRESH_MS = 1500;

interface ChatEntry {
  ts?: string;
  from?: string;        // sender id or "user"
  fromName?: string;    // sender display name
  to?: string;          // "*" = global, otherwise target agent id
  room?: string;        // "global" or room name
  text?: string;
  kind?: string;        // "text" | "agent"
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let panelActive = false;

function ensureDir(): void {
  mkdirSync(CHAT_DIR, { recursive: true });
}

function now(): string {
  return new Date().toISOString();
}

function readEntries(): ChatEntry[] {
  if (!existsSync(CHAT_LOG)) return [];
  try {
    const raw = readFileSync(CHAT_LOG, "utf8").split("\n").filter(Boolean);
    return raw.slice(-MAX_ENTRIES).map((line) => {
      try { return JSON.parse(line) as ChatEntry; } catch { return null; }
    }).filter((e): e is ChatEntry => e !== null);
  } catch { return []; }
}

function soulFileName(name: string): string {
  return join(SOULS_DIR, name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") + SOUL_EXT);
}

interface SoulMeta {
  name?: string;
  role?: string;
  session?: string;
  sessionId?: string;
  specialty?: string;
  personality?: string;
  projects?: Record<string, string[]>; // project key -> session ids
  projectLastSeen?: Record<string, string>; // project key -> ISO timestamp
  claimed_at?: string;
}

function readSouls(): Record<string, SoulMeta> {
  const out: Record<string, SoulMeta> = {};
  if (!existsSync(SOULS_DIR)) return out;
  try {
    for (const f of readdirSync(SOULS_DIR)) {
      if (!f.endsWith(SOUL_EXT)) continue;
      const name = f.slice(0, -SOUL_EXT.length);
      const raw = readFileSync(join(SOULS_DIR, f), "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---/);
      const meta: SoulMeta = { name };
      if (m) {
        const body = m[1];
        // multi-line fields (specialty, personality) come as YAML-ish blocks; parse simple key: value and indented lists
        const lines = body.split("\n");
        let curKey: string | null = null;
        const projects: Record<string, string[]> = {};
        for (const line of lines) {
          const idx = line.indexOf(":");
          if (idx !== -1 && !line.startsWith(" ") && !line.startsWith("\t")) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            curKey = k;
            if (k === "projects" && v) {
              // inline JSON-ish dict: {"proj": ["s1","s2"], ...}
              try { const parsed = JSON.parse(v); Object.assign(projects, parsed); } catch { /* skip */ }
            } else if (k && v) {
              (meta as any)[k] = v;
            }
          } else if (curKey === "projects" && line.trim().startsWith("-")) {
            // list item under projects
            try {
              const item = JSON.parse(line.trim().slice(1).trim());
              if (Array.isArray(item)) { const [proj, sids] = item; if (proj) projects[proj] = sids; }
            } catch { /* skip */ }
          }
        }
        if (Object.keys(projects).length) meta.projects = projects;
      }
      out[name] = meta;
    }
  } catch { /* ignore */ }
  return out;
}

/** Serialize a soul meta back to YAML frontmatter. */
function writeSoul(meta: SoulMeta): void {
  const name = (meta.name || "agent").toLowerCase();
  const path = soulFileName(name);
  const lines = ["---"];
  lines.push(`name: ${name}`);
  if (meta.role) lines.push(`role: ${meta.role}`);
  if (meta.session) lines.push(`session: ${meta.session}`);
  if (meta.sessionId) lines.push(`session_id: ${meta.sessionId}`);
  if (meta.specialty) lines.push(`specialty: ${meta.specialty}`);
  if (meta.personality) lines.push(`personality: ${meta.personality}`);
  if (meta.projects && Object.keys(meta.projects).length) {
    lines.push(`projects: ${JSON.stringify(meta.projects)}`);
  }
  if (meta.projectLastSeen && Object.keys(meta.projectLastSeen).length) {
    lines.push(`project_last_seen: ${JSON.stringify(meta.projectLastSeen)}`);
  }
  lines.push(`claimed_at: ${meta.claimed_at || new Date().toISOString()}`);
  lines.push("status: active");
  lines.push("---");
  try { mkdirSync(SOULS_DIR, { recursive: true }); writeFileSync(path, lines.join("\n") + "\n", "utf8"); } catch { /* ignore */ }
}

/** Normalize a cwd/path into a short project key. */
function projectKey(cwd: string): string {
  const home = homedir();
  let p = cwd || "";
  if (p.startsWith(home)) p = p.slice(home.length);
  const parts = p.split("/").filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "Projects" || parts[0] === "projects" || parts[0] === "projects" || parts[0] === "work")) {
    return parts.slice(0, 2).join("/");
  }
  return parts.length ? parts.join("/") : "home";
}

/** Record a session for this agent's current project into its soul. */
function recordProject(ctx: ExtensionContext): void {
  const sid = ctx.sessionManager?.getSessionId?.() ?? "";
  const cwd = ctx.cwd || ctx.sessionManager?.getCwd?.() || "";
  if (!sid) return;
  const souls = readSouls();
  let mine: SoulMeta | undefined;
  let myName = "";
  for (const [name, meta] of Object.entries(souls)) {
    if (meta.session === sid || meta.sessionId === sid) { mine = meta; myName = name; break; }
  }
  if (!mine) return;
  const key = projectKey(cwd);
  if (!key) return;
  mine.projects = mine.projects || {};
  mine.projectLastSeen = mine.projectLastSeen || {};
  const sids = mine.projects[key] || [];
  if (!sids.includes(sid)) sids.push(sid);
  mine.projects[key] = sids.slice(-10);
  mine.projectLastSeen[key] = new Date().toISOString();
  writeSoul(mine);
}

function mySoulName(ctx: ExtensionContext): string {
  const sid = ctx.sessionManager?.getSessionId?.() ?? "";
  const souls = readSouls();
  for (const [name, meta] of Object.entries(souls)) {
    if (meta.session === sid || meta.sessionId === sid) return name;
  }
  return ctx.sessionManager?.getSessionName?.() || "agent";
}

/** Set this agent's own kitty tab title to its soul name (via control socket). */
function setKittyTabTitle(title: string): void {
  const pid = process.env.KITTY_PID;
  const winId = process.env.KITTY_WINDOW_ID;
  if (!pid || !winId) return;
  const runtime = process.env.XDG_RUNTIME_DIR || "/run/user/1000";
  const sock = `${runtime}/kitty-${pid}`;
  execAsync("kitty", ["@", "--to", `unix:${sock}`, "set-tab-title", "--match", `window_id:${winId}`, title]);
}

function claimSoul(name: string, ctx: ExtensionContext): { ok: boolean; reason?: string } {
  const sid = ctx.sessionManager?.getSessionId?.() ?? "";
  const existing = readSouls();
  for (const [n, meta] of Object.entries(existing)) {
    if (meta.session === sid && meta.sessionId === sid && n === name.toLowerCase()) {
      return { ok: true }; // already mine
    }
  }
  const path = soulFileName(name);
  if (existsSync(path)) {
    // owned by another session?
    const raw = readFileSync(path, "utf8");
    if (raw.includes(`session: ${sid}`)) return { ok: true };
    return { ok: false, reason: `"${name}" is already claimed` };
  }
  const body = `---\nname: ${name.toLowerCase()}\nrole: agent\nsession: ${sid}\nsession_id: ${sid}\nclaimed_at: ${new Date().toISOString()}\nstatus: active\n---\n`;
  try {
    mkdirSync(SOULS_DIR, { recursive: true });
    writeFileSync(path, body, "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

function appendEntry(e: ChatEntry): void {
  ensureDir();
  const line = JSON.stringify({ ts: now(), ...e }) + "\n";
  try { appendFileSync(CHAT_LOG, line, "utf8"); } catch { /* ignore */ }
}

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout).trim());
    });
  });
}

interface AgentInfo {
  id: string;
  sessionId: string;
  firstMessage?: string;
  activity?: string;
  sessionName?: string;
}

/** List live agents via the same registry the kernel roster uses. */
async function listAgents(): Promise<AgentInfo[]> {
  const out = await execAsync("prime-agent", ["list", "--json"]);
  if (!out) return [];
  try {
    const data = JSON.parse(out);
    return (data.sessions || []).map((s: any) => ({
      id: s.id,
      sessionId: s.sessionId,
      firstMessage: s.firstMessage || "",
      activity: s.activity || "",
      sessionName: s.sessionName || "",
    }));
  } catch { return []; }
}

/** Resolve a `:name:` selector to a live agent id. Order: soul name → id/uuid → firstMessage. */
async function resolveAgent(selector: string, currentId: string): Promise<string | null> {
  const sel = selector.trim().toLowerCase();
  if (!sel) return null;
  const agents = await listAgents();
  // 1) soul registry (chosen names)
  const souls = readSouls();
  const soulMatch = Object.entries(souls).find(([name, meta]) =>
    name.toLowerCase() === sel ||
    (meta.sessionId || "").toLowerCase() === sel ||
    (meta.session || "").toLowerCase() === sel);
  if (soulMatch) {
    const sid = (soulMatch[1].sessionId || soulMatch[1].session || "").trim();
    const bySid = agents.find((a) => a.sessionId === sid || a.id === sid);
    if (bySid && bySid.id !== currentId) return bySid.id;
  }
  // 2) exact id/uuid
  const exact = agents.find((a) => a.id.toLowerCase() === sel || a.sessionId.toLowerCase() === sel);
  if (exact) return exact.id;
  // 3) name/firstMessage match
  const byName = agents.find((a) =>
    (a.sessionName || "").toLowerCase() === sel ||
    (a.firstMessage || "").toLowerCase().includes(sel) ||
    (a.id.toLowerCase().startsWith(sel)));
  if (byName && byName.id !== currentId) return byName.id;
  // 4) project familiarity: agent whose soul has the most sessions in this project
  const projMatches = Object.entries(souls)
    .map(([name, meta]) => ({ name, meta, count: (meta.projects && meta.projects[sel]) ? meta.projects[sel].length : 0 }))
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count);
  if (projMatches.length) {
    const sid = (projMatches[0].meta.sessionId || projMatches[0].meta.session || "").trim();
    const bySid = agents.find((a) => a.sessionId === sid || a.id === sid);
    if (bySid && bySid.id !== currentId) return bySid.id;
  }
  return null;
}

/** Post a message to the shared log. */
function post(entry: ChatEntry): void {
  appendEntry(entry);
}

/** Deliver via the agent-message channel (same as kernel agent_message.send). */
async function deliver(targetId: string, message: string): Promise<void> {
  await execAsync("prime-agent", ["send", targetId, message, "--json"]);
}

/* ------------------------------------------------------------------ */
/* Chat panel                                                          */
/* ------------------------------------------------------------------ */

class ChatView extends Container {
  private entries: ChatEntry[] = [];
  private sel = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCount = -1;

  constructor(private tui: any, private theme: any, private done: (r: null) => void) {
    super();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); }

  private refresh(): void {
    const entries = readEntries();
    if (entries.length !== this.lastCount) {
      this.lastCount = entries.length;
      this.entries = entries;
      this.sel = Math.max(0, this.entries.length - 1);
      this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") { this.done(null); return; }
    if (data === "r" || data === "R") { this.refresh(); return; }
    if (matchesKey(data, Key.up)) { this.sel = Math.max(0, this.sel - 1); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.sel = Math.min(this.entries.length - 1, this.sel + 1); this.tui.requestRender(); return; }
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    lines.push(t.fg("accent", `== AGENT CHAT ==  (${this.entries.length})`));
    lines.push(t.fg("dim", "-".repeat(Math.min(width, 48))));
    if (this.entries.length === 0) {
      lines.push(t.fg("muted", "(no chat yet — try `:: hello` or `:name: hi`)"));
    }
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const room = e.room && e.room !== "global" ? `#${e.room} ` : "";
      const from = e.fromName || e.from || "?";
      const target = e.to && e.to !== "*" ? `→${e.to.slice(0, 8)} ` : "";
      const selMark = i === this.sel ? "»" : " ";
      const color = e.from === "user" ? "success" : e.to && e.to !== "*" ? "warning" : "info";
      const text = truncateToWidth(e.text || "", Math.max(10, width - 24));
      lines.push(`${selMark}${t.fg(color, `[${(e.ts || "").slice(11, 19)}]`)} ${t.fg("neutral", room + from + target)}`);
      lines.push(`  ${t.fg("neutral", text)}`);
    }
    lines.push(t.fg("dim", "-".repeat(Math.min(width, 48))));
    lines.push(t.fg("muted", "↑↓ scroll · r refresh · q close"));
    return lines;
  }
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default function globalChatExtension(pi: ExtensionAPI): void {
  ensureDir();

  const openPanel = async (ctx: any) => {
    if (panelActive) return;
    panelActive = true;
    try {
      await ctx.ui.custom(
        (tui: any, theme: any, _kb: any, done: (r: null) => void) => new ChatView(tui, theme, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "36%",
            minWidth: 42,
            margin: { top: 1, right: 0, bottom: 1, left: 1 },
          },
          onHandle: () => {},
        },
      );
    } catch { /* panel failed */ }
    panelActive = false;
  };

  // ---- `::` and `:name:` input routing -------------------------------
  pi.on("input", async (event: any, ctx: ExtensionContext) => {
    const raw = event.text ?? "";
    if (!raw.startsWith(":") || raw.startsWith(":::")) {
      return { action: "continue" } as any;
    }
    // `::` global chat
    if (raw.startsWith("::")) {
      let text = raw.slice(2).trim();
      let room = "global";
      if (text.startsWith("#")) {
        const sp = text.indexOf(" ");
        if (sp === -1) { text = ""; }
        else { room = text.slice(1, sp).trim() || "global"; text = text.slice(sp + 1).trim(); }
      }
      if (!text) {
        ctx.ui.notify("Global chat: `:: message` (or `::#room message`)", "info");
        return { action: "handled" } as any;
      }
      const selfId = ctx.sessionManager?.getSessionId?.() ?? "agent";
      const selfName = mySoulName(ctx);
      // Log it
      post({ from: "user", fromName: "you", to: "*", room, text, kind: "text" });
      // Broadcast to every live agent (same channel as agent_message)
      const agents = await listAgents();
      for (const a of agents) {
        if (a.id === selfId) continue;
        await deliver(a.id, `[global${room !== "global" ? ":" + room : ""}] ${text}`);
      }
      ctx.ui.notify(`Global chat${room !== "global" ? " #" + room : ""}: ${text.slice(0, 60)}`, "info");
      return { action: "handled" } as any;
    }
    // `:name:` direct message
    if (raw.startsWith(":") && !raw.startsWith("::")) {
      const close = raw.indexOf(":", 1);
      if (close === -1) return { action: "continue" } as any;
      const name = raw.slice(1, close).trim();
      const text = raw.slice(close + 1).trim();
      if (!name || !text) {
        ctx.ui.notify("Direct: `:name: message`", "info");
        return { action: "handled" } as any;
      }
      const selfId = ctx.sessionManager?.getSessionId?.() ?? "agent";
      const selfName = mySoulName(ctx);
      const target = await resolveAgent(name, selfId);
      if (!target) {
        ctx.ui.notify(`No live agent matches "${name}"`, "error");
        return { action: "handled" } as any;
      }
      post({ from: "user", fromName: selfName, to: target, room: "global", text, kind: "text" });
      await deliver(target, `[direct] ${text}`);
      ctx.ui.notify(`→ ${name}: ${text.slice(0, 60)}`, "info");
      return { action: "handled" } as any;
    }
    return { action: "continue" } as any;
  });

  // ---- /soul command: claim or show your chosen name -------------------
  pi.registerCommand("soul", {
    description: "Claim or show your agent soul name (/soul <name>). The name routes :name: chat to you.",
    getArgumentCompletions: (prefix: string) => {
      const pool = SOUL_POOL.filter((n) => n.startsWith(prefix.toLowerCase()));
      return pool.map((n) => ({ value: n, label: n }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const current = mySoulName(ctx);
      // `set <field> <text>` updates specialty/personality of my own soul
      const setMatch = trimmed.match(/^set\s+(specialty|personality)\s+([\s\S]+)$/i);
      if (setMatch) {
        const field = setMatch[1].toLowerCase();
        const value = setMatch[2].trim();
        const sid = ctx.sessionManager?.getSessionId?.() ?? "";
        const souls = readSouls();
        for (const [name, meta] of Object.entries(souls)) {
          if (meta.session === sid || meta.sessionId === sid) {
            meta[field] = value;
            writeSoul(meta);
            ctx.ui.notify(`Soul ${field} updated: ${value.slice(0, 60)}`, "success");
            return;
          }
        }
        ctx.ui.notify("Claim a soul first: /soul <name>", "error");
        return;
      }
      const name = trimmed;
      if (!name) {
        const souls = readSouls();
        ctx.ui.notify(`Your soul: ${current}. Claim: /soul <name> · set: /soul set specialty <text>`, "info");
        return;
      }
      const res = claimSoul(name, ctx);
      if (res.ok) {
        ctx.ui.notify(`Soul claimed: ${name.toLowerCase()}`, "success");
        try { pi.setSessionName(name.toLowerCase()); } catch { /* optional */ }
        setKittyTabTitle(name.toLowerCase());
      } else {
        ctx.ui.notify(res.reason || "could not claim soul", "error");
      }
    },
  });

  // ---- inject my soul into the system prompt so I act per my identity ---
  pi.on("before_agent_start", async (event: any, ctx: ExtensionContext) => {
    try {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      if (!sid) return undefined;
      const souls = readSouls();
      let mine: SoulMeta | undefined;
      for (const meta of Object.values(souls)) {
        if (meta.session === sid || meta.sessionId === sid) { mine = meta; break; }
      }
      if (!mine) return undefined;
      const parts = [`Your soul name is ${mine.name}.`];
      if (mine.role) parts.push(`Role: ${mine.role}.`);
      if (mine.specialty) parts.push(`Specialty: ${mine.specialty}.`);
      if (mine.personality) parts.push(`Personality: ${mine.personality}.`);
      const projs = Object.entries(mine.projects || {}).sort((a, b) =>
        (mine.projectLastSeen?.[b[0]] || "").localeCompare(mine.projectLastSeen?.[a[0]] || ""));
      if (projs.length) {
        parts.push("Projects you have worked in (most recent first): " +
          projs.map(([k, sids]) => `${k} (${sids.length} sessions)`).join(", "));
      }
      parts.push("Answer in character but stay practical. Others reach you as `:" + mine.name + ":` in global chat.");
      const soulBlock = "[Soul identity]\n" + parts.join("\n");
      const base = (event.systemPrompt || "").trim();
      const already = base.includes("[Soul identity]");
      return { systemPrompt: already ? base : base + "\n\n" + soulBlock };
    } catch { return undefined; }
  });

  // ---- record project familiarity on each finished turn ----------------
  pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
    try { recordProject(ctx); } catch { /* ignore */ }
  });

  // ---- auto-claim a soul on session start if this agent has none ------
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    const sid = ctx.sessionManager?.getSessionId?.() ?? "";
    if (!sid) return;
    const souls = readSouls();
    const mine = Object.values(souls).some((meta) => meta.session === sid || meta.sessionId === sid);
    if (mine) return;
    // try the pool in order, first free name wins
    for (const candidate of SOUL_POOL) {
      if (candidate === "grave") continue; // reserved for the human
      const path = soulFileName(candidate);
      if (existsSync(path)) continue;
      if (claimSoul(candidate, ctx).ok) {
        try { pi.setSessionName(candidate); } catch { /* optional */ }
        setKittyTabTitle(candidate);
        try { ctx.ui.notify(`Soul: ${candidate} (claim another with /soul <name>)`, "info"); } catch { /* no UI */ }
        return;
      }
    }
  });

  // ---- /souls command: list all souls + their project familiarity ------
  pi.registerCommand("souls", {
    description: "List all agent souls and their project familiarity. /souls <project> filters.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const souls = readSouls();
      const filter = args.trim().toLowerCase();
      let lines: string[] = [];
      if (Object.keys(souls).length === 0) {
        lines.push("(no souls claimed yet — agents claim via /soul <name>)");
      }
      for (const [name, meta] of Object.entries(souls).sort()) {
        if (filter && !name.includes(filter) &&
            !(meta.specialty || "").toLowerCase().includes(filter) &&
            !Object.keys(meta.projects || {}).some((k) => k.includes(filter))) continue;
        const projects = Object.entries(meta.projects || {})
          .sort((a, b) => (meta.projectLastSeen?.[b[0]] || "").localeCompare(meta.projectLastSeen?.[a[0]] || ""))
          .slice(0, 6)
          .map(([k, sids]) => `${k} (${sids.length})`)
          .join(", ");
        lines.push(`${name}${meta.role ? " [" + meta.role + "]" : ""}${meta.specialty ? " — " + meta.specialty : ""}`);
        if (projects) lines.push(`    projects: ${projects}`);
      }
      ctx.ui.notify(lines.slice(0, 12).join("\n") || "(no souls)", "info");
    },
  });

  // ---- /chat command -------------------------------------------------
  pi.registerCommand("chat", {
    description: "Open the shared agent chat log panel. /chat off closes.",
    getArgumentCompletions: (prefix: string) => {
      const args = ["off"].filter((a) => a.startsWith(prefix.toLowerCase()));
      return args.map((a) => ({ value: a, label: a }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim().toLowerCase() === "off") {
        // can't force-close a custom panel; just notify
        ctx.ui.notify("Close the chat panel with q or Esc", "info");
        return;
      }
      await openPanel(ctx);
    },
  });

  // ---- hotkey --------------------------------------------------------
  pi.registerShortcut("ctrl+alt+g", {
    description: "Toggle the shared agent chat panel",
    handler: async (ctx: ExtensionCommandContext) => { await openPanel(ctx); },
  });
}

