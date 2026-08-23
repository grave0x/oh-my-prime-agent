/**
 * bash-first — tool-choice heuristic.
 * Shell for shell work, ipython for real logic. Injected per turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function bashFirst(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const line = "Tool choice: for shell/text/file/process operations (ls, grep, sed, awk, jq, find, git, curl, mkdir, chmod, ps, env, cat, wc, sort, uniq, xargs), use the bash tool — a single shell process is faster and lighter than starting Python. Use ipython only when you need real logic, data structures, libraries, JSON/CSV parsing, or multi-step stateful computation.";
    return { systemPrompt: (event.systemPrompt || "") + "\n\n" + line };
  });
}
