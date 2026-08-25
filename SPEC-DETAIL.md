# ompa — Implementation SPEC (SPEC-DETAIL)

> Companion to `SPEC.md`. SPEC.md is the strategy (what/why/not). This file is
> the build contract: schemas, algorithms, event flows, thresholds, and
> invariants. If a decision isn't here, it's deferred in SPEC.md §Decisions.

---

## 0. Layout & data model

```
~/.prime/oh-my-prime-agent/        repo (git)
├── bin/ompa                       CLI (bash)
├── ompr.toml                      single source of config
├── SPEC.md / SPEC-DETAIL.md / ROADMAP.md / OPTIMIZE.md
├── plugins/<name>/                each plugin = dir of .ts + optional assets
│   ├── resource-guard/
│   ├── global-chat/
│   ├── souls/
│   ├── notif-box/
│   ├── bash-first/
│   ├── self-profiler/             §9 — in-session profiler feeding /refine
│   ├── ompa-tui/                  §8 — modular panel dashboard + status widget
│   ├── kernel-pilot/              §11 — stateless py runner + ipython router
│   └── fleet/
├── completions/                   shell completions (ompa.fish, omp.fish)
├── tests/test-ompa.sh             anti-slop CLI harness (mock registry, sandboxed HOME)
└── themes/<name>/                 kitty-tab-bar.py + soul-accents + hypr rules

~/.prime/agent/extensions/         symlink targets (ompa install)
~/.prime/agent/souls/              soul registry + vaults
~/.local/state/resource-guard/usage.jsonl
~/.local/state/agent-chat/chat.jsonl
~/.local/state/terminal-notif/notif.log
~/.local/state/fleet/runs.jsonl      # subagent run log (spawn → reap)
~/.local/state/fleet/queue.json      # capped-spawn wait queue
~/.local/state/fleet/checkpoints/    # offloaded-wait checkpoints
~/.local/state/ompa/profile.jsonl          # §9 profiler event log (rotated)
~/.local/state/ompa/profile-distilled.json # §9 compact aggregate for /refine + TUI
~/.local/state/ompa/refine-prime.jsonl     # §10 audit journal of applied prime edits
~/.local/state/ompa/kernel-pilot.jsonl     # §11 backend routing stats (py/ipython, mode, ms, ok)
~/.prime/agent/refine-prime-enabled        # §10 gate: prime edits allowed (ompa refine-prime)
~/.prime/agent/resource-policy.json  # GOVERNED: written by `ompa sync` (never hand-edited)
```

**Optimization contract:** measured surfaces + targets live in
[OPTIMIZE.md](OPTIMIZE.md). If a knob exists in ompr.toml but has no surface
behind it, it's premature. If a surface exists but has no knob, it's a gap.

**Install contract:** `ompa install` symlinks each enabled plugin's `*.ts` into
`~/.prime/agent/extensions/` (prime-agent auto-discovers). Enabling/disabling =
create/remove symlink. Themes copy into `~/.config/kitty/` and
`~/.config/hypr/custom/` (Lua API on this box — see §5). **Completions:**
`ompa install` (and `ompa completions fish`) auto-copies
`completions/{ompa,omp}.fish` into `~/.config/fish/completions/` — auto
config of auto completions; the repo is the source, the installed copy is
regenerated, never hand-edited.

**Config precedence:** defaults (code) < `ompr.toml` < env `OMPA_*` < CLI flag.
`ompr.toml` is written by `ompa install` on first run if missing.

---

## 1. resource-guard

**Job:** record, throttle, hold. Make heavy tool calls good citizens.

### 1.1 Detection (heavy command)

Applied to `bash` tool (`event.input.command`) and `ipython` (`event.input.code`).

Heavy signals (regex, case-insensitive, OR-ed with user `heavyPatterns`):
- build/compile/decompile binaries: `cargo|rustc|make|ninja|cmake|gcc|g\+\+|clang|clang\+\+|go build|go install|gradle|mvn|bazel|jadx|apktool|tsc|webpack|vite build`
- package-manager builds: `npm run build|pnpm build|yarn build`
- release/opt markers: `opt-level|codegen-units|target/release|CMAKE_BUILD_TYPE`
- explicit job control: `-j\s*\d+|--jobs`

Not heavy: `ls|grep|cat|curl|git*|pip install*` (pip install of pure wheels is
allowed; source builds of big packages are caught by the build regexes).

### 1.2 Pressure model

Sample every event:
```
load1  = /proc/loadavg field 1
memAvailMB = MemAvailable kB / 1024
swapUsedMB = (SwapTotal - SwapFree) kB / 1024
pressured ⇔ load1 > maxLoad1  OR  memAvailMB < minMemAvailMB  OR  swapUsedMB > maxSwapUsedMB
```
Defaults (12-core/16GB box): `maxLoad1=9, minMemAvailMB=1200, maxSwapUsedMB=8000`.

### 1.3 Hold algorithm

```
on heavy tool_call:
  if not pressured: → throttle, run immediately
  else:
    loop until not pressured or elapsed >= maxHoldMs:
      record("held")
      notify user ("holding <tool> — load X")
      sleep pollMs (1.5s default)
    run anyway after maxHoldMs (the user's request outranks perfection)
```
Invariant: **the guard never blocks forever.** maxHoldMs bounds every hold.
Holds are visible (notify each poll batch, not each 1.5s tick).

### 1.4 Throttle transforms (applied to bash only)

1. `injectJobs(cmd)`: if first token ∈ buildTools and no `-j/--jobs` present:
   - `cargo <sub> <args>` → insert `-j 4` after the subcommand
   - `make|ninja` → append `-j 4`
   - `cmake` → append `-- -j 4`
   - respect an existing `-j N` verbatim (user intent wins; no cap override)
2. `throttleShell(cmd)`: prefix `nice -n 19 ionice -c 3`; multi-line commands
   wrap as `nice -n 19 ionice -c 3 bash -c '<escaped>'`.
3. ipython code: not rewritable safely → record only (`action:"throttled"`).

### 1.5 Telemetry (usage.jsonl)

One line per event:
```
{ts, action: held|ran|ran-after-hold|throttled, tool,
 load1, memAvailMB, swapUsedMB, heldForMs, snippet(first 120 chars)}
```
`/resource` TUI command prints live load/mem/swap + last 4 events.

### 1.6 Context injection (per turn)

`before_agent_start` appends to systemPrompt:
```
[Resource context] 12 cores. load1=… (max 9), memAvailable=…MB (min 1200),
swapUsed=…MB (max 8000).
UNDER PRESSURE: prefer single-threaded work; avoid new builds unless asked.
  | HEADROOM: proceed, but throttle builds.
Tool choice: bash for shell/text/file ops; ipython only for logic/state.
```
The bash-first plugin provides the tool-choice line independently so it can be
enabled/disabled alone.

### 1.7 omp-internal workers (`governOmpWorkers=true`)

The governor's detection is not limited to the bash/ipython tool calls — it
also covers omp's own resident workers: `__omp_worker_tiny_inference`,
`__omp_worker_mnemopi_embed`, `__omp_worker_stt`/`tts`, `__omp_worker_tab`.
Same treatment: when pressured, heavy workers are held/reniced (nice 19,
ionice 3); idle ones are shut down per `[inference] idleTimeoutMs` and
respawned on demand (OPTIMIZE.md Surface 2).

### 1.8 Injection rate-limit (`[inject] rateLimitTurns`)

`[Resource context]` is re-injected only when the pressure state changed or
`rateLimitTurns` (default 10) turns elapsed — never re-stating an unchanged
load line every turn (OPTIMIZE.md Surface 5). Soul blocks keep their own
caps (§2.5). Identical blocks across turns are deduped, not re-appended.

---

## 2. souls (identity + memory vault)

**Job:** durable agent identity + durable memory, injected every turn.

### 2.1 Soul file (`~/.prime/agent/souls/<name>.soul.md`)

Frontmatter (YAML-ish, single-line key: value):
```
name: reaper
role: root agent
session: <uuid>            # current binding
session_id: <short id>     # cached short id
specialty: …
personality: …
projects: {"<key>": ["<uuid>", …]}          # key = projectKey(cwd)
project_last_seen: {"<key>": "<ISO>"}
claimed_at: <ISO>
status: active
```
Name sanitization: lowercase, `[^a-z0-9_-]` → `-`. Reserved: `grave` (human).

**Auto-claim** (`session_start`): if this session has no soul, claim the first
free name from the pool (order matters: reaper, crypt, shovel, spade, tomb,
vault, …), set session name, set kitty tab title. Sessions that die leave the
file; `ompa prune` removes souls whose session is not live (reserved list:
reaper, crypt, shovel).

### 2.2 Memory vault (`~/.prime/agent/souls/<name>.memory.jsonl`)

JSONL, one Fact per line:
```
{"id":"<8 hex>","ts":"<ISO>","content":"<text>","source":"auto|manual|<cmd>","tags":[]}
```
Cap: 500 facts (oldest dropped on write). Append-only; rewrite on truncate.

### 2.3 Commands

- `/remember <text>` — store manual fact (source: "manual").
- `/recall [query]` — last 10, reversed; query filters substring match.
- `/forget <id|query>` — by id or content substring.

### 2.4 Auto-capture (`agent_end`)

Only for claimed souls (name ≠ fallback "agent"). Record
`Worked on: <first 90 chars of user prompt>` when:
- prompt length ≥ 15 chars, AND
- the exchange used ≥ 1 tool (real work, not smalltalk), AND
- no fact in the last 5 contains the first 30 chars of the topic (dedupe).

### 2.5 Injection (`before_agent_start`)

Build `[Soul memory]` block: keyword hits (words >3 chars from the user prompt
scored against fact content, top 3) + recent facts (last 6), deduped, max 6.
Append to systemPrompt. Never duplicated: check `[Soul memory]` in base.

### 2.6 Identity injection (global-chat)

`[Soul identity]` block: name, role, specialty, personality, projects sorted by
`project_last_seen`, and `:name:` reachability hint. Same append-once rule.

---

## 3. global-chat (fabric)

**Job:** cross-agent chat + rooms + soul routing, one shared log.

### 3.1 Message syntax (TUI input)

- `:: text` — global broadcast (all live agents).
- `::#room text` — room broadcast (room: `#name`, implicit join on first use).
- `:name: text` — direct to soul `name` (resolves soul → session uuid →
  `prime-agent send`).
- `/chat` — toggle chat panel. Hotkey: `ctrl+alt+g`.

### 3.2 Resolution & delivery

`:name:` → look up soul file → `session` uuid (or `session_id` short) → fall
back to most project-familiar session for that name if primary is gone.
Delivery = `prime-agent send <id|uuid> <message>` (same daemon channel as the
kernel's agent_message). Sender identity is not spoofable (daemon enforces).

### 3.3 Log (`~/.local/state/agent-chat/chat.jsonl`)

```
{ts, type: global|room|direct, room?, from, to?, text}
```

### 3.4 Parser invariant (pitfall documented)

`:name:` parsing must use `indexOf(":", 1)` — naive `split(":")` breaks on
URLs/times inside messages. This exact bug shipped once; regression-guard it.

---

## 4. notif-box

**Job:** notifications you can see and toggle, agent-side.

- `terminal_notif.notify(title, body, level)` — desktop notify-send + log +
  box queue. Log: `~/.local/state/terminal-notif/notif.log`.
- `box_open/toggle/close` — floating kitty window (class `notifbox`).
- `tab_set(title, color)` — kitty control socket: `$XDG_RUNTIME_DIR/kitty-<pid>`.
  Socket discovery must glob and prefer the instance hosting prime-agent
  windows (there are two kitty instances on this box; the socket path is
  `kitty-<pid>`, NOT `/run/user/1000/kitty`).
- In-harness notifications extension surfaces agent messages via the box.

---

## 5. Theme engine

**Job:** desktop aesthetics as a feature, per soul.

- Theme = `kitty-tab-bar.py` + soul accent map + optional Hyprland rules.
- `ompa theme <name>` copies theme files into kitty/hypr configs.
- Accent map keys = soul names (reaper=(255,42,109), crypt=(0,240,255),
  shovel=(252,186,10), …).
- **Hyprland (this box)**: 0.56.x uses the Lua config API. Rules as
  `hl.window_rule({match={class='^(x)$'}, …})`, binds as
  `hl.bind('SUPER + SHIFT + N', hl.dsp.exec_cmd('cmd'))` — legacy
  `windowrule=`/`bind=` and `hyprctl keyword` are NOT honored.
- **Kitty**: `tab_bar.py` loads at startup only (`@run_once`); theme changes
  need a kitty restart. Custom gradient tab draws per-tab color ramps.

---

## 6. Sitter mode (M3, spec'd now)

**Job:** the always-on resident caretaker. Guest rules are reactive; sitter is
proactive.

### 6.1 Telemetry sources
`/proc/loadavg`, `/proc/meminfo`, cgroup v2 stats, `journalctl --user`, `ps`
scans (CPU%, RSS, state), battery/thermal (when present).

### 6.2 Escalation ladder (fixed order)
```
notify → throttle(renice/ionice) → kill(orphan/runaway) → suspend → hibernate
```
- hibernate only when: idle + no jobs + (low battery | sustained thermal/swap
  pressure); **checkpoint jobs first**.
- suspend-and-inspect: before killing anything unknown, suspend + read-only
  forensics (memory maps, open fds, sockets) — the agent writes the forensics,
  no signature DB (SPEC §Far Horizon).

### 6.3 Action loop
```
sample → detect(anomaly vs baseline) → decide(policy match) → act → record
```
Baseline = rolling 15-min stats; anomaly = deviation > 3σ or hard-threshold hit.

---

## 7. fleet (subagent lifecycle governor)

**Job:** cap, queue, offload, reap. Make a fleet of subagents as polite as one
guest. The guest rules govern the agent; the fleet governs the agents.

### 7.1 Cap & admission

`maxSubagents = 15` (default; ompr.toml `[fleet]`).

- Counter: live subagents (state ≠ done|offloaded). Sampled at spawn request.
- At the cap, a spawn request **queues and waits** — high-priority work
  included. The cap is absolute; priority only orders the queue.
- Queue entry: `{id, priority, queuedAt}`. Priorities: critical(0) > normal(1)
  > best-effort(2); default normal.
- Dequeue: when a live subagent enters done/offloaded, admit the
  highest-priority item; ties → FIFO (`queue.json` rewritten atomically).
- Invariant: offloaded (checkpointed) and done subagents never hold a slot.

### 7.2 Wait-state offload

A subagent is **offloadable** when it enters a wait state:

- blocked on user input (awaiting a message / approval), or
- awaiting an async peer reply (agent-network inbox empty), or
- sleeping > `offloadSleepMs` (30s default) with no queued work.

Offload protocol (checkpoint → release → restore):

1. **checkpoint** — persist session transcript delta + in-flight intent to
   `~/.local/state/fleet/checkpoints/<id>.jsonl` (atomic temp+rename).
2. **release** — stop the renderer and drop the worker's memory (worker exits;
   SIGSTOP is NOT offload — it keeps RSS). Offload = durable checkpoint +
   process exit.
3. **restore (wake)** — on new input or a notification to that agent: respawn
   the worker, replay the checkpoint, resume where it waited.

Invariants: offload only in a wait state — never mid-tool-call or mid-turn;
restore is idempotent (checkpoint replay is re-runnable).

### 7.3 Dormant TUI (focus-aware rendering)

Prerequisite-gated scope: **unbounded TUI count ships only if the renderer can
go dormant when unfocused** (`focusDormant=true`).

- **Trigger:** window/tab loses focus (kitty focus events) OR renderer idle >
  `dormantMs` (2s default) with no visible change.
- **Dormant:** render loop stops (no repaint, no diff), timer callbacks
  suspend, panel refresh intervals stop. Process stays alive at ~0 CPU.
- **Metric:** dormant TUI average CPU < 0.1% over 10s. If a platform cannot
  meet it, TUIs are capped there (fallback fixed cap, e.g. 4).
- **Wake:** focus event, or an agent notification (→ §7.4).

### 7.4 Tab-flash notification

Even a dormant/unfocused agent can notify:

- Agent message / notif event → flash the terminal tab: background = soul
  accent, high-contrast text, ~2s flash, decay to normal. Distinct from the
  notif-box.
- Transport: kitty control socket (same discovery as notif-box §4),
  `set-tab-title`/`set-tab-color` + a restore timer.
- The flash is terminal-level, NOT a TUI repaint — it must not wake the
  renderer into a full redraw. The flash is the only visible cost of an
  unfocused agent.

### 7.5 Proactive reaping (native)

- On `agent_end` / run completion: reap immediately — collect output, append
  to `runs.jsonl`, release the worker; drop the checkpoint if done, keep it
  only if offloadable-wait.
- Zombie guard: every governor tick (30s), scan for finished-but-unreaped
  subagents; reap anything terminal for > `reapGraceMs` (60s default) or whose
  parent is gone.
- Houseguest rule #1 for fleets: no orphans, no zombies, no checkpoint litter.

### 7.6 Config (`[fleet]` in ompr.toml)

```toml
[fleet]
maxSubagents  = 15
offloadSleepMs = 30000
dormantMs     = 2000
focusDormant  = true      # prerequisite gate for unbounded TUIs (§7.3)
reapGraceMs   = 60000
```

### 7.7 Hygiene GC (`[hygiene]`, native tick)

Houseguest rule #3 for the fleet's litter (OPTIMIZE.md Surface 3):

- On each governor tick (30 s), `ompa gc` removes session artifacts +
  transcripts of **dead** sessions older than `artifactMaxAgeDays` (14
  default). Live sessions are never touched.
- State files (`usage.jsonl`, `chat.jsonl`, `notif.log`, `runs.jsonl`) rotate
  at `logMaxMB` (8 default): append → drop oldest half. Bounded, forever.
- `runGcOnTick=true` makes it native — no manual cleanup command required.

### 7.8 omp background workers (`[inference]`)

- Workers (`tiny_inference`, `mnemopi_embed`, `tab`, `stt`/`tts`, broker)
  idle > `idleTimeoutMs` (120 s) are shut down and respawned on demand.
- When `governOmpWorkers=true` (§1.7), active heavy workers are held/reniced
  under pressure instead of stacking on top of builds (Surface 8: rustc 2.4 GB
  + inference 1.6 GB collide).

---

## 8. ompa-tui (modular dashboard + status widget)

**Job:** one dashboard, many panels, config-driven, reload-aware. Panels are
small modules returning fresh lines on demand; a registry composes them behind
a tab bar.

### 8.1 Panel registry

Each panel = `{id, title, refresh(): string[]}`. Panels read their data from
disk on every refresh, so nothing caches stale state. Built-ins:

| id | reads | shows |
|---|---|---|
| resource | `/proc` + resource-policy.json + usage.jsonl tail | load/mem/swap vs policy, last guard events |
| chat | chat.jsonl tail | global agent chat |
| notifs | notif.log tail | notifications, ACTION/error marked ⚠ |
| souls | souls dir | name/role/specialty per soul |
| fleet | runs.jsonl + queue.json | recent subagent runs, queue depth |
| profile | profile-distilled.json (§9) | turns/tools/holds + refine hints |
| help | static | keys + config pointers |

Config (`ompr.toml [tui]`): `panels = [...]` (order + subset), `refreshMs`,
`statusWidget`, `statusRefreshMs`. Enabled panels are rebuilt on every
`session_start` — including reason `reload` — so editing ompr.toml and
`/reload` updates the TUI without a restart (the "updates on reload" contract).
`session_shutdown` (reload/quit/switch) disposes timers and clears the widget —
no leaked timers, invariant #17.

### 8.2 Surfaces

- **Dashboard overlay** — `/dashboard` or `/ompa`, hotkey `ctrl+alt+o`.
  `ctx.ui.custom` overlay anchored right-center. Keys: ←→/Tab switch panel,
  ↑↓ scroll, r refresh, q/Esc close. Same overlay pattern as chat/notifs.
- **Status widget** — `ctx.ui.setWidget("ompa-status", factory, {placement:
  "aboveEditor"})`: one line above the editor with
  `⚡ load/mem/swap · 💬 chat · ⚑ action notifs · 🛠 profiler tool calls`.
  Toggle: `/ompa widget on|off`. Refreshes at `statusRefreshMs`.

Both surfaces sanitize all external text (F3) and truncate to viewport width.

---

## 9. self-profiler (thin profiler feeding /refine)

**Job:** record the agent's own behaviour cheaply and distill it into a small,
deterministic, evidence-backed refinement suggestion — no LLM cost per distill.

### 9.1 Events (JSONL, `~/.local/state/ompa/profile.jsonl`)

| event | fields |
|---|---|
| turn | turnIndex, durationMs |
| tool | toolCallId, tool, snippet (≤120 chars) |
| result | toolCallId, tool, durationMs, isError |

Rotated at 1 MB (keep newest half). Source of truth for the TUI + refine.

### 9.2 Distilled profile (`profile-distilled.json`)

Written at `agent_end` and by `/profile`; always < 4 KB so /refine can read it
without token bloat:

```json
{ "generated": ISO, "turns": N, "avgTurnMs": X, "holds": H,
  "tools": {"bash": {"count": C, "totalMs": T, "maxMs": M, "errors": E}},
  "repeatedCommands": [{"prefix": "cargo build", "count": 3}],
  "refineHints": ["Tool bash failed 3 times ...", "..."] }
```

`holds` counts `action:"held"` lines in the resource-guard log (pressure
evidence). `refineHints` are deterministic thresholds (errors ≥ 3, avg tool
latency > 30 s, repeated command ≥ 3, holds ≥ 3, avg turn > 2 min) — each hint
is phrased as a `refine.run("<hint>")` instruction.

### 9.3 Commands

- `/profile` — print the distilled profile + refine hints.
- `/profile reset` — clear log + distilled.

---

## 10. refine prime access (audited)

**Job:** let `/refine` modify the prime-agent user surface (config, extensions,
souls, prompts, skills, themes), not just the continual-harness state file.

### 10.1 Status before (measured)

Refine applied only `prompt | memory | skill | subagent` edits to
`harness_state.json`; the base system prompt was blocked, and no file/config
surface was reachable. Prime access did **not** already exist.

### 10.2 What was added

`bin/apply-refine-prime-patch.py` (idempotent, `--remove` to revert, backup at
`refinement.js.orig-ompa`) patches prime-agent's `applyRefinementProposal` to
accept a fifth edit kind:

```json
{ "action": "update" | "delete", "kind": "prime",
  "path": "<allowlisted abs path>", "content": "<new contents>",
  "metadata": { "operation": "write" | "delete" }, "reason": "..." }
```

- `validateEdit` → `validatePrimeEdit` (allowlist check, op check, content check).
- `applyPrimeEdit` performs the edit: atomic tmp+rename, `.bak-refine` backup,
  journaled to `~/.local/state/ompa/refine-prime.jsonl` (ts/id/op/path/bytes/
  backup/reason). The refine planner prompt documents the new kind so the LLM
  can actually emit it.

**Allowlist** (deny-list wins): `~/.prime/oh-my-prime-agent`, `extensions/`,
`souls/`, `prompts/`, `~/.agents/skills/`, `~/.config/kitty`, `~/.config/hypr`,
`resource-policy.json`. **Deny-list:** `~/.npm-global/lib/node_modules/
prime-agent` (never self-edit the running harness source) and
`~/.prime/agent/harness*` (the continual-harness store refine already owns).

### 10.3 Gate

Prime edits apply only when the gate file `~/.prime/agent/refine-prime-enabled`
exists (invariant #18). CLI:

```
ompa refine-prime enable    # applies the patch (idempotent) + creates the gate
ompa refine-prime disable   # removes the gate (patch stays; edits refused)
ompa refine-prime status    # patch state, gate, allowlist, journal tail
```

`[refine] primeAccess = true` in ompr.toml mirrors the gate for humans; the
gate file is authoritative.

---

## 11. kernel-pilot (hot-swappable execution backends)

**Job:** most ipython calls are pure computation — no rlm, no skills, no
persistent variables, no magics, no await. Serve those with a lightweight
stateless runner; keep the stateful kernel for the calls that actually need
it. The kernel is already lazy (never started until the first ipython call),
so stateless-only sessions never pay its ~500 MB RSS (OPTIMIZE.md S1).

### 11.1 Backends

| backend | what runs the code | state | rlm/skills | magics/await/%%bash |
|---|---|---|---|---|
| `stateful` | the session's IPython kernel (KernelManager) | persistent + snapshot | yes | yes |
| `stateless` | fresh `python3 -` subprocess per call (kernel venv, nice 19, timeout, output caps) | none | no | no |
| `auto` (default) | classifier routes each call | — | — | — |

`classifyKernelMode` is a conservative static heuristic: any of `rlm`, skill
module imports (agent_email, websearch, task_manager, refine, compact, edit,
goal, terminal_notif, agent_message, agent_observe, attach_image,
rlm_heartbeat, auto_learn), `%%`/`%` magics, `get_ipython()`, `In[`/`Out[`,
top-level `await`, `input(`, `!` shell escapes, or `_ipython` → `stateful`.
Pure code with a trailing top-level expression is echoed notebook-style
(`print(repr(...))` via an AST wrapper).

### 11.2 Additive + hot-swap

- **`py` tool (always additive):** a new stateless tool the model can pick for
  pure work. Stateful-looking code gets a guidance error ("use ipython").
- **`ipython` router (patch-gated):** the patch sets
  `globalThis.__ompaKernelPilotLive` at module import (once per process) and
  exposes the session's base tool definitions at
  `globalThis.__ompaKernelPilot[sessionId]` (per-session, replaced on
  rebuild). The plugin registers the router only when the live marker is
  present — a fresh patched process activates it; a `/reload` in an old
  process (cached module) stays additive and the built-in `ipython` tool is
  untouched. The router (extension tools win over built-ins in
  `_refreshToolRegistry`): `auto` classifies per call, `stateful` always
  delegates to the base tool (real provisioner + RLM bridge + snapshots +
  busy-kernel UX + attachments), `stateless` always runs the runner. Without
  the patch the plugin degrades to additive mode. A restart is required to
  activate the router after patching.

### 11.3 Surface & commands

- Config `ompr.toml [kernel]`: `backend`, `timeoutMs`, `maxOutputChars`,
  `guidance`.
- `/kernel` status + stats; `/kernel auto|stateless|stateful` hot-swaps the
  backend live (per-session; reload resets to config); `/kernel reset` clears
  stats. Stats journal: `~/.local/state/ompa/kernel-pilot.jsonl`.
- Guidance injected per turn when backend ≠ stateful: prefer `py` for pure
  computation, reserve `ipython` for stateful work.
- CLI: `ompa kernel-pilot patch|unpatch|status` (patch is idempotent; `--remove`
  reverts; backup `agent-session.js.orig-ompa`).

Invariants: the runner never starts the kernel; a stateless call can never
hang the session (timeout + SIGKILL + abort wiring, invariant #21); stateful
calls are bit-for-bit the built-in path (delegation, not reimplementation).

---

## 12. CLI contract (ompa)

```
ompa install            link enabled plugins (from ompr.toml §plugins)
ompa enable <p>         link one plugin
ompa disable <p>        unlink one plugin
ompa theme <name>       apply theme (cp2077 | rebecca)
ompa prune              remove souls whose sessions are dead (reserved safe)
ompa status             plugins on/off, theme, souls
ompa fleet              fleet governor: running X/15, queued Y, offloaded Z
ompa fleet reap --all   force-reap finished subagents (zombie guard bypass)
ompa sync               write resource-policy.json from ompr.toml (single source)
ompa gc                 run hygiene GC now (artifacts/transcripts > maxAgeDays)
ompa reap               kill idle omp/pi background workers (auto-cleanup)
ompa enable-reap        wire the 5-min systemd user timer (auto; also on install)
ompa completions        install shell completions (fish; auto-run on install)
ompa refine-prime       gate /refine prime-modification access (enable|disable|status; §10)
ompa kernel-pilot       hot-swap ipython backends (patch|unpatch|status; §11)
ompa --version          print version
```
In-TUI commands (from the §8/§9/§11 plugins): `/dashboard` (alias `/ompa`),
`ctrl+alt+o` toggle, `/ompa widget on|off`, `/profile`, `/profile reset`,
`/kernel auto|stateless|stateful`, `/kernel status`, `/kernel reset`.
Exit codes: 0 ok, 1 user error, 2 unknown plugin/theme.

---

## 13. Invariants (regression guards)

1. The guard never blocks a tool call longer than `maxHoldMs`.
2. `:name:` parsing uses `indexOf(":", 1)`; never bare `split(":")`.
3. Soul injection appends once per turn (`[Soul memory]`/`[Soul identity]`).
4. Vault writes are atomic (temp + rename) and capped at 500 facts.
5. `ompa prune` never touches reserved souls (reaper, crypt, shovel).
6. Heavy builds always run through `nice -n 19 ionice -c 3`; existing `-j N`
   is never overridden upward.
7. Multi-line commands are never throttled by naive prefixing — they get the
   `bash -c` wrap or are skipped.
8. Auto-capture never writes for unclaimed/test sessions (name = "agent").
9. Any action that changes the user's machine state must be visible: logged,
   notified, or both (houseguest rule #1).
10. At most `maxSubagents` live subagents, ever; offloaded/done never hold a
    slot. At the cap, spawn requests queue and wait — priority orders the
    queue, never bypasses the cap.
11. Offload happens only in a wait state — never mid-tool-call or mid-turn.
12. Unbounded TUIs require `focusDormant=true`; a dormant TUI's avg CPU is
    < 0.1% (10s window), else TUIs fall back to a fixed cap.
13. Fleet checkpoint writes are atomic (temp + rename); restore replays
    idempotently.
14. **Single source of truth:** `resource-policy.json` is written by
    `ompa sync` from ompr.toml — it is never hand-edited, so the governor
    prime reads and the governor ompa tunes can never drift.
15. Injection is rate-limited: an unchanged `[Resource context]` is not
    re-appended within `rateLimitTurns`; identical blocks are deduped.
16. `ompa gc` / hygiene only ever touches dead sessions' artifacts — live
    sessions are never reaped or truncated.
17. ompa-tui leaves no leaked timers: every panel/widget disposes on
    `session_shutdown` (reload/quit/switch) and rebuilds on `session_start`
    (including reason `reload`), so `/reload` reflects config edits.
18. Prime edits (§10) apply only when the gate file exists; every applied prime
    edit is atomic, backed up (`.bak-refine`), and journaled. Deny-list paths
    (npm dist, harness store) are always refused.
19. The self-profiler never breaks the session: all reads/writes are
    best-effort, the event log is capped/rotated, and distill is deterministic
    (no LLM call).
20. The kernel-pilot runner never starts the stateful kernel: stateless calls
    run in a fresh subprocess with timeout + SIGKILL + abort wiring; a
    stateless call can never hang or poison the session.
21. Stateful ipython calls always delegate to the base tool (real provisioner
    + RLM bridge + snapshots + attachments) — the router reimplements nothing,
    so the stateful path is bit-for-bit the built-in behavior.

---

## 14. Milestone mapping

| Milestone | Build contract | Done? |
|-----------|---------------|-------|
| M1 framework | repo, CLI, config, 5 plugins, 2 themes, license, CI | ✅ |
| M2 souls+fleet-v1 | vault + commands + injection + auto-capture; backend eval; fleet cap/queue + proactive reaping | ⏳ |
| M2.5 tui+profile+prime | modular dashboard (§8) + self-profiler (§9) + refine prime access (§10) | ✅ this session |
| M2.6 kernel-pilot | hot-swappable execution backends: stateless `py` runner + ipython router (auto/stateless/stateful) + prompt guidance (§11) | ✅ this session |
| M3 sitter+fleet-v2 | §6 telemetry + ladder + loop; telemetry history; theme previews; fleet offload-on-wait + focus-dormant TUIs + tab-flash notify | — |
| M4 one-command | fresh-machine installer; multi-harness (gated) | — |
| M5 launch | OSS release; product tier separation (free core / paid sitter) | — |
