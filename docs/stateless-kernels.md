# Stateless kernels — brainstorm

> Companion to [SPEC.md](../SPEC.md) and [SPEC-DETAIL.md](../SPEC-DETAIL.md).
> Question this session: *which additional stateless kernels could ompa add or
> build — and which are worth it?* Every idea below gets: use case, benefits,
> failures & weak points, cost/benefit. Verdict per idea. Measured numbers are
> from grave's box (12 cores / 15 GB RAM / zram swap) unless noted.

## What "kernel" means here

Prime already runs one **stateful** IPython kernel per session: variables
persist, skills are pre-imported, snapshots survive resume. That is powerful
and expensive — roughly **0.5–1.5 GB RSS per kernel** on this box, and every
restart pays a bootstrap + snapshot cost.

A **stateless kernel** is an execution backend with *no user namespace*: every
call starts from the same empty baseline, returns a result, and leaves nothing
behind. Trade-off: zero persistence vs. zero residue. Stateless backends are
perfect for **trusted, repeatable, cheap operations**; the stateful kernel is
for everything that needs continuity.

The evaluation lens is the ompa north star: *more agents per dollar of
hardware, politely*. A kernel is only worth adding if it makes the box quieter
or the agent faster for a class of work that the stateful kernel currently
over-serves.

---

## Idea 1 — stateless sandboxed shell kernel (`bash-sandbox`)

**What:** a subprocess-per-call bash backend: spawn `/bin/bash -c '<cmd>'`
under a fresh cgroup/session with rlimits (CPU, RSS, no-new-privs, timeout,
nice/ionice), capture stdout/stderr, kill on timeout, return. No state between
calls. This is a *hardened* version of what the built-in bash tool already
does, with per-call isolation and guaranteed reaping.

**Use case:** untrusted-ish snippets, third-party scripts, anything the agent
should be able to *walk away from*. Also the correct backend for the "run this
one command" 80% of bash calls that never need the stateful kernel.

**Benefits:**
- A stuck build/script **cannot leak**: rlimit + timeout + cgroup kill, every
  time. Houseguest rule #1 becomes structural.
- Cheap: no Python interpreter, no snapshot, near-zero baseline RSS (a fork of
  bash ≈ 2–5 MB vs 500+ MB for the IPython kernel).
- Isolatable per-call env (PATH, HOME, secrets) with zero carry-over — a
  natural secret boundary.

**Failures & weak points:**
- No continuity: `cd`, `export`, backgrounded jobs, and installed packages
  reset every call. Agents compensate by re-typing setup — token cost.
- Background processes that escape the cgroup (double-fork) can orphan; needs
  a reaper tick (fleet §7.5 pattern).
- Pipes/chains need the same `bash -c` wrap the resource-guard already applies.
- Shell is not a programming language: complex logic still goes to Python.

**Cost/benefit:** low cost (a few hundred lines; we already throttle/hold bash
in resource-guard). High benefit for the 80% single-shot case and for any
"run this and forget it" job. **Verdict: build — as a mode of the existing
bash tool, not a new tool.** Priority: high.

---

## Idea 2 — stateless Python kernel (`py-runner`)

**What:** `python3 -c <script>` (or `python3 -` on stdin) with the same
rlimits/timeout/cgroup treatment as Idea 1, on a frozen venv containing only
the pre-installed skill modules (requests, httpx, yaml, pandas, …). No
namespace, no snapshot, no ipykernel — just "run this script, give me the
result".

**Use case:** the ~60% of ipython calls that are *pure function calls* —
parse JSON, transform data, compute a number — where the persistent kernel's
state is unused. Also the natural runner for skills that are pure functions.

**Benefits:**
- Massive memory relief: one shared stateless worker (or per-call fork of a
  warm interpreter) instead of N resident kernels. Even one resident
  stateful kernel per agent × 48 processes is 2.8 GB RSS + 2.6 GB swap today
  (OPTIMIZE.md S1); moving pure-function calls to a stateless worker removes
  the *reason* for many kernels to stay alive.
- Isolation: a crashy script dies alone, not the session kernel.
- Deterministic: same input → same output, trivially cacheable.

**Failures & weak points:**
- Startup latency: cold `python3 -c` ≈ 40–80 ms here (imports dominate). Below
  ~10 ms/call the stateful kernel wins on latency, but agent-scale calls are
  mostly ≥ 100 ms anyway.
- No access to session state (`rlm`, skills, kernel variables) — the RLM
  host-request channel must be explicitly re-enabled per call or the stateless
  runner is blind.
- Package drift: the frozen venv must track the kernel's skill set.
- Does NOT replace the stateful kernel for debugging sessions where the user
  *wants* the notebook.

**Cost/benefit:** medium cost (bootstrap venv, rlimit wrapper, skill shims).
High benefit — this is the single biggest memory win on the measured surface.
**Verdict: build — DONE (v1).** Priority: high. Shipped as the `kernel-pilot`
plugin (SPEC-DETAIL §11): additive `py` stateless tool + hot-swappable
`ipython` router (`auto` classifies per call: rlm/skills/magics/await →
kernel; pure → runner; `/kernel auto|stateless|stateful` swaps live). The
runner uses the kernel venv, nice 19, timeout, output caps, and echoes the
last top-level expression notebook-style. A per-call spawn costs 40–80 ms
cold; a warmed worker pool is the natural v2.

---

## Idea 3 — jq/sqlite read-only data kernels (`query-runner`)

**What:** two tiny stateless backends: `jq` for JSON and `sqlite3 :memory:`
(or a read-only file handle) for SQL. Each call is one command; output is
bounded (head/tail caps). The query *is* the state.

**Use case:** the agent's most common "data" operations today — filter a JSONL
log, join two CSVs, aggregate a state file. Currently these burn a full
ipython kernel call (with all its overhead) or a bash call with fragile
`awk`/`jq` quoting.

**Benefits:**
- Near-zero overhead: jq is ~5 MB resident, sqlite ~1 MB; a call is one
  process, one result.
- Enforced read-only for sqlite/jq by construction — safe against
  foot-guns on state files.
- Deterministic + cacheable; trivially time-boxed.

**Failures & weak points:**
- Another tool choice to learn; model must know when to use jq vs python.
- SQL is a bigger surface than most agents need; JSON via jq is unforgiving
  for nested transforms.
- Two more executables to ship/verify on fresh machines (distro-default-thin
  tension).

**Cost/benefit:** low cost, moderate benefit. It competes with "bash with jq"
which already exists on most boxes. **Verdict: don't build as kernels —
document the one-liners instead** (bash-first plugin already nudges this).
Priority: low.

---

## Idea 4 — WebAssembly/wasm microkernel (`wasm-runner`)

**What:** a wasmtime/wasmer-based runner for WASM/WASI binaries — the
"containers without the container" kernel. Each call gets a fresh wasm
instance, 1–64 MB memory cap, deterministic syscall surface.

**Use case:** running untrusted or third-party tools (parsers, converters,
minifiers, single-file binaries) with hard memory/CPU isolation, no process
spawn overhead.

**Benefits:**
- Strong isolation at ~10 MB runtime, faster than cgroup+fork for many small
  jobs.
- Cross-platform binaries (one .wasm runs anywhere) — fits distro-default
  packaging.
- No kernel snapshot, no state, trivially parallel.

**Failures & weak points:**
- Ecosystem: most real tools are not WASI-compiled; the useful subset today is
  small (wasm-tools, some parsers).
- Debugging inside wasm is painful; network/syscall support is still uneven.
- Adds a runtime dependency (wasmtime ≈ 30–60 MB installed) against the thin
  principle.

**Cost/benefit:** medium-high cost, speculative benefit today. **Verdict:
defer** until a concrete tool demand appears (gate behind a plugin).
Priority: low.

---

## Idea 5 — stateless RLM "mini-kernel" (skill-only runner)

**What:** a bootstrapped python process that loads ONLY the installed skill
modules (agent_email, websearch, task_manager, …) and exposes them as pure
functions over a simple protocol — no ipykernel, no user namespace, no
snapshot. Effectively "the skill layer without the notebook".

**Use case:** every skill call that does not need kernel state: send email,
search the web, notify, list agents. Today each of these rides the full
stateful kernel (and its RSS).

**Benefits:**
- Same isolation/price wins as Idea 2 but scoped to the *installed skill
  contract* — skills already declare their imports/callables, so a runner can
  be generated from the manifest.
- Skills are the refinement unit (refine creates/updates skills), so a
  stateless skill runner makes **every refinement testable without a session**:
  distill → validate skill → run in mini-kernel → observe. This directly
  assists the refine loop from the other direction.
- One shared worker per machine (not per session) can multiplex skill calls —
  the fleet already wants this.

**Failures & weak points:**
- Skills that genuinely need kernel state (edit uses the file system, rlm
  spawns children) must be explicitly marked stateful or rejected.
- The skill contract currently assumes a live kernel (`await <import>.<fn>`);
  a mini-kernel needs a call-serialization layer.
- Auth/secrets must be plumbed per-call, not via kernel env.

**Cost/benefit:** medium cost, high benefit — it is the *test harness* for
refine itself plus a memory win. **Verdict: build the runner as the refine
validation backend first** (smallest scope), then generalize to skills.
Priority: medium-high. The kernel-pilot `py` runner is the first slice of
this — stateless, venv-scoped, call-serializable; wiring it as the /refine
skill-test bed is a small follow-up.

---

## Idea 6 — cron/tick stateless kernel (`ticker`)

**What:** a minimal, single-purpose kernel that never takes user input —
only fires scheduled actions (distill profile, run hygiene GC, sample
telemetry, notify on threshold) with no state between ticks.

**Use case:** the sitter (SPEC §6) and the governor ticks (fleet §7.5,
hygiene §7.7) today live inside session processes; a dedicated ticker isolates
them from any session's lifecycle.

**Benefits:**
- The sitter survives session teardown — it is machine-scoped, not
  session-scoped.
- Deterministic, low-frequency, tiny (one process, ~10 MB, sleeps between
  ticks).
- One place for all "native governor tick" work; audit via one log.

**Failures & weak points:**
- A daemon is the opposite of stateless in the "no residue" sense — it is
  *stateful* across ticks (needs a crash-restart story, socket or dbus
  supervision).
- The ticker must not become a second always-on model — it should be pure
  logic + notify, zero LLM by default.

**Cost/benefit:** low-medium cost, high benefit but only for the M3 sitter
milestone. **Verdict: defer to M3** (spec exists; §6.3 action loop is the
spec). Priority: low until sitter work starts.

---

## Idea 7 — GraphQL/REST "data-fetch kernel" (`fetch-runner`)

**What:** a stateless runner wrapping undici/curl with declarative fetch
options (url, headers, body, timeout, size cap) returning normalized JSON/text
— plus optional `jq` post-processing (Idea 3).

**Use case:** the ~40% of agent turns that call an API. Today they go through
bash curl (quoting hell) or ipython requests (kernel overhead).

**Benefits:**
- One consistent, bounded, time-boxed fetch primitive; response size caps stop
  context bloat (ties to OPTIMIZE.md S5 — tokens are the expensive resource).
- Cacheable: identical GETs within a window can hit a shared cache — a
  stateless kernel is the perfect cache key (input → output).

**Failures & weak points:**
- Auth handling: secrets must be injected per-call from the existing Bitwarden
  / secret-service policy, which adds plumbing.
- Streams/large downloads don't fit the "return a value" model; those stay in
  bash/python.
- Overlaps with the websearch skill; risk of a second way to do the same
  thing.

**Cost/benefit:** low cost, moderate benefit. **Verdict: fold into the
mini-kernel (Idea 5) as a built-in `fetch` skill** rather than a separate
kernel. Priority: low-medium.

---

## Ranking

| idea | cost | benefit | fits ompa thin? | verdict |
|---|---|---|---|---|
| 1 bash-sandbox | low | high (isolation for the 80% single-shot case) | yes | build (mode of bash tool) |
| 2 py-runner | medium | high (biggest memory win: stateless pure functions) | yes | **built (v1): kernel-pilot plugin** |
| 5 skill mini-kernel | medium | high (refine validation backend + memory win) | yes | build as refine testbed first (kernel-pilot runner is slice 1) |
| 3 jq/sqlite query | low | moderate | yes | document one-liners, no kernel |
| 7 fetch-runner | low | moderate | yes | fold into mini-kernel |
| 6 ticker | low-med | high (sitter) | yes | defer to M3 sitter |
| 4 wasm-runner | med-high | speculative | borderline | defer (plugin-gated) |

## The one-liner

**py-runner is built** (kernel-pilot plugin, v1: stateless `py` tool +
hot-swappable `ipython` router). Next up: **bash-sandbox** (hard isolation
for single-shot shell) and the **skill mini-kernel as the /refine validation
backend** (kernel-pilot's runner is slice 1). Everything else is either a mode
of those two or waits for the sitter. The cheapest win left on this box is
the /refine validation backend, because it turns every refinement into a
runnable test instead of a hope.
