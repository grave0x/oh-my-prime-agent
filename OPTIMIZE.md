# ompa — Optimization surface map (measured)

> The deep optimization surfaces inside prime/omp, measured on grave's box
> (12 cores, 15 GB RAM, zram swap), each with its ompr target. Evidence over
> opinion: every number below was read off this machine, not guessed.
> Companion to SPEC-DETAIL.md — the targets live in `ompr.toml`.

> **Build status (2026-08-25):** S3/S4/S6 **BUILT** — `ompa sync`
> (single-source config → resource-policy.json) + `ompa gc` (dead-session
> artifacts + state-file rotation), tested by `tests/test-ompa.sh` (36 checks,
> all passing). S5 **BUILT** — resource-guard.ts §1.8 injection rate-limit.
> S1/S2/S7 **BUILT (v1)** — `ompa reap` auto-cleanup: provably-idle omp
> background workers killed (idle CPU check + [inference] idleTimeoutMs),
> zombies reported, wired as a 5-min systemd user timer (`ompa enable-reap`;
> auto-enabled by `ompa install`). S8 pending (fleet cap/offload — kernel work).
> New this session: `ompa-tui` (modular panel dashboard + status widget, §8),
> `self-profiler` (per-tool latency/errors + refine hints, §9) and refine
> prime access (audited `prime` edits, §10) — the profiler gives /refine
> evidence, and prime edits let refine tune the config surface it owns.

## Surface 1 — Idle worker memory (the big one)

Measured: **48 resident agent processes** (26 `omp` + 22 `prime-agent`)
≈ **2.8 GB RSS + 2.6 GB swap**, most S-state (sleeping). prime's native
`idleEvictionMinutes=30` only covers prime's own session manager — omp's TUI
workers and background workers sit outside it.

ompr target:
- `[fleet]` offload-on-wait (SPEC-DETAIL §7.2): a waiting agent is
  checkpointed and released, not parked in RAM.
- `[inference]` idle shutdown for omp background workers (Surface 2).

## Surface 2 — omp background workers (inference/embed/tab/broker)

Measured: `__omp_worker_tiny_inference` holds **1.1–1.6 GB RSS** when active;
`__omp_worker_mnemopi_embed` ×2 resident; plus `__omp_worker_tab`,
`__omp_worker_stt`/`tts`, `__omp_worker_daemon_broker`. These are omp-internal
and currently outside any governor.

ompr target:
- `[inference] idleTimeoutMs`: workers shut down after idle, respawn on demand.
- `[resource] governOmpWorkers`: omp-internal jobs run through the same
  throttle/hold as bash builds (nice 19, ionice 3, hold when pressured).

## Surface 3 — Session-artifact litter

Measured: **934 MB** in `session-artifacts` (105 dirs, 50 older than 7 days);
99 MB of session transcripts. Nothing reaps it; it grows without bound.

ompr target:
- `[hygiene] artifactMaxAgeDays=14`: `ompa gc` removes artifacts/transcripts
  of dead sessions older than the cap — runs as a **native governor tick**,
  not a command you remember to run (houseguest rule #3).

## Surface 4 — Config duality (drift risk)

Measured: the governor is configured **twice** — prime reads
`~/.prime/agent/resource-policy.json`; ompa reads `ompr.toml [resource]`.
Same values today; nothing enforces it stays that way. Drift = a governor
that throttles differently than the operator intends.

ompr target:
- `ompa sync`: `ompr.toml` is the single source; `ompa sync` rewrites
  `resource-policy.json` from it. Invariant #14: they never diverge.

## Surface 5 — Per-turn injection cost

Measured: every session appends `[Resource context]` + `[Soul memory]` +
`[Soul identity]` every turn (`before_agent_start`). 25 sessions × N turns =
memory and API tokens spent re-stating what didn't change.

ompr target:
- `[inject] rateLimitTurns=10`: resource context re-injected only when the
  pressure state changed or every N turns.
- Identical block across turns → skipped (dedupe, not per-turn append).

## Surface 6 — Unbounded state/log growth

Measured: `resource-guard/usage.jsonl` at 1.4 MB and growing; `chat.jsonl`,
`notif.log`, fleet `runs.jsonl` have no caps.

ompr target:
- `[hygiene] logMaxMB=8` per state file; rotate on write (append → drop
  oldest half). Houseguest rule #3.

## Surface 7 — Zombies & unreaped work

Measured: 1 zombie resident; finished subagents have no native reaper.

ompr target: fleet §7.5 zombie guard (30 s tick, `reapGraceMs` 60 s) —
native, not manual.

## Surface 8 — Structural swap pressure

Measured: **11 GB / 15 GB zram in use**, 2.6 GB of it held by agent
processes; builds (rustc up to 2.4 GB) collide with inference (1.6 GB).

ompr target: `[fleet] maxSubagents=15` + offload = the only structural
answer; the cap keeps the fleet at what the box can actually carry, and
`governOmpWorkers` keeps heavy workers from stacking on top of builds.
