---
name: TeamBot
description: A monochrome workspace for a personal team of AI agents.
colors:
  light-background: "#f7f7f7"
  light-surface: "#ffffff"
  light-secondary: "#f5f5f5"
  light-text: "#202020"
  light-muted: "#656565"
  light-border: "#e7e7e7"
  dark-background: "#111111"
  dark-surface: "#181818"
  dark-secondary: "#202020"
  dark-text: "#eeeeee"
  dark-muted: "#ababab"
  dark-border: "#303030"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
    fontWeight: 400
  page-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  welcome-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 550
    letterSpacing: "-0.035em"
rounded:
  control: "8px"
  panel: "12px"
  workspace: "14px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
  section: "32px"
components:
  primary-button-light:
    backgroundColor: "{colors.light-text}"
    textColor: "{colors.light-surface}"
    rounded: "{rounded.control}"
    height: "36px"
  primary-button-dark:
    backgroundColor: "{colors.dark-text}"
    textColor: "{colors.dark-surface}"
    rounded: "{rounded.control}"
    height: "36px"
  input-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
---

## Overview

TeamBot is a self-hosted, single-user office for named AI agents. People return to a conversation, give a teammate work, and review results. The interface should make that sequence easy to follow. A solo builder may use it in daylight or late at night, so light and dark receive equal attention.

This design pass covers the existing React application in `apps/web`. Product context comes from `README.md`, `CLAUDE.md`, `docs/FEATURE_MAP.md`, and `docs/research/landscape.md`. The roadmap describes both implemented and planned capabilities; the running code determines what the UI can offer today.

References reviewed on October 1, 2026:

- [Grok Bot](https://x.ai/bot) and its [launch description](https://x.ai/news/introducing-grok-bot). The public product illustration presents a neutral conversation list, distinct agent identities, and a large conversation pane. TeamBot adopts the emphasis on teammates and direct communication.
- [How we designed Muse](https://introducing.muse.ai/) and [Meta's introduction](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/). Muse describes personal names and avatars, ongoing conversations, visible activity, and explicit approval controls. TeamBot uses these as interaction references, while retaining its shared channels, task board, and per-agent computers.

These are public references, not a claim of access to either signed-in product. No competitor artwork is included in TeamBot.

The sidebar puts agents first, followed by channels and workspace tools. Chat is the default agent view. Computer, work log, routines, and customization stay available as secondary tabs. The computer dock opens beside the conversation on wide screens and overlays it on smaller screens.

This session adds no new agent runtime capabilities. Memory, voice, generated avatars, marketplaces, new integrations, and other roadmap features remain future work. Identity controls edit the existing name, avatar, color, role, instructions, model, and MCP configuration fields.

## Colors

The workspace uses neutral grays. Primary actions invert between dark ink on light surfaces and light ink on dark surfaces. There is no purple application accent or gradient branding.

Use the semantic variables in `apps/web/src/styles.css`, especially `--panel`, `--panel-2`, `--text`, `--muted`, `--border`, `--accent`, and `--on-accent`. Do not hard-code white text on primary buttons, because those buttons become light in dark mode.

Small areas of color identify agents and communicate state. Avatar colors never tint the surrounding app. Green means success or working, amber means waiting or attention, and red means error or a destructive action. Status text accompanies these meanings. Warning banners remain visible when the server reports missing prerequisites.

The sidebar offers Light, Dark, and System. The preference is stored as `teambot-theme` in browser local storage and applied before React renders. System follows `prefers-color-scheme`, including changes while the app is open. When storage is unavailable, selecting a theme still applies for the current page.

Body text and placeholders should meet WCAG AA contrast of at least 4.5:1. Muted text must remain readable in both themes. Borders divide regions without competing with the content.

## Typography

Use the system sans-serif stack throughout the app. No external font requests are needed. Monospace is reserved for model IDs, paths, code, and technical details.

Navigation uses 13px text. Agent names are slightly heavier than their 11.5px role descriptions. Main text uses the body token; message prose has a 1.7 line height. Welcome headings use the welcome-title token and step down to 26px on narrow screens. Keep large headings above -0.04em letter spacing.

Write short action labels such as New agent, Customize, Save changes, and Watch live. Empty states explain what to do next. Technical details belong in configuration and work logs when users need them, rather than in welcome copy.

## Elevation

Separate regions with neutral surfaces and single-pixel borders. The desktop content pane has a small inset and rounded edges. Task columns have simple headers; individual tasks have a border, without another card wrapped around the column.

The shared modal uses native `dialog.showModal()`. This provides top-layer placement, keyboard focus containment, Escape dismissal, and focus restoration. Its backdrop dims the workspace. The dialog body scrolls while the footer remains available.

The CSS z-index tokens reserve 20 for the computer dock, 30 for mobile navigation, and 60 for toasts. Native dialogs use the browser's top layer. Avoid arbitrary high z-index values.

Hover feedback uses a 160ms color transition. Working indicators may animate, but all animation and transitions stop under `prefers-reduced-motion: reduce`. Do not animate page entrances or delay access to controls.

## Components

### Workspace and navigation

The desktop sidebar is 264px wide, reducing to 232px below 1100px. Agent rows show an avatar, name, role, and status. The new-agent action is at the top. Appearance, settings, and the global pause control are at the bottom.

At 760px and below, the sidebar becomes a full-width navigation panel opened from the top bar. Selecting a destination or pressing Escape closes it. The main pane is hidden while navigation is open. Preserve all destinations on mobile.

### Conversations

Messages and the composer share a maximum width of 840px. The composer has a lightly differentiated surface, a circular send button, and a mention hint. Enter sends; Shift+Enter adds a line. IME composition must not submit a message. A failed send retains its text. Switching conversations resets the draft so text cannot accidentally be sent to another agent.

Existing messages retain their author, timestamp, agent label, Markdown, and inline approvals. An empty channel introduces the team and links to agent conversations. First-run onboarding offers the existing starter team or a custom agent.

### Agent identity and customization

Creation begins with the existing role templates. A selected template uses a contrasting border and `aria-pressed`. The editor places a live identity preview beside the form. On mobile it stacks above the fields.

Offer preset emoji avatars and an editable avatar field, capped at the API's eight-character limit. Color swatches and a custom color picker update the existing avatar color. The preview reflects the draft name, role, avatar, color, and model. Changes only persist through Add agent or Save changes.

Model search keeps the existing model catalog. If the catalog cannot load, show the error and retain the manual model ID field. MCP options appear only when servers are configured. Do not show unimplemented skills, memory, or voice controls.

### Tasks, files, approvals, and settings

The board retains its status columns and horizontal scrolling on small screens. Task cards are keyboard-accessible buttons. Files and work logs use split panes on desktop and stacked panes on mobile. Activity tables scroll within the content region.

Approvals retain explicit decision controls and history. Settings retain system health, secrets, and policy editing. Applying the shared theme must not hide warnings or change these actions.

### Forms and feedback

Use the shared button, input, textarea, select, badge, and empty-state classes. New identity inputs have associated labels. Icon buttons need accessible names. Selected swatches and templates expose their state. Focus uses a visible two-pixel outline; never remove focus feedback without a replacement.

Use inline validation for form errors and status toasts for completed actions. Disable submission while saving. Keep the user's draft after a failure. Controls have larger targets on mobile.

## Do's and Don'ts

- Use CSS tokens for every shared surface and text color.
- Keep agents recognizable across navigation, conversations, and customization.
- Keep a single dominant action in each form.
- Check light and dark themes, keyboard access, long text, and narrow screens before extending the UI.
- Preserve the underlying policy, approval, pause, and takeover behavior.
- Do not introduce decorative gradients, large shadows, or colored application chrome.
- Do not copy competitor mascots or imply that planned features work today.
- Do not use fabricated activity, messages, or agents to fill a real workspace. Verification data belongs in an isolated test instance.
- Do not overwrite users' agent settings merely to make the interface look consistent.

For deeper product positioning in a later session, `$impeccable init` can capture a separate `PRODUCT.md`. It is not required to use this implemented design system.
