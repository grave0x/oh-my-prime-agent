#!/usr/bin/env bash
# Anti-slop test harness for ompa sync + gc + hygiene.
# Every check CAN fail: asserts real behavior (values, ages, safety rails).
# Sandboxed: temp HOME + OMPA_ROOT + a mocked `prime-agent` registry.
set -uo pipefail

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD/home"
export OMPA_ROOT="$TD/repo"
mkdir -p "$HOME/.prime/agent/souls" "$HOME/.prime/agent/session-artifacts" \
         "$HOME/.prime/agent/sessions" "$HOME/.local/state/resource-guard" \
         "$HOME/.local/state/agent-chat" "$HOME/.local/state/terminal-notif" "$OMPA_ROOT"
cp "$(dirname "$0")/../bin/ompa" "$TD/ompa"
chmod +x "$TD/ompa"

LIVE="aaaa1111-2222-3333-4444-555566667777"

mock_registry() { # $1 = mode: ok | fail
  mkdir -p "$TD/bin"
  if [ "$1" = ok ]; then
    cat > "$TD/bin/prime-agent" <<MOCK
#!/usr/bin/env bash
[ "\${1:-}" = "list" ] || exit 0
echo '{"sessions":[{"sessionId":"$LIVE","id":"$LIVE"}]}'
MOCK
  else
    printf '#!/usr/bin/env bash\nexit 1\n' > "$TD/bin/prime-agent"
  fi
  chmod +x "$TD/bin/prime-agent"
  export PATH="$TD/bin:$PATH"
}

write_fixture() { # $1 = ompr.toml content
  cat > "$OMPA_ROOT/ompr.toml"
}

write_fixture <<'EOF'
[package]
version = "0.0.0"

[resource]
maxLoad1 = 7
minMemAvailMB = 900
maxSwapUsedMB = 5000
pollMs = 1000
maxHoldMs = 120000
maxJobs = 3
niceLevel = 19
ioClass = 3

[hygiene]
artifactMaxAgeDays = 1
logMaxMB = 1
EOF

fail=0
check() { # name cmd...
  local name="$1"; shift
  if "$@"; then printf 'PASS  %s\n' "$name"; else printf 'FAIL  %s\n' "$name"; fail=1; fi
}

POLICY="$HOME/.prime/agent/resource-policy.json"
mock_registry ok

# ---------------- sync ----------------
"$TD/ompa" sync >/dev/null 2>&1
check "sync writes policy file"                    test -f "$POLICY"
check "sync maps maxLoad1=7"                       python3 -c "import json;assert json.load(open('$POLICY'))['maxLoad1']==7"
check "sync maps minMemAvailMB=900"                python3 -c "import json;assert json.load(open('$POLICY'))['minMemAvailMB']==900"
check "sync maps maxSwapUsedMB=5000"               python3 -c "import json;assert json.load(open('$POLICY'))['maxSwapUsedMB']==5000"
check "sync maps maxJobs=3"                        python3 -c "import json;assert json.load(open('$POLICY'))['maxJobs']==3"
check "sync maps niceLevel=19"                     python3 -c "import json;assert json.load(open('$POLICY'))['niceLevel']==19"
check "sync emits valid JSON"                      python3 -c "import json;json.load(open('$POLICY'))"
check "sync has 3 default heavyPatterns"          python3 -c "import json;assert len(json.load(open('$POLICY'))['heavyPatterns'])==3"
check "sync keeps tools=[bash,ipython]"           python3 -c "import json;assert json.load(open('$POLICY'))['tools']==['bash','ipython']"
# perProject preservation across re-sync
python3 -c "import json;p=json.load(open('$POLICY'));p['perProject']={'/x':{'maxJobs':2}};open('$POLICY','w').write(json.dumps(p))"
"$TD/ompa" sync >/dev/null 2>&1
check "sync preserves perProject from old policy"  python3 -c "import json;assert json.load(open('$POLICY'))['perProject']=={'/x':{'maxJobs':2}}"
s1=$(sha256sum "$POLICY" | cut -d' ' -f1)
"$TD/ompa" sync >/dev/null 2>&1
s2=$(sha256sum "$POLICY" | cut -d' ' -f1)
check "sync is idempotent (no drift on re-run)"    test "$s1" = "$s2"
check "sync backs up previous policy"              test -f "$POLICY.bak-ompa"

# sync honors arrays from ompr.toml when present
write_fixture <<'EOF'
[resource]
maxLoad1 = 5
tools = ["bash"]
heavyPatterns = ["patA", "patB"]
perProject = {"/home/grave/Projects/Moonshell": {"maxJobs": 2}}
EOF
rm -f "$POLICY" "$POLICY.bak-ompa"
"$TD/ompa" sync >/dev/null 2>&1
check "sync uses ompr.toml tools override"         python3 -c "import json;assert json.load(open('$POLICY'))['tools']==['bash']"
check "sync uses ompr.toml heavyPatterns override" python3 -c "import json;assert len(json.load(open('$POLICY'))['heavyPatterns'])==2"
check "sync maps overridden maxLoad1=5"            python3 -c "import json;assert json.load(open('$POLICY'))['maxLoad1']==5"
check "sync maps ompr.toml perProject"             python3 -c "import json;assert json.load(open('$POLICY'))['perProject']=={'/home/grave/Projects/Moonshell':{'maxJobs':2}}"
check "sync writes injectRateLimitTurns default"   python3 -c "import json;assert json.load(open('$POLICY'))['injectRateLimitTurns']==10"

# ---------------- gc ----------------
write_fixture <<'EOF'
[hygiene]
artifactMaxAgeDays = 1
logMaxMB = 1
EOF
mkdir -p "$HOME/.prime/agent/session-artifacts/$LIVE"
touch -d "40 days ago" "$HOME/.prime/agent/session-artifacts/$LIVE"
mkdir -p "$HOME/.prime/agent/session-artifacts/deadbbbb-2222-3333-4444-555566667777"
touch -d "40 days ago" "$HOME/.prime/agent/session-artifacts/deadbbbb-2222-3333-4444-555566667777"
mkdir -p "$HOME/.prime/agent/session-artifacts/deadcccc-2222-3333-4444-555566667777"   # fresh (age gate: kept)
mkdir -p "$HOME/.prime/agent/session-artifacts/not-a-uuid-dir"
touch -d "40 days ago" "$HOME/.prime/agent/session-artifacts/not-a-uuid-dir"          # non-UUID litter: must survive
printf 'x\n' > "$HOME/.prime/agent/sessions/$LIVE.jsonl"
printf 'x\n' > "$HOME/.prime/agent/sessions/deadbbbb-2222-3333-4444-555566667777.jsonl"
touch -d "40 days ago" "$HOME/.prime/agent/sessions/deadbbbb-2222-3333-4444-555566667777.jsonl"
python3 -c "open('$HOME/.local/state/resource-guard/usage.jsonl','w').write('\n'.join(str(i) for i in range(1, 250001)) + '\n')"  # 250000 lines, ~1.5MB > 1MB, line N is 'N'

"$TD/ompa" gc >/dev/null 2>&1
check "gc removed dead-old artifact"       test ! -d "$HOME/.prime/agent/session-artifacts/deadbbbb-2222-3333-4444-555566667777"
check "gc kept live artifact (old)"        test -d "$HOME/.prime/agent/session-artifacts/$LIVE"
check "gc kept dead-young artifact"        test -d "$HOME/.prime/agent/session-artifacts/deadcccc-2222-3333-4444-555566667777"
check "gc removed dead-old transcript"     test ! -f "$HOME/.prime/agent/sessions/deadbbbb-2222-3333-4444-555566667777.jsonl"
check "gc kept live transcript"            test -f "$HOME/.prime/agent/sessions/$LIVE.jsonl"
check "gc rotated oversized usage.jsonl"   python3 -c "import json;lines=[l for l in open('$HOME/.local/state/resource-guard/usage.jsonl')];assert len(lines)==125000, len(lines)"
check "gc keeps NEWEST half (first kept line 125001)" python3 -c "lines=[l for l in open('$HOME/.local/state/resource-guard/usage.jsonl')];assert lines[0].strip()=='125001', lines[0]"
check "gc ignores non-UUID litter in artifacts" test -d "$HOME/.prime/agent/session-artifacts/not-a-uuid-dir"

# gc safety rail: registry failure aborts, deletes nothing
mock_registry fail
mkdir -p "$HOME/.prime/agent/session-artifacts/deadbbbb-2222-3333-4444-555566667777"
touch -d "40 days ago" "$HOME/.prime/agent/session-artifacts/deadbbbb-2222-3333-4444-555566667777"
"$TD/ompa" gc >/dev/null 2>&1; rc=$?
check "gc aborts when registry fails"       test "$rc" -ne 0
check "gc deletes nothing on failure"       test -d "$HOME/.prime/agent/session-artifacts/deadbbbb-2222-3333-4444-555566667777"

# gc safety rail: empty-but-valid registry also aborts (F4 empty rail)
mock_registry_ok_empty() {
  mkdir -p "$TD/bin"
  printf '#!/usr/bin/env bash\n[ "${1:-}" = "list" ] || exit 0\necho '"'"'{"sessions":[]}'"'"'\n' > "$TD/bin/prime-agent"
  chmod +x "$TD/bin/prime-agent"
  export PATH="$TD/bin:$PATH"
}
mock_registry_ok_empty
"$TD/ompa" gc >/dev/null 2>&1; rc=$?
check "gc aborts on empty registry"         test "$rc" -ne 0
check "gc deletes nothing on empty registry" test -d "$HOME/.prime/agent/session-artifacts/deadbbbb-2222-3333-4444-555566667777"

echo
if [ "$fail" -eq 0 ]; then echo "ALL TESTS PASSED"; else echo "TEST FAILURES: $fail"; exit 1; fi
