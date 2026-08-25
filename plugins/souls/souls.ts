/**
 * souls — memory vault for agent souls (M2).
 * Every soul gets a durable JSONL vault at ~/.prime/agent/souls/<name>.memory.jsonl.
 * Facts persist across sessions and are injected into context each turn.
 *
 * Commands:
 *   /remember <text>          store a durable fact
 *   /recall [query]           show recent facts (or match query keywords)
 *   /forget <id|query>        remove a fact
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const SOULS_DIR = join(homedir(), ".prime", "agent", "souls");
const SOUL_EXT = ".soul.md";
const MEM_EXT = ".memory.jsonl";
const MAX_INJECT = 6;           // facts injected per turn (recent first)
const MAX_STORE = 500;          // vault cap per soul (oldest dropped)

interface Fact { id: string; ts: string; content: string; source?: string; tags?: string[]; }

function mySoulName(sessionId: string): string {
  if (!existsSync(SOULS_DIR)) return "agent";
  try {
    for (const f of readdirSync(SOULS_DIR)) {
      if (!f.endsWith(SOUL_EXT)) continue;
      const raw = readFileSync(join(SOULS_DIR, f), "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!m) continue;
      const meta: Record<string, string> = {};
      for (const ln of m[1].split("\n")) {
        const kv = ln.match(/^([a-zA-Z_]+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2];
      }
      if (meta.session === sessionId || meta.session_id === sessionId) return f.slice(0, -SOUL_EXT.length);
    }
  } catch { /* ignore */ }
  return "agent";
}

function vaultPath(name: string): string {
  return join(SOULS_DIR, name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") + MEM_EXT);
}

function readFacts(name: string): Fact[] {
  const p = vaultPath(name);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Fact; } catch { return null; } })
      .filter((f): f is Fact => !!f && typeof f.content === "string");
  } catch { return []; }
}

function writeFacts(name: string, facts: Fact[]): void {
  const p = vaultPath(name);
  const lines = facts.slice(-MAX_STORE).map((f) => JSON.stringify(f));
  try { writeFileSync(p, lines.join("\n") + (lines.length ? "\n" : ""), "utf8"); } catch { /* ignore */ }
}

function remember(name: string, content: string, source?: string): Fact {
  const facts = readFacts(name);
  const fact: Fact = { id: randomUUID().slice(0, 8), ts: new Date().toISOString(), content, source, tags: [] };
  facts.push(fact);
  writeFacts(name, facts);
  return fact;
}

function forget(name: string, query: string): number {
  const facts = readFacts(name);
  const q = query.toLowerCase();
  const kept = facts.filter((f) => f.id !== q && !f.content.toLowerCase().includes(q));
  const removed = facts.length - kept.length;
  if (removed) writeFacts(name, kept);
  return removed;
}

function recallText(name: string, query?: string): string {
  const facts = readFacts(name);
  if (!facts.length) return "(vault empty)";
  let list = facts;
  if (query) {
    const q = query.toLowerCase();
    list = facts.filter((f) => f.content.toLowerCase().includes(q));
  }
  list = list.slice(-10).reverse();
  return list.map((f) => `${f.id} ${f.ts.slice(0, 16).replace("T", " ")} ${f.content}`).join("\n");
}

export default function souls(pi: ExtensionAPI): void {
  // ---- inject memory into context each turn (proven path: systemPrompt chaining) ----
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      const name = mySoulName(sid);
      const facts = readFacts(name);
      if (!facts.length) return undefined;
      const prompt = (event.prompt || "").toLowerCase();
      const hits = facts
        .map((f) => ({ f, score: (f.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && prompt.includes(w)).length) }))
        .sort((a, b) => b.score - a.score)
        .filter((h) => h.score > 0)
        .slice(0, 3)
        .map((h) => h.f);
      const recent = facts.slice(-MAX_INJECT).reverse();
      const shown: Fact[] = [];
      for (const f of [...hits, ...recent]) {
        if (!shown.some((x) => x.id === f.id)) shown.push(f);
        if (shown.length >= MAX_INJECT) break;
      }
      if (!shown.length) return undefined;
      const block = "[Soul memory]\n" + shown.map((f) => `- ${f.content}${f.source ? ` (from ${f.source})` : ""}`).join("\n");
      const base = (event.systemPrompt || "").trim();
      const already = base.includes("[Soul memory]");
      return { systemPrompt: already ? base : base + "\n\n" + block };
    } catch { return undefined; }
  });


  // ---- auto-capture: record notable work at prompt end (claimed souls only) ----
  pi.on("agent_end", async (event: any, ctx: any) => {
    try {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      const name = mySoulName(sid);
      if (name === "agent") return; // unclaimed/test sessions stay quiet
      const msgs: any[] = Array.isArray(event.messages) ? event.messages : [];
      const userMsg = msgs.find((m: any) => m.role === "user");
      if (!userMsg) return;
      const content = userMsg.content;
      let promptText = "";
      if (typeof content === "string") promptText = content;
      else if (Array.isArray(content)) promptText = content.map((c: any) => c?.text || "").join(" ");
      promptText = promptText.replace(/\s+/g, " ").trim();
      if (promptText.length < 15) return;
      const usedTools = msgs.some((m: any) =>
        Array.isArray(m.content) && m.content.some((c: any) => c?.type === "tool_use"));
      if (!usedTools) return; // smalltalk or pure answers are not vault material
      const topic = promptText.slice(0, 90);
      const facts = readFacts(name);
      if (facts.slice(-5).some((f) => f.content.includes(topic.slice(0, 30)))) return; // dedupe
      remember(name, `Worked on: ${topic}`, "auto");
    } catch { /* never break the loop */ }
  });

  pi.registerCommand("remember", {
    description: "Store a durable fact in this soul's memory vault.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      const name = mySoulName(sid);
      if (!args.trim()) { ctx.ui.notify("usage: /remember <fact>", "info"); return; }
      const f = remember(name, args.trim());
      ctx.ui.notify(`soul ${name}: remembered ${f.id}`, "success");
    },
  });

  pi.registerCommand("recall", {
    description: "Show recent vault facts (optionally match a query).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      const name = mySoulName(sid);
      ctx.ui.notify(recallText(name, args.trim() || undefined), "info");
    },
  });

  pi.registerCommand("forget", {
    description: "Remove a fact by id or content query.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sid = ctx.sessionManager?.getSessionId?.() ?? "";
      const name = mySoulName(sid);
      const n = forget(name, args.trim());
      ctx.ui.notify(n ? `soul ${name}: forgot ${n} fact(s)` : "nothing matched", "info");
    },
  });
}
