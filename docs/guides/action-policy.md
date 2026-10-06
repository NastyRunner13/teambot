# Action policy

Every tool call an agent makes passes through one gateway before anything runs. The **action policy** is the YAML that gateway reads. It decides whether a call runs, waits for you, goes to a reviewer model, is handed to you to do yourself, or is refused. Edit it in **Settings → Action policy** (with team sign-in on, only owners can). The policy is checked when you save, and a policy with an error is refused with the reason.

This guide explains how decisions are made and gives rules you can copy.

## The five actions

| Action | What happens |
|---|---|
| `allow` | The call runs. |
| `review` | An independent **reviewer model** (`TEAMBOT_REVIEWER_MODEL`) sees what the agent was asked to do and the exact action, then answers allow, ask or deny. If the reviewer fails for any reason, you are asked. |
| `ask` | The run pauses and an approval card appears in the chat where the agent is working (and on Telegram or Slack if connected). **Approve** runs the call; **Deny** tells the agent no. |
| `handoff` | The call doesn't run. You're asked to do the step yourself, usually by taking control of the agent's computer, and to hand back when you're done. |
| `deny` | The call doesn't run. The agent is told which rule blocked it and not to work around it. |

A run that waits for you is saved to the database, so it survives restarts and can wait as long as needed.

## How a decision is made

1. Every rule whose conditions **all** match the call is collected.
2. **The strictest match wins:** `deny` > `handoff` > `ask` > `review` > `allow`. An `allow` rule can never loosen a stricter rule that also matches.
3. If no rule matches, the **default for the tool's risk class** applies.

```yaml
defaults:
  internal: allow   # team tools: messages, progress, memory, skills
  read: allow       # looking at things: snapshots, reading files, browsing
  write: allow      # changing things inside the agent's own computer
  external: ask     # acting outside the computer: connected apps, new agents, routines
```

Some calls always go to a person, whatever the policy says: `ask_for_approval` and `propose_page` always ask, and `request_human_takeover` always hands off.

If the saved policy ever fails to load, TeamBot runs in **safe mode** until you save a valid one: team tools are allowed and everything else asks.

## Tools and their risk classes

| Risk | Tools |
|---|---|
| `internal` | `post_message`, `send_dm`, `ask_agent`, `read_channel`, `update_progress`, `ask_for_approval`, `request_human_takeover`, `use_skill`, `remember`, `forget`, `search_history`, `propose_page`, `comment_on_page`, `resolve_comment`, `list_routines`, `stop_routine`, `resume_routine`, `show_ui`, and published components (`ui_<name>`) |
| `read` | `read_file`, `list_files`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_scroll`, `browser_back`, `browser_tabs`, `computer_screenshot`, `computer_scroll`, `list_pages`, `read_page`, `list_page_comments` |
| `write` | `shell`, `write_file`, `browser_click`, `browser_type`, `browser_press`, `computer_click`, `computer_type`, `computer_key`, `computer_drag`, `run_coding_agent`, `create_page`, `edit_page`, `draft_component` |
| `external` | `create_agent`, `create_routine`, and every connector or MCP tool (`mcp__<server>__<tool>`) |

The `computer_*` tools exist only for agents with full desktop control turned on. A tool's exact name is also shown on its card in the chat.

## Rule fields

```yaml
rules:
  - name: A short sentence; it is shown on approval cards and in the audit log
    tools: [browser_click, browser_type]   # required; * wildcards allowed
    agents: [Researcher]                   # agent names; wildcards allowed
    initiator: [human, agent, schedule, event]
    domains: [example.com]                 # also matches sub.example.com
    target: "\\b(send|submit)\\b"          # regex on the clicked/typed-into element's label
    field_types: [password]                # input types being typed into
    args:                                  # argument name -> regex on its value
      command: "\\bsudo\\b"
    when: "spend_today > 5.0"              # a CEL expression that must be true
    action: ask                            # required
```

Only `name`, `tools` and `action` are required. Every other field you give must match.

- **`tools`** and **`agents`** are globs: `browser_*`, `mcp__github__*`, `*`.
- **`initiator`** is who started the work. `human` means a person's message. `agent` means a teammate's request. `schedule` means a timed routine. `event` means a routine started from outside: a webhook, an email, a Slack message or a calendar event.
- **`domains`** applies to browser tools. It is the site the browser is on, or is navigating to. `*` wildcards work too (`*.bank.com`).
- **`target`** and **`field_types`** come from the page itself. Before a click or keystroke, the gateway asks the agent's computer what element is under it (its visible label and input type). For desktop tools, it is what is under the pointer.
- **`args`** regexes are case-insensitive and see the arguments **as the agent wrote them**, so a secret still appears as its `{{secret:NAME}}` placeholder. Non-string values are matched against their JSON. If a named argument is missing, the rule doesn't match.
- **Regexes in YAML:** inside double quotes, write each backslash twice (`"\\bsudo\\b"`). Inside single quotes, write it once (`'\bsudo\b'`).

Useful argument names: `shell` takes `command` and `cwd`. `write_file` takes `path` and `content`. `browser_navigate` takes `url`. `browser_type` takes `ref`, `text` and `submit`. `browser_press` takes `key`. `run_coding_agent` takes `agent`, `task` and `cwd`. `post_message` takes `channel` and `text`. `send_dm` takes `to` and `text`. `remember` and `forget` take `scope` (`me` or `team`).

## `when`: conditions in CEL

`when` takes a [CEL](https://cel.dev) expression for anything the fields above can't express. It is checked when you save, so a typo or an expression that isn't true/false is rejected with the reason.

| Variable | Type | Meaning |
|---|---|---|
| `tool`, `risk`, `agent`, `initiator` | string | As above |
| `args` | map | The tool's arguments (`args.command`, `args.url`…) |
| `domain`, `url`, `target`, `field_type` | string | Page facts, empty when not known |
| `hour`, `weekday` | int | **UTC** time; weekday 0 is Sunday |
| `spend_today` | double | The agent's spend today in USD |
| `steps` | int | Model calls so far in this run |
| `read_only` | bool | Whether the run is read-only |

If an expression fails while running (for example `args.path` when the tool has no `path`), it **fails closed**: `deny`, `handoff`, `ask` and `review` rules count as matching, and `allow` rules don't. Use `has(args.path)` to test for a key first.

## Recipes

Add these under `rules:` and adjust them to fit.

### Never touch a site

```yaml
  - name: Never touch banking sites
    tools: [browser_*]
    domains: [mybank.com]
    action: deny
```

For a hard boundary, combine this with an **internet allowlist** on the agent's Customize page. The allowlist firewalls the computer itself, so it also covers `curl` in the shell. A policy rule can only see what a tool reports.

### Ask before anything outside working hours

```yaml
  - name: Outside working hours, ask before changing anything
    tools: ["*"]
    when: 'risk in ["write", "external"] && (hour < 8 || hour >= 20 || weekday == 0 || weekday == 6)'
    action: ask
```

Remember that `hour` is UTC. For 08:00–20:00 in UTC+5:30, use `hour < 2 || hour >= 14` (minutes are not available).

### Slow down an agent that is spending a lot

```yaml
  - name: After $5 in a day, ask before more browsing or commands
    tools: [browser_*, shell]
    when: "spend_today > 5.0"
    action: ask
```

This is a softer limit than a budget. A budget stops work. This rule keeps it going one approval at a time.

### Treat outside triggers with suspicion

```yaml
  - name: Work started by a webhook or email gets a second look
    tools: [shell, write_file, browser_click, browser_type]
    initiator: [event]
    action: review
```

Webhook bodies, emails and Slack messages reach the agent as untrusted content. Even so, a crafted message can try to steer it, and the reviewer catches what looks unrelated to the request.

### Let one agent use an app freely, and ask for everyone else

Connector tools default to `ask` through the `external` default. To let a trusted agent read from Linear without approvals:

```yaml
  - name: Planner reads Linear without asking
    tools: ["mcp__linear__list_*", "mcp__linear__get_*"]
    agents: [Planner]
    action: allow
```

An `allow` rule matching is enough to beat a *default*, but not a stricter *rule*.

### Keep secrets out of the shell

```yaml
  - name: Ask before a command uses a secret
    tools: [shell]
    args:
      command: "\\{\\{secret:"
    action: ask
```

A secret is redacted from output, but an agent that may use it in a command could still transform it and print it (`echo … | base64`). This rule puts you in the loop whenever that is possible.

### Keep a component away from an agent

Components are offered to every agent once published. `agents` has no "everyone except", so use `when` to keep one for a single agent:

```yaml
  - name: Only Analyst draws invoices
    tools: [ui_invoice]
    when: 'agent != "Analyst"'
    action: deny
```

### Review every git push, block force-pushes

```yaml
  - name: Never force-push
    tools: [shell]
    args:
      command: "\\bgit\\s+push\\b.*(--force|-f\\b)"
    action: deny
```

The default policy already sends `git push` to the reviewer, and because the strictest rule wins, a force-push is denied outright.

## Checking that a rule works

- **Approval cards name the rule** that asked, and a blocked action's tool card names the rule that blocked it.
- **The run's full log** (open a reply's "Worked for …" note, then the full log) and the audit log (`GET /api/events`) have a `tool.checked` event for every call, with the action and the rule. Calls sent to the reviewer also get a `tool.reviewed` event with its verdict and reason.
- **Test with real work.** With `TEAMBOT_OFFLINE_MODELS=1` agents only echo and never call tools, so test rules with a cheap model and a throwaway task instead.

## Changing the default

Your saved policy is stored in the database. Upgrading TeamBot never changes it, even when the built-in default (`DEFAULT_POLICY_YAML` in `apps/server/src/policy.ts`) gains new rules. To pick up new default rules, copy them across from that file. **Reset to default** in **Settings → Action policy** also works, but it saves the default straight away and replaces every rule you wrote, so copy yours somewhere first.
