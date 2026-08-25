# ompa TODO panel — feature spec

> Status: **proposed** · Owner: ompa-tui plugin · Milestone: M2 (thin core,
> opt-in panel)
> Parity target: the `todo` surface omp ships (`/todo append <task>`,
> statuses `pending|in_progress|completed|abandoned|blocked`, tree renderer
> with per-section `x/y` counts).

## Pitch (one line)

A persistent, agent-visible TODO list rendered as an omp-style tree in one of
the ompa dashboard's modular panes — the same shape omp renders, kept where
the user already looks.

## Context

- omp's `/todo` is a plain-text-in-drive todo the agent updates as it works
  ("After each completed step: immediately update `todo`"; "Before
  substantial work: compare next action with todos"). ompa needs the same
  capability so a session can carry a multi-phase job across turns, reloads,
  and even across harnesses (pi + prime-agent) without losing the plan.
- The first real workload is the **credential/key import** drive: enumerate
  key sources, map them onto the omp/prime/pi key schemas, import for all
  providers, verify. That workflow is the seed content (§Seed) and the
  acceptance exercise for the feature.

## Placement — "one of the modular panes on the sidebar"

- New panel `todo` in the ompa dashboard panel registry (`ompa-tui.ts`
  `buildPanels`), same pattern as `resource` / `chat` / `notifs` / `souls` /
  `fleet` / `profile` / `upstream` / `help`.
- Enabled by listing it in `ompr.toml [tui] panels = [...]` (default: on,
  after `profile`). Panel list is read on every refresh and rebuilt on
  `/reload` — no restart needed, consistent with the existing registry.
- When the dashboard is open, the TODO pane shows the full tree with live
  `x/y` counts; it is one tab among the modular panes, keyboard-switchable
  like the rest (`←→`/`Tab`).

## Data model

Storage: `~/.prime/oh-my-prime-agent/todo.json` (next to `ompr.toml`; plain
JSON, git-friendly, no deps — houseguest-thin).

```jsonc
{
  "version": 1,
  "sections": [
    {
      "id": "I",
      "title": "Discovery",
      "items": [
        { "id": "I-1", "text": "Enumerate all key sources (keyring, env, files)", "status": "pending", "notes": null, "createdAt": "...", "updatedAt": "..." }
      ]
    }
  ]
}
```

- **Section**: `id` (roman numeral, stable), `title`, ordered `items`.
- **Item**: `id` (`<section>-<n>`, stable across edits), `text`, `status`,
  optional `notes` (blocked reason / context), timestamps.
- **Statuses** (omp parity): `pending`, `in_progress`, `completed`,
  `abandoned`, `blocked` (blocked = waiting on external input; excluded from
  the incomplete count so it doesn't nag).
- **Single active pointer**: at most one `in_progress` item per section.
  Marking an item `in_progress` clears any other `in_progress` in the same
  section. No stale pointers allowed (mirrors omp's rule).
- **Counts**: per section `done/total` where `done` = `completed`,
  `total` = all items except `abandoned`; header shows global
  `Σ done / Σ total`.

## Rendering contract (omp parity)

Target render — byte-for-byte the shape omp produces:

```
TODO  (Σ 0/11)
 ├─ I. Discovery · 0/3
 │  ├─  Enumerate all key sources (keyring, env, files)
 │  ├─  Identify omp/prime/pi key schemas
 │  └─  List all 17 providers needing import
 ├─ II. Import-Omp · 0/2
 ├─ III. Import-Prime · 0/2
 ├─ IV. Import-Pi · 0/2
 ├─ V. Verification · 0/2
 └─────
```

- Section connectors: ` ├─ ` for all but the last, ` └─ ` for the last; a
  closing ` └─────` line ends the tree.
- Item connectors under a section: ` │  ├─ ` (non-last), ` │  └─ ` (last).
- Status glyphs: `` (unchecked) / `` (checked) prefix per item;
  `in_progress` items render with the unchecked glyph + `accent` color,
  `completed` with checked glyph + `dim`, `blocked` with `⛔` + `warning`,
  `abandoned` struck/dim.
- Counts `x/y` in `section title · x/y`; `0/0` sections render bare.
- Lines truncated to panel width (`truncateToWidth`, existing helper); no
  horizontal scroll.

## Behavior

### Panel
- `refresh()` re-reads `todo.json` each tick (same as other panels — edits
  from the CLI/agent appear live; no file watcher, no deps).
- Scrollable with existing `↑↓`; content capped to panel height with a
  `… N more` tail, matching the `upstream` panel.
- Optional interactive mode (`[todo] interactive = true`): with the Todo
  pane active, `space` toggles the selected item `pending ⇄ completed`, `n`
  marks it `in_progress` (single-pointer), `b` blocks it (prompts reason),
  `a` abandons, `r` reopens. Off by default — the pane is a status view;
  mutation belongs to commands/agent unless the user opts in.

### Commands
- `/todo` — print the tree (stdout, like `/omp-upstream`).
- `/todo append <section> <text>` — add an item to a section (default
  section = last, or `I` if empty).
- `/todo done <id>` · `/todo next <id>` · `/todo block <id> <reason>` ·
  `/todo reopen <id>` · `/todo reset` (clear all statuses; `--hard` clears
  the list).
- `/ompa todo` — alias of `/todo`.
- Completions for ids (`I-1`, …) and verbs.

### LLM tool — `ompa_todo`
- Read: full tree + statuses + timestamps (so the agent can orient).
- Mutate: `append`, `done`, `next`, `block`, `reopen` with the same
  semantics and single-pointer enforcement.
- **Agent contract** (mirrors omp's prompt rules, injected via the tool
  description + a line in the system prompt): before substantial work,
  compare next action with the todo; after each completed step, update it
  immediately; never leave a stale `in_progress` while working later phases.

## Seed content (first workload)

Seeded on first run (if `todo.json` missing), from the credential-import
drive:

| Section | Title | Items |
|---|---|---|
| I | Discovery | 3 — enumerate all key sources (keyring, env, files); identify omp/prime/pi key schemas; list all 17 providers needing import |
| II | Import-Omp | 2 — map discovered keys onto omp schema; import + persist |
| III | Import-Prime | 2 — map onto prime-agent schema; import + persist |
| IV | Import-Pi | 2 — map onto pi schema; import + persist |
| V | Verification | 2 — verify all 17 providers resolve in each harness; dry-run a call per provider |

The exact 17-provider list is owned by Discovery item I-3 (union across the
harness auth configs, keyring, and env; configs today already show
free-pi / google / groq / hf-dsv4 / mistral / novita / openrouter).

## Config

`ompr.toml`:

```toml
[todo]
file = "~/.prime/oh-my-prime-agent/todo.json"   # storage
interactive = false                              # panel checkbox toggles
# [tui] panels += "todo"                          # enable the pane

[tui]
panels = ["resource", "chat", "notifs", "souls", "fleet", "profile", "todo", "upstream", "help"]
```

Env: `OMPA_TODO_INTERACTIVE=1` override for a session.

## Implementation notes

- Lives in the existing `ompa-tui.ts` plugin (same file as the panel
  registry + commands) — no new plugin dir, no new symlink; follows the
  `upstream` panel precedent.
- Storage writes: read-modify-write `todo.json` with atomic rename
  (tmp + `renameSync`), never partial. Concurrent agent/CLI edits are safe
  because each writer re-reads before writing; last-writer-wins per item is
  accepted (single user).
- Ids stable: `I-1`… never renumber on reorder/delete (append-only
  semantics for ids).
- No new npm deps (node builtins only) — houseguest-thin.
- Panel + commands + tool share one loader (`loadTodo` / `saveTodo`); all
  mutations go through `saveTodo` so counts and single-pointer stay
  consistent.

## Acceptance criteria

1. `/todo` renders the seeded tree exactly in the omp format (§Rendering),
   with `0/3`, `0/2`… and global `Σ 0/11`.
2. `todo` pane appears in the dashboard when listed in `[tui] panels`, is
   keyboard-switchable, scrolls, and reflects file edits on the next tick.
3. `append` / `done` / `next` / `block` / `reopen` mutate `todo.json`;
   single-pointer holds (marking `next` clears sibling `in_progress`).
4. `block` items are excluded from `total` counts; `abandoned` likewise.
5. `ompa_todo` tool reads + mutates with the same semantics; agent contract
   text present in tool description.
6. `todo.json` survives `/reload`, session restart, and a git round-trip
   (no binary state, no absolute paths).
7. Interactive mode (opt-in): `space`/`n`/`b`/`a`/`r` work in the pane.
8. Fresh install with no `todo.json` seeds the I–V workflow.

## Non-goals (refused)

- No DAG / dependencies / due dates / priorities — a flat ordered tree only.
- No reminders or notifications from todo state (the upstream-drift watcher
  owns notification; todo is a plan surface, not an alarm).
- No cross-harness live sync — the file is the sync point (both harnesses
  read/write the same path; document as the contract).
- No markdown import/export in v1 (`todo.json` is the only format).
- Not a project manager; one todo list per machine (per
  `[todo] file`), not per project, in v1.
