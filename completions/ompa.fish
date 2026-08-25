# ompa — oh-my-prime-agent fish completions
# Auto-installed by `ompa completions fish` / `ompa install`. Do not hand-edit;
# regenerate from the repo: ~/.prime/oh-my-prime-agent/completions/ompa.fish

set -l ompa_root "$HOME/.prime/oh-my-prime-agent"

# --- subcommands (first token) ---
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a install -d "link enabled plugins into Prime extensions"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a enable -d "enable one plugin"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a disable -d "disable one plugin"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a theme -d "apply a theme"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a status -d "show state"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a sync -d "write resource-policy.json from ompr.toml (single source)"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a gc -d "run hygiene GC now (dead-session artifacts > maxAgeDays)"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a fleet -d "fleet governor: running/queued/offloaded"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a prune -d "remove souls whose sessions are dead"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a completions -d "install shell completions (fish)"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a version -d "print version"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet prune completions version help" \
  -a help -d "show help"

# --- argument completions ---
complete -c ompa -f -n "__fish_seen_subcommand_from enable disable" \
  -a "(command ls -1 $ompa_root/plugins 2>/dev/null)" -d "plugin"
complete -c ompa -f -n "__fish_seen_subcommand_from theme" \
  -a "(command ls -1 $ompa_root/themes 2>/dev/null)" -d "theme"
complete -c ompa -f -n "__fish_seen_subcommand_from fleet" -a status -d "running X/15, queued Y, offloaded Z"
complete -c ompa -f -n "__fish_seen_subcommand_from fleet" -a reap -d "force-reap finished subagents"
complete -c ompa -f -n "__fish_seen_subcommand_from fleet; and __fish_seen_subcommand_from reap" -l all -d "reap everything (zombie guard bypass)"
complete -c ompa -f -n "__fish_seen_subcommand_from completions" -a fish -d "fish completions"

# --- top-level reap / enable-reap (auto cleanup) ---
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet reap enable-reap prune completions version help" \
  -a reap -d "kill idle omp/pi background workers (auto-cleanup)"
complete -c ompa -f -n "not __fish_seen_subcommand_from install enable disable theme status sync gc fleet reap enable-reap prune completions version help" \
  -a enable-reap -d "wire the 5-min systemd user timer (auto)"

# --- flags ---
complete -c ompa -s V -l version -d "print version"
complete -c ompa -s h -l help -d "show help"
