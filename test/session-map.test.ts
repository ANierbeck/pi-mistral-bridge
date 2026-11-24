// Unit tests for src/session-map.ts (T5 slice B): the pure state machine that
// maps a Pi session to its ACP session and decides the turn flow
// (continueToolResults / delta / rebuild, ADR-0003) plus the session-key
// derivation. No ACP, no network — pure functions over Message lists.
import { describe, expect, it } from 'vitest';
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { ParkedCall } from '../src/mcp-bridge.ts';
import { digestMessages } from '../src/transcript.ts';
import {
  SessionMap,
  createSessionState,
  decideFlow,
  hashText,
  recordSentPrefix,
  sessionKey,
  type SessionState,
} from '../src/session-map.ts';

const ts = 1_700_000_000_000;

function user(content: UserMessage['content']): UserMessage {
  return { role: 'user', content, timestamp: ts };
}

function assistant(
  content: AssistantMessage['content'] = [{ type: 'text', text: 'ok' }]
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'mistral-bridge',
    provider: 'mistral-bridge',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: ts,
  };
}

function toolResult(toolCallId: string, toolName = 'read'): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: `result of ${toolCallId}` }],
    isError: false,
    timestamp: ts,
  };
}

function batch(...callIds: string[]): ParkedCall[] {
  return callIds.map((callId) => ({ callId, piToolName: 'read', args: { path: '/x' } }));
}

/** A state that has just finished a turn: the given messages ARE the sent prefix
 *  (Pi history after the turn, i.e. context messages + the emitted assistant message). */
function stateAfterTurn(sentPrefix: readonly Message[], alias = 'alias-a'): SessionState {
  const state = createSessionState(alias);
  state.acpSessionId = 'sess-1';
  state.systemPromptDigest = hashText(PROMPT);
  recordSentPrefix(state, sentPrefix);
  return state;
}

const PROMPT = 'You are helpful.';

describe('decideFlow', () => {
  it('rebuilds when no ACP session exists yet', () => {
    const state = createSessionState('alias-a');
    const decision = decideFlow(state, {
      messages: [user('hi')],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
    expect(decision.flow === 'rebuild' && decision.reason).toMatch(/no acp session/i);
  });

  it('rebuilds when the session is dirty (abort/crash/steering, ADR-0003)', () => {
    const state = stateAfterTurn([user('hi'), assistant()]);
    state.dirty = true;
    const decision = decideFlow(state, {
      messages: [user('hi'), assistant(), user('again')],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
    expect(decision.flow === 'rebuild' && decision.reason).toMatch(/dirty/i);
  });

  it('rebuilds on a model switch (different pool alias, ADR-0007)', () => {
    const state = stateAfterTurn([user('hi'), assistant()], 'alias-a');
    const decision = decideFlow(state, {
      messages: [user('hi'), assistant(), user('again')],
      modelAlias: 'alias-b',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
    expect(decision.flow === 'rebuild' && decision.reason).toMatch(/model/i);
  });

  it('rebuilds when the system prompt changed', () => {
    const state = stateAfterTurn([user('hi'), assistant()]);
    const decision = decideFlow(state, {
      messages: [user('hi'), assistant(), user('again')],
      modelAlias: 'alias-a',
      systemPrompt: 'A different prompt.',
    });
    expect(decision.flow).toBe('rebuild');
    expect(decision.flow === 'rebuild' && decision.reason).toMatch(/system prompt/i);
  });

  it('continueToolResults: trailing toolResults answering exactly the pending batch callIds (any order)', () => {
    const messages: Message[] = [
      user('hi'),
      assistant([{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
    ];
    const state = stateAfterTurn(messages);
    state.pendingToolBatch = batch('call-b', 'call-a');
    const withResults: Message[] = [...messages, toolResult('call-a'), toolResult('call-b')];
    const decision = decideFlow(state, {
      messages: withResults,
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('continueToolResults');
    if (decision.flow === 'continueToolResults') {
      expect(decision.results.map((r) => r.toolCallId).sort()).toEqual(['call-a', 'call-b']);
    }
  });

  it('rebuilds when a user message arrives while a tool batch is pending (steering-dirty)', () => {
    const messages: Message[] = [
      user('hi'),
      assistant([{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
    ];
    const state = stateAfterTurn(messages);
    state.pendingToolBatch = batch('call-a');
    const steered: Message[] = [...messages, toolResult('call-a'), user('wait, also this')];
    const decision = decideFlow(state, {
      messages: steered,
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
    expect(decision.flow === 'rebuild' && decision.reason).toMatch(/pending|steer/i);
  });

  it('rebuilds when the trailing toolResults do not match the pending batch callIds', () => {
    const messages: Message[] = [user('hi'), assistant()];
    const state = stateAfterTurn(messages);
    state.pendingToolBatch = batch('call-a');
    const decision = decideFlow(state, {
      messages: [...messages, toolResult('some-other-call')],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
  });

  it('delta: prefix digest matches and only new user message(s) follow', () => {
    const sent: Message[] = [user('hi'), assistant()];
    const state = stateAfterTurn(sent); // sent prefix = [user, assistant]
    expect(state.sentCount).toBe(2);
    expect(state.digestOfSentPrefix).toBe(digestMessages(sent));
    const decision = decideFlow(state, {
      messages: [...sent, user('next question')],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('delta');
    if (decision.flow === 'delta') expect(decision.newMessages).toEqual([user('next question')]);
  });

  it('delta with several appended user messages (incl. image content)', () => {
    const sent: Message[] = [user('hi'), assistant()];
    const state = stateAfterTurn(sent);
    const img = user([{ type: 'image', data: 'AAA=', mimeType: 'image/png' }]);
    const decision = decideFlow(state, {
      messages: [...sent, user('one'), img, user('three')],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('delta');
    if (decision.flow === 'delta') expect(decision.newMessages).toHaveLength(3);
  });

  it('rebuilds on divergence: an earlier message was edited', () => {
    const state = stateAfterTurn([user('hi'), assistant()]);
    const decision = decideFlow(state, {
      messages: [user('hi'), assistant(), user('again')].map((m, i) =>
        i === 0 ? user('EDITED') : m
      ),
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
    expect(decision.flow === 'rebuild' && decision.reason).toMatch(/diverg/i);
  });

  it('rebuilds on compaction (history got shorter than the sent prefix)', () => {
    const state = stateAfterTurn([user('hi'), assistant()]); // sentCount = 2
    const decision = decideFlow(state, {
      messages: [user('compacted summary')],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
  });

  it('rebuilds when trailing messages after the sent prefix are not user messages', () => {
    const state = stateAfterTurn([user('hi'), assistant()]);
    const decision = decideFlow(state, {
      messages: [user('hi'), assistant(), assistant([{ type: 'text', text: 'extra' }])],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
  });

  it('rebuilds when nothing new was appended', () => {
    const state = stateAfterTurn([user('hi'), assistant()]);
    const decision = decideFlow(state, {
      messages: [user('hi'), assistant()],
      modelAlias: 'alias-a',
      systemPrompt: PROMPT,
    });
    expect(decision.flow).toBe('rebuild');
  });
});

describe('recordSentPrefix', () => {
  it('records count + digest of the sent prefix (context messages + emitted assistant message)', () => {
    const state = createSessionState('alias-a');
    const messages: Message[] = [user('hi'), assistant()];
    recordSentPrefix(state, messages);
    expect(state.sentCount).toBe(2);
    expect(state.digestOfSentPrefix).toBe(digestMessages(messages));
  });
});

describe('sessionKey', () => {
  it('prefers the Pi session id from the provider call options', () => {
    expect(sessionKey({ sessionId: 'pi-session-42' }, [user('hi')], PROMPT)).toBe('pi-session-42');
  });

  it('falls back to a content hash of system prompt + first user message when no session id is given', () => {
    const k1 = sessionKey(undefined, [user('hi'), assistant(), user('more')], PROMPT);
    const k2 = sessionKey({}, [user('hi'), assistant(), user('different tail')], PROMPT);
    expect(k1).toBe(k2); // same conversation start -> same key
    expect(k1).not.toBe(sessionKey(undefined, [user('other'), assistant()], PROMPT));
    expect(k1).not.toBe(sessionKey(undefined, [user('hi')], 'another prompt'));
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles a first user message with image blocks in the fallback', () => {
    const k = sessionKey(
      undefined,
      [user([{ type: 'image', data: 'AAA=', mimeType: 'image/png' }])],
      PROMPT
    );
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toBe(
      sessionKey(
        undefined,
        [user([{ type: 'image', data: 'BBB=', mimeType: 'image/png' }])],
        PROMPT
      )
    );
  });
});

describe('SessionMap', () => {
  it('creates, returns and deletes states per key', () => {
    const map = new SessionMap();
    const a = map.get('k1', 'alias-a');
    expect(map.get('k1', 'alias-a')).toBe(a);
    expect(a.acpSessionId).toBeNull();
    expect(a.pendingToolBatch).toBeNull();
    expect(a.dirty).toBe(false);
    expect(map.size).toBe(1);
    const b = map.get('k2', 'alias-a');
    expect(b).not.toBe(a);
    expect(map.size).toBe(2);
    map.delete('k1');
    expect(map.size).toBe(1);
    expect(map.get('k1', 'alias-a')).not.toBe(a);
    map.clear();
    expect(map.size).toBe(0);
  });
});
