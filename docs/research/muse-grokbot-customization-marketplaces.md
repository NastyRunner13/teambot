# Muse and Grok Bot customization and marketplace research

Prepared for TeamBot · 1 October 2026

## Findings

Both Meta Muse and SpaceXAI Grok Bot let people give an agent a recognizable identity. Their extension experiences differ. Grok Bot documents an in-app Marketplace for connector plugins and packaged skills, plus a public marketplace of Bot templates. Muse documents a connector directory, a partner submission process, and custom connectors created through conversation. The reviewed Muse materials do not establish an equivalent public, first-party marketplace for arbitrary user-authored skill packages. Sources: [Grok Bot apps](https://docs.x.ai/grok-bot/computer-and-apps), [Grok Bot skills](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Muse Connector Platform](https://muse.ai/platform), [Muse connector help](https://www.meta.com/help/artificial-intelligence/1687253048996149/).

For TeamBot, the useful direction is a persistent agent profile, a browsable capability catalog, and a guided connection process. Treat appearance, instructions, installed packages, authenticated accounts, and permission grants as separate records. This is our design recommendation, not a claim about either company's private implementation.

This report covers public documentation, engineering posts, public catalogs, and relevant open repositories. It does not claim a hands-on test of authenticated Muse or Grok Bot accounts. Coding products, Muse Code and Grok Build, appear only where their published extension formats help explain marketplace mechanics. Their features must not be assumed to exist in the personal-agent apps.

## What the different objects mean

| Object | What it changes | Example |
|---|---|---|
| Agent profile | Identity and standing behavior | Name, avatar, role, tone, recurring responsibilities |
| Avatar | Visual representation | Portrait, mascot, accessories, activity animation |
| Skill | Instructions for doing a task | How to prepare a weekly research briefing |
| Connector | Access to a particular service | An authenticated connection to a calendar |
| MCP server | A protocol endpoint exposing capabilities | Tools for searching issues or creating a document |
| Plugin | An installable bundle of capabilities | Skills plus an MCP server and configuration |
| Agent template | A reusable starting configuration | A research assistant with instructions and integration requirements |
| Routine | When a workflow runs | Run the briefing every Monday morning |

MCP stands for Model Context Protocol. It defines communication between an AI application and capability servers. It does not by itself supply a consumer marketplace, a package-review process, or an avatar system. A marketplace is an application layer around discovery and installation. Sources: [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture), [Grok Build extensions](https://docs.x.ai/build/features/skills-plugins-marketplaces).

## How agent appearance works

### Meta Muse

Meta describes custom avatars, names, personalities, and visual styles as core parts of Muse. The avatar also anchors the activity experience: a short status appears underneath it, and tapping it opens activity and approved permissions. This connects the character to ongoing work instead of using it only as decoration. The design post confirms the experience, but does not publish a complete specification of every appearance editor control. Source: [How We Designed Muse](https://introducing.muse.ai/).

Meta separately documents **Muse Realtime Avatar**, introduced on 23 September 2026. Its mechanism is more substantial than a set of prerecorded expressions:

1. Reference media establishes the character's appearance.
2. Muse Realtime Voice produces a stream of speech tokens.
3. An audio decoder produces speech while an audio-driven Diffusion Transformer uses the same tokens to produce matching video.
4. Recent video latents carry visual continuity into subsequent chunks.

Meta reports 448 × 768 video at 25 frames per second and approximately 870 milliseconds from the end of a user's turn to the first byte of synchronized output. These are vendor measurements, not our benchmarks. Crucially, Meta says its examples demonstrate model capability and do not all represent avatars available in the app. This research therefore does not assume unrestricted image uploads or that every small idle animation uses this model. Source: [Bringing Your Muse to Life](https://research.meta.ai/blog/bringing-your-muse-to-life).

### SpaceXAI Grok Bot

The documented profile flow is **New → Create new Bot → Bot menu or Edit Profile**. Users can set the name, label, description, and avatar. Persistent instructions belong in the description; individual assignments belong in conversation. Source: [Create and manage Bots](https://docs.x.ai/grok-bot/bots).

SpaceXAI's design account describes a consistent character family with simple forms, expressive eyes, controlled variations, and accessories. Motion also communicates lifecycle state: idle, thinking, working, waiting, blocked, and done. This matters when a user has several Bots in a roster and needs to distinguish both identity and activity at a glance. Source: [Designing Grok Bot](https://x.ai/news/designing-grok-bot).

That source does not identify the rendering engine or asset format. It would be speculation to call the system Rive, Lottie, WebGL, sprite sheets, or a particular 3D rig. It also does not establish that every visual variation described by the designers is individually editable by users.

### What we should take from this

The following are TeamBot proposals:

| Layer | Suggested behavior | Reason |
|---|---|---|
| Identity | Save name, role, avatar asset, and appearance settings | Keep the same agent recognizable across chats and tasks |
| Behavior | Store instructions separately from appearance | Changing a character's look should not silently alter its permissions or job |
| Status | Drive expression and motion from actual runtime events | An animation should communicate work the system is really doing |
| Accessibility | Pair motion with a text status and reduced-motion option | Make status understandable without animation or color |
| Optional generation | Generate a character once, then reuse approved assets | Establish a coherent identity without generating video for every background task |

For an initial TeamBot version, a small original mascot system with selectable colors, accessories, and state animations is a practical starting point. Live generative video is a separate product investment involving voice, streaming, inference cost, and latency. The reviewed evidence does not justify making it a dependency of avatar customization.

## How people discover and configure extensions

### Grok Bot connector plugins and skills

The official setup sequence is **Marketplace in the sidebar → browse plugins → Add → complete browser authentication if requested**. In chat, `@` attaches a connector to the task. Installed connectors are account-wide. Source: [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps).

Skills have another entry point. A user can ask the Bot to save a successful workflow as a skill. The desktop composer exposes saved skills through `/`. Private skills are shared across Bots and can be checked under **Marketplace → Your plugins → Manage plugins and skills → Private skills**. Packaged skills can also be discovered through Marketplace. The documentation additionally describes teaching a workflow by demonstration, subject to rollout availability. Source: [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

A useful distinction is installation versus use. Installing a connector makes an integration available; signing in connects the account; referencing it in a task makes the intended service explicit. These are different user decisions, even if a product combines them into a short setup flow.

The reviewed public documentation verifies browsing and installation in the app. It does not disclose the in-app search ranking algorithm, recommendation model, internal catalog database, or exact package schema used by Grok Bot.

### Grok Bot templates and public search

The public Bot marketplace has a search field labeled **Search by creator or bot name**, categories such as Engineering and Design, featured entries, creator attribution, descriptions, and Add links. This is direct evidence of a searchable agent-template catalog. It should not be confused with a raw MCP server registry. Source: [Grok Bot Marketplace](https://x.ai/bot/marketplace).

The template guide describes a recipient opening a shared page, choosing **Add to Grok Bot**, reviewing the included context and integrations, and choosing **Add Bot**. The recipient gets a new Bot that may still need plugin installation and account setup. Custom code, scripts, API keys, and non-standard MCP setups are not automatically portable. Publishers can include setup instructions. Source: [Templates for Grok Bot](https://x.ai/bot/guides/templates-for-grok-bot).

The September 8 guide discusses selected reusable memories in a template. The September 29 management page says direct duplication excludes learned memory and conversation history. These are distinct operations. A TeamBot export should explicitly list its contents rather than treating duplication, publishing a template, and sharing a live agent as interchangeable. Sources: [Template guide](https://x.ai/bot/guides/templates-for-grok-bot), [Bot management](https://docs.x.ai/grok-bot/bots).

### Muse connectors and guided setup

Muse supports two entry points: ask it to connect a named service, or open **Settings → Connectors → Connect**, read the connection information, and continue through authorization. For an unsupported service, the user can ask Muse to create a custom connector. Setup may require API information, which Muse stores in its Secure Credentials Store. Meta explicitly says it does not review these custom connectors. Source: [How Muse works with Connectors](https://www.meta.com/help/artificial-intelligence/1687253048996149/).

The official distribution path for a provider is different. **Describe the product → submit the connector for review → appear in the directory after approval.** Meta describes functional, security, and legal review plus end-to-end testing. Editors can select connectors for featured placement. The page confirms a directory and review process; it does not disclose its search ranking implementation or a complete public manifest schema. Source: [Muse Connector Platform](https://muse.ai/platform).

Muse for Small Business adds named integrations including Asana, Canva, Figma, Notion, Shopify, Slack, Stripe, and QuickBooks. Meta says the full connector list is available in settings. This is evidence of a growing supported catalog, not evidence that every connector uses MCP internally. Source: [Muse for Small Business](https://muse.ai/business).

### Muse skills and community directories

Meta's engineering account describes skills as instructions written alongside service integrations. It also describes a VM capable of developing custom skills and says Muse can create connectors for services with APIs or CLIs. That supports extensibility, but does not establish a standardized public skill-upload store in the Muse app. Source: [How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).

An independent directory, Muse Skills, demonstrates a different distribution method. Users search or filter listings, inspect the supplied instructions, copy an installation prompt, and paste it into Muse. Listings include skills, prompt packs, workflows, and configuration snippets. The site identifies itself as unaffiliated with Meta. We verified that the directory presents this flow; we did not test the resulting installation or automatic skill loading inside Muse. Source: [Muse Skills](https://museskills.dev/).

For our research, distinguish three categories: officially distributed connector skills, user-created capabilities inside an agent workspace, and third-party directories that distribute prompts or files. Calling all three a native plugin marketplace would conceal meaningful differences.

## Comparison at a glance

This table summarizes the evidence above. An unverified feature is not necessarily absent.

| Capability | Meta Muse | Grok Bot |
|---|---|---|
| Personalized identity | Avatar, name, personality and style documented | Name, label, description and avatar documented |
| Visual activity feedback | Status under avatar; activity opens from avatar | Avatar motion reflects work state |
| Public avatar generation architecture | Realtime voice-to-video model described, with app availability caveat | Visual design principles described; rendering implementation undisclosed |
| Native extension discovery | Connector list and reviewed provider directory | In-app Marketplace for plugins and packaged skills |
| Public agent-template search | Equivalent first-party catalog not established by this review | Search by creator or Bot name plus category browsing |
| Custom workflow reuse | Built-in skills and custom development described; general upload-store contract unverified | Save a task as a skill; shared private library; `/` invocation |
| Unsupported service setup | Ask Muse to create a custom connector | Custom MCP setups acknowledged in template guide; universal setup UI not established |
| Public developer package reference | Muse Code docs, a separate product | Grok Build docs and repository, a separate product |

## What makes a marketplace work technically

### Published reference from Grok Build

The open `xai-org/plugin-marketplace` repository is a useful implementation reference, specifically for **Grok Build**. Its catalog lives in `.grok-plugin/marketplace.json`. Entries identify a plugin and its source, with optional descriptions, categories, keywords, domains, and display metadata. The documentation says keywords and domains support suggestions.

Sources can refer to local directories or remote repositories. Remote entries require a full commit SHA, which the client checks after cloning. A generated `plugin-index.json` lists included components so the client can preview package contents. The index must match the catalog's pinned revision. Catalog changes go through validation and code-owner review. These mechanisms connect search results to inspectable, versioned packages. Source: [Official marketplace repository](https://github.com/xai-org/plugin-marketplace/blob/main/README.md).

Grok Build exposes a terminal marketplace browser through `/marketplace`. Its plugin packages can include skills, commands, agents, hooks, MCP servers, and language servers. This proves a working package-and-catalog model in the vendor ecosystem; it does not prove Grok Bot uses the same repository or backend. Source: [Grok Build Plugin Marketplace announcement](https://x.ai/news/grok-plugin-marketplace).

### Published reference from Muse Code

Muse Code's developer documentation describes named marketplace catalogs, local snapshots, available-package listing, and explicit refreshes. Package integrity is checked against a digest. Refreshing a catalog is separate from updating an installed package. This is a useful lifecycle distinction for TeamBot. These pages are under the SDK documentation's `/next/` path, so treat them as version-sensitive developer documentation rather than a guarantee about every installed release. Source: [Muse Code marketplaces and updates](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/concepts/marketplaces-and-updates/).

Its trust documentation records approvals for individual runtime capabilities and marks changed definitions for renewed review. That gives us a concrete reference for tracking package installation separately from permission to activate executable components. Source: [Muse Code trust and review](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/concepts/trust-review-and-scopes/).

### Where an MCP catalog fits

The official MCP Registry publishes server metadata, including where to locate a package or remote endpoint and how to configure it. Packages remain in registries such as npm, PyPI, or Docker Hub. The Registry describes downstream marketplaces as consumers that add their own curation and metadata. Its namespace verification is not a complete security review of server code. The reviewed documentation still labels the Registry as preview. Source: [The MCP Registry](https://modelcontextprotocol.io/registry/about).

Our inference is that TeamBot can build its own curated catalog and optionally import MCP metadata. We found no evidence that Muse or Grok Bot uses this Registry as its internal marketplace backend.

## Recommended TeamBot experience

Everything in this section is a proposal informed by the research. No implementation is included in this work.

### A clear discovery flow

Use a single capability browser with filters for **Skills**, **Apps and connectors**, **Plugins**, and **Agent templates**. A person should be able to search for either a service, such as Notion, or a goal, such as preparing meeting notes.

Each result should show the publisher, intended outcome, package type, required accounts, compatible runtime, version, and review status. An installed result should say whether it is ready, needs authentication, or has an error. Keep raw transport names and configuration files in an advanced view.

A detail view should explain what gets added and offer an example task. For a plugin containing multiple parts, list those parts. For a template, show the instructions and integration requirements before creating the agent.

### Installation and configuration

1. The user selects a capability and reviews its contents.
2. TeamBot checks compatibility and the exact package version or digest.
3. The user chooses which agent may use it.
4. A structured form collects non-secret settings such as workspace or project identifiers.
5. OAuth or a secure credential field connects the external account.
6. TeamBot presents the permissions and tests connectivity with a harmless operation where supported.
7. The capability becomes ready and offers an example task.

Installation should have explicit states such as downloaded, needs configuration, needs authentication, ready, disabled, and failed. A package can be installed while its connector remains unusable. Showing that distinction makes troubleshooting much easier.

### Search for people and agents

Start with name, description, category, service, and keyword search. Add goal-based matching when we can evaluate whether it improves results. Apply compatibility and access filters before recommending a package.

Expose the same catalog to agents through a read-only search capability. For example, a request to organize support tickets can produce a recommendation with the package's purpose, required account, and requested permissions. A search result should not itself install software or grant access. The user can then complete the same structured setup used by manual discovery.

For runtime discovery, keep compact skill descriptions available and load detailed instructions when relevant. For MCP, connect an authorized server and discover its tools through the protocol. Looking up an uninstalled package and selecting a tool from an already connected server are separate operations. Protocol reference: [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture).

### Suggested records

| Record | Minimum information to preserve |
|---|---|
| Catalog entry | Stable ID, publisher, type, summary, tags, compatibility, source and version |
| Package contents | Skills, tools, commands and other bundled components |
| Installation | Selected version or digest, installation scope, enabled state and update status |
| Connection | Provider, account, endpoint, configuration and credential reference |
| Agent assignment | Which agent may use which installation or connection |
| Permission grant | Allowed actions, account or resource scope, expiry and approving user |
| Avatar profile | Asset reference, appearance parameters, animation set and fallback image |

Secrets should be referenced from the credential store. A copied agent template should carry integration requirements and setup instructions without copying credentials, browser sessions, or private task history.

### Permissions and maintenance

Muse provides a particularly useful reference for separating agent intent from permission enforcement. Its published architecture places connector execution, credentials, and the Sentinel permission authority outside the main runtime cell. Sentinel can allow, deny, or ask for approval, and credential substitution happens after authorization at the network boundary. Source: [Muse safety architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).

For TeamBot, use the existing policy gateway for new extension calls, preserve the approved package revision, and request renewed review when an update adds access or executable components. Include disable, reconnect, uninstall, and update controls. Distinguish removal of local credentials from revocation at the external provider, which may require a separate provider action.

## Where TeamBot stands today

A limited read-only inspection of this checkout found:

| Area | Current evidence | Research implication |
|---|---|---|
| Identity editor | `AgentForm.tsx` has an avatar text field, emoji choices and colors | An appearance editor can extend an existing profile flow |
| Avatar rendering | `Avatar.tsx` renders the avatar string and an optional status dot | Character assets and animation would be additional rendering work |
| MCP transport | `mcp.ts` supports stdio and Streamable HTTP, retrieves tools and exposes them through the tool registry | Basic MCP connectivity already exists |
| Agent access | MCP tools are filtered by each agent's `mcpServers` setting | Preserve this explicit assignment in the marketplace flow |
| Setup experience | Settings tells users to edit `mcp.json` and restart | The main usability gap is catalog discovery and guided configuration |

Local references: [agent editor](../../apps/web/src/views/AgentForm.tsx), [avatar component](../../apps/web/src/components/Avatar.tsx), [MCP manager](../../apps/server/src/tools/mcp.ts), [settings view](../../apps/web/src/views/SettingsView.tsx).

One implementation detail deserves attention before accepting executable marketplace packages: the current MCP manager launches stdio processes from the server and merges the server environment into their environment. The per-agent tool filter controls which tools the model is offered; it does not place those processes inside the agent's isolated computer. A future installer should define process isolation and permitted environment variables explicitly.

The existing feature map also groups several identity features together and marks Muse negatively. The newly reviewed sources support Muse avatar and identity customization. A future update should separate customizable identity from support for multiple persistent peer agents. This report does not modify the feature map.

## Decisions suggested by the research

1. Extend TeamBot's existing identity editor with original character assets and clear runtime state feedback.
2. Build a small curated connector and skill catalog before opening public submissions.
3. Make configuration, account authentication, and per-agent access visible steps.
4. Treat an agent template as a reviewed configuration export with explicit setup requirements.
5. Add third-party publishing after versioning, capability review, updates, and uninstall behavior are defined.
6. Evaluate live voice-and-avatar video separately from the basic agent interface.

## Questions public research did not settle

- Muse's exact current avatar-editor controls and limits across web, iOS, and Android.
- Grok Bot's avatar rendering technology, asset pipeline, and complete user-editable appearance options.
- The precise manifests, ranking systems, and recommendation services behind the two personal-agent catalogs.
- A standardized, publicly documented skill-package upload and update contract for the Muse personal app.
- A universal arbitrary-MCP setup flow in the personal apps comparable to the documented coding-tool commands.
- End-to-end behavior of community installation prompts, token refresh, connector removal, and template imports in real accounts.

These are candidates for a later hands-on product review. The next step would be a recorded walkthrough of profile editing, catalog search, one connector connection, one skill installation, and removal in each app. For now, the report separates documented behavior, community distribution claims, and our proposed design so it can guide discussion without implying that unverified internals are known.
