# P0 / P1 implementation review

Reviewed 2026-10-02 against `docs/FEATURE_MAP.md`, the current source, and the existing tests.

**Verdict: most features exist, but P0 and P1 are not yet correctly complete.** There are reproducible defects in isolation, DM privacy, cancellation, crash recovery, budgets, read-only monitoring and calendar triggers. Feature presence and passing happy-path tests are not sufficient to mark these requirements complete.

This was a review, not a repair. Application source was not changed.

## Status after fixes (2026-10-02)

All 14 findings were confirmed against the source and fixed, with regressions in `apps/server/test/hardening.test.ts`, `triggers.test.ts` and `docker.integration.test.ts` (rebuilt image). Three related gaps found while verifying were fixed too:

- Read-only escape (10) was wider than stated: a read-only run could `@mention` another agent or `spawn_helpers` and get a normal run. Tools now opt in to read-only use (`readOnlyOk`), and work a read-only run hands on stays read-only.
- Agent computers on Docker Desktop reach the host's `127.0.0.1` through `host.docker.internal`, so finding 2 also applied to host mode, not only Compose. Open-mode computers are now firewalled off the TeamBot host.
- An agent could read a private DM it belongs to on behalf of anyone (`read_channel`, `search_history`). In team mode it now reads only what everyone in the run's conversation could read.

Remaining limits, documented rather than fixed: an agent allowed to use a secret in a shell can deliberately reveal it (13 narrowed the claim, refuses values under 4 characters and withholds screenshots from secret-using actions); coding-agent CLI spend is not counted in budgets (8); dependencies are advisory; BYO/local model endpoints are still missing.

## Validation

- Existing non-Docker suite: **88 tests passed** in 20 suites.
- Existing Docker integration suite: **5 tests passed**, using the installed `teambot/computer:latest` image. The image was not rebuilt during this review.
- Server, web and computerd typechecks: **passed**.
- Production web build: **passed**.
- Eight additional isolated reproductions confirmed defects using an in-memory workspace, fake models/computers and synthetic data. A ninth reproduction used a disposable real Docker computer to confirm cancellation failure.
- Initial test/typecheck attempts could not read several installed dependency files inside the sandbox. Rerunning with the required local access passed; this was an environment restriction, not a code failure.
- No live paid model, real Slack/Telegram account, real mailbox/calendar account, external OAuth provider, or real OTLP collector was used. Those integrations have mock/protocol test coverage, not live-service acceptance coverage from this review. No interactive browser UI acceptance pass was performed.

## Findings, ordered by impact

### 1. High: the shared-folder boundary follows links outside its root

**Affects:** P0 shared files, isolation and secret protection.

`sharedPath()` checks the lexical path only. File reads, attachment checks and uploads then follow filesystem links. An agent can create a link in the shared volume; in the Linux Compose deployment, that link can resolve to a server-side path such as `/data` when the server follows it. Reads may expose server files, and an upload directory link can redirect writes outside `/shared`.

**Reproduced:** a link inside an isolated test shared folder pointed to a sibling directory containing a synthetic server-only marker. `GET /api/shared/file` returned **200** with that marker.

**References:** [shared-files.ts:10](../apps/server/src/shared-files.ts#L10), [api.ts:975](../apps/server/src/api.ts#L975).

**Needed:** enforce the resolved filesystem boundary for existing files and upload parents, reject links where appropriate, and account for replacement races. Test both reads and writes through links.

### 2. High: default Compose networking exposes the owner API to agent computers

**Affects:** P0 isolation, governance and self-hosting.

Compose binds the server to `0.0.0.0` inside the same `teambot` network that agent containers join. With team sign-in off, the API authentication hook returns immediately and requests act as the owner. An agent with the default open network can therefore reach the management API directly, including policy and other-agent settings. Publishing the host port on `127.0.0.1` does not isolate this internal container path.

**Evidence:** source/configuration trace; a complete Compose deployment attack was not executed.

**References:** [docker-compose.yml:21](../docker-compose.yml#L21), [docker.ts:258](../apps/server/src/computers/docker.ts#L258), [api.ts:174](../apps/server/src/api.ts#L174).

**Needed:** authenticate management traffic even in personal mode and isolate computers from the management API/network.

### 3. High: a team member can join somebody else's private DM

**Affects:** P1 private DMs and multi-user access control.

The message endpoints check `channelFor()`, but the channel membership mutation endpoints do not. A signed-in member can supply their own member ID to another DM's membership endpoint and then read it normally. Channel IDs are also exposed through unfiltered run/approval metadata. Separately, `/api/runs/:id` returns transcripts and events without a channel visibility check, exposing the original DM input even when the message endpoint refuses access. Agent `read_channel` also accepts a channel ID through `resolveChannel()` without checking visibility.

**Reproduced:** private messages returned **404**, adding the test member returned **200**, and the same messages then returned **200** including the private marker.

**References:** [api.ts:483](../apps/server/src/api.ts#L483), [api.ts:547](../apps/server/src/api.ts#L547), [workspace.ts:65](../apps/server/src/workspace.ts#L65).

**Needed:** enforce visibility and membership-management permissions on every relevant route/tool; prevent arbitrary membership edits to DMs; filter transcripts/events as well as messages.

### 4. High: one agent run mixes private and public conversations

**Affects:** P0 conversation routing and durable queues; P1 DM privacy.

The runtime consumes every pending inbox item for an agent into one transcript, regardless of channel or thread. It then changes the run's reply destination to the latest input's channel/thread. A DM and a public mention can become one model request whose answer is published publicly. Inputs from different people can also be mixed this way. Mixed read-only and ordinary inputs remove the run's read-only restriction.

**Reproduced:** queued a private DM and then a public mention for a paused agent. On resume, one model call received both, and its synthetic echo published the private marker in the public channel.

**Reference:** [runtime.ts:284](../apps/server/src/runtime/runtime.ts#L284).

**Needed:** separate runs/transcripts by conversation and authorization context, and preserve the source and reply destination of each request.

### 5. High: cancelling or pausing a run does not stop its computer command

**Affects:** P0 pause/resume/cancel, global stop, human takeover; P1 coding agents.

The server aborts its HTTP request, but computerd does not connect request disconnection to command cancellation. `runShell()` kills its process group only on its own timeout. Long-running shell commands and coding CLIs can therefore keep changing files or making external requests after the UI says cancelled/paused; they can also continue during human takeover.

**Reproduced on real Docker:** cancelled a command during a short sleep. The run became `cancelled`, but the command subsequently wrote its marker file. Result: `{ runStatus: 'cancelled', commandContinued: true }`.

**References:** [docker.ts:56](../apps/server/src/computers/docker.ts#L56), [server.ts:95](../computer/computerd/src/server.ts#L95), [shell.ts:47](../computer/computerd/src/shell.ts#L47).

**Needed:** explicit remote cancellation and process-group termination, with acknowledgement before treating the computer as stopped or safe for takeover.

### 6. High: crash recovery can silently repeat a completed tool

**Affects:** P0 crash-safe durable work and action audit.

`tool.finished` is persisted before the tool result is saved into the transcript. If the process dies in that window, the call is still pending in the transcript. Recovery only inserts an interrupted result when a start exists **without** a finish; a pending call with both events is left pending and executes again. There is also a separate input-loss window: inbox items are consumed before their transcript is saved, without one encompassing transaction.

**Reproduced:** seeded the exact persisted state of a started-and-finished shell call with its transcript result absent, then restarted the runtime. The shell call executed again.

**References:** [runtime.ts:120](../apps/server/src/runtime/runtime.ts#L120), [runtime.ts:279](../apps/server/src/runtime/runtime.ts#L279), [runtime.ts:288](../apps/server/src/runtime/runtime.ts#L288), [runtime.ts:488](../apps/server/src/runtime/runtime.ts#L488).

**Needed:** persist completion/result atomically, treat any already-started pending action conservatively during recovery, and consume input in the same transaction that stores it in the run.

### 7. High: member-editable setup scripts can use reserved secrets

**Affects:** P0 vault guarantees; P1 owner/member boundaries and setup scripts.

Members may edit an agent's setup script and start/rerun its computer. Setup execution calls `vault.resolve()` without the `forAgent` restriction, so reserved `TEAMBOT_*` values can be injected into member-authored commands. Output redaction does not prevent writing a resolved value to a file or sending it elsewhere.

**Reproduced:** a member patched a setup script referencing a synthetic reserved secret; the fake computer received the resolved secret in the command. No real credentials were used.

**References:** [api.ts:164](../apps/server/src/api.ts#L164), [api.ts:339](../apps/server/src/api.ts#L339), [lifecycle.ts:109](../apps/server/src/runtime/lifecycle.ts#L109).

**Needed:** make privileged setup configuration owner-controlled and explicitly restrict which secrets setup may resolve.

### 8. High: retiring a helper removes its spending from the parent's cap

**Affects:** P1 budgets and short-lived helpers.

Budget families are derived from currently existing agents. Retirement deletes the helper's row, so future parent budget checks no longer include that helper's past costs. Costs remain in the workspace-wide total, but the parent's daily/monthly/token caps can be bypassed by finishing and replacing helpers.

**Reproduced:** a helper spent $2 against a $1 parent cap. Parent was blocked before retirement and unblocked afterwards, while the workspace still showed $2.

**References:** [budget.ts:24](../apps/server/src/runtime/budget.ts#L24), [helpers.ts:23](../apps/server/src/runtime/helpers.ts#L23).

**Needed:** persist billing ownership with usage records or retain historical family membership. Also account for coding-agent API consumption if the caps are intended to cover all agent spend: the current cost events cover harness model calls, compaction and reviews, not CLI provider usage.

### 9. High: egress enforcement is installed after the computer has started

**Affects:** P1 fail-closed network allowlists.

`ensure()` starts the container and waits for its browser/daemon to become healthy before installing the firewall. Containers also use `unless-stopped`, so Docker may restart them independently. The firewall is not persistent across restart, and server startup starts proxies rather than first restricting every running computer. Existing established connections are accepted when restrictions are applied. The steady-state integration test passes but does not establish a fail-closed startup/restart boundary.

**Evidence:** source trace; the startup/restart bypass was not separately reproduced.

**References:** [docker.ts:130](../apps/server/src/computers/docker.ts#L130), [docker.ts:231](../apps/server/src/computers/docker.ts#L231), [docker.ts:273](../apps/server/src/computers/docker.ts#L273).

**Needed:** establish host/network-namespace restrictions before any agent-controlled process starts, including Docker restarts, and handle pre-existing connections when tightening policy.

### 10. Medium: read-only routines still have mutating internal tools

**Affects:** P1 read-only monitoring.

The read-only allowlist admits all tools with risk `internal`. That includes `remember`, `forget`, `create_task` and `update_task`, rather than only looking and reporting. A monitoring routine can change persistent memory or the task board.

**Reproduced:** a run with `readOnly: true` successfully wrote `MUTATED_BY_READ_ONLY_RUN` into its agent memory.

**References:** [runtime.ts:30](../apps/server/src/runtime/runtime.ts#L30), [knowledge-tools.ts:38](../apps/server/src/tools/knowledge-tools.ts#L38), [workspace-tools.ts](../apps/server/src/tools/workspace-tools.ts).

**Needed:** use an explicit read-only capability separate from internal/external risk, allowing reporting only as an intentional exception.

### 11. Medium: some external event text is placed outside the untrusted wrapper

**Affects:** P1 untrusted-content tagging and event triggers.

Email sender display text and calendar summaries are interpolated into `event.via`. That value becomes part of the instruction-like routine heading outside `<untrusted_content>`, although the body is wrapped correctly. These fields are controlled by external senders/feed authors.

**Evidence:** source trace.

**References:** [triggers.ts:248](../apps/server/src/runtime/triggers.ts#L248), [triggers.ts:280](../apps/server/src/runtime/triggers.ts#L280), [cron.ts:80](../apps/server/src/runtime/cron.ts#L80).

**Needed:** keep a fixed trusted event heading and put all external metadata inside the wrapper.

### 12. Medium: a calendar routine at zero minutes before never fires

**Affects:** P1 calendar event triggers.

The API permits `minutesBefore: 0`, but the query interval is `(max(since + lead, at), at + lead]`. With a zero lead this is always empty. Short leads can also miss an event that starts between the five-minute checks.

**Reproduced:** checked immediately before, exactly at, and after a synthetic event's start with zero lead; no inbox item was created.

**Reference:** [triggers.ts:266](../apps/server/src/runtime/triggers.ts#L266).

**Needed:** query the elapsed notification window and deduplicate by occurrence, including events whose notification time fell between polls.

### 13. Medium: “secrets never shown to the model” is not true for every output

**Affects:** P0 secret protection; P1 desktop tools.

Text redaction intentionally skips values shorter than four characters. Screenshots are saved and sent to the model unchanged. For example, entering an injected secret into a visible non-password field with `computer_type` returns a screenshot containing the value; text redaction does not alter those pixels. Encryption and ordinary text placeholder injection work, but the absolute claim is too strong.

**Evidence:** source trace; no real secrets were displayed or sent during review.

**References:** [vault.ts:111](../apps/server/src/vault.ts#L111), [runtime.ts:474](../apps/server/src/runtime/runtime.ts#L474), [vision.ts:13](../apps/server/src/runtime/vision.ts#L13), [vision.ts:50](../apps/server/src/runtime/vision.ts#L50).

**Needed:** cover supported short values and prevent sensitive screen content from reaching models, or explicitly narrow the guarantee and supported secret-entry flows.

### 14. Medium: invalid stored policy falls back to permissive defaults

**Affects:** P0/P1 deterministic fail-closed governance.

Save-time validation rejects malformed policies, and CEL evaluation failures are conservative. However, if a stored policy becomes invalid (for example after migration/version changes or database editing), startup silently substitutes the default policy. That default allows ordinary read, write and internal tools, potentially loosening a previously restrictive policy.

**Reference:** [policy.ts:308](../apps/server/src/policy.ts#L308).

**Needed:** block execution until the policy is repaired or enter an explicit deny/ask-all recovery mode.

## Coverage of every P0 roadmap item

“Present” means implementation and relevant evidence were found, not that all possible paths are proven correct. Cross-cutting findings above still apply.

| P0 item | Assessment |
|---|---|
| Self-hosted API, UI, scheduler and computer pool | Present; SQLite substitution is documented. Default Compose isolation needs finding 2 fixed. |
| Named roster, role, instructions, avatar | Present; API/UI wired and partial-update tests pass. |
| Model choice per agent, including BYO/local in the matrix | **Partial:** per-agent OpenRouter models work; production provider and base URL are fixed to OpenRouter. No configurable local/OpenAI-compatible endpoint or direct provider adapter. See `app.ts:88`, `models/openrouter.ts:7`. |
| Dedicated isolated computer, terminal and filesystem | Present; real Docker tests pass. Stronger gVisor runtime is opt-in, not the architecture's stated default. Findings 1 and 2 weaken isolation. |
| Persistent browser/logins and state across restart | Persistent home volume and browser profile implemented; existing tests exercise computer operations and home restore, not a real third-party login lifecycle. |
| Live screen and human takeover | VNC and controls present; cancellation/takeover safety needs finding 5 fixed. No live UI acceptance check in this review. |
| Agent DMs, human/agent channels, threads | Present with tests; findings 3 and 4 prevent privacy/routing sign-off. |
| Attachments and shared artifact hand-off | Present with upload/thread tests; finding 1 blocks safe boundary sign-off. |
| Task ownership, claim/reassignment, hand-off and dependencies | Present with pipeline tests. Dependencies notify/instruct agents to wait; they are not a hard prohibition on starting/completing a blocked task. |
| Offline background work and durable queue | Server-side runtime present; findings 4–6 prevent full durability/cancellation sign-off. |
| Context compaction | Implemented with a utility model and retained transcript tail; no dedicated compaction/crash test in the current suite. |
| Rules: allow/ask/deny/handoff, approval inbox | Present; focused policy/runtime tests pass. Findings 2, 7 and 14 weaken overall governance. |
| Global pause/kill switch | Dispatch pause present and tested; active computer execution is not killed (finding 5). |
| Vault, injection and secret redaction | Encryption/injection tests pass; findings 1, 7 and 13 prevent the absolute secret guarantee. |
| Activity timeline and audit | Event persistence, API and UI present; privacy filtering and atomic result durability need findings 3 and 6 fixed. |
| MCP client | Implemented and connector tests pass. Host-side execution rather than per-computer isolation is an explicitly documented limitation. |
| Cron schedules | Implemented with persisted schedules and runtime inbox delivery. |

## Coverage of every P1 completion-table item

| P1 item | Assessment |
|---|---|
| Reviewer model | Present; allow/ask/deny and unavailable/invalid-response handling tested. |
| Untrusted-content tagging | Partial; ordinary tool bodies protected, event metadata gap in finding 11. |
| Spend/token budgets | Partial; basic caps tested, helper retirement defect in finding 8; CLI usage is uncounted. |
| CEL policies | Present and tested; invalid stored-policy startup behavior needs finding 14 fixed. |
| Egress proxy and allowlists | Real steady-state Docker enforcement passed; startup/restart gap in finding 9. |
| Skills / SKILL.md | Present; parsing, access filtering, editor/API and text supporting-file copy tested. Binary or oversized supporting files are explicitly skipped. |
| Routines with skill and trigger | Present; read-only semantics need finding 10 fixed. |
| Webhook, email, Slack and calendar triggers | Present with tests; calendar timing defect and untrusted metadata gaps in findings 11–12. Mail and feed tests use fakes. |
| Proactive monitoring and stalled-task follow-ups | Follow-up implementation/tests present; read-only monitoring remains partial (finding 10). |
| Editable plain-file memory | Present; agent/team files, remember/forget, editor and rename behavior tested. |
| Search across past sessions | Message/task search implemented for human and agent callers. Run/tool transcripts are not searchable; filtering must remain consistent with finding 3. |
| Lead agent per channel | Present and tested for unaddressed human messages. |
| Base images, setup, sleep/snapshot, idle shutdown | Present; Docker setup and snapshot/restore passed. Setup-secret permissions need finding 7 fixed. Snapshots cover the home folder, not the full OS image or `/shared`. |
| Slack and Telegram bridges | Present; messages, approvals and files have mocked tests. Each bridge pairs one owner identity; this is not per-member bridge identity. |
| Full GUI computer use | Present and real screenshot/coordinate-click tests pass. Secret-image issue in finding 13 remains. |
| Coding-agent adapter | Claude Code/Codex/Gemini command construction, key environment and tool wiring present; mocked tests pass. Live CLI/provider runs not tested; cancellation and spend limitations remain. |
| Short-lived helpers | Spawn/report/retire tested; historical budget accounting is broken (finding 8). |
| OAuth app connectors | Discovery/registration/PKCE/refresh tested against a test OAuth/MCP server; real vendors not exercised. |
| Multi-user workspace | Sign-in/invites/roles implemented and ordinary auth tests pass; findings 3, 4 and 7 block release sign-off. |
| OpenTelemetry export | OTLP JSON log/trace payloads implemented and tested via fake transport. Real collector acceptance not exercised; model spans currently have identical start/end timestamps. |

The matrix's messaging row names Teams and WhatsApp too, but the P1 roadmap explicitly narrows delivery to **Slack and Telegram first**. Those other bridges are not implemented and should not be implied by the completion claim. Likewise, the matrix's coding examples include Cursor while the delivered adapter list is Claude Code, Codex and Gemini.

## Recommended status

- **P0: implemented with release-blocking correctness and isolation defects.**
- **P1: broad feature coverage, partial correctness, not ready for an unqualified “complete” claim.**
- Prioritize findings 1–9, then the remaining correctness/safety issues. Add regressions for the reproduced paths before changing the completion claim.
- Keep documented substitutions (SQLite, host-side MCP, Slack/Telegram-first) distinct from actual missing scope (BYO/local models) and defects.
