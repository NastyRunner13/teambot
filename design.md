---
name: TeamBot
description: A deep-black chat workspace for a personal team of AI agents.
colors:
  dark-background: "#000000"
  dark-surface: "#121212"
  dark-raised: "#1b1b1b"
  dark-active: "#262626"
  dark-text: "#f4f4f4"
  dark-muted: "#9b9b9b"
  dark-border: "#2c2c2c"
  light-background: "#ffffff"
  light-surface: "#f4f4f4"
  light-raised: "#ececec"
  light-active: "#e4e4e4"
  light-text: "#111111"
  light-muted: "#646464"
  light-border: "#dcdcdc"
typography:
  body:
    fontFamily: "Inter Variable, Inter, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
    fontWeight: 400
  message:
    fontFamily: "Inter Variable"
    fontSize: "15px"
    lineHeight: 1.62
  page-title:
    fontFamily: "Inter Variable"
    fontSize: "26px"
    fontWeight: 700
    letterSpacing: "-0.025em"
rounded:
  control: "10px"
  input: "12px"
  card: "16px"
  bubble: "22px"
  pill: "999px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
  section: "32px"
components:
  primary-button-dark:
    backgroundColor: "{colors.dark-text}"
    textColor: "{colors.dark-background}"
    rounded: "{rounded.pill}"
    height: "40px"
  primary-button-light:
    backgroundColor: "{colors.light-text}"
    textColor: "{colors.light-background}"
    rounded: "{rounded.pill}"
    height: "40px"
  composer:
    backgroundColor: "{colors.dark-surface}"
    rounded: "28px"
---

## Overview

TeamBot is a self-hosted office for named AI agents. People return to a conversation, give a teammate work, watch it happen, and review results. The interface is a chat app first: a list of conversations, one conversation, and a details panel beside it.

The October 2 2026 redesign follows [Grok Bot](https://x.ai/bot) at the owner's request: a deep-black canvas, a conversation list with previews, bubble messages with a floating name pill, a profile panel with Details, Library and Computer, routines with on/off switches, and a "Connect apps" entry at the bottom of the sidebar. It is drawn from scratch; no Grok artwork, icons or code are used.

What changed from the first design: the Activity, Approvals and Tasks pages are gone. Approvals appear in the conversation where the agent asked; what agents did shows in the conversation as work notes. Later the same day the task board went altogether: agents show their plan as a progress checklist instead. Skills, shared files, connectors and chat bridges live together under Connect apps.

## Colors

Dark (deep black) is the default; Light and Auto (follows `prefers-color-scheme`) are picked in the profile menu. The preference is stored as `teambot-theme` in local storage and applied in `index.html` before React renders, so there is no flash.

Use the variables in `apps/web/src/styles.css`: `--bg`, `--panel`, `--panel-2` (bubbles, inputs, cards), `--panel-3` (hover), `--active` (selected rows and tabs), `--text`, `--muted`, `--faint`, `--border`, `--border-strong`, `--accent` and `--on-accent`. Primary buttons invert: light ink on dark, dark ink on light. Never hard-code white or black text on them.

Color identifies agents and state, nothing else. Each agent's blob is drawn in its own color; the application chrome stays neutral. Green means working or done, amber means waiting for you, red means an error or a destructive action. The three tiles on the Connect apps button (blue, green, amber) are the only fixed decorative colors. Apps in Connect apps get a tile in a color of their own so they're recognizable, the way agents are: the app's initial in black or white, whichever reads better on it (`inkOn` in `lib/catalog.ts`), never the vendor's logo.

Body text and placeholders should meet WCAG AA (4.5:1) in both themes. `--muted` is for secondary text; `--faint` only for timestamps and hints.

## Typography

Inter (variable, bundled through `@fontsource-variable/inter`, so nothing is fetched from the internet) for everything except code, paths and model IDs, which use the monospace stack.

UI text is 14px; message bubbles are 15px with a 1.62 line height. Conversation names in the sidebar are 14.5px semibold over a 13px preview. Page titles are 26px bold with slight negative tracking.

Write short labels: Create new agent, Customize, Pause, Edit, Full log. Empty states say what to do next.

## Layout

- **Sidebar** (300px; 72px when collapsed, remembered per browser): collapse, search and new-chat buttons; the conversation list newest first (a chat per agent, each group chat, and DMs with people in team mode); the profile button and Connect apps at the bottom.
- **Chat**: messages up to 780px wide, a floating pill with the agent or group name (it opens the profile), and a pill-shaped composer with an attach button and a round send button.
- **Panel** (400px): the agent's or group's profile, or a page opened from it (a routine, the routine editor, memory, customize, a thread, a run's full log). It sits beside the chat on wide screens and covers it at 1100px and below, where it starts closed and closes when you switch chats.
- **Settings frame**: Settings and Connect apps share it. The sections are listed on the left (232px, under "Settings" and "Connect apps" labels) and the open one is on the right, up to 760px wide (960px for the marketplace and the policy editor). Where the frame has less than 760px of room, the sections become a strip of pills along the top that scrolls sideways.
- At 760px and below the sidebar becomes a full-screen navigation drawer opened from the top bar.

Panel pages remember which conversation they were opened on (`panel.at` in the store); anywhere else the panel shows that conversation's own profile.

## Components

### Conversation list

Each row: avatar (40px), name, and one line of preview — the last message without Markdown, "You:" for your own, the author's name in group chats, "Working…" while an agent works there, and "Needs your answer" (amber) when an approval waits. Idle agents show no status dot. Opening a chat doesn't reorder the list; only messages do.

### Messages

Your messages are right-aligned bubbles; everyone else's are left-aligned. In a chat with one agent its name isn't repeated; in group chats the author's avatar and name head each run of messages. Hovering shows the time, Reply (thread) and Copy. System notices (📋, ⚠️) are centered muted text without a bubble.

When an agent working for a conversation messages someone elsewhere, the conversation shows a centered line at that point: "Messaged [blob] Job Scout", "Messaged you" or "Posted in #launch", with the author's name first when it isn't the agent you're chatting with. Several posts in a row to the same place share one line. It opens that conversation. A conversation between two agents has a "Job Scout ⇄ Writer" pill, names the author of every message, and has no composer: a line at the bottom points to your own chat with either agent.

### Work notes

While an agent works for a conversation, one live line at the bottom says what it is doing now ("Search history for …", "Waiting for your approval"), with a shimmer, led by the agent's name unless it's the one you're chatting with. An agent on a job with several steps keeps a plan (the `update_progress` checklist): then the line names the step it is on with a count ("Deep-dive tiers… · 1 of 4"), and the checklist shows below it, open by default, every step listed: done ones checked, the current one spinning, the rest as empty circles. Without a plan the line expands to the actions so far. Either way it ends with Full log, Watch its computer and Stop. Helpers working for the agent get their own live lines.

When the run finishes, a collapsed note sits above its first message: "Worked for 2m 14s · 5 steps" (the plan's steps, or "3 of 5 steps done" if it stopped short; without a plan, the number of actions). Expanded, it shows the plan, or else only actions and outcomes (tool calls, a human's answers, failures, budget stops), never the model's thinking. Runs with neither get no note. The run's page in the panel shows the plan above the full log.

There is no task board. Agents hand each other work by message (see the "Messaged …" line above), and a helper's result goes to the agent that started it rather than into the chat.

### Agent profile

Details: status with Pause/Resume; Routines as cards with the schedule in words ("Every day at 2:31 AM and 2:31 PM", in local time) and a switch; Customize and Memory rows; helpers. Library: files the agent shared in chats, grouped by Today, Yesterday, This week, This month, Older. Computer: the live screen with take-control, recent work, blocked sites, setup script and snapshots. Hovering the screen offers Expand (also an icon in the bar below it), which fills the window with the screen at 16:10 over the dimmed app, the agent's name on top and Take control and Collapse beside it. Escape collapses it, except while you have control and the screen has focus: then Escape goes to the computer. Only one view is connected at a time.

A routine opens to its Instruction, When to run, where it reports and its last and next run, with Pause, Edit, Run now and Delete. The editor picks a schedule in local time (every day, weekdays, weekends, certain days, every few hours or minutes, or a raw cron) and stores UTC cron. When one cron can't express the choice (times with different minutes, or local days that map to different UTC days), it says so instead of saving something else.

### Avatars

Agents are blob characters with two eyes: eight shapes, each filled with the agent's color. The shape comes from the agent's emoji (the editor's eight emoji map to the eight shapes), so Telegram and Slack, which show the emoji, stay consistent. People are their initials in a circle. A group shows two of its agents overlapping.

### Settings rows

A section is a title (24px), an optional introduction, and groups: a 16px heading, an optional line of explanation, then rows divided by hairlines (no card around them). A row has the setting's name with one line of explanation on the left and its control on the right: a switch, a segmented control, a short input with Save, a status ("✓ Set", "Not reachable") or a button. When a row needs a form (a password, a token, a new secret), the button opens it inline under the row rather than in a dialog. On narrow screens the control drops below the text.

### Connect apps

- **Marketplace** (`/apps`): search, "N installed ›" with the first tiles stacked, then Featured, Chat apps and one group per category (first four apps, "Show all N"). Each app is a row in a two-column grid: tile, name and one line, and its quickest action on the right (Connect, Add for apps without sign-in, Set up for token apps and chat apps) or its state (Connected in green, Needs sign-in or Needs a token in amber, Can't connect in red). "Add a custom app" closes the list.
- **App page** (`/apps/:id`): back link, a 56px tile with the name, category and website, the state and the main action, with Remove in the ⋯ menu. Then what agents can do with it, a token field for token apps, **Agents with access** (a switch per agent), the tools it offers and its details (sign-in, address, tool names, MCP Registry entry). Connecting from the list opens this page, so choosing agents is the next step.
- **Installed** (`/apps/installed`): the same rows for connected apps, mcp.json servers and chat apps, then skills.
- Skills and Files keep their list-and-detail panes, filling the frame's height.

Members in team mode can look; only owners connect, remove or hand out apps.

### Dialogs, menus and feedback

The shared modal uses native `dialog.showModal()` (top layer, focus containment, Escape). Mark a dialog's first field with `data-autofocus`. Files open in a preview dialog from anywhere (attachments, libraries). Menus are rounded popovers; the profile menu opens upward from the bottom-left. Toasts are pills at the bottom center.

z-index tokens: 25 for the overlay panel, 30 for mobile navigation, 60 for toasts.

## Do's and Don'ts

- Use the CSS tokens for every surface and text color, and check both themes.
- Keep agents recognizable: the same blob and color in the list, the chat and the panel.
- Keep approvals in the conversation they belong to, with explicit decision buttons.
- Animate only live state (working dots, the live line); everything stops under `prefers-reduced-motion`.
- Check keyboard access, long names and text, and phone width before extending the UI.
- Do not copy competitor artwork or icons, or imply that planned features work today.
- Do not fill a real workspace with fabricated activity. Verification data belongs in an isolated test instance.
- Do not overwrite users' agent settings to make the interface look consistent.
