# Routines and triggers

A **routine** hands an agent an instruction at a set time, or when something happens outside TeamBot. A routine reports in a conversation you choose, can follow a skill, and can be made **read-only** so the agent can only look and report.

Routines belong to an agent. Click the agent's name at the top of its chat to open its panel, and under **Routines** use **New routine** (+). The list has a switch per routine to turn it on and off. Agents can also set routines up themselves when you ask for something "every morning" (see [Routines agents set up](#routines-agents-set-up)).

## The parts of a routine

| Field | What it does |
|---|---|
| **Name** | Shown in the list and in the prompt the agent gets ("Routine "Morning brief" …"). |
| **Instruction** | What the agent should do each time, up to 5,000 characters. Write it the way you would message the agent. |
| **Starts** | The trigger: on a schedule, or when a webhook is called, an email arrives, a Slack message is posted or a calendar event is coming up. |
| **Report in** | The conversation the agent works and replies in. If you leave it empty, it uses your chat with the agent. |
| **Skill to follow** | Optional. The agent loads this [skill](skills-and-memory.md) first and follows it. |
| **Read-only** | For monitoring. The agent can browse and read, but can't run commands, click, type, change files or change memory, and anything it asks a teammate is read-only too. It replies only when something needs attention. |

A routine that fires while the agent is busy waits in its inbox. A routine for an agent that is over budget waits until the budget allows it.

## On a schedule

Choose a frequency (every day, weekdays, weekends, certain days, every few hours, every few minutes) or **Custom (cron)** and write a standard five-field cron expression:

```
┌ minute (0–59)
│ ┌ hour (0–23)
│ │ ┌ day of month (1–31)
│ │ │ ┌ month (1–12)
│ │ │ │ ┌ day of week (0–6, Sunday = 0)
│ │ │ │ │
0 9 * * 1-5     weekdays at 09:00
*/30 * * * *    every 30 minutes
0 8 1 * *       08:00 on the first of each month
```

Times are in the **server's local time zone**. In Docker Compose that is UTC unless you set `TZ` for the container. The routine's page shows when it runs next. A run missed while the server was down is not made up later.

## When a webhook is called

Any service that can send an HTTP POST can start the routine: CI, a form, a monitoring alert, Zapier. When you save a webhook routine, its page shows the URL, a secret token and a ready-made `curl` command:

```bash
curl -X POST http://127.0.0.1:8787/api/hooks/<routine-id> \
  -H "x-teambot-token: <token>" \
  -H "content-type: application/json" \
  -d '{"text": "Deploy of web-2 failed on step migrate"}'
```

- Send the token in the `x-teambot-token` header, or as `?token=` if the sender can't set headers.
- The body can be anything up to 256 KB. JSON, form data and plain text are passed on as they are. The agent sees the first 20,000 characters, tagged as **untrusted content** that it must not take orders from.
- Responses: `202` accepted; `404` wrong URL or token; `409` the routine is turned off; `410` its agent was removed; `429` ten calls are already waiting for the agent (try later).
- **Make a new token** on the routine's page if a token leaks. The old one stops working at once.

TeamBot listens on `127.0.0.1`, so a service on the internet can't reach the webhook directly. Put it behind a reverse proxy or a tunnel you control (see [Deployment](deployment.md)), and expose only `/api/hooks/` if that's all you need.

## When an email arrives

TeamBot checks any IMAP mailbox **every 2 minutes** for **unread** mail received since the day the routine was created. Each match goes to the agent and is marked as read.

| Field | Example |
|---|---|
| IMAP server, port | `imap.gmail.com`, `993` |
| User | `you@gmail.com` |
| Password | For Gmail and Outlook, an **app password**, not your account password |
| Only mail from | `alerts@vendor.com` (optional) |
| Subject contains | `invoice` (optional) |

Each check picks up at most five messages. Attachments are saved under `/shared/uploads/email`, so the agent can open them. The password is stored encrypted as a reserved secret: agents can't see or use it. After you save, the mailbox is checked straight away so a wrong password shows up at once. **Check now** on the routine's page checks again, and the page shows when it last checked and the last error.

Good fits: forwarding invoices to an agent that files them, triaging a support inbox in read-only mode, acting on alert emails.

## On a Slack message

1. Connect Slack under **Connect apps** first (see [Connectors](connectors.md#telegram-and-slack)).
2. Invite the app to the channel in Slack: `/invite @TeamBot`.
3. Copy the channel ID from the bottom of the channel's details in Slack (it looks like `C0123ABCD`) into **Slack channel ID**.

Every new message in that channel then starts the routine with who wrote it and what they wrote. Edits, joins and the bot's own messages are ignored.

## Before a calendar event

Paste a calendar's **iCal address**. For Google Calendar, that's Settings → your calendar → "Secret address in iCal format". TeamBot reads the feed **every 5 minutes** and starts the routine **Minutes before** each event (10 by default). It handles recurring events and time zones, and fires once per event. After downtime it skips meetings that are long over. The event's title, start and end, location, organizer, attendees and description reach the agent as untrusted content. The address is stored encrypted, because whoever has it can read the calendar.

A good fit: "Before each meeting, look up the attendees' companies and send me a one-paragraph brief."

## Read-only routines for monitoring

Tick **Read-only** for routines that should only watch:

> Every hour, check status.example.com and our pricing page. Tell me if anything changed since last time.

A read-only run:

- has only tools that look (browsing, reading files and pages, searching history), plus messaging and its progress checklist;
- passes on read-only status to any teammate it asks;
- ends with `[silent]` (nothing posted) when nothing needs attention, so you're only told about changes.

## Routines agents set up

Ask an agent for something recurring ("every weekday at 9, summarise new GitHub issues in #dev") and it can set up the routine itself with `create_routine`, for itself or for a teammate. The guardrails:

- The default policy sends `create_routine` to the **reviewer model**. Change that rule to `ask` if you want to approve every new routine yourself.
- An agent's routines run **at most every 15 minutes**. A person can set shorter intervals in the editor.
- A routine's own run can't create or resume routines, so routines can't multiply themselves.
- `list_routines` shows them. `stop_routine` with `pause: true` pauses one, and `resume_routine` turns it back on. Stopping for good removes a routine an agent set up, but only pauses one a person made.

## Running one now

**Run it now** (the play button on a routine's page) fires it straight away, which is the quickest way to test an instruction. Each run shows up in the conversation it reports in, like any other job, with its checklist and tool cards.
