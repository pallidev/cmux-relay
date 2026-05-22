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

interface PerSurfaceState {
  messages: AcpChatMessage[];
  isProcessing: boolean;
  permissionRequest: AcpPermissionState | null;
  acpSessionId: string | null;
  currentAssistantId: string | null;
}

function createEmptySurface(): PerSurfaceState {
  return {
    messages: [],
    isProcessing: false,
    permissionRequest: null,
    acpSessionId: null,
    currentAssistantId: null,
  };
}

export function useAcpChat(
  sendViaTransport: (data: string) => void,
  activeSurfaceId: string | null,
) {
  const [surfaceStates, setSurfaceStates] = useState<Map<string, PerSurfaceState>>(new Map());
  const [agentStatus, setAgentStatus] = useState<'starting' | 'ready' | 'error' | null>(null);
  const [agentName, setAgentName] = useState('');
  const surfaceStatesRef = useRef(surfaceStates);

  // Keep ref in sync
  surfaceStatesRef.current = surfaceStates;

  const updateSurface = useCallback((surfaceId: string, updater: (prev: PerSurfaceState) => PerSurfaceState) => {
    setSurfaceStates(prev => {
      const next = new Map(prev);
      const current = next.get(surfaceId) || createEmptySurface();
      next.set(surfaceId, updater(current));
      return next;
    });
  }, []);

  // Fallback: use activeSurfaceId when agent doesn't send surfaceId (backward compat)
  const resolveSurfaceId = useCallback((msgSurfaceId: string | undefined): string | null => {
    return msgSurfaceId || activeSurfaceId;
  }, [activeSurfaceId]);

  const handleAcpMessage = useCallback((msg: RelayToClient) => {
    switch (msg.type) {
      case 'acp.agent_status':
        setAgentStatus(msg.status);
        setAgentName(msg.agentName);
        break;

      case 'acp.session.created': {
        const sid = resolveSurfaceId(msg.surfaceId);
        if (!sid) break;
        updateSurface(sid, prev => ({
          ...prev,
          acpSessionId: msg.sessionId,
        }));
        break;
      }

      case 'acp.session_update': {
        const sid = resolveSurfaceId(msg.surfaceId);
        if (!sid) break;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const update = msg.update as any;
        if (!update) break;

        switch (update.sessionUpdate) {
          case 'user_message_chunk': {
            const text = update.content?.type === 'text' ? update.content.text : '';
            if (!text) break;

            updateSurface(sid, prev => {
              const finalized = prev.messages.map(m =>
                m.isStreaming ? { ...m, isStreaming: false } : m
              );
              return {
                ...prev,
                messages: [...finalized, { id: crypto.randomUUID(), role: 'user' as const, content: text, toolCalls: [], isStreaming: false }],
                currentAssistantId: null,
              };
            });
            break;
          }

          case 'agent_message_chunk': {
            const text = update.content?.type === 'text' ? update.content.text : '';
            if (!text) break;

            updateSurface(sid, prev => {
              const last = prev.messages[prev.messages.length - 1];
              if (last && last.role === 'assistant' && last.isStreaming) {
                const hasCompletedTools = last.toolCalls.some(
                  tc => tc.status === 'completed' || tc.status === 'failed'
                );
                if (hasCompletedTools) {
                  const finalized = prev.messages.map((m, i) =>
                    i === prev.messages.length - 1 ? { ...m, isStreaming: false } : m
                  );
                  const id = crypto.randomUUID();
                  return {
                    ...prev,
                    messages: [...finalized, { id, role: 'assistant' as const, content: text, toolCalls: [], isStreaming: true }],
                    currentAssistantId: id,
                  };
                }
                return {
                  ...prev,
                  messages: prev.messages.map((m, i) =>
                    i === prev.messages.length - 1
                      ? { ...m, content: m.content + text }
                      : m
                  ),
                };
              }
              const id = crypto.randomUUID();
              return {
                ...prev,
                messages: [...prev.messages, { id, role: 'assistant' as const, content: text, toolCalls: [], isStreaming: true }],
                currentAssistantId: id,
              };
            });
            break;
          }

          case 'tool_call': {
            const tc: AcpToolCall = {
              id: update.toolCallId ?? crypto.randomUUID(),
              title: update.title ?? 'Tool',
              status: update.status ?? 'pending',
            };

            updateSurface(sid, prev => {
              const last = prev.messages[prev.messages.length - 1];
              if (last && last.role === 'assistant' && last.isStreaming) {
                return {
                  ...prev,
                  messages: prev.messages.map((m, i) =>
                    i === prev.messages.length - 1
                      ? { ...m, toolCalls: [...m.toolCalls, tc] }
                      : m
                  ),
                };
              }
              const id = crypto.randomUUID();
              return {
                ...prev,
                messages: [...prev.messages, { id, role: 'assistant' as const, content: '', toolCalls: [tc], isStreaming: true }],
                currentAssistantId: id,
              };
            });
            break;
          }

          case 'tool_call_update': {
            const tcId = update.toolCallId;
            if (!tcId) break;

            updateSurface(sid, prev => ({
              ...prev,
              messages: prev.messages.map(m => {
                if (m.role !== 'assistant' || !m.isStreaming) return m;
                return {
                  ...m,
                  toolCalls: m.toolCalls.map(tc =>
                    tc.id === tcId
                      ? { ...tc, status: update.status ?? tc.status, title: update.title ?? tc.title }
                      : tc
                  ),
                };
              }),
            }));
            break;
          }

          case 'agent_thought_chunk':
            break;
        }
        break;
      }

      case 'acp.permission_request': {
        const sid = resolveSurfaceId(msg.surfaceId);
        if (!sid) break;
        updateSurface(sid, prev => ({
          ...prev,
          permissionRequest: {
            requestId: msg.requestId,
            toolName: msg.toolName,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            options: (msg.options as any[])?.map((o: any) => ({
              optionId: o.optionId,
              name: o.name,
              kind: o.kind,
            })) ?? [],
          },
        }));
        break;
      }

      case 'acp.session_complete': {
        const sid = resolveSurfaceId(msg.surfaceId);
        if (!sid) break;
        updateSurface(sid, prev => ({
          ...prev,
          isProcessing: false,
          messages: prev.messages.map(m =>
            m.isStreaming ? { ...m, isStreaming: false } : m
          ),
        }));
        break;
      }
    }
  }, [updateSurface, resolveSurfaceId]);

  // Get the active surface's state (or empty default)
  const activeState = (activeSurfaceId && surfaceStates.get(activeSurfaceId)) || createEmptySurface();

  const sendPrompt = useCallback((text: string) => {
    if (!activeSurfaceId || !text.trim()) return;
    const state = surfaceStatesRef.current.get(activeSurfaceId);
    if (!state?.acpSessionId) return;
    updateSurface(activeSurfaceId, prev => ({
      ...prev,
      isProcessing: true,
      messages: [
        ...prev.messages,
        { id: crypto.randomUUID(), role: 'user' as const, content: text, toolCalls: [], isStreaming: false },
      ],
      currentAssistantId: null,
    }));
    sendViaTransport(JSON.stringify({ type: 'acp.prompt', sessionId: state.acpSessionId, surfaceId: activeSurfaceId, text }));
  }, [activeSurfaceId, sendViaTransport, updateSurface]);

  const respondToPermission = useCallback((optionId: string) => {
    if (!activeSurfaceId) return;
    const state = surfaceStatesRef.current.get(activeSurfaceId);
    if (!state?.permissionRequest || !state.acpSessionId) return;
    sendViaTransport(JSON.stringify({
      type: 'acp.permission_response',
      sessionId: state.acpSessionId,
      surfaceId: activeSurfaceId,
      requestId: state.permissionRequest.requestId,
      outcome: optionId,
    }));
    updateSurface(activeSurfaceId, prev => ({ ...prev, permissionRequest: null }));
  }, [activeSurfaceId, sendViaTransport, updateSurface]);

  const cancel = useCallback(() => {
    if (!activeSurfaceId) return;
    const state = surfaceStatesRef.current.get(activeSurfaceId);
    if (!state?.acpSessionId) return;
    sendViaTransport(JSON.stringify({ type: 'acp.cancel', sessionId: state.acpSessionId, surfaceId: activeSurfaceId }));
  }, [activeSurfaceId, sendViaTransport]);

  const ensureSession = useCallback((surfaceId: string, cwd?: string) => {
    const state = surfaceStatesRef.current.get(surfaceId);
    if (state?.acpSessionId) return;
    sendViaTransport(JSON.stringify({ type: 'acp.new_session', surfaceId, cwd }));
  }, [sendViaTransport]);

  const getSurfaceHasSession = useCallback((surfaceId: string): boolean => {
    return !!surfaceStatesRef.current.get(surfaceId)?.acpSessionId;
  }, []);

  return {
    messages: activeState.messages,
    isProcessing: activeState.isProcessing,
    permissionRequest: activeState.permissionRequest,
    agentStatus,
    agentName,
    acpSessionId: activeState.acpSessionId,
    handleAcpMessage,
    sendPrompt,
    respondToPermission,
    cancel,
    ensureSession,
    getSurfaceHasSession,
  };
}
