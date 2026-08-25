# Adversarial Review — ompa (oh-my-prime-agent)

Reviewer: spade (01a02ee3) · 2026-08-25 · Static review of bin/ompa + plugins/* (1,514 LOC) + CI/themes.
Method: evidence-based attack pass (shell escaping, frontmatter/JSON injection, terminal injection,
data-loss paths, spec drift). No runtime execution.

## Findings (ranked by impact × likelihood)

### F1 — HIGH: resource-guard throttling bypass on chained commands
`plugins/resource-guard/resource-guard.ts` — `throttleShell()` and `injectJobs()` only look at the
first token of a single-line command:
- `cd repo && cargo build` → `nice … cd repo && cargo build`: **nice/ionice apply to `cd`, cargo runs
  unthrottled** (multi-line commands get a proper `bash -c '…'` wrapper, single-line do not).
- `injectJobs()` checks `tokens[0]` only, so `cd … && cargo build` gets **no `-j` injection** — the
  per-project Moonshell `-j2` OOM fix (exactly the chained form used in practice) is silently skipped.
Fix: wrap single-line commands in the same `bash -c` form (or prefix `nice … bash -c 'cmd'`), and
match the build tool anywhere in the command, not just the first token.

### F2 — MEDIUM-HIGH: soul frontmatter injection via /soul name
`global-chat.ts claimSoul()` writes `name: ${name.toLowerCase()}` raw into the YAML frontmatter of
`~/.prime/agent/souls/<name>.soul.md`. A name containing `\n` (e.g. `/soul evil\nspecialty: pwned`)
injects arbitrary frontmatter keys. `readSouls()` parses those keys and `before_agent_start` injects
`Role: …`/`specialty` into the **system prompt** — persistent prompt-injection + identity spoof on the
claimed soul. Same issue in `/soul set specialty|personality <value>` (multi-line value). The
`getArgumentCompletions` pool suggests names but the handler accepts anything.
Fix: reject control chars/newlines in `claimSoul` names and `set` values; validate with the same
charset as `soulFileName()`.

### F3 — MEDIUM: terminal escape injection in chat/notif panels
`ChatView.render()` and `NotifsView.render()` display raw `text`/title/body via theme `fg()` with no
ANSI/control-char stripping visible in the plugin. A crafted `::` post or agent message containing
`\x1b[` sequences renders into the agent's TUI (screen clear / fake prompts / cursor tricks).
`chat.jsonl` and `notif.log` are appendable by any local process. Fix: strip CSI + control chars at
render (pattern: `sanitize_terminal` in writer-llm/util.py); verify whether pi-tui `t.fg()` already
escapes — if it does, downgrade to a note.

### F4 — MEDIUM: `ompa prune` data loss on registry failure
`bin/ompa cmd_prune()`: if `prime-agent list --json` fails (daemon down/renamed), `live_ids` is empty
and **every non-reserved soul + memory vault is deleted**, silently. Reserved list is hardcoded
(`reaper crypt shovel`) and **ignores `ompr.toml [souls] reserved = ["grave"]`** (config drift).
Fix: abort prune when `live_ids` is empty; read reserved names from config.

### F5 — LOW-MEDIUM: soul vault duplicate accumulation; injected memory = prompt-injection surface
`souls.ts agent_end` dedupe checks only the last 5 facts (`facts.slice(-5)`), so repeated prompts
accumulate "Worked on:" entries (cap 500). Vault content is injected verbatim into the system prompt
every turn — any fact containing instructions becomes prompt-injection material; today all content is
user-typed/auto-captured, but any future import/sync turns this into a vector.
Fix: hash-based dedupe; consider quoting injected memory as data.

### F6 — LOW (hygiene/robustness)
- `usage.jsonl` and `chat.jsonl` grow unbounded (no rotation) — disk-fill over years.
- `resource-guard` imports `execFileSync` (unused); ipython "throttle" path records only, no wrap —
  spec drift if SPEC-DETAIL claims ipython is throttled (it is held, not wrapped).
- `effectivePolicy()` uses `cwd.startsWith(prefix)` without a path boundary (`…/Moonshell-evil` matches).
- `cmd_prune` greps `prime-agent list --json` output with regex (fragile vs `--json` schema changes).
- Hand-rolled `toml_get` in bin/ompa (values with spaces/quotes break the enabled-list parse).

## Strengths (keep)
- All subprocess execution via `execFile` with arg arrays — no `shell: true` injection in TS plugins.
- Policy file externalized (`resource-policy.json`), hold-then-run bounded by `maxHoldMs`.
- Soul **filename** sanitization exists (`soulFileName`); per-project policy override works for
  direct `cargo …` invocations.
- Errors deliberately swallowed with "never break the tool" discipline; CI uses minimal permissions.

## Not tested
Runtime behavior, TUI rendering internals (`pi-tui` `t.fg` escaping), multi-agent interaction under
load, and any claims in SPEC/SPEC-DETAIL not exercised above.
