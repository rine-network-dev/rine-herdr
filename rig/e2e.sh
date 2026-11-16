#!/usr/bin/env bash
# e2e.sh: the rine-herdr docker e2e covering the full lifecycle, from startup to daemon exit. Runs inside the compose rig:
#   docker compose -p rine-herdr-e2e -f compose.herdr.yml run --rm -T --user "$(id -u):$(id -g)" rig /work/rig/e2e.sh
# Assertions read the fake agents' JSONL logs, the daemon's IPC and the server; nothing greps model prose.
set -uo pipefail
# shellcheck source=e2e-lib.sh
. "$(dirname "$0")/e2e-lib.sh"
: "${HERDR_E2E_MX_DOMAIN:?set HERDR_E2E_MX_DOMAIN to a domain with MX records}"
export HERDR_SOCKET_PATH=$HOME/.config/herdr/herdr.sock
export RINE_OWNER_DIR=$R/owner-a
mkdir -p "$L" "$R/bin"
# herdr types into an agent only while its foreground process carries a known agent name, so the stand-in is "claude"
ln -sf "$(command -v node)" "$R/bin/claude"
trap 'herdr server stop >/dev/null 2>&1; kill $(jobs -p) 2>/dev/null' EXIT

bash "$(dirname "$0")/seed-tree.sh" || { say "FAILED seed"; exit 1; }
for r in repo-a repo-b; do
    git init -q "$R/$r" && git -C "$R/$r" -c user.name=e2e -c user.email=e2e@example.com commit -q --allow-empty -m init
done
STAMP=$(date +%s)
CANARY="CANARY-$STAMP-$RANDOM"
org() { node "$ORG_TOOL" "$@"; }
agent_id() { binding_field "$1" agentId; }
handle_of() { binding_field "$1" handle; }
envelopes() { typed_lines "$1" | grep -c '^rine: ' || true; }
pane_has() { pane_text "$1" | grep -q "$2"; }
shim_tools() { fa "$1" tools | jv 'j.tools.length'; }
count_is() { [ "$($1 "$2")" = "$3" ]; }
bind() { rine-herdr bind --pane "$1" --name "$2" >/dev/null; }
apply() { (cd "$1" && rine-herdr apply --yes --repo "$1" >"$L/apply.out" 2>&1); }
plan_is_empty() { (cd "$1" && rine-herdr plan --repo "$1" 2>&1) | grep -q "nothing to do"; }
held() { ipc quarantine.list '{}' | jv 'j.result.entries.length'; }
# apply refuses an uncommitted rine-herdr.toml, so the policy is committed first, as a real user would
commit_policy() { git -C "$1" add rine-herdr.toml && git -C "$1" -c user.name=e2e -c user.email=e2e@example.com commit -q -m policy; }

scenario "startup"
rine-herdr init --new-org --email "e2e-a-$STAMP@$HERDR_E2E_MX_DOMAIN" --org-slug "ea${STAMP: -7}" --org-name e2e-a >"$L/init.out" 2>&1
ck "init created a branch" grep -q "host ready" "$L/init.out"
start_herdr
herdr plugin link "$R/plugin" >"$L/link.out" 2>&1  # the seeded plugin dir; `rine-herdr link` would npm-install from the registry
herdr server stop >/dev/null 2>&1; wait_for 20 test ! -S "$HERDR_SOCKET_PATH"
start_herdr
ck "herdr server is up" test -S "$HERDR_SOCKET_PATH"
ck "the startup hook leaves a daemon" wait_for 40 test -S "$STATE/daemon.sock"
ck "status answers over IPC" test -n "$(daemon_status)"
end_scenario

WS_A=$(herdr workspace create --cwd "$R/repo-a" | herdr_ids); PANE_A=$WS_A
PANE_B=$(new_pane "$WS_A"); PANE_U=$(new_pane "$WS_A")
for pair in "a $PANE_A" "b $PANE_B" "u $PANE_U"; do set -- $pair; fake_agent "$1" "$2" || say "fake agent $1 did not start"; done

scenario "zero tools when pending or unbound"
bind "$PANE_A" a; bind "$PANE_B" b
ck "unbound pane lists 0 tools" count_is shim_tools u 0
ck "pending_apply pane lists 0 tools" count_is shim_tools a 0
ck "the pending pane's agent is told to run apply" test "$(fa a tools | jv 'j.instructions.includes("rine-herdr apply")')" = true
ck "the unbound pane's agent is told to bind" test "$(fa u tools | jv 'j.instructions.includes("rine-herdr bind")')" = true
end_scenario

scenario "init, bind, apply (solo, 2 panes)"
ck "apply succeeds" apply "$R/repo-a"
ck "apply names the branch as its authority although RINE_OWNER_DIR is set" grep -q "authority: branch .* (no owner directory needed)" "$L/apply.out"
ck "apply prints no owner-dir notice" sh -c "! grep -q 'Owner directory:' $L/apply.out"
ck "both bindings applied" test "$(jv "j.filter((b) => b.state === 'applied').length" < "$STATE/bindings.json")" = 2
BR=$(org branches "$R/owner-a" "$STATE/branch-home" 2>&1)
ck "the branch exists on the server" grep -q herdr- <<<"$BR"
AG=$(org agents "$R/owner-a" "$STATE/branch-home" 2>&1)
ck "both agents groups_only/groups_only, private" test "$(echo "$AG" | jv "j.filter((x) => x.incoming === 'groups_only' && x.outgoing === 'groups_only' && x.preset === 'private').length")" -ge 2
ck "one herdr-* group holds the agents" grep -q herdr- <(org groups "$(binding_field a configDir)")
ck "applied agents list tools" test "$(shim_tools a)" -gt 0
ck "a second plan has nothing to do (the exposure the server reports is read back)" plan_is_empty "$R/repo-a"
end_scenario

scenario "envelope, no body"
B0=$(typed b)
org send "$(binding_field a configDir)" "$(handle_of b)" "$CANARY" >/dev/null 2>&1 || fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"$CANARY\"}}" >/dev/null
ck "exactly one envelope" wait_for 30 cmp_of typed b -eq $((B0 + 1))
sleep 3
ck "still exactly one line" test "$(typed b)" -eq $((B0 + 1))
ENV_RE='^rine: new message for .+ from .+ \(.+\), thread [0-9a-f-]{36}\. Read it with rine_read message_id [0-9a-f-]{36}\.$'
ck "the line is the single envelope" grep_last b -E "$ENV_RE"
ck "canary absent from typed lines" sh -c "! grep '\"type\":\"line\"' $L/b.jsonl | grep -q $CANARY"
ck "canary absent from daemon.log and state dir" sh -c "! grep -rq $CANARY $STATE --exclude=quarantine.json"
READ=$(fa b read)
ck "rine_read returns the canary" grep -q "$CANARY" <<<"$READ"
end_scenario

scenario "working queue and token"
fa b state working >/dev/null; B0=$(typed b)
for i in 1 2 3; do fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"w$i\"}}" >/dev/null; done
ck "token shows 3" wait_for 40 pane_has "$PANE_B" "3 queued"
ck "no typed line while working" test "$(typed b)" -eq "$B0"
sleep 32; fa b state idle >/dev/null
ck "idle gives one burst envelope" wait_for 30 cmp_of typed b -eq $((B0 + 1))
ck "it is a burst line" grep_last b -F "3 new messages"
BURST_RE='^rine: 3 new messages for .+: (rine_read message_id [0-9a-f-]{36} from .+ \(.+\)(; |\.$)){3}'
ck "the burst names each message" grep_last b -E "$BURST_RE"
end_scenario

scenario "blocked is never typed"
sleep 32; fa b state blocked >/dev/null; B0=$(typed b)
fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"blocked\"}}" >/dev/null
sleep 20
ck "no typed line for 20 s" test "$(typed b)" -eq "$B0"
fa b state idle >/dev/null
ck "idle gives one envelope" wait_for 30 cmp_of typed b -eq $((B0 + 1))
end_scenario

scenario "wake budget"
sleep 32; B0=$(typed b)
for i in 1 2 3; do fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"s$i\"}}" >/dev/null; sleep 5; done
ck "one envelope within 30 s" test "$(typed b)" -eq $((B0 + 1))
ck "the rest follows after the spacing" wait_for 45 cmp_of typed b -eq $((B0 + 2))
end_scenario

scenario "graph refusal"
printf '[local]\ngraph = [["a", "b"]]\n' >"$R/repo-a/rine-herdr.toml"; commit_policy "$R/repo-a"
PANE_C=$(new_pane "$WS_A"); fake_agent c "$PANE_C"; bind "$PANE_C" c
ck "apply with the graph succeeds" apply "$R/repo-a"
fa c call rine_send "{\"to\":\"$(handle_of a)\",\"payload\":{\"text\":\"nope\"}}" >"$L/c-send.out"
ck "c's send to a is refused" grep -q '"ok":false' "$L/c-send.out"
fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"still\"}}" >"$L/a-send.out"
ck "a to b still works" grep -q '"ok":true' "$L/a-send.out"
end_scenario

scenario "apply on branch keys alone"
EMPTY_OWNER=$R/empty-owner-dir; mkdir -p "$EMPTY_OWNER"
branch_only_apply() { (export RINE_OWNER_DIR=$EMPTY_OWNER; apply "$1"); }
PANE_D=$(new_pane "$WS_A"); fake_agent d "$PANE_D"; bind "$PANE_D" d
ck "this host holds no owner dir at the default location" test ! -e "$HOME/.config/rine-owner"
ck "apply succeeds with RINE_OWNER_DIR at an empty dir" branch_only_apply "$R/repo-a"
ck "its output names the branch authority" grep -q "authority: branch .* (no owner directory needed)" "$L/apply.out"
ck "it prints no owner-dir notice" sh -c "! grep -q 'Owner directory:' $L/apply.out"
ck "d is applied" test "$(binding_field d state)" = applied
AG=$(org agents "$R/owner-a" "$STATE/branch-home" 2>&1)
ck "d is groups_only/groups_only, private" test "$(echo "$AG" | jv "j.filter((x) => x.id === '$(agent_id d)' && x.incoming === 'groups_only' && x.outgoing === 'groups_only' && x.preset === 'private').length")" = 1
ck "it never fell back to the owner" sh -c "! grep -q 'continuing as the org owner' $L/apply.out"
end_scenario

scenario "solo to team: the stale group is dissolved, not left half-applied"
printf 'profile = "team"\n' >"$R/repo-a/rine-herdr.toml"; commit_policy "$R/repo-a"
ck "the profile switch applies" apply "$R/repo-a"
ck "the plan names the stale group as dissolved" grep -q "dissolves stale group" "$L/apply.out"
ck "no step failed" sh -c "! grep -q FAILED $L/apply.out"
ck "one herdr group is left for a" test "$(org groups "$(binding_field a configDir)" | jv "j.filter((g) => g.name.startsWith('herdr-')).length")" = 1
ck "a second plan has nothing to do" plan_is_empty "$R/repo-a"
end_scenario

scenario "cross-org team and quarantine"
BORG=$(org register b "$HERDR_E2E_MX_DOMAIN"); org agent b bee >"$L/bee.out"
WS_B=$(herdr workspace create --cwd "$R/repo-b" | herdr_ids)
fake_agent lead "$WS_B"; bind "$WS_B" lead
GROUP=$(node "$ORG_TOOL" group-create "$R/b/cfg" platform-dev "$(agent_id lead)" 2>&1 | jv 'j.handle')
printf 'profile = "team"\n[[external.groups]]\nhandle = "%s"\nagents = ["lead"]\n' "$GROUP" >"$R/repo-b/rine-herdr.toml"; commit_policy "$R/repo-b"
ck "team apply accepts the external group" apply "$R/repo-b"
BASE=$(typed lead)
org send "$R/b/cfg" "$(handle_of lead)" first-contact >/dev/null 2>&1
ck "the first contact is held" wait_for 40 cmp_of held "" -ge 1
ck "no typed line while held" test "$(typed lead)" -eq "$BASE"
ENTRY=$(ipc quarantine.list '{}' | jv 'j.result.entries[0]')
ipc quarantine.decide "{\"bindingKey\":$(echo "$ENTRY" | jv 'JSON.stringify(j.bindingKey)'),\"senderId\":$(echo "$ENTRY" | jv 'JSON.stringify(j.senderId)'),\"decision\":\"approve\"}" >/dev/null
ck "approve gives one envelope" wait_for 40 cmp_of typed lead -eq $((BASE + 1))
end_scenario

scenario "owner-dir trap"
ck "the pane env carried the real owner dir and a bogus token" grep -q "\"RINE_TOKEN\":\"bogus\"" "$L/a.jsonl"
WHO=$(fa a call rine_whoami '{}')
ck "whoami names the one bound agent" grep -q "$(agent_id a)" <<<"$WHO"
ck "whoami lists no other agent" test "$(echo "$WHO" | jv 'JSON.parse(j.text).agents.length')" = 1
end_scenario

scenario "cc-lease deferral"
sleep 32; fa b state idle >/dev/null; B0=$(typed b)
seal_lease "$(agent_id b)" "$R/repo-a" 0
( while sleep 10; do seal_lease "$(agent_id b)" "$R/repo-a" 0; done ) & LEASE=$!
fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"leased\"}}" >/dev/null
ck "token updates" wait_for 40 pane_has "$PANE_B" "queued"
sleep 5
ck "no typed line under a live lease" test "$(typed b)" -eq "$B0"
kill $LEASE; seal_lease "$(agent_id b)" "$R/repo-a" 1
fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"released\"}}" >/dev/null
ck "released lease delivers" wait_for 60 cmp_of typed b -gt "$B0"
end_scenario

scenario "unbind"
rine-herdr unbind --pane "$PANE_B" >/dev/null
ck "the shim lists 0 tools" count_is shim_tools b 0
B0=$(typed b); sleep 32
fa a call rine_send "{\"to\":\"$(handle_of b)\",\"payload\":{\"text\":\"after\"}}" >/dev/null
sleep 10
ck "no further envelope" test "$(typed b)" -eq "$B0"
end_scenario

scenario "daemon exit"
ck "unknown-frame counter is 0" test "$(daemon_status | jv 'j.unknownFrames ?? j.unknown_frames ?? 0')" = 0
herdr server stop >/dev/null 2>&1
ck "daemon gone within 40 s" wait_for 40 test ! -S "$STATE/daemon.sock"
ck "pidfile removed" test ! -e "$STATE/daemon.pid"
end_scenario

say "SUMMARY scenarios passed=$PASSED_SCENARIOS failed=$FAILED_SCENARIOS"
[ "$FAILED_SCENARIOS" -eq 0 ]
