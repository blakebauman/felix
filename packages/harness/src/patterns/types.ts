/**
 * Pattern runtime types. An `Agent` exposes an `invoke` and a
 * `streamEvents` surface — that's the only contract pattern builders need
 * to satisfy.
 */

import type { Tool } from '../tools/types';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

/**
 * An image attached to a user message (multimodal input). Mapped to a
 * provider-native image block at model-call time (Anthropic `image` /
 * OpenAI `image_url`); providers without vision (Workers AI) ignore them.
 * Attachments are *not* persisted to the session log — they're analyzed on
 * the turn they're sent, not re-fed on every subsequent turn.
 */
export interface ImageAttachment {
  /** A data URL (`data:<mime>;base64,<…>`) or a remote `https://` URL. */
  url: string;
  /** MIME type, e.g. `image/png`. */
  media_type: string;
  /** Original filename — display only. */
  filename?: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Tool call id, when role === 'tool'. */
  tool_call_id?: string;
  /** Tool name, when role === 'tool'. */
  name?: string;
  /** Tool calls emitted by the model on an assistant turn. */
  tool_calls?: ToolCall[];
  /** Image attachments on a user turn (multimodal input). */
  attachments?: ImageAttachment[];
  /**
   * Extended-thinking blocks emitted by Anthropic on an assistant turn.
   * Each block carries opaque text + a signature (or, for blocks
   * Anthropic redacted for safety, an encrypted `data` blob). Both
   * shapes are part of an integrity check Anthropic enforces when you
   * echo a tool_use continuation, so we keep the blocks attached to
   * the message and round-trip them verbatim on the next request.
   * Empty / absent for non-Anthropic providers and for runs without
   * `thinking_budget`.
   */
  thinking?: ThinkingBlock[];
}

export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface InvokeInput {
  messages: ChatMessage[];
  /**
   * When set, the react/deep loop hydrates prior turns from the
   * configured Checkpointer (default = ConversationDO), appends each new
   * turn as it's produced, and lets a continuation pick up where a prior
   * invocation paused.
   *
   * Multi-agent patterns treat the PARENT as the single persistent entity
   * for the thread — they never let children race-write the same DO:
   *   - router forwards the id to its chosen child (exactly one runs);
   *   - parallel and groupchat withhold the id from children and persist
   *     the parent transcript themselves (children run stateless);
   *   - plan_execute persists the planner input + synthesized answer to the
   *     parent thread; its executor sub-loops run stateless.
   */
  threadId?: string;
}

export interface InvokeResult {
  messages: ChatMessage[];
  /** Final assistant turn (convenience). */
  final: ChatMessage;
}

export type StreamEvent =
  | { event: 'on_chat_model_stream'; data: { chunk: { content: string } } }
  | { event: 'on_tool_start'; data: { name: string; input: Record<string, unknown> } }
  | { event: 'on_tool_end'; data: { name: string; output: string } }
  | { event: 'on_chain_end'; data: { output: InvokeResult } };

export interface Agent {
  /** Tools resolved + wrapped at build time (exposed for /v1/models inspection). */
  readonly tools: readonly Tool[];
  /** Pattern identifier ("react" / "deep" / ...). */
  readonly pattern: string;
  /** Manifest name + version this agent was compiled from. */
  readonly manifestId: string;
  readonly manifestVersion: string;

  invoke(input: InvokeInput): Promise<InvokeResult>;
  streamEvents(input: InvokeInput): AsyncGenerator<StreamEvent>;
}
