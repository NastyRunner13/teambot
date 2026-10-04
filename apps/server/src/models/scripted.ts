// A fake model for tests and offline demos: each call returns the next scripted reply.
import type { ModelInfo } from '@teambot/shared';
import type { AssistantMessage, ChatRequest, ChatResponse, ModelProvider } from './types.js';

export type ScriptStep = AssistantMessage | ((req: ChatRequest) => AssistantMessage);

let callCounter = 0;

/** Shorthand for an assistant message that calls one tool. */
export function callTool(name: string, args: Record<string, unknown>, content: string | null = null): AssistantMessage {
  callCounter += 1;
  return {
    role: 'assistant',
    content,
    tool_calls: [{ id: `call_${callCounter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

export function say(text: string): AssistantMessage {
  return { role: 'assistant', content: text };
}

export class ScriptedProvider implements ModelProvider {
  readonly requests: ChatRequest[] = [];
  private scripts = new Map<string, ScriptStep[]>();

  /** Queue replies for a model id ("*" = any model without its own script). */
  script(model: string, steps: ScriptStep[]) {
    this.scripts.set(model, [...(this.scripts.get(model) ?? []), ...steps]);
    return this;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const queue = this.scripts.get(req.model)?.length ? this.scripts.get(req.model)! : this.scripts.get('*');
    const step = queue?.shift();
    if (!step) return { message: say('[silent]'), finishReason: 'stop', model: req.model, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    const { cutOff, ...message } = typeof step === 'function' ? step(req) : step;
    // A step marked cutOff plays a reply that hit the output limit.
    const finishReason = cutOff ? 'length' : message.tool_calls ? 'tool_calls' : 'stop';
    return { message, finishReason, model: req.model, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0001 } };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'test/model', name: 'Test model', contextLength: 100_000, promptPricePerM: 0, completionPricePerM: 0, inputModalities: ['text'] }];
  }
}

/** TEAMBOT_OFFLINE_MODELS=1: every agent replies with a canned echo, so the app can be tried without a key or any cost. */
export class EchoProvider implements ModelProvider {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    const line = String(last?.content ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
    const message = say(`(offline test model) I received: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
    return { message, finishReason: 'stop', model: req.model, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'offline/echo', name: 'Offline echo (testing)', contextLength: 100_000, promptPricePerM: 0, completionPricePerM: 0, inputModalities: ['text'] }];
  }
}
