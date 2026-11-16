#!/bin/sh
# Runs inside the rig image only (compose.herdr.yml, service rig, --no-deps). Records herdr's wire facts under $OUT.
# usage: docker compose -p rine-herdr-e2e -f compose.herdr.yml run --rm --no-deps -T --user "$(id -u):$(id -g)" \
#          -v "<host-out-dir>:/work/out" rig /work/rig/probe.sh
set -eu
OUT=${OUT:-/work/out}
mkdir -p "$HOME"
herdr api schema --json > "$OUT/api-schema.json"
herdr --default-config > "$OUT/default-config.toml"
herdr --version > "$OUT/version.txt"

herdr server > /work/scratch/server.log 2>&1 &
SOCK="$HOME/.config/herdr/herdr.sock"
i=0; while [ ! -S "$SOCK" ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
export HERDR_SOCKET_PATH="$SOCK"

ws=$(herdr workspace create --cwd /work/scratch --label probe)
pane=$(printf '%s' "$ws" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.root_pane.pane_id))')
split=$(herdr pane split "$pane" --direction right --no-focus 2>/dev/null || herdr pane split "$pane" --direction right)
pane2=$(printf '%s' "$split" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.pane.pane_id))')
echo "pane=$pane pane2=$pane2" > "$OUT/panes.txt"

# A self-report only holds authority while the pane runs an agent-named process, so the pane runs a stand-in "claude".
mkdir -p /work/scratch/bin
ln -sf /usr/bin/sleep /work/scratch/bin/claude
herdr pane run "$pane" "PATH=/work/scratch/bin:\$PATH claude 600" > /dev/null
sleep 2

node /work/rig/probe-frames.mjs "$SOCK" "$pane" 12 > "$OUT/frames.ndjson" 2> "$OUT/frames.err" &
rec=$!
sleep 1
seq=1
for state in working idle working blocked idle; do
  herdr pane report-agent "$pane" --source custom:rine-probe --agent claude --state "$state" --seq "$seq" \
    >> "$OUT/report-agent.log" 2>&1 || echo "report-agent $state failed" >> "$OUT/report-agent.log"
  seq=$((seq + 1)); sleep 0.4
done

# Rename a self-reported agent (the pane has no built-in agent kind)
herdr agent rename "$pane" probe-one > "$OUT/rename.out" 2>&1 || echo "exit=$?" >> "$OUT/rename.out"
herdr agent get probe-one > "$OUT/agent-get-after-rename.out" 2>&1 || echo "exit=$?" >> "$OUT/agent-get-after-rename.out"

# blocked agent: prompt must be refused
herdr pane report-agent "$pane" --source custom:rine-probe --agent claude --state blocked --seq "$seq" >/dev/null 2>&1
seq=$((seq + 1)); sleep 0.3
herdr agent prompt probe-one "hello" > "$OUT/prompt-blocked.out" 2>&1 || echo "exit=$?" >> "$OUT/prompt-blocked.out"

# idle agent: prompt accepted
herdr pane report-agent "$pane" --source custom:rine-probe --agent claude --state idle --seq "$seq" >/dev/null 2>&1
sleep 0.3
herdr agent prompt probe-one "hello" > "$OUT/prompt-idle.out" 2>&1 || echo "exit=$?" >> "$OUT/prompt-idle.out"

# A pane created while recording, so the fixture carries herdr's pane_created shape
herdr pane split "$pane" --direction down >/dev/null 2>&1 || echo "split for pane_created failed" >> "$OUT/close.out"
sleep 0.3
herdr pane close "$pane2" > "$OUT/close.out" 2>&1 || echo "exit=$?" >> "$OUT/close.out"
wait "$rec" || true
# The plugin manifest parses, and the plugin pane and action params the daemon will use are accepted
herdr plugin link /work/src/rine-herdr/plugin > "$OUT/plugin-link.json" 2>&1 || echo "exit=$?" >> "$OUT/plugin-link.json"
herdr plugin pane open --plugin rine-herdr --entrypoint rine > "$OUT/plugin-pane-open.out" 2>&1 || echo "exit=$?" >> "$OUT/plugin-pane-open.out"

# The docs' keybinding snippet loads clean; a bogus entry is the negative control
cat > "$HOME/.config/herdr/config.toml" <<'EOF'
[[keys.command]]
key = "prefix+alt+r"
type = "plugin_action"
command = "rine-herdr.open"
EOF
herdr server reload-config > "$OUT/keybinding-good.out" 2>&1 || echo "exit=$?" >> "$OUT/keybinding-good.out"
cat >> "$HOME/.config/herdr/config.toml" <<'EOF'
[[keys.command]]
key = "prefix+alt+x"
type = "nonsense"
command = "x"
EOF
herdr server reload-config > "$OUT/keybinding-control.out" 2>&1 || echo "exit=$?" >> "$OUT/keybinding-control.out"

herdr server stop > /dev/null 2>&1 || true
