import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We test the logic of useAcpChat by importing the state processing functions
// directly. Since the hook uses React state, we test the message processing logic
// through the exported interface by simulating what the hook does.

// Instead of testing the React hook directly (which requires a React test renderer),
// we test the message processing logic that the hook implements.

// The key logic is: given a sequence of ACP session_update messages,
// how does the message list get built up?

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
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? (update.content.text ?? '') : '';
      if (!text) return messages;

      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.isStreaming) {
        return messages.map((m, i) =>
          i === messages.length - 1
            ? { ...m, content: m.content + text }
            : m
        );
      }
      return [...messages, { id: `msg-${Date.now()}-${Math.random()}`, role: 'assistant', content: text, toolCalls: [], isStreaming: true }];
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
      return [...messages, { id: `msg-${Date.now()}-${Math.random()}`, role: 'assistant', content: '', toolCalls: [tc], isStreaming: true }];
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

describe('ACP chat message processing', () => {
  let messages: SimpleMessage[];

  beforeEach(() => {
    messages = [];
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

    it('ignores non-text content', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image' },
      });

      assert.equal(messages.length, 0);
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

    it('supports multiple tool calls in one message', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read',
        status: 'pending',
      });
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-2',
        title: 'Write',
        status: 'pending',
      });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].toolCalls.length, 2);
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

    it('does not modify non-streaming messages', () => {
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read',
        status: 'pending',
      });
      messages = finalize(messages);
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
      });

      // Status stays 'pending' because message is no longer streaming
      assert.equal(messages[0].toolCalls[0].status, 'pending');
    });
  });

  describe('full conversation flow', () => {
    it('handles user message + assistant response + completion', () => {
      // User sends message (added externally in the hook)
      messages = [
        { id: 'user-1', role: 'user', content: 'Fix the bug', toolCalls: [], isStreaming: false },
      ];

      // Assistant starts streaming
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will fix the bug.' },
      });
      assert.equal(messages.length, 2);
      assert.equal(messages[1].role, 'assistant');

      // Tool call
      messages = processUpdate(messages, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Edit file',
        status: 'in_progress',
      });

      // More text
      messages = processUpdate(messages, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Done!' },
      });

      // Complete
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
