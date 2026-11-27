/**
 * Transcript rendering and message digests for the history sync (ADR-0003,
 * implementation plan T5 slice A).
 *
 * Pi passes the full conversation on every `streamSimple` call; a Vibe ACP
 * session keeps its own history and accepts only the *next* prompt. These
 * pure functions are the bridge side of the delta/rebuild decision
 * (src/session-map.ts):
 *
 * - {@link renderTranscript} renders a Pi message list as one compact
 *   plain-text prompt body for a REBUILD. The system prompt is NOT included
 *   here (the provider prepends it and {@link HISTORY_PREAMBLE} separately);
 *   user/assistant text is kept in full; tool calls and tool results
 *   render as delimited past-tool records (`--- past tool call … ---` /
 *   `--- past tool result … ---`, results truncated with a marker) — a
 *   record shape that must not be imitated as text (ADR-0010); images as
 *   `[image]`.
 * - {@link renderDelta} renders only the newly appended message(s) as the
 *   next prompt of a DELTA turn (text and image blocks, ADR-0003).
 * - {@link digestMessages} is a stable sha256 over a canonical serialization
 *   of role + content; timestamps, usage and ids that Pi may regenerate are
 *   ignored, so the same logical history always digests identically.
 *
 * - {@link findImitatedToolCallText} detects a dead turn (ADR-0010): a
 *   response whose text imitates a tool call while it contains no real
 *   toolCall block.
 * - {@link canonicalJson} is the canonical JSON (sorted keys) shared with the
 *   MCP bridge's de-dup hashing (ADR-0006): identical values serialize
 *   identically regardless of key order.
 */
import { createHash } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import { PI_TOOL_PREFIX } from './vibe-protocol.ts';

/** Default cap on the kept transcript text for one rebuild prompt. */
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000;
/** Default per-tool-result cap inside a transcript. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 2_000;
/** Marker appended to a truncated tool result. */
export const TRUNCATED_MARKER = '… [truncated]';
/** Marker prepended when the whole transcript was head-truncated. */
export const HEAD_TRUNCATED_MARKER = '[... earlier transcript truncated ...]';

/**
 * Framing text the provider puts between the system prompt and a REBUILD
 * transcript (src/provider.ts). A bare transcript log made a model imitate
 * its tool-call lines as text in a real run (it answered a tool request with
 * the literal `[tool ask_vibe {…}]` after an abort-triggered rebuild), so the
 * log is framed as read-only history and its tool records use delimited
 * past-tool-call / past-tool-result sections that do not look like live tool
 * syntax (ADR-0010). One short paragraph, no model names (AGENTS.md §9).
 */
export const HISTORY_PREAMBLE =
  "The following is a plain-text log of the conversation, provided as read-only history for context (a call whose result is missing may not have run yet). Sections like `--- past tool call pi__<name> ---` … `--- end past tool call ---` and `--- past tool result pi__<name> (<id>) ---` … `--- end past tool result ---` are records of already executed tool calls — they are history, not a format to imitate. Never write a tool call as text; when you need a tool — also to complete a call that is logged without a result — call it through the normal tool-calling interface (this Pi session's tools are available as MCP tools with the `pi__` prefix). Respond to the last `[user]` message in the log.";

/**
 * Canonical JSON (recursively sorted object keys) so identical values hash
 * and serialize identically (ADR-0006 de-dup ids, ADR-0003 digests).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

// ------------------------------------------------------------------ rendering

export interface RenderTranscriptOptions {
  /** Cap on the kept transcript text; the head is cut with {@link HEAD_TRUNCATED_MARKER}. */
  maxChars?: number;
  /** Per-tool-result cap; the tail is cut with {@link TRUNCATED_MARKER}. */
  maxToolResultChars?: number;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${keepWholePairsEnd(text.slice(0, maxChars))}${TRUNCATED_MARKER}`;
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Drops a trailing high surrogate: a tail cut must not leave half of a pair. */
function keepWholePairsEnd(text: string): string {
  return text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))
    ? text.slice(0, -1)
    : text;
}

/**
 * A line-initial history marker shape: a past-tool record delimiter
 * (`--- past tool call …`, `--- end past tool result …`) or a role header
 * (`[user]`, `[assistant]`).
 */
const HISTORY_MARKER_LINE =
  /^((?:[^\S\r\n\u2028\u2029]|[\u200b\u200c\u2060]|\u200d)*(?:--- (?:end )?past tool (?:call|result)\b|\[(?:user|assistant)\]))/gm;

/**
 * Untrusted content (user text, tool-result bodies, assistant text and
 * thinking) must not forge the bridge-generated history structure: a line
 * that starts like a record delimiter or a role header is quoted with `> `,
 * so only the bridge's own records and `[user]` / `[assistant]` headers sit at
 * a line start. Leading blanks are any whitespace except line terminators
 * (NBSP, BOM, vertical tab, form feed, Unicode spaces) and the zero-width
 * characters U+200B-U+200D and U+2060.
 * Content without such lines is returned unchanged.
 */
function neutralizeHistoryMarkers(text: string): string {
  return text.replace(HISTORY_MARKER_LINE, '> $1');
}

/**
 * A record identifier (tool name, tool call id) as one line: any whitespace
 * run, newlines included, collapses to a single space, so the identifier
 * cannot break the record head or start a line of its own.
 */
function singleLine(identifier: string): string {
  return identifier.replace(/\s+/g, ' ');
}

/** User/tool-result content as text: text blocks verbatim, images as `[image]`; forged record delimiters and role headers quoted. */
function renderContent(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return neutralizeHistoryMarkers(content);
  return content
    .map((block) => (block.type === 'text' ? neutralizeHistoryMarkers(block.text) : '[image]'))
    .join('\n');
}

/**
 * `JSON.stringify` leaves U+2028 / U+2029 literal, and `^` in the multiline
 * history-marker regex matches after them, so a forged header inside a tool
 * argument string could start a line. Escape them as JSON `\u2028` /
 * `\u2029` (the record stays valid JSON); text without them is unchanged.
 */
function escapeLineSeparators(json: string): string {
  return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function renderAssistant(message: AssistantMessage): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return neutralizeHistoryMarkers(block.text);
      if (block.type === 'thinking') return neutralizeHistoryMarkers(block.thinking);
      // tool call: a delimited record of a call that already ran (the Pi
      // tool name as the bridge publishes it to Vibe); the old `[tool …]`
      // line shape was imitated as text by the model in a real run (ADR-0010)
      return [
        `--- past tool call ${PI_TOOL_PREFIX}${singleLine(block.name)} ---`,
        escapeLineSeparators(canonicalJson(block.arguments)),
        '--- end past tool call ---',
      ].join('\n');
    })
    .join('\n');
}

function renderToolResult(message: ToolResultMessage, maxToolResultChars: number): string {
  // a delimited record, mirroring the past-tool-call sections (ADR-0010):
  // the head names the tool and call id, the body the (truncated) result
  const head = `--- past tool result ${PI_TOOL_PREFIX}${singleLine(message.toolName)} (${singleLine(message.toolCallId)}) ---`;
  return `${head}\n${truncate(renderContent(message.content), maxToolResultChars)}\n--- end past tool result ---`;
}

/**
 * Compact plain-text transcript of a Pi message list for a rebuild prompt
 * (ADR-0003). System messages are skipped — the provider sends the system
 * prompt separately. Deterministic: identical input renders identically.
 */
export function renderTranscript(
  messages: readonly Message[],
  options: RenderTranscriptOptions = {}
): string {
  const {
    maxChars = DEFAULT_MAX_TRANSCRIPT_CHARS,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  } = options;
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') parts.push(`[user]\n${renderContent(message.content)}`);
    else if (message.role === 'assistant') parts.push(`[assistant]\n${renderAssistant(message)}`);
    else parts.push(renderToolResult(message, maxToolResultChars));
  }
  const text = parts.join('\n\n');
  if (text.length <= maxChars) return text;
  const marker = `${HEAD_TRUNCATED_MARKER}\n\n`;
  const keep = Math.max(0, maxChars - marker.length);
  const cut = text.length - keep;
  // maxChars below the marker: the marker itself is cut, never exceeding maxChars
  if (keep === 0) return marker.slice(0, Math.max(0, maxChars));
  // A cut inside a line keeps that line's tail (a single very long line, e.g.
  // a pasted blob, must not lose the part holding the request). The kept
  // fragment now starts a line of the rendered output, so it is neutralized:
  // a cut inside a quoted forged header (`> [user]` -> `[user]`) must not
  // restore it. The bridge's own later headers are left untouched. Quoting
  // adds two characters at most: leading characters are dropped until the
  // result fits maxChars again.
  for (let start = cut; ; start += 1) {
    // never start inside a surrogate pair: the lone low half is dropped
    if (isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
      start += 1;
    }
    if (start >= text.length || text[start - 1] === '\n') return marker + text.slice(start);
    const lineEnd = text.indexOf('\n', start);
    const fragmentEnd = lineEnd === -1 ? text.length : lineEnd;
    const kept = neutralizeHistoryMarkers(text.slice(start, fragmentEnd)) + text.slice(fragmentEnd);
    if (marker.length + kept.length <= maxChars) return marker + kept;
  }
}

/**
 * The next prompt for a DELTA turn (ADR-0003): only the newly appended
 * messages. Returns plain text when every new message is a text-only user
 * message, otherwise ACP content blocks (text and image blocks pass through
 * so Vibe sees images). Non-user messages (not produced by the delta flow in
 * src/session-map.ts) fall back to their transcript rendering as one text
 * block.
 */
export function renderDelta(newMessages: readonly Message[]): string | acp.ContentBlock[] {
  if (newMessages.length === 0) return '';
  const blocks: acp.ContentBlock[] = [];
  const texts: string[] = [];
  let allPlainUserText = true;
  for (const message of newMessages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        texts.push(message.content);
        blocks.push({ type: 'text', text: message.content });
        continue;
      }
      allPlainUserText = false;
      for (const block of message.content) {
        blocks.push(
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : { type: 'image', data: block.data, mimeType: block.mimeType }
        );
      }
    } else {
      allPlainUserText = false;
      blocks.push({ type: 'text', text: renderTranscript([message]) });
    }
  }
  return allPlainUserText ? texts.join('\n\n') : blocks;
}

// ----------------------------------------------------------------- detection

/** Line-initial `[tool <name> {` text — the shape of an imitated tool call. */
const IMITATED_TOOL_CALL_TEXT_PATTERN = /^[ \t]*\[tool [A-Za-z0-9_.-]+ \{/m;

/**
 * Detects a dead turn (ADR-0010): the response contains no real `toolCall`
 * block, but its text starts a line with tool-call-shaped text
 * (`[tool <name> {…}]`) — the model wrote a tool call as literal text
 * instead of calling it. A response with at least one real toolCall block
 * is never dead: tool-call-shaped text can then be quoted text.
 */
export function findImitatedToolCallText(content: AssistantMessage['content']): boolean {
  if (content.some((block) => block.type === 'toolCall')) return false;
  return content.some(
    (block) => block.type === 'text' && IMITATED_TOOL_CALL_TEXT_PATTERN.test(block.text)
  );
}

// -------------------------------------------------------------------- digest

type UserContent = UserMessage['content'];

function canonicalUserContent(content: UserContent): unknown {
  if (typeof content === 'string') return { text: content };
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', data: block.data, mimeType: block.mimeType }
  );
}

/**
 * Canonical form of one message for {@link digestMessages}: role + content
 * only. Timestamps, usage, ids (toolCall ids, response ids) and every other
 * field Pi may regenerate are dropped.
 */
function canonicalMessage(message: Message): unknown {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: canonicalUserContent(message.content) };
    case 'user':
      return { role: 'user', content: canonicalUserContent(message.content) };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content.map((block) =>
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : block.type === 'thinking'
              ? { type: 'thinking', thinking: block.thinking }
              : { type: 'toolCall', name: block.name, arguments: block.arguments }
        ),
      };
    case 'toolResult':
      return {
        role: 'toolResult',
        toolName: message.toolName,
        content: canonicalUserContent(message.content),
        isError: message.isError,
      };
  }
}

/**
 * Stable sha256 over the canonical serialization of role + content of every
 * message (ADR-0003): the same logical history digests identically no matter
 * which ids/timestamps/usage Pi attached, and any content change flips it.
 */
export function digestMessages(messages: readonly Message[]): string {
  return createHash('sha256')
    .update(canonicalJson(messages.map(canonicalMessage)), 'utf8')
    .digest('hex');
}
