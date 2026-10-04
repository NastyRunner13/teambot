import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLocation } from 'wouter';
import { useStore } from '../store';

/** Links /shared/... paths and highlights @mentions, outside of code. */
function enrich(text: string, names: Set<string>): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) {
        const inner = part.match(/^`(\/shared\/[^`\s]+)`$/);
        return inner ? `[\`${inner[1]}\`](#file:${inner[1]})` : part;
      }
      return part
        .replace(/(^|[\s(])(\/shared\/[^\s)\]`'"<>,;]+[^\s)\]`'"<>,;.:!?])/g, (_m, pre: string, p: string) => `${pre}[${p}](#file:${p})`)
        .replace(/(^|[^\w@[])@([A-Za-z][A-Za-z0-9_-]{0,31})/g, (m, pre: string, name: string) =>
          names.has(name.toLowerCase()) ? `${pre}[@${name}](#mention:${name})` : m,
        );
    })
    .join('');
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const [, navigate] = useLocation();
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const names = new Set([...agents, ...humans].map((m) => m.name.toLowerCase()));

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (href?.startsWith('#mention:')) {
              const name = href.slice(9).toLowerCase();
              const agent = agents.find((a) => a.name.toLowerCase() === name);
              return (
                <span className="mention" style={{ cursor: agent ? 'pointer' : undefined }} onClick={() => agent && navigate(`/agents/${agent.id}`)}>
                  {children}
                </span>
              );
            }
            if (href?.startsWith('#file:')) {
              return (
                <a href={`/files?path=${encodeURIComponent(href.slice(6))}`} onClick={(e) => (e.preventDefault(), navigate(`/files?path=${encodeURIComponent(href.slice(6))}`))}>
                  {children}
                </a>
              );
            }
            // Links within TeamBot (a page an agent wrote, a conversation) open in place.
            if (href?.startsWith('/') && !href.startsWith('//')) {
              return (
                <a href={href} onClick={(e) => (e.preventDefault(), navigate(href))}>
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {enrich(text, names)}
      </ReactMarkdown>
    </div>
  );
});
