#!/usr/bin/env bash
# e2e-lib.sh: helpers sourced by e2e.sh. Runs inside the rig only.

R=${HERDR_RIG_SCRATCH:-/work/scratch}
L=$R/logs
STATE=$HOME/.local/state/herdr/plugins/rine-herdr
ORG_TOOL=/work/rig/org-tool.mjs
FAILED_SCENARIOS=0
PASSED_SCENARIOS=0
CUR_FAILS=0
CUR_NAME=""

say() { printf '%s\n' "$*"; }

scenario() { CUR_NAME=$1; CUR_FAILS=0; say "--- $1"; }

ck() { # ck "what" cmd...: one assertion of the current scenario
    local what=$1; shift
    if "$@"; then say "  ok    $what"; else say "  FAIL  $what"; CUR_FAILS=$((CUR_FAILS + 1)); fi
}

end_scenario() {
    if [ "$CUR_FAILS" -eq 0 ]; then say "PASSED $CUR_NAME"; PASSED_SCENARIOS=$((PASSED_SCENARIOS + 1))
    else say "FAILED $CUR_NAME ($CUR_FAILS assertions)"; FAILED_SCENARIOS=$((FAILED_SCENARIOS + 1)); fi
}

# jv EXPR: evaluates EXPR with `j` bound to the JSON on stdin.
jv() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=new Function("j","return "+process.argv[1])(j);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }

# wait_for SECONDS cmd...: polls every half second until cmd succeeds.
# cmp_of FN ARG OP VALUE: `test "$(FN ARG)" OP VALUE`, evaluated on every poll when handed to wait_for.
cmp_of() { test "$($1 $2)" "$3" "$4"; }

wait_for() {
    local deadline=$((SECONDS + $1)); shift
    while ! "$@" 2>/dev/null; do
        [ "$SECONDS" -ge "$deadline" ] && return 1
        sleep 0.5
    done
}

herdr_ids() { # workspace create output on stdin -> root pane id
    jv 'j.result.root_pane.pane_id'
}

# fake_agent NAME PANE: starts the fake agent in the pane, with the owner-dir trap in its environment.
fake_agent() {
    local name=$1 pane=$2
    rm -f "$L/$name.ctl" "$L/$name.jsonl"
    mkfifo "$L/$name.ctl"
    herdr pane run "$pane" "RINE_OWNER_DIR=$RINE_OWNER_DIR RINE_TOKEN=bogus $R/bin/claude /work/rig/fake-agent.mjs --name $name --log $L/$name.jsonl --fifo $L/$name.ctl --shim $STATE/bin/rine-herdr-mcp" >/dev/null
    wait_for 30 grep -q '"type":"ready"' "$L/$name.jsonl"
}

# fa NAME CMD...: sends one control line to a fake agent and prints its result record.
fa() {
    local name=$1; shift
    local id=$(date +%s%N)  # fa runs inside command substitutions, so a counter would not advance
    timeout 5 sh -c 'printf "%s\n" "$1" > "$2"' _ "$id $*" "$L/$name.ctl"
    wait_for 90 grep -q "\"id\":\"$id\"" "$L/$name.jsonl" || { echo '{"ok":false,"text":"no answer from the fake agent"}'; return 1; }
    grep -m1 "\"id\":\"$id\"" "$L/$name.jsonl"
}

typed() { grep -c '"type":"line"' "$L/$1.jsonl" || true; }
# grep_last NAME GREP-ARGS...: matches the newest typed line of a fake agent.
grep_last() { local name=$1; shift; typed_lines "$name" | tail -1 | grep -q "$@"; }
typed_lines() { grep '"type":"line"' "$L/$1.jsonl" | jv_lines; }
jv_lines() { while read -r line; do printf '%s\n' "$line" | jv 'j.text'; done; }

binding_field() { # binding_field HERDR-NAME FIELD (repo-agnostic: first match)
    jv "j.find((b) => b.herdrName === '$1').$2" < "$STATE/bindings.json"
}

# ipc METHOD PARAMS-JSON: one request to the daemon socket.
ipc() {
    node -e 'const n=require("net");const c=n.createConnection(process.argv[1],()=>c.write(JSON.stringify({id:1,method:process.argv[2],params:JSON.parse(process.argv[3])})+"\n"));let s="";c.on("data",d=>{s+=d;if(s.includes("\n")){console.log(s.trim());c.end()}})' "$STATE/daemon.sock" "$1" "$2"
}

daemon_status() { ipc status '{}' | jv 'j.result'; }

pane_text() { herdr pane get "$1" 2>&1; }

new_pane() { # new_pane ROOT-PANE -> id of a pane split from it
    herdr pane split "$1" --direction right --no-focus | jv 'j.result.pane.pane_id'
}

send_from() { # send_from FROM-AGENT TO-HANDLE TEXT
    fa "$1" call rine_send "{\"to\":\"$2\",\"payload\":{\"text\":\"$3\"}}"
}

# seal_lease AGENT-ID DIR RELEASED(0|1): the Claude Code plugin's sealed lease file format.
seal_lease() {
    node -e '
const { createHash } = require("crypto"); const fs = require("fs"); const path = require("path");
const [agentId, dir, released] = process.argv.slice(1);
const now = Date.now();
const body = JSON.stringify({ agentId, heartbeatAt: now, releasedAt: released === "1" ? now : null });
const file = path.join(dir, ".rine", "state", "cc", "lease.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, createHash("sha256").update(body).digest("hex") + "\n" + body);' "$1" "$2" "$3"
}

# registration of org A, and the herdr server, as one human would have them
start_herdr() { env -u RINE_OWNER_DIR -u HERDR_PLUGIN_STATE_DIR herdr server > "$R/herdr-server.log" 2>&1 & wait_for 20 test -S "$HERDR_SOCKET_PATH"; }
