// Unit tests for src/transcript.ts (T5 slice A): the pure transcript renderer,
// the delta renderer and the message digest behind the delta/rebuild decision
// (ADR-0003). Snapshot tests pin the exact render format; digest tests pin the
// stability contract (same content -> same digest, any content change ->
// different digest, regenerated ids/timestamps/usage do not matter).
import { describe, expect, it } from 'vitest';
import type {
  AssistantMessage,
  Message,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import {
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  HEAD_TRUNCATED_MARKER,
  HISTORY_PREAMBLE,
  TRUNCATED_MARKER,
  digestMessages,
  findImitatedToolCallText,
  renderDelta,
  renderTranscript,
} from '../src/transcript.ts';

const ts = 1_700_000_000_000;

function user(content: UserMessage['content']): UserMessage {
  return { role: 'user', content, timestamp: ts };
}

function assistant(
  content: AssistantMessage['content'],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'mistral-bridge',
    provider: 'mistral-bridge',
    model: 'some-model',
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: ts,
    ...overrides,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  content: ToolResultMessage['content'],
  isError = false
): ToolResultMessage {
  return { role: 'toolResult', toolCallId, toolName, content, isError, timestamp: ts };
}

describe('renderTranscript (rebuild prompt body, ADR-0003)', () => {
  it('renders user/assistant text, tool calls as delimited past-tool-call records, images as [image]; system messages are excluded; never the imitable [tool pi__ shape', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.', timestamp: ts } as SystemMessage,
      user('hello there'),
      assistant([
        { type: 'text', text: 'Hi! Let me check.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/x' } },
      ]),
      toolResult('call-1', 'read', [{ type: 'text', text: 'file contents here' }]),
      user([
        { type: 'text', text: 'and an image:' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ]),
    ];
    const rendered = renderTranscript(messages);
    expect(rendered).toMatchSnapshot();
    expect(rendered).not.toContain('You are helpful.');
    expect(rendered).toContain('[user]\nhello there');
    expect(rendered).toContain(
      '--- past tool call pi__read ---\n{"path":"/tmp/x"}\n--- end past tool call ---'
    );
    expect(rendered).toContain(
      '--- past tool result pi__read (call-1) ---\nfile contents here\n--- end past tool result ---'
    );
    expect(rendered).toContain('[image]');
    // the rendered log must never carry the [tool pi__ ...] shape the model
    // imitated as text in a real run (ADR-0010)
    expect(rendered).not.toContain('[tool pi__');
  });

  it('renders thinking blocks as text and tool call arguments canonically (sorted keys)', () => {
    const messages: Message[] = [
      assistant([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'answer' },
        {
          type: 'toolCall',
          id: 'c',
          name: 'bash',
          arguments: { command: 'ls', _meta: { b: 2, a: 1 } } as never,
        },
      ]),
    ];
    const rendered = renderTranscript(messages);
    expect(rendered).toContain('hmm');
    expect(rendered).toContain('answer');
    // canonical JSON sorts object keys, so `_meta` precedes `command`
    expect(rendered).toContain(
      '--- past tool call pi__bash ---\n{"_meta":{"a":1,"b":2},"command":"ls"}\n--- end past tool call ---'
    );
  });

  it('truncates long tool results with the marker', () => {
    const long = 'x'.repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 100);
    const rendered = renderTranscript([toolResult('c1', 'read', [{ type: 'text', text: long }])]);
    expect(rendered).toContain(TRUNCATED_MARKER);
    expect(rendered).not.toContain(long);
    expect(rendered.length).toBeLessThan(long.length);
  });

  it('truncates the whole transcript from the head when it exceeds maxChars, keeping the tail', () => {
    const messages: Message[] = [
      user('first message '.repeat(50)),
      user('last message '.repeat(50)),
    ];
    const rendered = renderTranscript(messages, { maxChars: 200 });
    expect(rendered.length).toBeLessThanOrEqual(200);
    expect(rendered.startsWith(HEAD_TRUNCATED_MARKER)).toBe(true);
    expect(rendered).toContain('last message');
    expect(rendered).not.toContain('first message');
  });

  it('is deterministic: same messages render identically regardless of ids/timestamps/usage', () => {
    const a = renderTranscript([
      user('hi'),
      assistant([{ type: 'toolCall', id: 'x', name: 'read', arguments: {} }], {
        timestamp: 1,
        usage: {
          input: 9,
          output: 9,
          cacheRead: 9,
          cacheWrite: 0,
          totalTokens: 9,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    ]);
    const b = renderTranscript([
      user('hi'),
      assistant([{ type: 'toolCall', id: 'y', name: 'read', arguments: {} }], {
        timestamp: 2,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    ]);
    expect(a).toBe(b);
  });

  it('renders an empty transcript as an empty string', () => {
    expect(renderTranscript([])).toBe('');
    expect(
      renderTranscript([{ role: 'system', content: 'sys', timestamp: ts } as SystemMessage])
    ).toBe('');
  });
});

describe('renderDelta (the next prompt when only new user messages were appended)', () => {
  it('returns plain text for text-only user messages', () => {
    expect(renderDelta([user('one'), user('two')])).toBe('one\n\ntwo');
  });

  it('returns ACP content blocks (text + image) when images are present', () => {
    expect(
      renderDelta([
        user([
          { type: 'text', text: 'look' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ]),
      ])
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
  });

  it('returns an empty string for no new messages', () => {
    expect(renderDelta([])).toBe('');
  });
});

describe('digestMessages (stable sha256 over role + content, ADR-0003)', () => {
  it('is stable: same content digests the same regardless of timestamps/usage/ids', () => {
    const base: Message[] = [
      user('hi'),
      assistant([{ type: 'text', text: 'hello' }]),
      assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { p: 1 } }]),
      toolResult('call-1', 'read', [{ type: 'text', text: 'out' }]),
    ];
    const same: Message[] = [
      user('hi'),
      assistant([{ type: 'text', text: 'hello' }], { timestamp: ts + 99 }),
      assistant([{ type: 'toolCall', id: 'REGENERATED', name: 'read', arguments: { p: 1 } }], {
        timestamp: ts + 100,
        usage: {
          input: 5,
          output: 5,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
      toolResult('REGENERATED', 'read', [{ type: 'text', text: 'out' }], false),
    ];
    expect(digestMessages(base)).toBe(digestMessages(same));
    expect(digestMessages(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any content changes (text, args, tool result, roles, order)', () => {
    const base = digestMessages([user('hi'), assistant([{ type: 'text', text: 'a' }])]);
    expect(digestMessages([user('hi'), assistant([{ type: 'text', text: 'b' }])])).not.toBe(base);
    expect(digestMessages([user('hi there')])).not.toBe(digestMessages([user('hi')]));
    expect(
      digestMessages([
        assistant([{ type: 'toolCall', id: 'c', name: 'read', arguments: { p: 1 } }]),
      ])
    ).not.toBe(
      digestMessages([
        assistant([{ type: 'toolCall', id: 'c', name: 'read', arguments: { p: 2 } }]),
      ])
    );
    expect(digestMessages([toolResult('c', 'read', [{ type: 'text', text: 'x' }])])).not.toBe(
      digestMessages([toolResult('c', 'read', [{ type: 'text', text: 'y' }])])
    );
    expect(digestMessages([user('a'), user('b')])).not.toBe(digestMessages([user('b'), user('a')]));
    // image content participates
    expect(
      digestMessages([user([{ type: 'image', data: 'AAA=', mimeType: 'image/png' }])])
    ).not.toBe(digestMessages([user([{ type: 'image', data: 'BBB=', mimeType: 'image/png' }])]));
  });

  it('is insensitive to key order in tool arguments', () => {
    const a = digestMessages([
      assistant([
        { type: 'toolCall', id: 'c', name: 't', arguments: { x: 1, y: { b: 2, a: 1 } } } as never,
      ]),
    ]);
    const b = digestMessages([
      assistant([
        { type: 'toolCall', id: 'c', name: 't', arguments: { y: { a: 1, b: 2 }, x: 1 } } as never,
      ]),
    ]);
    expect(a).toBe(b);
  });

  it('distinguishes isError on tool results', () => {
    expect(digestMessages([toolResult('c', 't', [{ type: 'text', text: 'x' }])])).not.toBe(
      digestMessages([toolResult('c', 't', [{ type: 'text', text: 'x' }], true)])
    );
  });
});

describe('findImitatedToolCallText (dead-turn detection, ADR-0010)', () => {
  it('flags tool-call-shaped text at the start of a line when there is no real tool call', () => {
    expect(
      findImitatedToolCallText([{ type: 'text', text: '[tool pi__read {"path":"/tmp/x"}]' }])
    ).toBe(true);
    expect(
      findImitatedToolCallText([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'sure:\n  [tool ask_vibe {"q":1}]' },
      ])
    ).toBe(true);
  });

  it('does not flag ordinary text, mid-line mentions, or a response with a real tool call', () => {
    expect(findImitatedToolCallText([{ type: 'text', text: 'plain answer' }])).toBe(false);
    expect(
      findImitatedToolCallText([{ type: 'text', text: 'the [tool pi__read {"a":1}] shape' }])
    ).toBe(false);
    expect(
      findImitatedToolCallText([
        { type: 'toolCall', id: 'c', name: 'read', arguments: {} },
        { type: 'text', text: '[tool pi__read {"path":"/tmp/x"}]' },
      ])
    ).toBe(false);
    expect(findImitatedToolCallText([])).toBe(false);
  });
});

describe('HISTORY_PREAMBLE (rebuild prompt framing, ADR-0003)', () => {
  it('is one short English paragraph that frames the transcript as a read-only log of already executed tool calls and forbids writing tool calls as text', () => {
    expect(typeof HISTORY_PREAMBLE).toBe('string');
    expect(HISTORY_PREAMBLE.length).toBeLessThanOrEqual(700);
    expect(HISTORY_PREAMBLE).not.toContain('\n');
    // key tokens: the past-tool-call record delimiters, "already executed",
    // the pi__ MCP tool prefix, the [user] marker of the last message to
    // answer — and never the old imitable [tool …] line shape (ADR-0010)
    expect(HISTORY_PREAMBLE).toContain('--- past tool call');
    expect(HISTORY_PREAMBLE).toContain('--- past tool result');
    expect(HISTORY_PREAMBLE).not.toContain('[tool');
    expect(HISTORY_PREAMBLE).toContain('already executed');
    expect(HISTORY_PREAMBLE).toContain('pi__');
    expect(HISTORY_PREAMBLE).toContain('[user]');
    // the actual instructions, not just tokens (Sourcery finding on PR #10):
    // framing as history, no imitating, no writing tool calls as text,
    // normal tool-calling interface, and unfinished calls must be completed
    expect(HISTORY_PREAMBLE).toContain('read-only history');
    expect(HISTORY_PREAMBLE).toContain('not a format to imitate');
    expect(HISTORY_PREAMBLE).toMatch(/[Nn]ever write a tool call as text/);
    expect(HISTORY_PREAMBLE).toMatch(/call it through the normal tool-calling interface/);
    expect(HISTORY_PREAMBLE).toContain('logged without a result');
  });
});
