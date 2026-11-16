# Changelog

All notable changes to `@rine-network/herdr` are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-16

The plugin depends on zod 4 (`^4.6.7`), which carries the fix for GHSA-mrhx-c7xc-m3w5.

**What you will see differently:**

- A `rine-herdr.toml` that fails validation reports zod 4 wording for a wrong type or value
  (`Invalid input: expected string, received number`). Unknown keys still print their line and a
  `did you mean` hint.
- An omitted `[local]` or `[features]` table still takes its defaults (`graph = [["*", "*"]]`, no optional tools).

## [0.1.0] - 2026-11-15

UX fixes from the showcase review.

- `q` in the rine pane closes the popup. Choices that were not `a` or `d` no longer decide a held first contact:
  only `a` approves and `d` (then `y`) denies, anything else leaves it held. Quarantine groups held messages per
  sender and agent, with a count and the first arrival; the menu says how many senders are held (Status counts the
  same unit) and is printed once, under each answer, after the screen is cleared. Non-numeric rows answer `no such
  row`, and a decision says `1 held message settled`.
- A change to `[features] tools` reaches an applied binding: `plan` shows `rine tools A -> B` and `apply` writes it.
  `plan` after `apply` is empty (exposure is read from the agent's exposure endpoint).
- Changing profile retires the stale `herdr-*` groups instead of failing with "Cannot remove the last admin". The
  bound agent that administers a group deletes it, and only when every member is one of this host's bound agents;
  otherwise a bound agent leaves it and the others keep it. A group nobody on this host can delete or leave is
  reported (exit 1), the other steps still run, and the policy is not recorded as applied until it is fixed. Groups
  deleted in the same plan count as room for the new one under the group quota.
- A stale group that `apply` could neither dissolve nor leave because its member list could not be read, or because
  your agent is its only admin among outsiders, now fails like a failed dissolve: `apply` names the group on stderr,
  exits 1 and records nothing, so `plan` lists it again and the next `apply` retries. The other steps still run and
  the agents they applied keep their tools.
- Group invitations from the agents `apply` seats no longer wake an agent or land in quarantine. An invitation from
  another agent bound in the same repo (not under the solo profile, which creates no groups), or from the org of a
  configured `[[external.groups]]` group that names the agent, is dropped. The invitation is sealed and the plugin
  never opens it, so the rule goes by the sender, not the group: an invitation to a different group from those
  senders is dropped too (`rine_group_invites` still lists it). Any other invitation is judged like a first message.
- The burst envelope names up to three messages in the single form's terms (sender, class, message id) and counts the
  rest (`+K more; rine_inbox lists all`). Both forms say `rine_read message_id <id>`, the tool's real parameter.
- Docs and README say herdr's toasts are off by default: the held first-contact toast needs `[ui.toast] delivery =
  "herdr"` in herdr's config.
- `apply` prints one line for agents that could not be seated in an MLS group instead of the SDK's warnings.
- Plan steps are worded for people, with plural-aware counts, a quota refusal that says how to get room, and
  `nothing to do; this repo matches the policy` for an empty plan. An uncommitted policy file is refused before the plan.
- A daemon that is down says so (`error: ...`, in the CLI and the pane alike) and prints the command to start it.
  `daemon status` lists the agents that are streaming by name, gives pane and state only for streams that stopped,
  and shows frame counters only when they are non-zero.
- Policy typos name the line and the nearest key (`line 1: unknown key "profil" (did you mean "profile"?)`).
- First-run order in the README, the skill and the usage text now includes `register-mcp`. Bare usage lists one line
  per command with the version, and `--help` exits 0. `link` prints the config path and says to restart herdr.
- `register-mcp` prints the `claude mcp add` command one flag per line (the server name on its own line, not as a
  value of `--transport`) and says to restart running agents.
- The pane's skills screen lists the base skill first, with a one-line summary for each.
- `bind` offers the herdr agent kind as the default name, counting up (`claude-2`) when a binding in the repo
  already has it; the empty bindings view points at the pane you came from.
- The queued-message count in a pane's herdr metadata reads `3 queued` instead of `✉3`.
- A pane without rine tools tells its agent why: not bound (`rine-herdr bind`), or bound but the policy not applied
  yet (`rine-herdr apply`).
- Unseated MLS members are tracked through the SDK `onMlsUnseated` hook.

- `apply` acts with the host's branch key. The org owner directory is needed only to write allow entries for
  `[external]` orgs under enforced external message rules, or to loosen an agent's policy while the org stops new
  agents.
- Against a rine server that predates branch policy writes, `apply` continues as the owner, saying so once, or stops
  with the `RINE_OWNER_DIR` advice and lists the steps it did not run.
- `plan` and `apply` print who acts, and how the policy file stands against the last apply on this host (unchanged,
  changed with short hashes, or never applied). The record is a review aid, not a control.
- The pane's apply refuses a policy file that is not committed, with no way to pass `--allow-dirty`.
- With a branch key the group quota is not read; `plan` says so and the server refuses a group over quota.

- First release: per-pane rine identities, state-aware delivery, the `rine-herdr.toml` policy file, the rine pane and
  six bundled skills.
