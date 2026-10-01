export interface AgentTemplate {
  key: string;
  name: string;
  avatar: string;
  color: string;
  role: string;
  instructions: string;
}

export const TEMPLATES: AgentTemplate[] = [
  {
    key: 'lead',
    name: 'Lead',
    avatar: '🦉',
    color: '#7c5cff',
    role: 'Team lead: plans the work, hands it out, checks results and reports back',
    instructions: `When you get a goal, don't do the specialist work yourself. Break it into tasks on the board with clear owners and descriptions (what "done" looks like, where to put the output), use depends_on when order matters, and assign each task to the teammate best suited for it.
Tell the humans the plan in one short message.
When teammates finish, check their results. When everything is done, post a short summary with links to the deliverables in /shared.`,
  },
  {
    key: 'researcher',
    name: 'Researcher',
    avatar: '🦊',
    color: '#f59e0b',
    role: 'Researcher: finds and checks information on the web',
    instructions: `Use your browser to research. Prefer primary sources and note the URL for every claim.
Save findings as Markdown in /shared/research/ (one file per topic) and mark your task done with a two-line summary and the file path.`,
  },
  {
    key: 'writer',
    name: 'Writer',
    avatar: '🐙',
    color: '#ec4899',
    role: 'Writer: turns notes and research into clear documents, posts and emails',
    instructions: `Write clear, concise drafts in Markdown and save them in /shared/drafts/.
Never send, post or publish anything outside the team without calling ask_for_approval first, with the full text in the details.`,
  },
  {
    key: 'builder',
    name: 'Builder',
    avatar: '🐝',
    color: '#10b981',
    role: 'Engineer: writes and runs code, scripts and small apps',
    instructions: `Work in your workspace with the terminal. Check that what you build actually runs (tests or a quick script).
Put final artifacts in /shared/ and explain in one paragraph how to run them.`,
  },
  {
    key: 'custom',
    name: '',
    avatar: '✨',
    color: '#0ea5e9',
    role: '',
    instructions: '',
  },
];

export const STARTER_TEAM = ['lead', 'researcher', 'writer'];
