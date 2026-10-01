// OpenTelemetry export over OTLP/HTTP (JSON), with no SDK. Turned on by OTEL_EXPORTER_OTLP_ENDPOINT.
//   Logs:   every audit event, with its type, agent, run and data as attributes.
//   Traces: one trace per run. The run is a span; each tool call and each model call is a child span.
// Event data is already scrubbed of secrets before it reaches the bus, so nothing new can leak here.
import crypto from 'node:crypto';
import type { EventRecord } from '@teambot/shared';
import type { App } from './app.js';
import { errorMessage } from './util.js';

const FLUSH_MS = 5000;
const MAX_BATCH = 500;
const MAX_QUEUE = 10_000;
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.waiting', 'run.paused']);

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface Attr {
  key: string;
  value: AttrValue;
}
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number; message?: string };
}

export type OtlpPost = (url: string, body: unknown, headers: Record<string, string>) => Promise<void>;

const hex = (seed: string, bytes: number) => crypto.createHash('sha256').update(seed).digest('hex').slice(0, bytes * 2);
/** A run's trace id is derived from its id, so every stretch of the run lands in the same trace. */
export const traceIdFor = (runId: string) => hex(`trace:${runId}`, 16);
export const spanIdFor = (kind: string, id: string) => hex(`${kind}:${id}`, 8);
const nanos = (iso: string) => `${BigInt(new Date(iso).getTime()) * 1_000_000n}`;

function attr(key: string, v: unknown): Attr | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number') return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } };
  return { key, value: { stringValue: typeof v === 'string' ? v : JSON.stringify(v) } };
}
const attrs = (pairs: Record<string, unknown>): Attr[] => Object.entries(pairs).map(([k, v]) => attr(k, v)).filter((a): a is Attr => !!a);

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const httpPost: OtlpPost = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
};

export class Telemetry {
  readonly endpoint: string;
  private headers: Record<string, string>;
  private service: string;
  private logs: unknown[] = [];
  private spans: Span[] = [];
  /** Open spans by key, with when they started. */
  private open = new Map<string, { start: string; name: string; attributes: Attr[]; parent?: string; traceId: string; spanId: string }>();
  private timer?: NodeJS.Timeout;
  private unsubscribe: (() => void) | null = null;
  private lastError: string | null = null;
  private exported = 0;
  private post: OtlpPost;
  /** The span of the stretch of work a run is in now (a run that waits and resumes has one per stretch). */
  private segments = new Map<string, string>();

  constructor(
    private app: App,
    opts: { endpoint?: string; headers?: string; service?: string; post?: OtlpPost } = {},
  ) {
    this.endpoint = (opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').replace(/\/+$/, '');
    this.headers = parseHeaders(opts.headers ?? process.env.OTEL_EXPORTER_OTLP_HEADERS);
    this.service = opts.service ?? process.env.OTEL_SERVICE_NAME ?? 'teambot';
    this.post = opts.post ?? httpPost;
  }

  get enabled() {
    return !!this.endpoint;
  }

  status() {
    return { enabled: this.enabled, endpoint: this.endpoint || null, exported: this.exported, error: this.lastError };
  }

  start() {
    if (!this.enabled) return;
    this.unsubscribe = this.app.bus.subscribe((e) => this.record(e));
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  async stop() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private name(id: string | null) {
    return id ? this.app.workspace.memberName(id) : undefined;
  }

  record(e: EventRecord) {
    const d = e.data as Record<string, any>;
    const traceId = e.runId ? traceIdFor(e.runId) : undefined;
    if (e.runId && (e.type === 'run.created' || e.type === 'run.started' || e.type === 'run.resumed') && !this.segments.has(e.runId)) {
      this.segments.set(e.runId, spanIdFor('run', `${e.runId}:${e.id}`));
    }
    const runSpan = e.runId ? this.segments.get(e.runId) : undefined;

    if (this.logs.length < MAX_QUEUE) {
      this.logs.push({
        timeUnixNano: nanos(e.ts),
        severityNumber: /failed|error|denied|exceeded/.test(e.type) ? 13 : 9,
        severityText: /failed|error|denied|exceeded/.test(e.type) ? 'WARN' : 'INFO',
        body: { stringValue: e.type },
        attributes: attrs({
          'teambot.event.id': e.id,
          'teambot.event.type': e.type,
          'teambot.agent.id': e.agentId,
          'teambot.agent.name': this.name(e.agentId),
          'teambot.actor.id': e.actorId,
          'teambot.run.id': e.runId,
          'teambot.channel.id': e.channelId,
          'teambot.event.data': JSON.stringify(d).slice(0, 8000),
        }),
        ...(traceId && runSpan ? { traceId, spanId: runSpan } : {}),
      });
    }

    if (!e.runId || !traceId || !runSpan) return;
    const agent = { 'teambot.agent.id': e.agentId, 'teambot.agent.name': this.name(e.agentId), 'teambot.run.id': e.runId };
    if (e.type === 'run.created' || e.type === 'run.started' || e.type === 'run.resumed') {
      const key = `run:${e.runId}`;
      if (!this.open.has(key)) {
        this.open.set(key, { start: e.ts, name: `run ${String(d.run?.title ?? '').slice(0, 80)}`, attributes: attrs({ ...agent, 'teambot.run.initiator': d.run?.initiator }), traceId, spanId: runSpan });
      }
    } else if (TERMINAL.has(e.type)) {
      const key = `run:${e.runId}`;
      const span = this.open.get(key);
      this.segments.delete(e.runId);
      if (span) {
        this.open.delete(key);
        const run = d.run ?? {};
        this.finish(span, e.ts, e.type === 'run.failed' ? 2 : 1, d.error, attrs({ 'teambot.run.status': run.status, 'teambot.run.steps': run.steps, 'teambot.run.cost_usd': run.costUsd }));
      }
    } else if (e.type === 'tool.started') {
      this.open.set(`tool:${e.runId}:${d.toolCallId}`, {
        start: e.ts,
        name: `tool ${d.tool}`,
        attributes: attrs({ ...agent, 'teambot.tool.name': d.tool, 'teambot.tool.call_id': d.toolCallId }),
        parent: runSpan,
        traceId,
        spanId: spanIdFor('tool', `${e.runId}:${d.toolCallId}`),
      });
    } else if (e.type === 'tool.finished') {
      const key = `tool:${e.runId}:${d.toolCallId}`;
      const span = this.open.get(key);
      if (span) {
        this.open.delete(key);
        this.finish(span, e.ts, d.ok ? 1 : 2, d.ok ? undefined : String(d.preview ?? '').slice(0, 300), attrs({ 'teambot.tool.duration_ms': d.ms }));
      }
    } else if (e.type === 'llm.response') {
      // A model call ends with this event; it started roughly when the call's duration says, else now.
      this.spans.push({
        traceId,
        spanId: spanIdFor('llm', String(e.id)),
        parentSpanId: runSpan,
        name: `chat ${d.model}`,
        kind: 3,
        startTimeUnixNano: nanos(e.ts),
        endTimeUnixNano: nanos(e.ts),
        attributes: attrs({
          ...agent,
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': 'openrouter',
          'gen_ai.request.model': d.model,
          'gen_ai.usage.input_tokens': d.inputTokens,
          'gen_ai.usage.output_tokens': d.outputTokens,
          'teambot.cost_usd': d.costUsd,
          'teambot.tool_calls': (d.toolCalls ?? []).join(','),
        }),
        status: { code: 1 },
      });
    }
    if (this.logs.length + this.spans.length >= MAX_BATCH) void this.flush();
  }

  private finish(span: { start: string; name: string; attributes: Attr[]; parent?: string; traceId: string; spanId: string }, end: string, code: number, message: string | undefined, extra: Attr[]) {
    if (this.spans.length >= MAX_QUEUE) return;
    this.spans.push({
      traceId: span.traceId,
      spanId: span.spanId,
      ...(span.parent ? { parentSpanId: span.parent } : {}),
      name: span.name,
      kind: 1,
      startTimeUnixNano: nanos(span.start),
      endTimeUnixNano: nanos(end),
      attributes: [...span.attributes, ...extra],
      status: message ? { code, message } : { code },
    });
  }

  private resource() {
    return { attributes: attrs({ 'service.name': this.service, 'service.version': '0.1.0' }) };
  }

  async flush() {
    if (!this.enabled) return;
    const logs = this.logs.splice(0);
    const spans = this.spans.splice(0);
    const scope = { name: 'teambot', version: '0.1.0' };
    try {
      if (logs.length) await this.post(`${this.endpoint}/v1/logs`, { resourceLogs: [{ resource: this.resource(), scopeLogs: [{ scope, logRecords: logs }] }] }, this.headers);
      if (spans.length) await this.post(`${this.endpoint}/v1/traces`, { resourceSpans: [{ resource: this.resource(), scopeSpans: [{ scope, spans }] }] }, this.headers);
      this.exported += logs.length + spans.length;
      this.lastError = null;
    } catch (err) {
      // Telemetry must never break the workspace: report it once and drop the batch.
      if (this.lastError === null) console.error(`OpenTelemetry export failed: ${errorMessage(err)}`);
      this.lastError = errorMessage(err);
    }
  }
}
