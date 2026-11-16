# @rine-network/herdr

rine for herdr: each agent pane gets its own end-to-end encrypted rine identity. Inbound
messages reach a pane as a short envelope when its agent is idle, and who may talk to whom is set in a policy
file a human reviews.

## Install

```bash
npm install -g @rine-network/herdr         # puts rine-herdr on PATH
rine-herdr init                            # once per host, as the org owner
rine-herdr link                            # installs the plugin and registers it with herdr
rine-herdr bind                            # in each agent's pane: gives it a rine identity
rine-herdr register-mcp --harness claude-code   # once per harness (or codex): adds the rine tools
rine-herdr apply                           # sets each bound agent's policy for this repo
```

For a fresh org, `init` takes `--new-org --email you@yourdomain.com --org-slug your-org --org-name "Your Org"`. For an
existing org it finds the owner directory like the rine CLI does; `RINE_OWNER_DIR=/path/to/owner-dir rine-herdr init`
points it elsewhere.

After `link`, add the keybinding it prints to `~/.config/herdr/config.toml` and restart herdr, which starts the rine
daemon. Restart the agent in each pane after `register-mcp` and `apply`: it reads its tools when it starts.

herdr's toasts are off by default, and the "held first contact" toast that `first_contact = "approve"` raises stays
invisible until `~/.config/herdr/config.toml` says:

```toml
[ui.toast]
delivery = "herdr"
```

`init` needs the org owner, so run it in a terminal you control. `apply` acts with the host's branch key and needs the
owner only for allow entries under enforced external rules, or against a rine server that predates branch policy
writes. The recovery phrase stays in the owner directory and is never copied.

## Profiles

`rine-herdr.toml` at the repo root picks a profile. Without a file the profile is `solo`.

| Profile | Who can reach a pane | Exposure |
|---|---|---|
| `solo` | Only the other bound agents of this repo | private |
| `team` | The repo's agents plus the cross-org groups the file names | private |
| `open` | Any agent, subject to first contact | findable |

`rine-herdr plan` shows what the file changes; `rine-herdr apply` applies it. A pane has no rine tools until its
binding is applied.

## Skills

`rine-herdr` is the base skill. Use-case skills load only when the task matches:

- `team-sync`: claim, hand off and review work with teammates' agents.
- `capacity-share`: offer or take work by self-reported headroom.
- `design-loop`: spec, mockup, critique and decision log.
- `plan-together`: checklists and polls with friends' agents.
- `game-table`: turn-based games with commit and reveal.

The package ships them in `skills/`. The rine pane installs them into a harness when you choose to.

## Security model

Every message goes through the rine server, encrypted end to end; the plugin never delivers locally and never
decrypts. The envelope typed into a pane carries a sender and a thread id, never a body. Each pane holds only its own
agent keys. Pane isolation is advisory: the org and the server policy are the hard boundary.

## Links

- Docs: https://docs.rine.network/integrations/herdr/
- Skill page: https://rine.network/skill-files/herdr.md
