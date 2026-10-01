// Long runs: when the transcript gets big, summarize the older part with a cheap model and keep
// the recent tail verbatim. Tool calls and their results are never split.
import type { App } from '../app.js';
import type { TranscriptMessage, Usage } from '../models/types.js';
import { errorMessage } from '../util.js';

export const estimateTokens = (messages: unknown[]) => Math.ceil(JSON.stringify(messages).length / 3.5);

function render(m: TranscriptMessage): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  if (m.role === 'assistant') {
    const calls = (m.tool_calls ?? []).map((c) => `  → ${c.function.name}(${clip(c.function.arguments, 400)})`).join('\n');
    return `ASSISTANT: ${clip(m.content ?? '', 2000)}${calls ? `\n${calls}` : ''}`;
  }
  if (m.role === 'tool') return `TOOL RESULT: ${clip(m.content, 1500)}`;
  return `USER: ${clip(m.content, 3000)}`;
}

export async function maybeCompact(
  app: App,
  scope: { agentId: string; runId: string },
  transcript: TranscriptMessage[],
  signal: AbortSignal,
): Promise<TranscriptMessage[]> {
  const limit = app.cfg.compactAtTokens;
  if (estimateTokens(transcript) < limit) return transcript;

  // Keep roughly the last third verbatim, starting at a message that is not a tool result.
  const keepBudget = limit * 0.35;
  let cut = transcript.length;
  let kept = 0;
  while (cut > 1 && kept < keepBudget) {
    cut -= 1;
    kept += estimateTokens([transcript[cut]]);
  }
  while (cut < transcript.length && transcript[cut].role === 'tool') cut += 1;
  if (cut <= 1 || cut >= transcript.length) return transcript;

  const head = transcript.slice(0, cut);
  const tail = transcript.slice(cut);
  let summary: string;
  let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const res = await app.models.chat({
      model: app.cfg.utilityModel,
      signal,
      maxTokens: 2000,
      messages: [
        {
          role: 'system',
          content:
            'You compress the work log of an AI agent so it can keep working. Write a dense summary: the goal and who asked, what has been done, key facts and findings (URLs, file paths, names, numbers), decisions, what is still open, and the immediate next step. Do not invent anything.',
        },
        { role: 'user', content: head.map(render).join('\n\n') },
      ],
    });
    summary = res.message.content?.trim() || '(summary unavailable)';
    usage = res.usage;
  } catch (err) {
    summary = `(Earlier steps were dropped to save space; summarizing them failed: ${errorMessage(err)})`;
  }

  const next: TranscriptMessage[] = [{ role: 'user', content: `[Summary of your earlier work in this run]\n${summary}` }, ...tail];
  app.bus.emit('run.compacted', scope, { before: estimateTokens(transcript), after: estimateTokens(next), dropped: head.length, ...usage });
  return next;
}
