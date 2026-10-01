import type { EventRecord } from '@teambot/shared';
import type { Store } from './store.js';

export type Listener = (e: EventRecord) => void;

export interface EventScope {
  actorId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  channelId?: string | null;
}

/** Writes every event to the append-only log, then fans it out to live listeners (WebSocket clients). */
export class Bus {
  private listeners = new Set<Listener>();

  constructor(private store: Store) {}

  emit(type: string, scope: EventScope = {}, data: Record<string, unknown> = {}): EventRecord {
    const event = this.store.appendEvent({
      type,
      actorId: scope.actorId ?? null,
      agentId: scope.agentId ?? null,
      runId: scope.runId ?? null,
      channelId: scope.channelId ?? null,
      data,
    });
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('event listener failed', err);
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
