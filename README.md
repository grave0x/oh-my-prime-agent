# oh-my-prime-agent (`ompa`)

Desktop-ergonomics framework for Prime Agent. One install, plugin + theme
system, alias `ompa` (avoids collision with oh-my-posh `omp` / oh-my-pi).

## Install

    git clone https://github.com/grave0x/oh-my-prime-agent ~/.prime/oh-my-prime-agent
    ln -s ~/.prime/oh-my-prime-agent/bin/ompa ~/.local/bin/ompa
    ompa install

## Plugins

| plugin | what it does |
|---|---|
| resource-guard | record/throttle/hold heavy tool calls; inject live load/mem/swap as context |
| global-chat | `::` global chat, `:name:` direct routing, souls + project familiarity |
| notif-box | in-TUI notifications panel (reads the terminal-notif log) |
| bash-first | per-turn tool-choice heuristic: shell for shell work, ipython for logic |
| self-profiler | thin in-session profiler: tool latency/errors, repeated shell patterns, refine hints (`/profile`) |
| ompa-tui | modular dashboard (`/dashboard`, `ctrl+alt+o`) + compact status widget + **upstream-drift panel**; panel registry, config-driven, rebuilds on `/reload` |
| kernel-pilot | hot-swappable execution backends: stateless `py` runner + `ipython` router (auto/stateless/stateful), prompt guidance |

## Commands

    ompa install            link enabled plugins into ~/.prime/agent/extensions
    ompa enable <plugin>    enable one plugin
    ompa disable <plugin>   disable one plugin
    ompa theme cp2077       apply a kitty tab-bar theme
    ompa status             show plugin/theme/soul state
    ompa refine-prime       gate /refine prime-modification access (enable|disable|status)
    ompa upstream           check priv builds vs upstreams now (notify + file issues on lag)
    ompa kernel-pilot       hot-swap ipython backends (patch|unpatch|status)

## Config

`~/.prime/oh-my-prime-agent/ompr.toml` — resource thresholds, enabled plugins,
theme, souls dir. Edit, then `ompa install`.

## Why

CLI-first agents optimize for headless boxes. On a desktop the same agent
behaviour freezes your keyboard. This bundle makes Prime desktop-aware:
resource budgets + hold/throttle, bash-first tool choice, agent identity
(souls), and cross-agent chat routed through the same agent-message channel.

## Roadmap

Future implementation, tooling, and aspirations: [ROADMAP.md](ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).
