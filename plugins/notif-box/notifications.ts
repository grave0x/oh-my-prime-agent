/**
 * Notifications — in-TUI notification log panel (no separate window).
 *
 * Usage:
 *   /notifs          open the right-side notifications panel
 *   /notifs off      close it
 *   ctrl+alt+n       toggle the panel
 *
 * Reads ~/.local/state/terminal-notif/notif.log (JSONL written by the
 * terminal_notif skill). Entries whose title/body contains "ACTION" or
 * level=warn/error are marked [ACTION NEEDED] and bell the terminal when they
 * arrive while this panel is closed.
 *
 * Keys: ↑↓ scroll · q/esc close
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const LOG = join(homedir(), ".local", "state", "terminal-notif", "notif.log");
const MAX_ENTRIES = 40;
const REFRESH_MS = 2000;
const LEVEL_THEME: Record<string, string> = { info: "info", warn: "warning", error: "error", ok: "success" };

interface NotifEntry { ts?: string; title?: string; body?: string; level?: string; }

let panelActive = false;

function readEntries(): NotifEntry[] {
  if (!existsSync(LOG)) return [];
  try {
    const raw = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
    const out: NotifEntry[] = [];
    for (const line of raw.slice(-MAX_ENTRIES)) {
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  } catch { return []; }
}

function needsAction(e: NotifEntry): boolean {
  const hay = ((e.title || "") + " " + (e.body || "")).toUpperCase();
  return hay.includes("ACTION") || e.level === "error";
}

class NotifsView extends Container {
  private entries: NotifEntry[] = [];
  private sel = 0;
  private lastMtime = 0;
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
    const changed = entries.length !== this.lastCount;
    const act = entries.some((e) => needsAction(e) && (e.ts || "") !== this.entries.find((x) => x.ts === e.ts)?.ts);
    if (changed || act) {
      this.lastCount = entries.length;
      this.entries = entries;
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
    const actionCount = this.entries.filter(needsAction).length;
    lines.push(t.fg("warning", `== NOTIFICATIONS ==  (${this.entries.length} · ${actionCount} action)`));
    lines.push(t.fg("dim", "-".repeat(Math.min(width, 48))));
    if (this.entries.length === 0) {
      lines.push(t.fg("muted", "(no notifications yet)"));
    }
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const lvl = LEVEL_THEME[e.level || "info"] || "info";
      const marker = needsAction(e) ? t.fg("error", "⚠ ") : "  ";
      const ts = (e.ts || "").padEnd(8);
      const title = truncateToWidth(e.title || "", Math.max(10, width - 30));
      const body = truncateToWidth(e.body || "", Math.max(10, width - 30));
      const selMark = i === this.sel ? "»" : " ";
      lines.push(`${selMark} ${marker}${t.fg(lvl, ts)} ${t.fg("neutral", title)}`);
      if (body) lines.push(`  ${t.fg("muted", body)}`);
    }
    lines.push(t.fg("dim", "-".repeat(Math.min(width, 48))));
    lines.push(t.fg("muted", "↑↓ scroll · r refresh · q close"));
    return lines;
  }
}

export default function notificationsExtension(pi: ExtensionAPI): void {
  const openPanel = async (ctx: any) => {
    if (panelActive) { return; }
    panelActive = true;
    try {
      await ctx.ui.custom(
        (tui: any, theme: any, _kb: any, done: (r: null) => void) => new NotifsView(tui, theme, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "34%",
            minWidth: 40,
            margin: { top: 1, right: 0, bottom: 1, left: 1 },
          },
          onHandle: () => {},
        },
      );
    } catch { /* panel failed to open */ }
    panelActive = false;
  };

  pi.registerCommand("notifs", {
    description: "In-TUI notifications panel (reads the terminal-notif log; ACTION items highlighted). /notifs off closes.",
    getArgumentCompletions: (prefix: string) => {
      const args = ["off"].filter((a) => a.startsWith(prefix.toLowerCase()));
      return args.map((a) => ({ value: a, label: a }));
    },
    handler: async (args: string, ctx: any) => { await openPanel(ctx); },
  });
  pi.registerShortcut("ctrl+alt+n", {
    description: "Toggle the in-TUI notifications panel",
    handler: async (ctx: any) => { await openPanel(ctx); },
  });
}
