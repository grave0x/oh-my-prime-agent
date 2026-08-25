/**
 * ompa-tui — modular in-TUI dashboard for ompa.
 *
 * A panel-registry TUI: panels are small modules that return fresh lines on
 * demand; the dashboard composes them behind a tab bar. Everything re-reads
 * its config/data on every refresh, so a `/reload` (or config edit + reload)
 * is picked up immediately — panels are rebuilt on `session_start` (reason
 * includes "reload") and the widget is disposed on `session_shutdown`.
 *
 *   /dashboard  (alias /ompa)   open the full dashboard overlay
 *   ctrl+alt+o                  toggle the dashboard
 *   /ompa widget on|off         toggle the compact status widget
 *
 * Keys inside the dashboard: ←→/Tab switch panels · ↑↓ scroll · r refresh
 * · q/Esc close
 *
 * Panels (configurable via ompr.toml [tui] panels = [...]):
 *   resource  live load/mem/swap + resource-guard event tail
 *   chat      tail of the global agent chat log
 *   notifs    tail of the terminal-notif log (ACTION items marked)
 *   souls     soul registry + project familiarity
 *   fleet     fleet run log + queue (when present)
 *   profile   self-profiler distilled profile + refine hints
 *   help      key reference
 *
 * The compact status widget (`statusWidget = true`) shows a one-line
 * dashboard above the editor: load/mem/swap + chat/notif/soul/profile counts.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const OMPA_ROOT = join(homedir(), ".prime", "oh-my-prime-agent");
const OMPR_TOML = join(OMPA_ROOT, "ompr.toml");
const POLICY = join(homedir(), ".prime", "agent", "resource-policy.json");
const CHAT_LOG = join(homedir(), ".local", "state", "agent-chat", "chat.jsonl");
const NOTIF_LOG = join(homedir(), ".local", "state", "terminal-notif", "notif.log");
const SOULS_DIR = join(homedir(), ".prime", "agent", "souls");
const FLEET_RUNS = join(homedir(), ".local", "state", "fleet", "runs.jsonl");
const FLEET_QUEUE = join(homedir(), ".local", "state", "fleet", "queue.json");
const PROFILE_DISTILLED = join(homedir(), ".local", "state", "ompa", "profile-distilled.json");

const DEFAULT_PANELS = ["resource", "chat", "notifs", "souls", "fleet", "profile", "upstream", "help"];
const WIDGET_KEY = "ompa-status";
const PANEL_TITLES: Record<string, string> = {
  resource: "Resource",
  chat: "Chat",
  notifs: "Notifications",
  souls: "Souls",
  fleet: "Fleet",
  profile: "Profile",
  upstream: "Upstream",
  help: "Help",
};

interface TuiConfig {
  panels: string[];
  refreshMs: number;
  statusWidget: boolean;
  statusRefreshMs: number;
}

const DEFAULT_CONFIG: TuiConfig = {
  panels: DEFAULT_PANELS,
  refreshMs: 2000,
  statusWidget: true,
  statusRefreshMs: 5000,
};

/** Minimal [tui] section reader — mirrors the tiny toml_get in bin/ompa. */
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

function tomlArray(section: string, key: string): string[] | undefined {
  for (const line of tomlSection(section)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`));
    if (m) {
      return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    }
  }
  return undefined;
}

function tomlBool(section: string, key: string, dflt: boolean): boolean {
  for (const line of tomlSection(section)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`));
    if (m) return m[1] === "true";
  }
  return dflt;
}

function tomlInt(section: string, key: string, dflt: number): number {
  for (const line of tomlSection(section)) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`));
    if (m) return parseInt(m[1], 10);
  }
  return dflt;
}

function loadTuiConfig(): TuiConfig {
  const panels = tomlArray("tui", "panels");
  return {
    panels: panels && panels.length ? panels : DEFAULT_CONFIG.panels,
    refreshMs: tomlInt("tui", "refreshMs", DEFAULT_CONFIG.refreshMs),
    statusWidget: tomlBool("tui", "statusWidget", DEFAULT_CONFIG.statusWidget),
    statusRefreshMs: tomlInt("tui", "statusRefreshMs", DEFAULT_CONFIG.statusRefreshMs),
  };
}

/* ======================================================================
 * UPSTREAM DRIFT WATCHER — "my priv builds vs upstreams"
 *
 * Same engine as the pi-side omp.ts port; shared config + state:
 * ~/.omp/upstream-watch.json. Checks the user's private builds (forks /
 * pinned installs / omp plugin pins) against upstreams; when a build lags
 * behind, notifies at higher priority (warning) and — deduped — files a
 * GitHub issue via the `gh` CLI. Env: OMP_WATCH=0|1,
 * OMP_WATCH_INTERVAL_HOURS.
 * ====================================================================== */

const UPSTREAM_WATCH_PATH = join(homedir(), ".omp", "upstream-watch.json");

interface WatchBuild {
  name: string;
  kind?: "git" | "npm" | "omp-plugins";
  local?: string;
  repo?: string;
  upstream?: string;
  branch?: string;
  npm?: string;
  installed?: string[];
}

interface WatchState {
  lastCheck?: string;
  builds?: Record<string, { lastUpstream?: string; lastNotified?: string; issueUrl?: string; issueError?: string }>;
}

interface WatchConfig {
  enabled: boolean;
  intervalHours: number;
  issueOnLag: boolean;
  githubUser: string;
  notifyLevel: string;
  builds: WatchBuild[];
  _state?: WatchState;
}

interface Drift {
  kind: string;
  name: string;
  behind: number;
  detail: string;
  sample: string[];
  upstreamRef: string;
  target: string;
}

const WATCH_DEFAULTS: WatchConfig = {
  enabled: true,
  intervalHours: 6,
  issueOnLag: true,
  githubUser: "grave0x",
  notifyLevel: "warning",
  builds: [
    {
      name: "pi",
      local: "~/Projects/04-llm/pi-modded",
      repo: "grave0x/oh-my-prime-agent", // grave0x/pi has issues disabled
      upstream: "earendil-works/pi",
      branch: "main",
      npm: "@earendil-works/pi-coding-agent",
    },
    {
      name: "prime-agent",
      repo: "grave0x/oh-my-prime-agent",
      npm: "prime-agent",
      installed: [
        "~/.npm-global/lib/node_modules/prime-agent/package.json",
        "~/.local/lib/node_modules/prime-agent/package.json",
      ],
    },
    { name: "omp", kind: "omp-plugins" },
  ],
};

function watchReadJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

function loadWatchConfig(): WatchConfig {
  const cfg: WatchConfig = JSON.parse(JSON.stringify(WATCH_DEFAULTS));
  const file = (watchReadJson(UPSTREAM_WATCH_PATH) ?? {}) as Record<string, unknown>;
  if (typeof file.enabled === "boolean") cfg.enabled = file.enabled;
  if (typeof file.intervalHours === "number") cfg.intervalHours = file.intervalHours;
  if (typeof file.issueOnLag === "boolean") cfg.issueOnLag = file.issueOnLag;
  if (typeof file.githubUser === "string") cfg.githubUser = file.githubUser;
  if (typeof file.notifyLevel === "string") cfg.notifyLevel = file.notifyLevel;
  if (Array.isArray(file.builds)) cfg.builds = file.builds.filter((b): b is WatchBuild => !!b && typeof (b as any).name === "string");
  if (file._state && typeof file._state === "object") cfg._state = file._state as WatchState;
  const env = process.env;
  if (env.OMP_WATCH === "0" || env.OMP_WATCH === "false") cfg.enabled = false;
  else if (env.OMP_WATCH === "1" || env.OMP_WATCH === "true") cfg.enabled = true;
  const ih = Number(env.OMP_WATCH_INTERVAL_HOURS);
  if (Number.isFinite(ih) && ih > 0) cfg.intervalHours = ih;
  return cfg;
}

function saveWatchState(cfg: WatchConfig): void {
  try {
    mkdirSync(dirname(UPSTREAM_WATCH_PATH), { recursive: true });
    writeFileSync(UPSTREAM_WATCH_PATH, JSON.stringify({ ...cfg, _state: cfg._state }, null, 2));
  } catch {
    /* best effort */
  }
}

function runCmd(cmd: string, args: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout || "").trim(), err: String(stderr || "").trim() });
    });
  });
}

function upstreamRef(ref: string): string {
  if (ref.includes("://") || ref.includes("@")) return ref;
  if (ref.includes("/")) return `https://github.com/${ref}.git`;
  return ref;
}

async function checkGitBuild(b: WatchBuild): Promise<Drift | null> {
  const local = expandHome(b.local || "");
  const upstream = b.upstream || "";
  if (!local || !upstream) return null;
  const branch = b.branch || "main";
  const f = await runCmd("git", ["-C", local, "fetch", "--quiet", upstreamRef(upstream), branch], 45000);
  if (!f.ok) return null;
  const behind = await runCmd("git", ["-C", local, "rev-list", "--count", "HEAD..FETCH_HEAD"], 15000);
  if (!behind.ok) return null;
  const n = parseInt(behind.out || "0", 10) || 0;
  if (n <= 0) return null;
  const localHead = (await runCmd("git", ["-C", local, "rev-parse", "--short", "HEAD"], 10000)).out || "?";
  const upHead = (await runCmd("git", ["-C", local, "rev-parse", "--short", "FETCH_HEAD"], 10000)).out || "?";
  const log = await runCmd("git", ["-C", local, "log", "--oneline", "-n 15", "HEAD..FETCH_HEAD"], 15000);
  return {
    kind: "git",
    name: b.name,
    behind: n,
    detail: `${localHead} → ${upHead}`,
    sample: log.out.split("\n").filter(Boolean).slice(0, 15),
    upstreamRef: upHead,
    target: upstream,
  };
}

async function installedVersion(b: WatchBuild): Promise<string | null> {
  for (const p of b.installed || []) {
    try {
      const j = JSON.parse(readFileSync(expandHome(p), "utf8"));
      if (j && typeof j.version === "string") return j.version;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function checkNpmBuild(b: WatchBuild): Promise<Drift | null> {
  const pkg = b.npm || "";
  if (!pkg) return null;
  const latest = await runCmd("npm", ["view", pkg, "version"], 30000);
  if (!latest.ok) return null;
  const latestV = latest.out.trim();
  const installed = await installedVersion(b);
  if (!installed || installed === latestV) return null;
  return {
    kind: "npm",
    name: b.name,
    behind: 1,
    detail: `${installed} → ${latestV}`,
    sample: [],
    upstreamRef: latestV,
    target: `npm:${pkg}`,
  };
}

async function checkOmpPlugins(): Promise<Drift | null> {
  const lockPath = join(homedir(), ".omp", "plugins", "omp-plugins.lock.json");
  const lock = (await watchReadJson(lockPath)) as { plugins?: Record<string, { version?: string }> } | null;
  if (!lock?.plugins) return null;
  const installed = lock.plugins;
  const cacheRoot = join(homedir(), ".omp", "plugins", "cache", "marketplaces");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(cacheRoot);
  } catch {
    return null;
  }
  const catalog: Record<string, string> = {};
  for (const d of dirs) {
    const mp = (await watchReadJson(join(cacheRoot, d, "marketplace.json"))) as { plugins?: Array<{ name?: string; version?: string }> } | null;
    for (const p of mp?.plugins ?? []) {
      if (p?.name && p?.version) catalog[p.name] = p.version;
    }
  }
  const drift: string[] = [];
  for (const [name, pin] of Object.entries(installed)) {
    const latest = catalog[name];
    if (!latest) continue;
    if (String(pin?.version || "") !== latest) drift.push(`${name} ${pin?.version || "?"} → ${latest}`);
  }
  if (!drift.length) return null;
  return {
    kind: "omp-plugins",
    name: "omp",
    behind: drift.length,
    detail: `${drift.length} plugin(s) behind marketplace catalog`,
    sample: drift.slice(0, 15),
    upstreamRef: drift[0] || "",
    target: "anthropics plugin marketplaces",
  };
}

async function checkBuild(b: WatchBuild): Promise<Drift | null> {
  if (b.kind === "omp-plugins") return checkOmpPlugins();
  if (b.local || b.upstream) {
    const git = await checkGitBuild(b);
    if (git) return git;
  }
  if (b.npm) return checkNpmBuild(b);
  return null;
}

async function fileLagIssue(cfg: WatchConfig, b: WatchBuild, d: Drift): Promise<void> {
  if (!cfg.issueOnLag || !b.repo) return;
  const builds = (cfg._state || (cfg._state = {})).builds || (cfg._state.builds = {});
  const st = builds[b.name] || (builds[b.name] = {});
  if (st.lastUpstream === d.upstreamRef) return;
  const title = `[upstream-drift] ${b.name} behind ${d.target} (${d.detail})`;
  const list = await runCmd("gh", ["issue", "list", "-R", b.repo, "--state", "open", "--search", `\"upstream-drift ${b.name}\" in:title`], 30000);
  if (list.ok && /upstream-drift/i.test(list.out) && /\d+/.test(list.out)) {
    st.lastUpstream = d.upstreamRef;
    saveWatchState(cfg);
    return;
  }
  const body = [
    `**Build:** ${b.name}`,
    `**Lag:** ${d.behind} ${d.kind === "npm" ? "version(s)" : "commit(s)"} behind upstream (${d.target})`,
    "",
    `**Detail:** ${d.detail}`,
    d.sample.length ? `\nUpstream changes (top ${d.sample.length}):\n\`\`\`\n${d.sample.join("\n")}\n\`\`\`` : "",
    "",
    "Auto-filed by the omp/ompa upstream-drift watcher. Status: `/omp-upstream` (pi) or `/ompa upstream` (prime-agent).",
  ].join("\n");
  const create = await runCmd("gh", ["issue", "create", "-R", b.repo, "--title", title, "--body", body], 30000);
  st.lastUpstream = d.upstreamRef;
  if (create.ok) {
    st.issueUrl = create.out.trim() || undefined;
    delete st.issueError;
  } else {
    st.issueError = (create.err || "gh failed").slice(0, 160);
  }
  saveWatchState(cfg);
}

type WatchNotifier = (title: string, body: string, level: string) => void;

async function runUpstreamWatch(notify: WatchNotifier): Promise<{ report: string; lagging: { build: WatchBuild; drift: Drift }[] }> {
  const cfg = loadWatchConfig();
  const lagging: { build: WatchBuild; drift: Drift }[] = [];
  for (const b of cfg.builds) {
    const drift = await checkBuild(b);
    if (!drift) continue;
    lagging.push({ build: b, drift });
    await fileLagIssue(cfg, b, drift);
    const builds = (cfg._state || (cfg._state = {})).builds || (cfg._state.builds = {});
    const st = builds[b.name] || (builds[b.name] = {});
    if (st.lastNotified !== drift.upstreamRef) {
      notify(
        `⚠ upstream lag: ${b.name}`,
        `${drift.behind} ${drift.kind === "npm" ? "version(s)" : "commit(s)"} behind ${drift.target} · ${drift.detail}`,
        cfg.notifyLevel,
      );
      st.lastNotified = drift.upstreamRef;
      saveWatchState(cfg);
    }
  }
  cfg._state!.lastCheck = new Date().toISOString();
  saveWatchState(cfg);
  return { report: formatWatchReport(cfg, lagging), lagging };
}

function formatWatchReport(cfg: WatchConfig, lagging: { build: WatchBuild; drift: Drift }[]): string {
  const lines: string[] = [];
  lines.push("# OMP upstream drift watch");
  lines.push("");
  lines.push(`- enabled: ${cfg.enabled} · interval: ${cfg.intervalHours}h · issues: ${cfg.issueOnLag ? "on" : "off"} (${cfg.githubUser})`);
  lines.push(`- last check: ${cfg._state?.lastCheck ?? "never"}`);
  lines.push("");
  if (!lagging.length) {
    lines.push("No drift detected — all tracked builds are current.");
    return lines.join("\n");
  }
  lines.push(`## Lagging (${lagging.length})`);
  for (const { build, drift } of lagging) {
    lines.push(`- **${build.name}**: ${drift.behind} ${drift.kind === "npm" ? "version(s)" : "commit(s)"} behind ${drift.target} (${drift.detail})`);
    for (const s of drift.sample.slice(0, 8)) lines.push(`    ${s}`);
    const st = (cfg._state?.builds || {})[build.name];
    if (st?.issueUrl) lines.push(`    issue: ${st.issueUrl}`);
    if (st?.issueError) lines.push(`    issue filing failed: ${st.issueError}`);
  }
  lines.push("");
  lines.push(`Tracked: ${cfg.builds.map((b) => b.name).join(", ")}`);
  lines.push("Config: ~/.omp/upstream-watch.json (env OMP_WATCH / OMP_WATCH_INTERVAL_HOURS)");
  return lines.join("\n");
}

/* ---- scheduler (module state shared across panels/commands/hooks) ---- */
let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchRunning = false;
let lastWatchReport: string = "(upstream watch not run yet — run `/ompa upstream`)";
let watchCtx: any = null;

async function runUpstreamWatchSafely(notify: WatchNotifier): Promise<void> {
  if (watchRunning) return;
  watchRunning = true;
  try {
    const r = await runUpstreamWatch(notify);
    lastWatchReport = r.report;
  } catch {
    /* never break the harness */
  } finally {
    watchRunning = false;
  }
}

function startUpstreamWatch(): void {
  const cfg = loadWatchConfig();
  if (!cfg.enabled) return;
  const intervalMs = Math.max(1, cfg.intervalHours) * 3600 * 1000;
  const last = cfg._state?.lastCheck ? Date.parse(cfg._state.lastCheck) : 0;
  const stale = !last || Number.isNaN(last) || Date.now() - last > intervalMs;
  const notifier: WatchNotifier = (title, body, level) => {
    try {
      watchCtx?.ui?.notify?.(`${title} — ${body}`, level);
    } catch {
      /* ignore */
    }
  };
  if (stale) void runUpstreamWatchSafely(notifier);
  if (watchTimer) return;
  watchTimer = setInterval(() => void runUpstreamWatchSafely(notifier), intervalMs);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** F3: strip ANSI/CSI escapes + control chars before rendering. */
function sanitizeTerminal(s: string): string {
  return (s || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[()#][0-9A-Za-z]?/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

function readTail(path: string, max: number): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return raw.slice(-max);
  } catch { return []; }
}

interface JsonRecord { [k: string]: unknown; }

function tailJson(path: string, max: number): JsonRecord[] {
  return readTail(path, max)
    .map((l) => { try { return JSON.parse(l) as JsonRecord; } catch { return null; } })
    .filter((e): e is JsonRecord => e !== null);
}

function systemStats(): { load1: number; memAvailMB: number; swapUsedMB: number } {
  try {
    const load = parseFloat(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) || 0;
    const mem = readFileSync("/proc/meminfo", "utf8");
    const g = (key: string) => {
      const m = mem.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? parseInt(m[1], 10) : 0;
    };
    return {
      load1: load,
      memAvailMB: Math.round(g("MemAvailable") / 1024),
      swapUsedMB: Math.round((g("SwapTotal") - g("SwapFree")) / 1024),
    };
  } catch {
    return { load1: 0, memAvailMB: 0, swapUsedMB: 0 };
  }
}

function readPolicy(): { maxLoad1: number; minMemAvailMB: number; maxSwapUsedMB: number } {
  try {
    const p = JSON.parse(readFileSync(POLICY, "utf8"));
    return {
      maxLoad1: p.maxLoad1 ?? 9,
      minMemAvailMB: p.minMemAvailMB ?? 1200,
      maxSwapUsedMB: p.maxSwapUsedMB ?? 8000,
    };
  } catch {
    return { maxLoad1: 9, minMemAvailMB: 1200, maxSwapUsedMB: 8000 };
  }
}

/* ------------------------------------------------------------------ */
/* Panel definitions                                                   */
/* ------------------------------------------------------------------ */

interface PanelDef {
  id: string;
  title: string;
  refresh(): string[];
}

function resourcePanel(): PanelDef {
  return {
    id: "resource",
    title: PANEL_TITLES.resource,
    refresh() {
      const s = systemStats();
      const p = readPolicy();
      const guard = tailJson(join(homedir(), ".local", "state", "resource-guard", "usage.jsonl"), 5)
        .map((e) => `  ${String(e.ts || "").slice(11, 19)} ${String(e.action)} load=${e.load1} mem=${e.memAvailMB}MB`);
      const lines = [
        `load1 = ${s.load1.toFixed(2)}  (max ${p.maxLoad1})`,
        `memAvailable = ${s.memAvailMB} MB  (min ${p.minMemAvailMB})`,
        `swapUsed = ${s.swapUsedMB} MB  (max ${p.maxSwapUsedMB})`,
        "",
        "resource-guard events:",
        ...(guard.length ? guard : ["  (none yet)"]),
      ];
      return lines;
    },
  };
}

function chatPanel(): PanelDef {
  return {
    id: "chat",
    title: PANEL_TITLES.chat,
    refresh() {
      const entries = tailJson(CHAT_LOG, 24);
      if (!entries.length) return ["(no chat yet — try `:: hello` or `:name: hi`)"];
      return entries.reverse().map((e) => {
        const from = String(e.fromName || e.from || "?");
        const to = e.to && e.to !== "*" ? ` →${String(e.to).slice(0, 10)}` : "";
        const room = e.room && e.room !== "global" ? ` #${e.room}` : "";
        const text = sanitizeTerminal(String(e.text || ""));
        return `[${String(e.ts || "").slice(11, 19)}] ${from}${to}${room}: ${text}`;
      });
    },
  };
}

function notifsPanel(): PanelDef {
  return {
    id: "notifs",
    title: PANEL_TITLES.notifs,
    refresh() {
      const entries = tailJson(NOTIF_LOG, 24);
      if (!entries.length) return ["(no notifications yet)"];
      return entries.reverse().map((e) => {
        const title = sanitizeTerminal(String(e.title || ""));
        const body = sanitizeTerminal(String(e.body || ""));
        const lvl = String(e.level || "info");
        const act = /ACTION/.test((title + " " + body).toUpperCase()) || lvl === "error" ? "⚠ " : "  ";
        return `${act}[${String(e.ts || "").slice(11, 19)}] (${lvl}) ${title}${body ? " — " + body : ""}`;
      });
    },
  };
}

function soulsPanel(): PanelDef {
  return {
    id: "souls",
    title: PANEL_TITLES.souls,
    refresh() {
      if (!existsSync(SOULS_DIR)) return ["(no souls dir yet)"];
      const out: string[] = [];
      try {
        for (const f of readdirSync(SOULS_DIR)) {
          if (!f.endsWith(".soul.md")) continue;
          const name = f.slice(0, -".soul.md".length);
          const raw = readFileSync(join(SOULS_DIR, f), "utf8");
          const m = raw.match(/^---\n([\s\S]*?)\n---/);
          const meta: Record<string, string> = {};
          if (m) {
            for (const ln of m[1].split("\n")) {
              const kv = ln.match(/^([a-zA-Z_]+):\s*(.*)$/);
              if (kv) meta[kv[1]] = kv[2];
            }
          }
          const role = meta.role ? ` [${meta.role}]` : "";
          const spec = meta.specialty ? ` — ${meta.specialty.slice(0, 60)}` : "";
          out.push(`${name}${role}${spec}`);
        }
      } catch { /* ignore */ }
      return out.length ? out : ["(no souls claimed yet — /soul <name>)"];
    },
  };
}

function fleetPanel(): PanelDef {
  return {
    id: "fleet",
    title: PANEL_TITLES.fleet,
    refresh() {
      const lines: string[] = [];
      const runs = tailJson(FLEET_RUNS, 8);
      if (existsSync(FLEET_QUEUE)) {
        try {
          const q = JSON.parse(readFileSync(FLEET_QUEUE, "utf8"));
          const items = Array.isArray(q) ? q : [];
          lines.push(`queue: ${items.length} waiting`);
        } catch { lines.push("queue: unreadable"); }
      }
      if (runs.length) {
        lines.push("recent runs:");
        for (const r of runs) {
          lines.push(`  ${String(r.ts || "").slice(11, 19)} ${String(r.id || "").slice(0, 8)} ${String(r.status || "")}`);
        }
      } else {
        lines.push("(fleet log empty — subagent runs appear here)");
      }
      return lines;
    },
  };
}

function profilePanel(): PanelDef {
  return {
    id: "profile",
    title: PANEL_TITLES.profile,
    refresh() {
      if (!existsSync(PROFILE_DISTILLED)) return ["(no profile yet — the self-profiler plugin fills this)"];
      try {
        const d = JSON.parse(readFileSync(PROFILE_DISTILLED, "utf8"));
        const lines = [`turns=${d.turns}  avgTurn=${Math.round((d.avgTurnMs || 0) / 1000)}s  holds=${d.holds || 0}`];
        const tools = Object.entries(d.tools || {}).sort((a: any, b: any) => b[1].totalMs - a[1].totalMs) as Array<[string, any]>;
        if (tools.length) {
          lines.push("tools:");
          for (const [t, a] of tools.slice(0, 6)) {
            lines.push(`  ${t}: ${a.count}x avg ${Math.round(a.totalMs / Math.max(1, a.count) / 1000)}s${a.errors ? ` ERR${a.errors}` : ""}`);
          }
        }
        const hints = d.refineHints || [];
        if (hints.length) {
          lines.push("refine hints:");
          for (const h of hints.slice(0, 4)) lines.push("  • " + h);
        }
        return lines;
      } catch {
        return ["(profile unreadable)"];
      }
    },
  };
}

function upstreamPanel(): PanelDef {
  return {
    id: "upstream",
    title: PANEL_TITLES.upstream,
    refresh() {
      const head = lastWatchReport.split("\n");
      const body = lastWatchReport.startsWith("# OMP") ? head.slice(2) : head;
      const lines: string[] = [];
      for (const line of body.slice(0, 26)) lines.push(sanitizeTerminal(line));
      if (body.length > 26) lines.push(`… ${body.length - 26} more`);
      lines.push("");
      lines.push("`/ompa upstream` to check now · auto-checks every interval (default 6h) · issues filed on lag");
      return lines;
    },
  };
}

function helpPanel(): PanelDef {
  return {
    id: "help",
    title: PANEL_TITLES.help,
    refresh() {
      return [
        "dashboard keys:",
        "  ← → or Tab   switch panel",
        "  ↑ ↓          scroll",
        "  r            refresh now",
        "  q / Esc      close",
        "",
        "ompa commands:",
        "  /dashboard   open this dashboard",
        "  /ompa widget on|off   status widget",
        "  /resource    resource-guard details",
        "  /profile     self-profiler + refine hints",
        "  /chat /notifs   legacy single panels",
        "",
        "config: ompr.toml [tui] panels = [...] · refreshMs · statusWidget",
        "reload: edit ompr.toml, then /reload — the dashboard rebuilds.",
      ];
    },
  };
}

function buildPanels(cfg: TuiConfig): PanelDef[] {
  const all: Record<string, () => PanelDef> = {
    resource: resourcePanel,
    chat: chatPanel,
    notifs: notifsPanel,
    souls: soulsPanel,
    fleet: fleetPanel,
    profile: profilePanel,
    upstream: upstreamPanel,
    help: helpPanel,
  };
  const out: PanelDef[] = [];
  for (const id of cfg.panels) {
    const f = all[id];
    if (f) out.push(f());
  }
  if (!out.some((p) => p.id === "help")) out.push(helpPanel());
  return out;
}

/* ------------------------------------------------------------------ */
/* Dashboard overlay                                                   */
/* ------------------------------------------------------------------ */

class DashboardView extends Container {
  private panels: PanelDef[];
  private active = 0;
  private scroll = 0;
  private lines: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private tui: any,
    private theme: any,
    private refreshMs: number,
    private done: (r: null) => void,
    panels: PanelDef[],
  ) {
    super();
    this.panels = panels;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), refreshMs);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private refresh(): void {
    try { this.lines = this.panels[this.active]?.refresh() ?? []; } catch { this.lines = ["(panel error)"]; }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") { this.done(null); return; }
    if (data === "r" || data === "R") { this.refresh(); return; }
    if (data === "\t" || matchesKey(data, Key.right)) {
      this.active = (this.active + 1) % this.panels.length;
      this.scroll = 0;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.active = (this.active - 1 + this.panels.length) % this.panels.length;
      this.scroll = 0;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up)) { this.scroll = Math.max(0, this.scroll - 1); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.scroll = Math.min(Math.max(0, this.lines.length - 1), this.scroll + 1); this.tui.requestRender(); return; }
  }

  render(width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    const tabs = this.panels.map((p, i) => (i === this.active ? t.fg("accent", `[${p.title}]`) : t.fg("dim", p.title))).join(" ");
    out.push(t.fg("accent", "== OMPA DASHBOARD ==") + "  " + tabs);
    out.push(t.fg("dim", "-".repeat(Math.min(width, 72))));
    const lines = this.lines.slice(this.scroll);
    for (const line of lines.slice(0, 40)) {
      out.push(t.fg("neutral", truncateToWidth(sanitizeTerminal(line), Math.max(12, width - 4))));
    }
    out.push(t.fg("dim", "-".repeat(Math.min(width, 72))));
    out.push(t.fg("muted", "←→/Tab switch · ↑↓ scroll · r refresh · q close"));
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Compact status widget                                               */
/* ------------------------------------------------------------------ */

class StatusWidget extends Container {
  private timer: ReturnType<typeof setInterval> | null = null;
  private line = "";

  constructor(private tui: any, private theme: any, refreshMs: number) {
    super();
    this.tick();
    this.timer = setInterval(() => this.tick(), refreshMs);
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); }

  private tick(): void {
    try {
      const s = systemStats();
      const p = readPolicy();
      const chat = tailJson(CHAT_LOG, 999).length;
      const notifs = tailJson(NOTIF_LOG, 999);
      const action = notifs.filter((e) => /ACTION/.test(((e.title || "") + " " + (e.body || "")).toUpperCase()) || e.level === "error").length;
      const prof = existsSync(PROFILE_DISTILLED) ? (JSON.parse(readFileSync(PROFILE_DISTILLED, "utf8")) as any) : null;
      const calls = prof?.tools ? Object.values(prof.tools as Record<string, any>).reduce((a: number, t: any) => a + (t.count || 0), 0) : 0;
      this.line = `⚡ load ${s.load1.toFixed(1)}/${p.maxLoad1} · mem ${(s.memAvailMB / 1024).toFixed(1)}GB · swap ${(s.swapUsedMB / 1024).toFixed(1)}GB  |  💬 chat ${chat}  ⚑ action ${action}  🛠 tools ${calls}`;
    } catch {
      this.line = "⚡ ompa status unavailable";
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const t = this.theme;
    return [t.fg("dim", truncateToWidth(this.line, Math.max(12, width - 2)))];
  }
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

let dashboardOpen = false;

function openDashboard(ctx: any, cfg: TuiConfig): Promise<void> {
  if (dashboardOpen) return Promise.resolve();
  dashboardOpen = true;
  const panels = buildPanels(cfg);
  return ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (r: null) => void) => new DashboardView(tui, theme, cfg.refreshMs, done, panels),
    {
      overlay: true,
      overlayOptions: {
        anchor: "right-center",
        width: "54%",
        minWidth: 60,
        maxHeight: "82%",
        margin: { top: 1, right: 0, bottom: 1, left: 1 },
      },
      onHandle: () => {},
    },
  ).catch(() => { /* panel failed */ }).finally(() => { dashboardOpen = false; });
}

function setStatusWidget(ctx: any, cfg: TuiConfig): void {
  try {
    if (!cfg.statusWidget) { ctx.ui.setWidget(WIDGET_KEY, undefined); return; }
    ctx.ui.setWidget(WIDGET_KEY, (tui: any, theme: any) => new StatusWidget(tui, theme, cfg.statusRefreshMs), {
      placement: "aboveEditor",
    });
  } catch { /* widget is best-effort */ }
}

export default function ompaTui(pi: ExtensionAPI): void {
  // Rebuild on every session start (startup AND reload) so config edits take
  // effect without restarting prime-agent: this is the "updates on reload" bit.
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    const cfg = loadTuiConfig();
    if (ctx.hasUI) setStatusWidget(ctx, cfg);
    watchCtx = ctx;
    startUpstreamWatch();
  });

  // Tear down cleanly on reload / quit / session switch: no leaked timers.
  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    try { if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined); } catch { /* ignore */ }
  });

  pi.registerCommand("dashboard", {
    description: "Open the modular ompa dashboard (resource/chat/notifs/souls/fleet/profile).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await openDashboard(ctx, loadTuiConfig());
    },
  });

  pi.registerCommand("ompa", {
    description: "ompa dashboard + widget + upstream-drift control. /ompa opens the dashboard; /ompa widget on|off toggles the status widget; /ompa upstream checks private builds vs upstreams now (notify + file issues on lag).",
    getArgumentCompletions: (prefix: string) => {
      const args = ["widget on", "widget off", "upstream"].filter((a) => a.startsWith(prefix.toLowerCase()));
      return args.map((a) => ({ value: a, label: a }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim().toLowerCase();
      if (arg.startsWith("widget")) {
        const on = arg === "widget on";
        const cfg = loadTuiConfig();
        cfg.statusWidget = on;
        setStatusWidget(ctx, cfg);
        ctx.ui.notify(on ? "status widget on" : "status widget off", "success");
        return;
      }
      if (arg === "upstream") {
        const notify: WatchNotifier = (title, body, level) => ctx.ui.notify(`${title} — ${body}`, level);
        await runUpstreamWatchSafely(notify);
        process.stdout.write(lastWatchReport + "\n");
        return;
      }
      await openDashboard(ctx, loadTuiConfig());
    },
  });

  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle the ompa dashboard",
    handler: async (ctx: ExtensionContext) => { await openDashboard(ctx, loadTuiConfig()); },
  });
}
