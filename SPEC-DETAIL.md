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
├── SPEC.md / SPEC-DETAIL.md / ROADMAP.md
├── plugins/<name>/                each plugin = dir of .ts + optional assets
│   ├── resource-guard/
│   ├── global-chat/
│   ├── souls/
│   ├── notif-box/
│   └── bash-first/
└── themes/<name>/                 kitty-tab-bar.py + soul-accents + hypr rules

~/.prime/agent/extensions/         symlink targets (ompa install)
~/.prime/agent/souls/              soul registry + vaults
~/.local/state/resource-guard/usage.jsonl
~/.local/state/agent-chat/chat.jsonl
~/.local/state/terminal-notif/notif.log
```

**Install contract:** `ompa install` symlinks each enabled plugin's `*.ts` into
`~/.prime/agent/extensions/` (prime-agent auto-discovers). Enabling/disabling =
create/remove symlink. Themes copy into `~/.config/kitty/` and
`~/.config/hypr/custom/` (Lua API on this box — see §5).

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

## 7. CLI contract (ompa)

```
ompa install            link enabled plugins (from ompr.toml §plugins)
ompa enable <p>         link one plugin
ompa disable <p>        unlink one plugin
ompa theme <name>       apply theme (cp2077 | rebecca)
ompa prune              remove souls whose sessions are dead (reserved safe)
ompa status             plugins on/off, theme, souls
ompa --version          print version
```
Exit codes: 0 ok, 1 user error, 2 unknown plugin/theme.

---

## 8. Invariants (regression guards)

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

---

## 9. Milestone mapping

| Milestone | Build contract | Done? |
|-----------|---------------|-------|
| M1 framework | repo, CLI, config, 5 plugins, 2 themes, license, CI | ✅ |
| M2 souls | vault + commands + injection + auto-capture; backend eval | ⏳ (this file) |
| M3 sitter | §6 telemetry + ladder + loop; telemetry history; theme previews | — |
| M4 one-command | fresh-machine installer; multi-harness (gated) | — |
| M5 launch | OSS release; product tier separation (free core / paid sitter) | — |
