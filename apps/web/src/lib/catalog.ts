// The apps Connect apps offers in one click. Each is the vendor's own remote MCP server on the vendor's own domain;
// `registry` names its entry in the official MCP Registry (registry.modelcontextprotocol.io) where the vendor
// published one under its own namespace. Don't fill this list from open registry search: it is full of proxies,
// look-alikes and probes.
// Checked 2026-10-03: OAuth apps answered with a sign-in that supports dynamic client registration (what TeamBot's
// sign-in needs); "none" apps answered without one. GitHub doesn't register clients, so it takes a pasted token.
// Not listed, because their sign-in can't register TeamBot: Asana, HubSpot, Box, MongoDB. Vercel and Figma
// register only clients they approved. Anything else can still be added by URL ("Add a custom app").

export type AppCategory = 'productivity' | 'engineering' | 'data' | 'research' | 'business' | 'sites';

export interface CatalogApp {
  /** Also the connector's name, so tools show up as mcp__<id>__<tool>. */
  id: string;
  name: string;
  category: AppCategory;
  /** One line for the list. */
  blurb: string;
  /** What agents can do with it, for the app's page. */
  about: string;
  url: string;
  auth: 'oauth' | 'none' | 'token';
  /** For token apps: where the token goes and how to get one. */
  token?: { header: string; prefix: string; label: string; help: string; helpUrl: string };
  website: string;
  registry?: string;
  /** The tile's color. */
  color: string;
  featured?: boolean;
}

export const CATEGORIES: { key: AppCategory; label: string }[] = [
  { key: 'productivity', label: 'Productivity' },
  { key: 'engineering', label: 'Engineering' },
  { key: 'data', label: 'Data and databases' },
  { key: 'research', label: 'Research and docs' },
  { key: 'business', label: 'Sales, support and payments' },
  { key: 'sites', label: 'Websites' },
];

export const CATALOG: CatalogApp[] = [
  // ── productivity ──
  {
    id: 'notion',
    name: 'Notion',
    category: 'productivity',
    blurb: 'Search, read and write pages and databases.',
    about: 'Agents can search your workspace, read pages and databases, and create or update pages, for example to file research or keep a project log.',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    website: 'https://www.notion.com',
    registry: 'com.notion/mcp',
    color: '#2f2f2f',
    featured: true,
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    category: 'productivity',
    blurb: 'Jira issues and Confluence pages.',
    about: 'Agents can search and update Jira issues, and read and write Confluence pages, across the Atlassian sites you allow.',
    url: 'https://mcp.atlassian.com/v2/mcp',
    auth: 'oauth',
    website: 'https://www.atlassian.com',
    registry: 'com.atlassian/atlassian-mcp-server',
    color: '#1868db',
    featured: true,
  },
  {
    id: 'zapier',
    name: 'Zapier',
    category: 'productivity',
    blurb: 'Gmail, Google Calendar, Sheets and 9,000 more apps.',
    about: 'Agents use actions in thousands of apps, including Google Workspace and Microsoft 365, through your Zapier account. You choose in Zapier which actions it offers.',
    url: 'https://mcp.zapier.com/api/v1/connect',
    auth: 'oauth',
    website: 'https://zapier.com/mcp',
    registry: 'com.zapier/mcp',
    color: '#ff4f00',
    featured: true,
  },
  {
    id: 'monday',
    name: 'monday.com',
    category: 'productivity',
    blurb: 'Boards, items and updates.',
    about: 'Agents can read and update boards, create items and post updates.',
    url: 'https://mcp.monday.com/mcp',
    auth: 'oauth',
    website: 'https://monday.com',
    registry: 'com.monday/monday.com',
    color: '#ff3d57',
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    category: 'productivity',
    blurb: 'Tasks, docs and lists.',
    about: 'Agents can find, create and update tasks and docs in your ClickUp workspace.',
    url: 'https://mcp.clickup.com/mcp',
    auth: 'oauth',
    website: 'https://clickup.com',
    color: '#7b68ee',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    category: 'productivity',
    blurb: 'Bases, tables and records.',
    about: 'Agents can read and write records in the bases you share with them.',
    url: 'https://mcp.airtable.com/mcp',
    auth: 'oauth',
    website: 'https://www.airtable.com',
    registry: 'com.airtable/mcp',
    color: '#166ee1',
  },
  {
    id: 'miro',
    name: 'Miro',
    category: 'productivity',
    blurb: 'Read and build boards.',
    about: 'Agents can read boards and add stickies, shapes and diagrams.',
    url: 'https://mcp.miro.com/',
    auth: 'oauth',
    website: 'https://miro.com',
    color: '#ffd02f',
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    category: 'productivity',
    blurb: 'Find and read your files.',
    about: 'Agents can search your Dropbox and read files, for example to pull a document into /shared.',
    url: 'https://mcp.dropbox.com/mcp',
    auth: 'oauth',
    website: 'https://www.dropbox.com',
    color: '#0061fe',
  },
  {
    id: 'granola',
    name: 'Granola',
    category: 'productivity',
    blurb: 'Your meeting notes and transcripts.',
    about: 'Agents can search your meeting notes, for example to write follow-ups or pull decisions into a doc.',
    url: 'https://mcp.granola.ai/mcp',
    auth: 'oauth',
    website: 'https://www.granola.ai',
    color: '#5f7d1e',
  },
  {
    id: 'calcom',
    name: 'Cal.com',
    category: 'productivity',
    blurb: 'Bookings and availability.',
    about: 'Agents can check your availability and manage bookings.',
    url: 'https://mcp.cal.com/mcp',
    auth: 'oauth',
    website: 'https://cal.com',
    color: '#292929',
  },
  // ── engineering ──
  {
    id: 'github',
    name: 'GitHub',
    category: 'engineering',
    blurb: 'Repositories, issues and pull requests.',
    about: 'Agents can read code, open and review pull requests, and work with issues and Actions in the repositories your token can reach.',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    token: {
      header: 'Authorization',
      prefix: 'Bearer ',
      label: 'Personal access token',
      help: 'Create a fine-grained token that can reach only the repositories agents should work on, with the permissions they need.',
      helpUrl: 'https://github.com/settings/personal-access-tokens/new',
    },
    website: 'https://github.com',
    registry: 'io.github.github/github-mcp-server',
    color: '#24292f',
    featured: true,
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'engineering',
    blurb: 'Issues, projects and cycles.',
    about: 'Agents can find, create and update issues and projects, and comment on them.',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    website: 'https://linear.app',
    registry: 'app.linear/linear',
    color: '#5e6ad2',
    featured: true,
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    category: 'engineering',
    blurb: 'Projects, issues and merge requests.',
    about: 'Agents can work with issues, merge requests and pipelines on gitlab.com.',
    url: 'https://gitlab.com/api/v4/mcp',
    auth: 'oauth',
    website: 'https://gitlab.com',
    registry: 'com.gitlab/mcp',
    color: '#e24329',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'engineering',
    blurb: 'Errors, issues and releases.',
    about: 'Agents can look up errors and their stack traces, and triage issues.',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    website: 'https://sentry.io',
    registry: 'io.github.getsentry/sentry-mcp',
    color: '#362d59',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'engineering',
    blurb: 'Workers, KV, R2 and D1.',
    about: 'Agents can list and manage Workers and their storage (KV, R2, D1) in your Cloudflare account.',
    url: 'https://bindings.mcp.cloudflare.com/mcp',
    auth: 'oauth',
    website: 'https://www.cloudflare.com',
    registry: 'com.cloudflare.mcp/mcp',
    color: '#f38020',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'engineering',
    blurb: 'Sites and deploys.',
    about: 'Agents can create sites, deploy and check build status.',
    url: 'https://mcp.netlify.com/mcp',
    auth: 'oauth',
    website: 'https://www.netlify.com',
    color: '#05807d',
  },
  {
    id: 'railway',
    name: 'Railway',
    category: 'engineering',
    blurb: 'Projects, services and deployments.',
    about: 'Agents can develop, deploy and debug Railway services.',
    url: 'https://mcp.railway.com/',
    auth: 'oauth',
    website: 'https://railway.com',
    registry: 'com.railway/mcp',
    color: '#853bce',
  },
  {
    id: 'jam',
    name: 'Jam',
    category: 'engineering',
    blurb: 'Bug reports with console and network logs.',
    about: 'Agents can open Jam bug reports and read their console logs, network requests and repro steps.',
    url: 'https://mcp.jam.dev/mcp',
    auth: 'oauth',
    website: 'https://jam.dev',
    color: '#e8590c',
  },
  {
    id: 'semgrep',
    name: 'Semgrep',
    category: 'engineering',
    blurb: 'Scan code for security issues.',
    about: 'Agents can scan code with Semgrep rules and read findings.',
    url: 'https://mcp.semgrep.ai/mcp',
    auth: 'oauth',
    website: 'https://semgrep.dev',
    color: '#1a7f5a',
  },
  // ── data ──
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'data',
    blurb: 'Databases, tables and edge functions.',
    about: 'Agents can query and change your Supabase projects: tables, migrations, logs and edge functions.',
    url: 'https://mcp.supabase.com/mcp',
    auth: 'oauth',
    website: 'https://supabase.com',
    registry: 'com.supabase/mcp',
    color: '#249361',
    featured: true,
  },
  {
    id: 'neon',
    name: 'Neon',
    category: 'data',
    blurb: 'Serverless Postgres.',
    about: 'Agents can create branches, run SQL and manage Neon projects.',
    url: 'https://mcp.neon.tech/mcp',
    auth: 'oauth',
    website: 'https://neon.com',
    registry: 'com.neon/mcp',
    color: '#00a37a',
  },
  {
    id: 'prisma',
    name: 'Prisma Postgres',
    category: 'data',
    blurb: 'Databases, migrations and backups.',
    about: 'Agents can create and manage Prisma Postgres databases.',
    url: 'https://mcp.prisma.io/mcp',
    auth: 'oauth',
    website: 'https://www.prisma.io',
    registry: 'io.prisma/mcp',
    color: '#0c344b',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    category: 'data',
    blurb: 'Product analytics, flags and experiments.',
    about: 'Agents can query insights and events, and read feature flags and experiments.',
    url: 'https://mcp.posthog.com/mcp',
    auth: 'oauth',
    website: 'https://posthog.com',
    registry: 'io.github.PostHog/mcp',
    color: '#c43b00',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    category: 'data',
    blurb: 'Models, datasets, Spaces and papers.',
    about: 'Agents can search models, datasets and papers, and use Spaces you choose on huggingface.co.',
    url: 'https://huggingface.co/mcp?login',
    auth: 'oauth',
    website: 'https://huggingface.co',
    registry: 'co.huggingface/hf-mcp-server',
    color: '#ffd21e',
  },
  // ── research ──
  {
    id: 'context7',
    name: 'Context7',
    category: 'research',
    blurb: 'Up-to-date docs for any library.',
    about: 'Agents fetch current documentation and code examples for the libraries they use, instead of guessing from memory. No sign-in needed.',
    url: 'https://mcp.context7.com/mcp',
    auth: 'none',
    website: 'https://context7.com',
    registry: 'io.github.upstash/context7',
    color: '#047857',
    featured: true,
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'research',
    blurb: 'Ask questions about any public GitHub repo.',
    about: 'Agents can read generated docs for public repositories and ask questions about how they work. No sign-in needed.',
    url: 'https://mcp.deepwiki.com/mcp',
    auth: 'none',
    website: 'https://deepwiki.com',
    color: '#4338ca',
  },
  {
    id: 'exa',
    name: 'Exa',
    category: 'research',
    blurb: 'Web search built for agents.',
    about: 'Agents can search the web and fetch page contents without driving a browser. No sign-in needed.',
    url: 'https://mcp.exa.ai/mcp',
    auth: 'none',
    website: 'https://exa.ai',
    registry: 'ai.exa/exa',
    color: '#1f40ed',
  },
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    category: 'research',
    blurb: "Microsoft's official docs and code samples.",
    about: 'Agents can search Microsoft and Azure documentation and fetch code samples. No sign-in needed.',
    url: 'https://learn.microsoft.com/api/mcp',
    auth: 'none',
    website: 'https://learn.microsoft.com',
    registry: 'com.microsoft/microsoft-learn-mcp',
    color: '#0067b8',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    category: 'research',
    blurb: 'Search, extract and crawl the web.',
    about: 'Agents can search the web and extract or crawl pages through your Tavily account.',
    url: 'https://mcp.tavily.com/mcp',
    auth: 'oauth',
    website: 'https://tavily.com',
    color: '#3b5bdb',
  },
  {
    id: 'apify',
    name: 'Apify',
    category: 'research',
    blurb: 'Thousands of ready-made scrapers.',
    about: 'Agents can run Apify Actors to scrape sites and collect data, billed to your Apify account.',
    url: 'https://mcp.apify.com',
    auth: 'oauth',
    website: 'https://apify.com',
    color: '#1f5eff',
  },
  // ── business ──
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'business',
    blurb: 'Customers, payments and invoices.',
    about: 'Agents can look up customers, payments and subscriptions, and create invoices or payment links. Your action policy asks you before each call.',
    url: 'https://mcp.stripe.com',
    auth: 'oauth',
    website: 'https://stripe.com',
    registry: 'com.stripe/mcp',
    color: '#635bff',
    featured: true,
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'business',
    blurb: 'Conversations and contacts.',
    about: 'Agents can search customer conversations and contacts, for example to summarize what customers ask about.',
    url: 'https://mcp.intercom.com/mcp',
    auth: 'oauth',
    website: 'https://www.intercom.com',
    color: '#286efa',
  },
  {
    id: 'close',
    name: 'Close',
    category: 'business',
    blurb: 'CRM leads, opportunities and calls.',
    about: 'Agents can find and update leads, contacts and opportunities in Close.',
    url: 'https://mcp.close.com/mcp',
    auth: 'oauth',
    website: 'https://www.close.com',
    registry: 'com.close/close-mcp',
    color: '#2459d6',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    category: 'business',
    blurb: 'Invoices, orders and disputes.',
    about: 'Agents can create and send invoices, and look up orders, transactions and disputes. Your action policy asks you before each call.',
    url: 'https://mcp.paypal.com/mcp',
    auth: 'oauth',
    website: 'https://www.paypal.com',
    registry: 'com.paypal.mcp/mcp',
    color: '#003087',
  },
  {
    id: 'square',
    name: 'Square',
    category: 'business',
    blurb: 'Payments, catalog and orders.',
    about: 'Agents can work with your Square catalog, orders, customers and payments.',
    url: 'https://mcp.squareup.com/mcp',
    auth: 'oauth',
    website: 'https://squareup.com',
    color: '#1a1a1a',
  },
  // ── sites ──
  {
    id: 'webflow',
    name: 'Webflow',
    category: 'sites',
    blurb: 'Sites, pages and CMS content.',
    about: 'Agents can edit pages and CMS collections, and publish your Webflow sites.',
    url: 'https://mcp.webflow.com/mcp',
    auth: 'oauth',
    website: 'https://webflow.com',
    registry: 'com.webflow/mcp',
    color: '#146ef5',
  },
  {
    id: 'wix',
    name: 'Wix',
    category: 'sites',
    blurb: 'Sites, stores and bookings.',
    about: 'Agents can manage your Wix sites, including store products, bookings and content.',
    url: 'https://mcp.wix.com/mcp',
    auth: 'oauth',
    website: 'https://www.wix.com',
    registry: 'com.wix/mcp',
    color: '#0c0c0c',
  },
];

/** Chat apps aren't MCP servers: they bring TeamBot's conversations and approvals to your phone. */
export const CHAT_APPS = [
  { id: 'telegram', name: 'Telegram', blurb: 'Approvals and messages from your agents, on your phone.', color: '#229ed9' },
  { id: 'slack', name: 'Slack', blurb: 'The same, in your DMs with a TeamBot app in Slack.', color: '#4a154b' },
] as const;

export type ChatAppId = (typeof CHAT_APPS)[number]['id'];

const normalize = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

/** The catalog entry an MCP server was added from, matched by address so a renamed connector still counts. */
export function catalogEntryFor(url: string | undefined): CatalogApp | undefined {
  return url ? CATALOG.find((a) => normalize(a.url) === normalize(url)) : undefined;
}

export function searchApps(query: string): CatalogApp[] {
  const q = query.trim().toLowerCase();
  if (!q) return CATALOG;
  return CATALOG.filter((a) => `${a.name} ${a.blurb} ${a.about} ${a.id}`.toLowerCase().includes(q));
}

/** Black or white letters, whichever reads better on the tile's color. */
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.36 ? '#111111' : '#ffffff';
}
