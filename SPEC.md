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

## Milestones

- M1 (now): stable framework, git init, initial commit, license, README.
- M2: souls get persistence + memory vault; fabric gets rooms + routing polish.
- M3: governor gets telemetry history + status dashboard; theme engine gets
  previews.
- M4: one-command install on a fresh machine; multi-harness targets (Claude
  Code, Codex) gated behind demand.
- M5: public release (OSS) — decide A/B/C at M3, not now.

## Decisions deferred (deliberately)

- Personal vs OSS vs product (A/B/C): decide at M3 with a working M2.
- Multi-harness support: Prime-first until the ergonomics layer is proven.
- Memory backend (mem0 vs mempalace vs own): evaluate in M2 against souls.

## Principles

1. Thin beats comprehensive.
2. The machine is a citizen with rights (responsiveness first).
3. Bash for shell work; Python for logic.
4. Identity over anonymity (souls, not sessions).
5. Cut anything that a competitor already does better.
