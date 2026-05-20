import { useState, useCallback, useRef } from 'react';
import type { RelayToClient } from '@cmux-relay/shared';

export interface AcpChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: AcpToolCall[];
  isStreaming: boolean;
}

export interface AcpToolCall {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface AcpPermissionState {
  requestId: string;
  toolName: string;
  options: { optionId: string; name: string; kind: string }[];
}

export function useAcpChat(sendViaTransport: (data: string) => void) {
  const [messages, setMessages] = useState<AcpChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<AcpPermissionState | null>(null);
  const [agentStatus, setAgentStatus] = useState<'starting' | 'ready' | 'error' | null>(null);
  const [agentName, setAgentName] = useState('');
  const [acpSessionId, setAcpSessionId] = useState<string | null>(null);
  const currentAssistantRef = useRef<string | null>(null);

  const handleAcpMessage = useCallback((msg: RelayToClient) => {
    switch (msg.type) {
      case 'acp.agent_status':
        setAgentStatus(msg.status);
        setAgentName(msg.agentName);
        break;

      case 'acp.session.created':
        setAcpSessionId(msg.sessionId);
        setAgentStatus('ready');
        break;

      case 'acp.session_update': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const update = msg.update as any;
        if (!update) break;

        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = update.content?.type === 'text' ? update.content.text : '';
            if (!text) break;

            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.isStreaming) {
                return prev.map((m, i) =>
                  i === prev.length - 1
                    ? { ...m, content: m.content + text }
                    : m
                );
              }
              const id = crypto.randomUUID();
              currentAssistantRef.current = id;
              return [...prev, { id, role: 'assistant', content: text, toolCalls: [], isStreaming: true }];
            });
            break;
          }

          case 'tool_call': {
            const tc: AcpToolCall = {
              id: update.toolCallId ?? crypto.randomUUID(),
              title: update.title ?? 'Tool',
              status: update.status ?? 'pending',
            };

            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.isStreaming) {
                return prev.map((m, i) =>
                  i === prev.length - 1
                    ? { ...m, toolCalls: [...m.toolCalls, tc] }
                    : m
                );
              }
              const id = crypto.randomUUID();
              currentAssistantRef.current = id;
              return [...prev, { id, role: 'assistant', content: '', toolCalls: [tc], isStreaming: true }];
            });
            break;
          }

          case 'tool_call_update': {
            const tcId = update.toolCallId;
            if (!tcId) break;

            setMessages(prev => prev.map(m => {
              if (m.role !== 'assistant' || !m.isStreaming) return m;
              return {
                ...m,
                toolCalls: m.toolCalls.map(tc =>
                  tc.id === tcId
                    ? { ...tc, status: update.status ?? tc.status, title: update.title ?? tc.title }
                    : tc
                ),
              };
            }));
            break;
          }

          case 'agent_thought_chunk':
            // Ignore thought chunks for now
            break;
        }
        break;
      }

      case 'acp.permission_request': {
        setPermissionRequest({
          requestId: msg.requestId,
          toolName: msg.toolName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          options: (msg.options as any[])?.map((o: any) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })) ?? [],
        });
        break;
      }

      case 'acp.session_complete':
        setIsProcessing(false);
        // Finalize streaming messages
        setMessages(prev => prev.map(m =>
          m.isStreaming ? { ...m, isStreaming: false } : m
        ));
        break;
    }
  }, []);

  const sendPrompt = useCallback((text: string) => {
    if (!acpSessionId || !text.trim()) return;
    setIsProcessing(true);
    setMessages(prev => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: text, toolCalls: [], isStreaming: false },
    ]);
    currentAssistantRef.current = null;
    sendViaTransport(JSON.stringify({ type: 'acp.prompt', sessionId: acpSessionId, text }));
  }, [acpSessionId, sendViaTransport]);

  const respondToPermission = useCallback((optionId: string) => {
    if (!permissionRequest || !acpSessionId) return;
    sendViaTransport(JSON.stringify({
      type: 'acp.permission_response',
      sessionId: acpSessionId,
      requestId: permissionRequest.requestId,
      outcome: optionId,
    }));
    setPermissionRequest(null);
  }, [permissionRequest, acpSessionId, sendViaTransport]);

  const cancel = useCallback(() => {
    if (!acpSessionId) return;
    sendViaTransport(JSON.stringify({ type: 'acp.cancel', sessionId: acpSessionId }));
  }, [acpSessionId, sendViaTransport]);

  const newSession = useCallback((cwd?: string) => {
    sendViaTransport(JSON.stringify({ type: 'acp.new_session', cwd }));
  }, [sendViaTransport]);

  return {
    messages,
    isProcessing,
    permissionRequest,
    agentStatus,
    agentName,
    acpSessionId,
    handleAcpMessage,
    sendPrompt,
    respondToPermission,
    cancel,
    newSession,
  };
}
