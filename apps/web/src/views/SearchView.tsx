// Search past conversations. Agents search the same history with search_history.
import { MessageSquare, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { Message, SearchResults } from '@teambot/shared';
import { api } from '../api';
import { Avatar } from '../components/Avatar';
import { ago } from '../lib/format';
import { useStore } from '../store';

export function SearchView() {
  const params = new URLSearchParams(useSearch());
  const q = params.get('q') ?? '';
  const [, navigate] = useLocation();
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const openThread = useStore((s) => s.openThread);
  const [text, setText] = useState(q);
  const [results, setResults] = useState<SearchResults | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(q);
    setResults(null);
    if (q.trim().length < 2) return;
    let cancelled = false;
    api.get<SearchResults>(`/search?q=${encodeURIComponent(q)}`).then((r) => !cancelled && setResults(r));
    return () => {
      cancelled = true;
    };
  }, [q]);
  useEffect(() => input.current?.focus(), []);

  function open(m: Message) {
    const channel = channels.find((c) => c.id === m.channelId);
    const dmAgent = channel?.kind === 'dm' ? agents.find((a) => channel.memberIds.includes(a.id)) : undefined;
    navigate(dmAgent ? `/agents/${dmAgent.id}` : `/c/${m.channelId}`);
    if (m.threadId) openThread(m.threadId);
  }

  const total = results?.messages.length ?? 0;

  return (
    <>
      <div className="page-header">
        <form
          className="search-box grow"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/search?q=${encodeURIComponent(text.trim())}`);
          }}
        >
          <Search size={16} />
          <input ref={input} className="input" aria-label="Search history" placeholder='Search messages — "exact phrase" works too' value={text} onChange={(e) => setText(e.target.value)} />
        </form>
      </div>
      <div className="page page-narrow">
        {!q && <div className="empty">Search everything your team has said: messages in every channel and DM.</div>}
        {q && results && total === 0 && <div className="empty">Nothing matches “{q}”. Every word has to appear, so try fewer words.</div>}
        {results && results.messages.length > 0 && (
          <div className="section" style={{ marginTop: 0 }}>
            <h2>Messages</h2>
            <div className="list">
              {results.messages.map(({ message, where, snippet }) => {
                const author = agents.find((a) => a.id === message.authorId) ?? humans.find((h) => h.id === message.authorId);
                return (
                  <div key={message.id} className="list-row clickable search-hit" onClick={() => open(message)}>
                    <Avatar member={author} size={28} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small">
                        <strong>{author?.name ?? 'Unknown'}</strong> <span className="muted">in {where}</span> <span className="faint">· {ago(message.createdAt)}</span>
                      </div>
                      <div className="search-snippet">{snippet}</div>
                    </div>
                    <MessageSquare size={14} className="faint" />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
