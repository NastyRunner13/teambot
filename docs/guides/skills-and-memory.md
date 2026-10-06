# Skills and memory

Agents get better at your work in two ways. **Skills** are written procedures ("how we do the weekly report"). **Memory** holds lasting facts and preferences ("Priya wants figures in EUR"). Both are plain files under `data/`, so you can read, edit, diff and version them outside TeamBot too.

## Skills

A skill is a folder with a `SKILL.md` file, in the open SKILL.md format used by Claude and other agent tools:

```
data/skills/
  weekly-report/
    SKILL.md
    template.md          # optional supporting files
    scripts/collect.py
```

### Writing one

Make one under **Connect apps → Skills → New skill**, or put the folder in `data/skills/` yourself. A new skill starts from this template:

```markdown
---
name: weekly-report
description: Write the Monday status report from last week's merged PRs and closed issues. Use when asked for the weekly report or a summary of last week.
---

# Weekly report

## When to use
Describe the situations where this procedure applies.

## Steps
1. Run `python ~/skills/weekly-report/scripts/collect.py` to list last week's merged PRs.
2. Fill in `~/skills/weekly-report/template.md`.
3. Save the result as `/shared/reports/week-<number>.md`.

## Output
Where the result goes and what it looks like.
```

The rules:

- **`name`** uses lowercase letters, numbers and hyphens, up to 64 characters, and must match the folder name. A skill whose front matter doesn't parse is listed with the error and isn't offered to agents.
- **`description`** is required (up to 1,024 characters). **It is the only part agents see until they load the skill**, so say both what it does and when to use it.
- `SKILL.md` can be up to 100 KB. Supporting files are copied to the agent's computer at `~/skills/<name>/` when the skill is loaded. Text files up to 200 KB are copied; binary or larger files are listed as skipped. Refer to them by that path in your steps.

### How agents use skills

1. Each agent's system prompt lists the **names and descriptions** of the skills it may use.
2. When a task fits one, the agent calls `use_skill` with the name. It gets the full instructions, and the supporting files land on its computer.
3. It follows the steps like any other work, through the same policy and approvals.

Choose which skills an agent may use on its **Customize** page. A routine can name a skill to follow, which makes the agent load it first.

**Tips.** Write steps the way you'd brief a new colleague: name sites and pages by their address and visible labels, say what "done" looks like, and say where results go. Put credentials in as `{{secret:NAME}}` (store the secret in **Settings → Secrets**), never as values. Every agent sees the names of stored secrets and can use them, but never their values. Keep one procedure per skill. A short skill that is always followed beats a long one that is half-followed.

### Showing a skill instead: recording a demonstration

Some procedures are easier to show than to describe. You can do the task once in an agent's browser, and TeamBot drafts the skill from what you did.

1. Open the agent's panel, choose **Computer** and press **Record**. This takes the computer from the agent, so nothing it does is recorded as yours.
2. Do the task in its browser at a normal pace. TeamBot logs the pages you open, what you click, what you type into each field, choices, ticked boxes, files picked and keys like Enter and Escape. Each action is labelled the way agents see the page, and stills are kept along the way.
3. Stop the recording. Optionally say what the task was and name the skill. The utility model then turns the log and a few stills into a **draft** SKILL.md, with when to use it, the inputs that change from run to run, what must be true first, the steps, and how to check it worked.
4. Review the draft under **Connect apps → Skills**, where drafts are listed above the skills. Each opens beside the recorded actions and stills. Edit it, then **Save as skill**, or **Discard** it.

**What never reaches the recording.** Password fields aren't read. Neither are fields whose type, autocomplete, name or label marks them as secret: API keys, tokens, one-time codes, card numbers. Anything you type that matches a stored secret becomes its `{{secret:NAME}}` placeholder. Page addresses keep their path but lose query values, fragments and token-like segments. Stills cover every form field, and no still is kept of a page where a secret was typed or whose address carried one.

**Limits.** A recording stops after 10 minutes or 1,000 actions, when you hand the computer back, or when the computer stops. It covers the browser, not other desktop apps. No agent sees a draft until a person saves it, and saving won't overwrite an existing skill of the same name unless you say so. In team mode a recording is visible only to the person who made it and to owners. Drafting is billed to the workspace (not the agent) and is skipped once the workspace's daily budget is spent.

## Memory

Each agent has two memory files, both included in its instructions on every step:

| File | What goes in it | Who changes it |
|---|---|---|
| `data/memory/agents/<Name>.md` | The agent's own notes: how you like its work, things it learned about its job | The agent (`remember`, `forget`) and you |
| `data/memory/team.md` | Facts every agent should know: who's who, preferences, conventions | Any agent (reviewed by default) and you |

Agents add a note with `remember`, which appends one dated bullet, and remove outdated ones with `forget`. By default, changes to **team** memory go to the reviewer model first (see [Action policy](action-policy.md)). Agents are told not to store task progress or secrets in memory.

To read or edit memory, open an agent's panel and choose **Memory**. Both files are there, and you can change anything. You can also edit the files on disk.

**Limits.** A memory file can be up to 32 KB, and the first 8,000 characters of each go into the prompt. Past that, the agent is told the rest was left out. Keep memory short and current: delete what's no longer true, and move long procedures into skills.

### Memory or skill?

| Use memory for | Use a skill for |
|---|---|
| Facts and preferences ("The design review is on Thursdays") | Procedures with steps ("How to prepare the design review deck") |
| Things that apply to most work | Things that apply to one kind of task |
| Short lines | Anything longer than a paragraph, or with files |

## Search

Agents (with `search_history`) and people (the **Search** page) can search every message in the conversations they're allowed to see: earlier decisions, links, results. All words must match, and `"exact phrases"` go in quotes. Agents also see a short list of their own last five jobs in other conversations, so "what did you do last time?" works from any chat.
