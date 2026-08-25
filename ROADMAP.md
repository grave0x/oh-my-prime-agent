# ompa — Roadmap & Aspirations

> Companion to [SPEC.md](SPEC.md). SPEC says *what* ompa is and *why*; this
> says *where it's going* and *how it gets built*. `v0.1.0` (M1) shipped the
> framework, CLI, plugins, and themes — this is the path from here.
> **Release state:** the repo is public now (`v0.1.0`, this session). Direction
> is decided — **product** (free core, paid sitter, distro-default wedge; see
> SPEC.md §Direction). The formal OSS launch (M5) is still ahead.

## Aspirational goals

The north star, in order of ambition:

1. **The machine as a citizen with rights.** An agent on a desktop is a guest;
   the host's responsiveness outranks the agent's throughput — always. Every
   feature either serves that or is refused.
2. **More agents per dollar of hardware.** Efficiency is a throughput
   multiplier: a polite session uses a fraction of the box, so the same box
   runs more concurrent agents. Frameworks optimize per-session throughput and
   turn the machine into a tragedy of the commons; ompa optimizes per-machine
   throughput.
3. **Distro-default-thin.** The moat is being the layer a distro ships by
   default, not an opt-in heavyweight. Guest + sitter host-health is the thin
   core; everything else is an opt-in plugin.
4. **The sitter that anticipates.** An idle agent that watches full system
   state and acts *before* you feel it — suspend the runaway, kill the orphan,
   throttle the thrash, clear caches, notify. The capability is innate; ompa
   makes the obvious thing exist.
5. **Identity over anonymity.** Souls — durable agent identity (name,
   specialty, personality, project familiarity) — so an agent knows who it is
   and what it knows, instead of being an anonymous session.

6. **The personal immune system (Far Horizon).** If ompa ships distro-default,
   the resident becomes the machine's immune system: detect novel malware and
   undisclosed zero-days in the wild — not just signature matches — and
   auto-submit findings to bounties. The machine earns while it defends
   itself. Trust, false positives, disclosure ethics, and 24/7 model cost make
   this the ceiling, not the plan — see SPEC.md §"Far Horizon".

## Future implementation

### Near-term (M2) — souls + fabric

- **Souls** get persistence across sessions and a memory vault; per-project
  familiarity that compounds instead of resetting each run.
- **Fabric** gets rooms and routing polish: `::` broadcast, `:name:` direct
  routing to the most-familiar soul.

### Mid-term (M3) — governor + theme

- **Governor** gets telemetry history (load/mem/swap over time) and a status
  dashboard; throttle/hold decisions move from fixed thresholds to trend-aware
  prediction.
- **Theme engine** gets live previews, per-soul accents, Hyprland rules, and
  the notification box as a first-class panel.
- **Refine revenue/packaging** — direction is decided (product; see SPEC.md §Direction). Exact pricing and packaging land with a working M2.

### Longer-term (M4–M5) — distribution

- One-command install on a fresh machine.
- Multi-harness targets (Claude Code, Codex) gated behind demand.
- Distro packaging — thin enough to ship as a default.

### Deferred — the security ceiling (Far Horizon)

- Full EDR / malware detection stays out of core (kernel drivers,
  false-positive triage, regulation). It is the *Far Horizon* — the personal
  immune system from the aspirations above — reached only through the chain
  etiquette → efficiency → always-on resident → security, never by making the
  default heavyweight. If it ever ships, it's a separate *security-sentinel*
  plugin running through the governor.

## Tooling

### Release & CI automation

- A `release` workflow: tag push → auto-generate release notes from
  conventional commits → cut the GitHub Release. (`v0.1.0` was done by hand.)
- CI on push/PR: `bash -n` + `shellcheck` for `bin/ompa`; `.ts` typecheck for
  plugins; a config-lint for `ompr.toml`.

### Testing

- A bash test harness for `bin/ompa` (install / enable / disable / theme /
  status) running against a temp `OMPA_ROOT` and a fake extensions dir.
- Plugin smoke tests: each plugin loads into a Prime extension context and
  registers its tools/events without error.

### Packaging & distribution

- A real install target for the distro-default aspiration — not just
  `ln -s` + clone.
- `ompa self-update` once there's a release stream to pull from.

## How to read this

- **SPEC.md** — the contract: what, why, the Houseguest Rules, boundaries.
- **this file** — the direction: aspirations, implementation order, tooling.
- Milestones map to git tags (`v0.1.0` = M1 shipped).


## M2 progress (this session)

- **souls plugin shipped**: per-soul memory vault (`~/.prime/agent/souls/<name>.memory.jsonl`),
  `/remember` `/recall` `/forget`, 500-fact cap, durable across sessions.
- **Per-turn injection**: relevant facts (keyword hits + recent) appended to the
  system prompt via `before_agent_start` (proven path).
- **Auto-capture**: `agent_end` records "Worked on: …" facts when the prompt used
  tools, for claimed souls only, deduped — the vault fills itself.
- **Fix**: soul identity injection switched from `context`+`unshift` to
  `before_agent_start`+`systemPrompt` chaining (the delivery-reliable path).
- **Registry hygiene**: dead test souls removed; crypt/shovel restored as
  reserved identity records.

Remaining M2: memory vault eval (mem0/mempalace vs own — decision deferred in
SPEC), project-familiarity→memory cross-links, `/recall` UI polish.
