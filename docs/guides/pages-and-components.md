# Pages and components

**Pages** are documents you and your agents write together. **Components** are small interfaces (a chart, a comparison, a form) that agents draw in a chat instead of describing them in prose.

## Pages

Pages are Markdown documents that belong to the whole workspace, like `/shared`. Open **Pages** at the top of the sidebar.

### Writing together

- **The editor saves as you type.** **Write** is the Markdown, **Preview** shows how it reads. A page holds up to 100,000 characters.
- **Edits never silently overwrite each other.** Every save names the revision it started from, and a save over a newer revision is refused. If someone else saved while you were typing, the editor keeps your draft and lets you load theirs, download yours or keep yours. An agent's or teammate's save appears while you look.
- **Ask an agent** opens your chat with an agent beside the page, and what you send links the page.

### What agents can do with pages

| Tool | What it does |
|---|---|
| `list_pages`, `read_page` | Find and read pages (page text reaches the model as untrusted content) |
| `create_page` | Make a new page |
| `edit_page` | Change a page by find-and-replace edits (each must match exactly once) or with a whole new text. It always names the revision it read, so it can't overwrite your edits. |
| `propose_page` | Show you a draft in the chat first. Nothing is saved until you press **Approve & save**. This always asks, whatever the policy says. |

Ask "draft a launch plan as a page and let me review it first" and the agent uses `propose_page`. Ask it to "update the launch plan page" and it uses `edit_page`. That edit is a `write` action, allowed by default; add a policy rule if you want to approve page edits.

### Comments and @mentions

- **Comment on a passage:** select text in Write or Preview and choose **Comment**, or comment on the whole page. Threads sit in a rail beside the page with replies, **Resolve** and **Reopen**. The page list shows how many threads each page has open.
- **@mention an agent** in a comment and it answers **in the thread**, the way it would answer a mention in a chat. It gets the page, the quoted passage and the thread so far. It can edit the page from there and reply with what it changed. If you reply in a thread an agent wrote in, the conversation continues with that agent.
- **Comments survive edits.** A thread remembers the passage it quoted and where it was. When the page changes, the passage is found again by its text. If the passage was edited away, the thread is marked **Outdated**, never dropped.
- Anyone can resolve a thread. Only a comment's author or an owner can delete it.

Agents have `list_page_comments`, `comment_on_page` and `resolve_comment` too. An agent's @mentions in comments count toward the same per-run handoff limit as `ask_agent`.

## Components: interfaces agents draw

When words aren't the best answer, an agent can draw an interface in the chat:

- **`show_ui`**: a one-off interface the agent writes itself (HTML, CSS and script). Turn this off with `TEAMBOT_GENERATIVE_UI=0`.
- **`ui_<name>`**: a **component** from your library, which the agent fills with arguments. Components are reviewed and published by a person, so they're the predictable option.

A message keeps its own copy of what it drew, so changing a component later doesn't change old chats.

### Writing a component

Open **Connect apps → Components** and choose **New component**. The playground has tabs for **HTML**, **CSS**, **Script**, **Arguments** (a JSON Schema) and **Sample** (arguments for the preview), with a live preview beside them.

Here is a complete example, a pricing comparison an agent can fill in:

**Name:** `price_table` (2–40 lowercase letters, numbers and underscores; the tool becomes `ui_price_table`)

**Arguments** — a JSON Schema for an object. Agents see it as the tool's parameters, and their arguments are checked against it:

```json
{
  "type": "object",
  "properties": {
    "plans": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "price": { "type": "number" },
          "features": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["name", "price"]
      }
    }
  },
  "required": ["plans"]
}
```

**HTML:**

```html
<div class="grid" id="plans"></div>
```

**CSS** — use the `--tb-*` variables so the component matches the app's light or dark theme:

```css
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.plan { background: var(--tb-raised); border: 1px solid var(--tb-border); border-radius: var(--tb-radius); padding: 12px; }
.price { font-size: 22px; font-weight: 600; }
.plan button { margin-top: 8px; background: var(--tb-accent); color: var(--tb-on-accent); border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
```

**Script** — arguments are in `teambot.args`. `teambot.reply(text)` puts text in the person's message box, ready for them to send:

```js
const root = document.getElementById('plans');
for (const p of teambot.args.plans) {
  const el = document.createElement('div');
  el.className = 'plan';
  el.innerHTML = `<strong></strong><div class="price"></div><ul></ul><button>Choose</button>`;
  el.querySelector('strong').textContent = p.name;
  el.querySelector('.price').textContent = `$${p.price}/mo`;
  for (const f of p.features ?? []) el.querySelector('ul').append(Object.assign(document.createElement('li'), { textContent: f }));
  el.querySelector('button').onclick = () => teambot.reply(`Let's go with ${p.name}.`);
  root.append(el);
}
```

Set text with `textContent` rather than putting arguments into `innerHTML`, because arguments come from a model.

**Publish** makes it available to agents as `ui_price_table`, after checking that the sample arguments fit the schema. **Withdraw** takes it away again but keeps the published copy, so you can publish it again later. With team sign-in on, only owners manage components.

Agents can draft components too (`draft_component`), for example when you ask "make a reusable card for our weekly metrics". A draft reaches nobody until a person publishes it, and an agent can't overwrite a draft a person saved last.

### What a component can and can't do

Every interface runs in a sandboxed frame:

- **No access to TeamBot.** The frame has its own opaque origin: no cookies, no storage, no access to the app or its API. The server also refuses changes that come from such a frame.
- **No network.** `fetch`, XHR, WebSockets, outside images and form submissions are blocked. Put data in the arguments, and draw charts with inline SVG or canvas.
- **Libraries from three CDNs.** Scripts, styles and fonts may load from `cdn.jsdelivr.net`, `cdnjs.cloudflare.com` and `unpkg.com`, for example a chart library.
- **Talking back is limited to `teambot.reply`.** The frame reports its height and any script errors. Text from `teambot.reply` waits in the message box until the person sends it, so an interface can never send a message by itself.
- **Theme variables:** `--tb-bg`, `--tb-surface`, `--tb-raised`, `--tb-text`, `--tb-muted`, `--tb-border`, `--tb-accent`, `--tb-on-accent`, `--tb-ok`, `--tb-warn`, `--tb-bad`, `--tb-info`, `--tb-font`, `--tb-mono`, `--tb-radius`.
- **Size limits:** HTML and script up to 60,000 characters each, and CSS up to 30,000.

Component tools pass the action policy like any other tool. To keep a component for some agents only, see [Action policy](action-policy.md#keep-a-component-away-from-an-agent).
