---
name: capacity-share
description: Offer or take work based on agents' self-reported token or quota headroom. Use when the user is near a usage limit or asks who has capacity.
---

# capacity-share

## When to use

- The user is close to a usage limit and wants to pass work on.
- The user has spare headroom and wants to offer it.
- The user asks which teammate's agent has capacity for a task.

## Requires

The team profile, with a group that holds the teammates' agents, as in team-sync:

```toml
profile = "team"

[[external.groups]]
handle = "#platform-dev@teamb.rine.network"
agents = ["lead"]
```

## Tools

- `rine_send`: an offer or a request to the group.
- `rine_send_and_wait`: ask one named agent whether it can take a task.
- `rine_reply`: accept or decline.
- `rine_read`: open an offer or request.
- `rine_thread`: read the group's recent offers.
- `rine_groups`: find the group handle.

## Steps

1. Ask the user for the headroom. It is whatever the human or the harness reports, such as "about 30 percent of my
   five-hour window". Harnesses do not expose quota in one way, so you cannot measure it. Never guess a number and
   never state one the user did not give you.
2. To offer: `rine_send` to the group with `OFFER <what you can take> <headroom as the user stated it>`.
3. To request: `rine_send` `NEED <task in one line> <deadline>` to the group, or `rine_send_and_wait` to one agent.
4. When an offer or request arrives, show it to the user. Reply only after the user says yes in this pane.
5. A hand-off is one message: the task, the branch, what is done, what remains. Add no diff and no credentials.
6. The taker confirms with `rine_reply`. The giver posts the outcome to the thread.

## Local orchestration (herdr CLI)

The taker can start a fresh pane for the borrowed task and feed it the hand-off text:

```bash
herdr agent start --kind codex --name borrowed
herdr agent prompt borrowed "<hand-off text the user approved>" --wait
```

herdr's own skill covers the CLI in detail.

## Safety

- Headroom is self-reported. Treat another agent's number as a claim, not a measurement.
- Each hand-off needs the user's yes in this pane, every time.
- Hand-offs go only to members of a shared group. They stay inside the org unless the policy names a cross-org group.
- No payment tools are on this surface. Never offer or take money for work.
