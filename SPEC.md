# ompa — SPEC

> North star: **Think Different.**
> The components (skills, MCP, memory) already exist. ompa asks the question
> nobody else is asking: *what does it feel like when the agent runs on your
> machine?* — and builds the layer that makes the agent a good citizen.

## Pitch (one line)

ECC and superpowers optimize the agent. Ruflo federates the agents.
ompa makes the agent a good citizen on your desktop.

## What ompa IS

A thin desktop-ergonomics layer for Prime Agent (and, later, other CLI
harnesses). Four pillars:

1. **Resource governor** — record / throttle / HOLD heavy tool calls against a
   global policy; inject live load/mem/swap as per-turn context so the agent
   can *feel* the machine before it acts.
2. **Souls** — durable agent identity: name, specialty, personality, project
   familiarity. Injected per turn. Agents know who they are and what they know.
3. **Fabric** — cross-agent chat (`::` broadcast, `:name:` direct), rooms,
   routing to the most-familiar soul.
4. **Theme engine** — gradient tab bars, per-soul accents, Hyprland rules,
   notification box. Desktop aesthetics as a first-class feature.





## Two Modes (the core product insight)

An agent is either working or idle. ompa gives it good behavior in both:

1. **Guest mode** (working on your task) — the Houseguest Rules. Throttle, hold,
   clean up after itself.
2. **Sitter mode** (idle) — a resident caretaker. Watches full system state
   (load, mem, swap, cgroups, journald) and reacts to anomalies *before* you
   feel them: notify → throttle → renice → kill → suspend → hibernate
   (escalation ladder). Hibernate when idle + no jobs + (low battery |
   sustained thermal/swap pressure); checkpoint jobs first. Suspect processes are **suspended first** (SIGSTOP or
   cgroup freezer), inspected via /proc/<pid>, then resumed, killed, or
   quarantined.
   caches, notify you.

Why this matters economically: efficiency is a **throughput multiplier**, not a
sacrifice. A polite session uses a fraction of the machine, so the same box
runs more concurrent agents. Frameworks optimize per-session throughput, which
turns the machine into a tragedy of the commons. ompa optimizes per-machine
throughput — more agents per dollar of hardware.

The absurdity that motivates this: an agent *can* already sit idle watching the
full system state and act the instant a slowdown appears — the capability is
innate — yet no common tool does it. ompa makes the obvious thing exist.

## The Houseguest Rules (the real spec)

An agent on your machine is a guest in your house. These are non-negotiable:

1. **Never leave the oven on.** If you start a job, you own it to completion or
   kill it. No orphaned builds, no `nohup` nobody reaps, no stale processes.
2. **Replace the roll if asked.** Do the implied task, not just the literal
   command. "Run the build" includes cleaning up after it.
3. **Take out the trash.** Proactively clean what you made: temp files, stale
   sessions, dead souls, dirty artifacts, old logs. Don't wait to be told.
4. **The machine is the host.** You are the guest. When the host is busy, wait.
   When the host is idle, you may hurry. The host's responsiveness outranks
   your throughput — always.
5. **Leave it cleaner than you found it.** Every session ends with a sweep.

The streaming-lag case proves this is not about local vs cloud. Even a cloud
API can tax the machine if the harness renders tokens without restraint. ompa
therefore governs BOTH: what the agent runs, and how the harness renders it.

## What ompa ADOPTS (steal shamelessly)

- superpowers: skills-as-methodology (trigger + when-to-use, not just code);
  a `writing-skills` bootstrapper; marketplace model.
- ECC: "harness OS" framing; unified memory vault concept; dashboard GUI;
  multi-harness install targets (scoped, not sprawling).
- ruflo: one-line installer; MCP server packaging; federation/rooms.

## What ompa DIFFERENTIATES on (the gap nobody owns)

- Desktop governor (hold/throttle/context). ECC "performance" = token
  efficiency, not machine responsiveness.
- Souls with identity + project familiarity. openhuman has life-memory, not
  agent identity.
- Theme engine. Pure desktop aesthetics — none of them touch it.
- Bash-first heuristic. Nobody encodes tool-choice ergonomics.
- Thin. Focused ergonomics layer, not a kitchen-sink OS.

## What ompa will NOT do

- NOT a general agent framework (langchain, autogen, crewAI own that).
- NOT a skills megastore (superpowers/anthropics own that).
- NOT a model router / provider layer.
- NOT a token-compression or context-engineering product (headroom, context-mode).
- NOT social-graph rankers, brand-voice, video generation, or prediction-market
  skills (ECC sprawl — refused).
- NOT a web dashboard with accounts (until proven needed; CLI + TUI first).

Every rejected feature above has a competitor that already does it better.
ompa wins by refusing to compete there.





### Agent-native inspection (why it stays thin)

A suspended PID is inspected with the Python kernel the agent already has —
no kernel driver, no pre-shipped signature DB, no SOC team:

- `/proc/<pid>` — maps, cmdline, environ, fd, status, cgroup, oom_score
- `pyelftools` — ELF structure, sections, imports
- `capstone` — disassembly of suspicious code
- `yara` — optional signature matching
- `angr` / `volatility` — heavier symbolic execution / memory forensics

The inspector is the model: it writes a bespoke inspection script per case,
instead of matching against a fixed signature set. EDR ships signatures; ompa
ships a model that writes its own forensics. Forensics itself is CPU-heavy, so
it runs through the same governor — a polite coroner, not another hog.

## Distribution principle

**Thin enough to ship as a distro default.** The moat is being the layer a
distro can include by default — not an opt-in heavyweight. Guest + sitter
host-health is the thin core. Everything else is an opt-in plugin.

## Explicitly NOT the core (heavy, opt-in)

- Full EDR: malware / zero-day detection is CrowdStrike/SentinelOne/Microsoft
  Defender territory — kernel drivers, false-positive triage, regulation.
- Automated bug-bounty submission with payments: authorization, liability, and
  bounty ToS make this a legal minefield, not a thin feature.
- These may become a later opt-in *security-sentinel plugin*, never the default.
  The moment ompa tries to be EDR, it stops being distro-default-thin.

## Milestones

- M1 (now): stable framework, git init, initial commit, license, README.
- M2: souls get persistence + memory vault; fabric gets rooms + routing polish.
- M3: governor gets telemetry history + status dashboard; theme engine gets
  previews.
- M4: one-command install on a fresh machine; multi-harness targets (Claude
  Code, Codex) gated behind demand.
- M5: public release (OSS) — the distribution channel; direction decided (product).

## Direction: PRODUCT (decided)

ompa is a product direction — not a personal dotfiles bundle, not just OSS.
Personal use is the dogfood (we run it on grave's machine every day); OSS is
the distribution channel; the product is the paid layer.

Revenue shape (to be refined at M3, not blocking):
- Free: core ergonomics layer (guest rules, throttle/hold, bash-first, themes).
- Paid: the sitter — always-on resident caretaker, telemetry history, and
  (far horizon) the security/immune-system layer.
- Distro-default thinness is the wedge: if a base image ships ompa, the
  paid sitter is the natural upgrade. "More agents per dollar of hardware"
  is the buyer's argument.

## Decisions deferred (deliberately)

- Multi-harness support: Prime-first until the ergonomics layer is proven.
- Memory backend (mem0 vs mempalace vs own): evaluate in M2 against souls.
- Exact pricing/packaging: at M3 with a working M2.

## Principles

1. Thin beats comprehensive.
2. The machine is a citizen with rights (responsiveness first).
3. Bash for shell work; Python for logic.
4. Identity over anonymity (souls, not sessions).
5. Cut anything that a competitor already does better.


## Far Horizon (the ceiling — not M2/M3, but the reason the foundation matters)

If ompa is thin enough to ship by default in a distro image, the resident
becomes a **personal immune system**:

- Watch full system state for anomalies (process, network, file, memory).
- Detect novel malware and undisclosed zero-days in the wild — not just
  signature matches.
- Automatically submit findings to vendor/community bounties, with payment
  wired to the machine's own bank.

The machine earns while it defends itself.

Hard problems — why this is horizon, not now:
- **Trust.** The sitter is the highest-value process on the box. It must
  defend itself (integrity, attestation) or malware targets it first.
- **False positives.** Junk submissions burn bounty reputation fast.
- **Disclosure ethics.** Finding vs. selling zero-days is a legal line.
- **Cost.** A capable model running 24/7 is only viable because the
  houseguest rules free the headroom.

The chain: etiquette → efficiency → always-on resident → security.
Each layer works only because the one below it is thin.
