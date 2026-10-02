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

What changed from the first design: the Activity, Approvals and Tasks pages are gone. Approvals appear in the conversation where the agent asked; what agents did shows in the conversation as work notes; tasks remain something agents use among themselves (search still finds them). Skills, shared files, connectors and chat bridges live together under Connect apps.

## Colors

Dark (deep black) is the default; Light and Auto (follows `prefers-color-scheme`) are picked in the profile menu. The preference is stored as `teambot-theme` in local storage and applied in `index.html` before React renders, so there is no flash.

Use the variables in `apps/web/src/styles.css`: `--bg`, `--panel`, `--panel-2` (bubbles, inputs, cards), `--panel-3` (hover), `--active` (selected rows and tabs), `--text`, `--muted`, `--faint`, `--border`, `--border-strong`, `--accent` and `--on-accent`. Primary buttons invert: light ink on dark, dark ink on light. Never hard-code white or black text on them.

Color identifies agents and state, nothing else. Each agent's blob is drawn in its own color; the application chrome stays neutral. Green means working or done, amber means waiting for you, red means an error or a destructive action. The three tiles on the Connect apps button (blue, green, amber) are the only fixed decorative colors.

Body text and placeholders should meet WCAG AA (4.5:1) in both themes. `--muted` is for secondary text; `--faint` only for timestamps and hints.

## Typography

Inter (variable, bundled through `@fontsource-variable/inter`, so nothing is fetched from the internet) for everything except code, paths and model IDs, which use the monospace stack.

UI text is 14px; message bubbles are 15px with a 1.62 line height. Conversation names in the sidebar are 14.5px semibold over a 13px preview. Page titles are 26px bold with slight negative tracking.

Write short labels: Create new agent, Customize, Pause, Edit, Full log. Empty states say what to do next.

## Layout

- **Sidebar** (300px; 72px when collapsed, remembered per browser): collapse, search and new-chat buttons; the conversation list newest first (a chat per agent, each group chat, and DMs with people in team mode); the profile button and Connect apps at the bottom.
- **Chat**: messages up to 780px wide, a floating pill with the agent or group name (it opens the profile), and a pill-shaped composer with an attach button and a round send button.
- **Panel** (400px): the agent's or group's profile, or a page opened from it (a routine, the routine editor, memory, customize, a thread, a run's full log). It sits beside the chat on wide screens and covers it at 1100px and below, where it starts closed and closes when you switch chats.
- At 760px and below the sidebar becomes a full-screen navigation drawer opened from the top bar.

Panel pages remember which conversation they were opened on (`panel.at` in the store); anywhere else the panel shows that conversation's own profile.

## Components

### Conversation list

Each row: avatar (40px), name, and one line of preview — the last message without Markdown, "You:" for your own, the author's name in group chats, "Working…" while an agent works there, and "Needs your answer" (amber) when an approval waits. Idle agents show no status dot. Opening a chat doesn't reorder the list; only messages do.

### Messages

Your messages are right-aligned bubbles; everyone else's are left-aligned. In a chat with one agent its name isn't repeated; in group chats the author's avatar and name head each run of messages. Hovering shows the time, Reply (thread) and Copy. System notices (📋, ⚠️) are centered muted text without a bubble.

When an agent working for a conversation messages someone elsewhere, the conversation shows a centered line at that point: "Messaged [blob] Job Scout", "Messaged you" or "Posted in #launch", with the author's name first when it isn't the agent you're chatting with. Several posts in a row to the same place share one line. It opens that conversation. A conversation between two agents has a "Job Scout ⇄ Writer" pill, names the author of every message, and has no composer: a line at the bottom points to your own chat with either agent.

### Work notes

While an agent works for a conversation, one live line at the bottom says what it is doing now ("Search history for …", "Waiting for your approval"), with a shimmer, led by the agent's name unless it's the one you're chatting with. It expands to the steps so far, Full log, Watch its computer and Stop. When the run finishes, a collapsed note sits above its first message: "Worked for 2m 14s · 9 steps". Expanded, it lists only actions and outcomes (tool calls, a human's answers, failures, budget stops), not the model's thinking. Runs that took no actions get no note.

### Agent profile

Details: status with Pause/Resume; Routines as cards with the schedule in words ("Every day at 2:31 AM and 2:31 PM", in local time) and a switch; Customize and Memory rows; helpers. Library: files the agent shared in chats, grouped by Today, Yesterday, This week, This month, Older. Computer: the live screen with take-control, recent work, blocked sites, setup script and snapshots.

A routine opens to its Instruction, When to run, where it reports and its last and next run, with Pause, Edit, Run now and Delete. The editor picks a schedule in local time (every day, weekdays, weekends, certain days, every few hours or minutes, or a raw cron) and stores UTC cron. When one cron can't express the choice (times with different minutes, or local days that map to different UTC days), it says so instead of saving something else.

### Avatars

Agents are blob characters with two eyes: eight shapes, each filled with the agent's color. The shape comes from the agent's emoji (the editor's eight emoji map to the eight shapes), so Telegram and Slack, which show the emoji, stay consistent. People are their initials in a circle. A group shows two of its agents overlapping.

### Connect apps

One page with Apps (MCP connectors, mcp.json servers, Telegram, Slack), Skills and Files tabs. Members in team mode can look; only owners change apps.

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
