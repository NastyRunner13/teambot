import type { ModelInfo } from '@teambot/shared';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface SystemMessage {
  role: 'system';
  content: string;
}
export interface UserMessage {
  role: 'user';
  content: string;
}
/** Text plus images, as sent to vision models. Built on the way to the model; never stored. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface MultimodalUserMessage {
  role: 'user';
  content: ContentPart[];
}
export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  /** Provider reasoning blocks; OpenRouter asks for these to be sent back unchanged across tool calls. */
  reasoning_details?: unknown;
}
export interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
  /** Screenshots the tool returned, as paths under the data folder (shown to the model on the way out). */
  images?: string[];
}

export type ChatMessage = SystemMessage | UserMessage | MultimodalUserMessage | AssistantMessage | ToolMessage;
/** Messages stored in a run transcript (the system prompt is rebuilt fresh every step). */
export type TranscriptMessage = UserMessage | AssistantMessage | ToolMessage;

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ChatResponse {
  message: AssistantMessage;
  finishReason: string;
  usage: Usage;
  model: string;
}

export interface ModelProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<ModelInfo[]>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
