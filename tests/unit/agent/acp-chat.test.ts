import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We test the logic of useAcpChat by simulating the state processing
// that the hook implements. This mirrors the exact logic in useAcpChat.ts.

interface SimpleMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: SimpleToolCall[];
  isStreaming: boolean;
}

interface SimpleToolCall {
  id: string;
  title: string;
  status: string;
}

function processUpdate(
  messages: SimpleMessage[],
  update: { sessionUpdate: string; content?: { type: string; text?: string }; toolCallId?: string; title?: string; status?: string },
): SimpleMessage[] {
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const text = update.content?.type === 'text' ? (update.content.text ?? '') : '';
      if (!text) return messages;

      // Finalize any in-progress assistant message (turn boundary)
      const finalized = messages.map(m =>
        m.isStreaming ? { ...m, isStreaming: false } : m
      );
      return [...finalized, { id: `user-${Date.now()}-${Math.random()}`, role: 'user' as const, content: text, toolCalls: [], isStreaming: false }];
    }

    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? (update.content.text ?? '') : '';
      if (!text) return messages;

      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.isStreaming) {
        // If current streaming message has completed tools, this is a new turn
        const hasCompletedTools = last.toolCalls.some(
          tc => tc.status === 'completed' || tc.status === 'failed'
        );
        if (hasCompletedTools) {
          const finalized = messages.map((m, i) =>
            i === messages.length - 1 ? { ...m, isStreaming: false } : m
          );
          return [...finalized, { id: `asst-${Date.now()}-${Math.random()}`, role: 'assistant', content: text, toolCalls: [], isStreaming: true }];
        }
        return messages.map((m, i) =>
          i === messages.length - 1
            ? { ...m, content: m.content + text }
            : m
        );
      }
      return [...messages, { id: `asst-${Date.now()}-${Math.random()}`, role: 'assistant', content: text, toolCalls: [], isStreaming: true }];
    }

    case 'tool_call': {
      const tc: SimpleToolCall = {
        id: update.toolCallId ?? `tc-${Date.now()}`,
        title: update.title ?? 'Tool',
        status: update.status ?? 'pending',
      };

      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.isStreaming) {
        return messages.map((m, i) =>
          i === messages.length - 1
            ? { ...m, toolCalls: [...m.toolCalls, tc] }
            : m
        );
      }
      return [...messages, { id: `asst-${Date.now()}-${Math.random()}`, role: 'assistant', content: '', toolCalls: [tc], isStreaming: true }];
    }

    case 'tool_call_update': {
      const tcId = update.toolCallId;
      if (!tcId) return messages;

      return messages.map(m => {
        if (m.role !== 'assistant' || !m.isStreaming) return m;
        return {
          ...m,
          toolCalls: m.toolCalls.map(tc =>
            tc.id === tcId
              ? { ...tc, status: update.status ?? tc.status, title: update.title ?? tc.title }
              : tc
          ),
        };
      });
    }

    default:
      return messages;
  }
}

function finalize(messages: SimpleMessage[]): SimpleMessage[] {
  return messages.map(m => m.isStreaming ? { ...m, isStreaming: false } : m);
}

function addUserMessage(messages: SimpleMessage[], text: string): SimpleMessage[] {
  return [...messages, { id: `user-${Date.now()}-${Math.random()}`, role: 'user' as const, content: text, toolCalls: [], isStreaming: false }];
}

describe('ACP chat message processing', () => {
  let messages: SimpleMessage[];

  beforeEach(() => {
    messages = [];
  });

  describe('user_message_chunk', () => {
    it('creates user message from chunk', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Fix the bug' },
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Fix the bug');
      assert.equal(messages[0].isStreaming, false);
    });

    it('finalizes streaming assistant before creating user message', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working on it' },
      });
      assert.equal(messages[0].isStreaming, true);

      messages = processUpdate(messages, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Thanks' },
      });

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'assistant');
      assert.equal(messages[0].isStreaming, false);
      assert.equal(messages[1].role, 'user');
      assert.equal(messages[1].content, 'Thanks');
    });
  });

  describe('agent_message_chunk', () => {
    it('creates new assistant message for first chunk', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, 'assistant');
      assert.equal(messages[0].content, 'Hello');
      assert.equal(messages[0].isStreaming, true);
    });

    it('appends subsequent chunks to current assistant message', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' world' },
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'Hello world');
    });

    it('starts new turn when completed tools exist', () => {
      // First turn: text + tool call (completed)
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Reading file...' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read file',
        status: 'pending',
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
      });

      // New text arrives after completed tools → new turn
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done!' },
      });

      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, 'Reading file...');
      assert.equal(messages[0].isStreaming, false);
      assert.equal(messages[0].toolCalls[0].status, 'completed');
      assert.equal(messages[1].content, 'Done!');
      assert.equal(messages[1].isStreaming, true);
    });

    it('does NOT start new turn when tools are still pending', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read',
        status: 'pending',
      });

      // Text arrives while tool is still pending → same turn
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '...' },
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, 'Working...');
    });
  });

  describe('tool_call', () => {
    it('adds tool call to current streaming assistant message', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Let me check' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read file',
        status: 'pending',
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].toolCalls.length, 1);
      assert.equal(messages[0].toolCalls[0].title, 'Read file');
      assert.equal(messages[0].toolCalls[0].status, 'pending');
    });

    it('creates new assistant message if no streaming message exists', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Bash',
        status: 'in_progress',
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].content, '');
      assert.equal(messages[0].toolCalls.length, 1);
    });
  });

  describe('tool_call_update', () => {
    it('updates status of existing tool call', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read',
        status: 'pending',
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
      });

      assert.equal(messages[0].toolCalls[0].status, 'completed');
    });
  });

  describe('history replay', () => {
    it('displays multi-turn conversation in chronological order', () => {
      // Turn 1: user asks, assistant responds with text + tool
      messages = processUpdate(messages, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Fix the bug' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will fix it.' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Edit file',
        status: 'pending',
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
      });

      // Turn 2: assistant continues after tool result
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Fixed!' },
      });

      // Turn 3: user asks follow-up
      messages = processUpdate(messages, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Run tests' },
      });

      // Turn 4: assistant responds
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Running tests...' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-2',
        title: 'Bash',
        status: 'pending',
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        status: 'completed',
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'All tests pass.' },
      });

      messages = finalize(messages);

      // Verify chronological order:
      // 0: user "Fix the bug"
      // 1: assistant "I will fix it." + [tc-1 completed]
      // 2: assistant "Fixed!" (new turn after completed tool)
      // 3: user "Run tests"
      // 4: assistant "Running tests..." + [tc-2 completed]
      // 5: assistant "All tests pass." (new turn after completed tool)
      assert.equal(messages.length, 6);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Fix the bug');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'I will fix it.');
      assert.equal(messages[1].toolCalls.length, 1);
      assert.equal(messages[1].toolCalls[0].status, 'completed');
      assert.equal(messages[2].role, 'assistant');
      assert.equal(messages[2].content, 'Fixed!');
      assert.equal(messages[3].role, 'user');
      assert.equal(messages[3].content, 'Run tests');
      assert.equal(messages[4].role, 'assistant');
      assert.equal(messages[4].content, 'Running tests...');
      assert.equal(messages[4].toolCalls.length, 1);
      assert.equal(messages[4].toolCalls[0].status, 'completed');
      assert.equal(messages[5].role, 'assistant');
      assert.equal(messages[5].content, 'All tests pass.');
    });
  });

  describe('real-time user input after history replay', () => {
    it('user prompt appears in messages after history replay', () => {
      // Simulate history replay
      messages = processUpdate(messages, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Previous question' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Previous answer' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-old',
        title: 'Read',
        status: 'pending',
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-old',
        status: 'completed',
      });

      // User sends a new real-time prompt (via sendPrompt)
      messages = addUserMessage(messages, 'New question from user');

      // Verify user message appears
      assert.equal(messages.length, 3);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Previous question');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'Previous answer');
      assert.equal(messages[2].role, 'user');
      assert.equal(messages[2].content, 'New question from user');

      // Agent responds to the new prompt
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'New answer' },
      });

      assert.equal(messages.length, 4);
      assert.equal(messages[3].role, 'assistant');
      assert.equal(messages[3].content, 'New answer');
      assert.equal(messages[3].isStreaming, true);
    });

    it('user prompt appears even when last assistant is streaming', () => {
      // History replay with streaming assistant at end
      messages = processUpdate(messages, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Question' },
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Answer' },
      });
      // Note: last message is streaming, no finalize called

      // User sends real-time prompt
      messages = addUserMessage(messages, 'Follow-up question');

      assert.equal(messages.length, 3);
      assert.equal(messages[2].role, 'user');
      assert.equal(messages[2].content, 'Follow-up question');

      // Agent responds
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Follow-up answer' },
      });

      assert.equal(messages.length, 4);
      assert.equal(messages[3].role, 'assistant');
      assert.equal(messages[3].content, 'Follow-up answer');
    });
  });

  describe('full conversation flow', () => {
    it('handles user message + assistant response + completion', () => {
      messages = addUserMessage(messages, 'Fix the bug');

      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will fix the bug.' },
      });
      assert.equal(messages.length, 2);
      assert.equal(messages[1].role, 'assistant');

      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Edit file',
        status: 'in_progress',
      });

      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Done!' },
      });

      messages = finalize(messages);

      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'I will fix the bug. Done!');
      assert.equal(messages[1].toolCalls.length, 1);
      assert.equal(messages[1].isStreaming, false);
    });
  });
});
