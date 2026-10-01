// OpenRouter is the model pool: one API key, hundreds of models, OpenAI-compatible tool calling.
import crypto from 'node:crypto';
import type { ModelInfo } from '@teambot/shared';
import { sleep } from '../util.js';
import { type AssistantMessage, type ChatRequest, type ChatResponse, ModelError, type ModelProvider, type ToolCall } from './types.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MODELS_TTL_MS = 60 * 60 * 1000;

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
}

export class OpenRouterProvider implements ModelProvider {
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(private apiKey: () => string) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const key = this.apiKey();
    if (!key) throw new ModelError('OPENROUTER_API_KEY is not set. Add it to .env and restart TeamBot.');

    const body = {
      model: req.model,
      messages: req.messages,
      tools: req.tools?.length ? req.tools : undefined,
      tool_choice: req.tools?.length ? 'auto' : undefined,
      max_tokens: req.maxTokens ?? 8192,
      usage: { include: true },
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000 * 3 ** (attempt - 1), 15_000));
      req.signal?.throwIfAborted();
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'http-referer': 'https://github.com/teambot',
            'x-title': 'TeamBot',
          },
          body: JSON.stringify(body),
          signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        lastError = err;
        continue; // network error: retry
      }

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: { message: text.slice(0, 300) } };
      }

      if (!res.ok || data.error) {
        const status = res.ok ? Number(data.error?.code) || 500 : res.status;
        const message = data.error?.message ?? `HTTP ${res.status}`;
        lastError = new ModelError(describeError(status, message, req.model), status);
        if (RETRYABLE.has(status)) continue;
        throw lastError;
      }

      const choice = data.choices?.[0];
      if (!choice?.message) {
        lastError = new ModelError(`OpenRouter returned no message for ${req.model}`);
        continue;
      }
      return {
        message: normalize(choice.message),
        finishReason: choice.finish_reason ?? 'stop',
        model: data.model ?? req.model,
        usage: {
          inputTokens: Number(data.usage?.prompt_tokens ?? 0),
          outputTokens: Number(data.usage?.completion_tokens ?? 0),
          costUsd: Number(data.usage?.cost ?? 0),
        },
      };
    }
    throw lastError instanceof Error ? lastError : new ModelError(String(lastError));
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_TTL_MS) return this.modelsCache.models;
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new ModelError(`Could not load the OpenRouter model list (HTTP ${res.status})`, res.status);
    const data = (await res.json()) as { data: RawModel[] };
    const models = data.data
      .filter((m) => m.supported_parameters?.includes('tools'))
      .map(
        (m): ModelInfo => ({
          id: m.id,
          name: m.name ?? m.id,
          contextLength: m.context_length ?? 0,
          promptPricePerM: Number(m.pricing?.prompt ?? 0) * 1e6,
          completionPricePerM: Number(m.pricing?.completion ?? 0) * 1e6,
          inputModalities: m.architecture?.input_modalities ?? ['text'],
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    this.modelsCache = { at: Date.now(), models };
    return models;
  }
}

function describeError(status: number, message: string, model: string): string {
  if (status === 401) return 'OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in .env.';
  if (status === 402) return 'OpenRouter says the account is out of credits (402). Add credits at openrouter.ai.';
  if (status === 404) return `Model "${model}" was not found on OpenRouter or does not support tool calling.`;
  return `OpenRouter error ${status} for ${model}: ${message}`;
}

function normalize(raw: any): AssistantMessage {
  const toolCalls: ToolCall[] | undefined = Array.isArray(raw.tool_calls)
    ? raw.tool_calls
        .filter((c: any) => c?.function?.name)
        .map((c: any) => ({
          id: c.id || `call_${crypto.randomBytes(6).toString('hex')}`,
          type: 'function' as const,
          function: { name: String(c.function.name), arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) },
        }))
    : undefined;
  const msg: AssistantMessage = { role: 'assistant', content: typeof raw.content === 'string' ? raw.content : null };
  if (toolCalls?.length) msg.tool_calls = toolCalls;
  if (raw.reasoning_details) msg.reasoning_details = raw.reasoning_details;
  return msg;
}
