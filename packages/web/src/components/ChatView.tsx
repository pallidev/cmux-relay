import { useState, useRef, useEffect, useMemo } from 'react';
import { ChatMessage } from './ChatMessage';
import { PermissionDialog } from './PermissionDialog';
import type { AcpChatMessage, AcpPermissionState } from '../hooks/useAcpChat';

interface ChatViewProps {
  messages: AcpChatMessage[];
  isProcessing: boolean;
  agentStatus: 'starting' | 'ready' | 'error' | null;
  agentName: string;
  permissionRequest: AcpPermissionState | null;
  canSend: boolean;
  onSendPrompt: (text: string) => void;
  onCancel: () => void;
  onPermissionResponse: (optionId: string) => void;
}

export function ChatView({
  messages,
  isProcessing,
  agentStatus,
  agentName,
  permissionRequest,
  canSend,
  onSendPrompt,
  onCancel,
  onPermissionResponse,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isProcessing || !canSend) return;
    onSendPrompt(input.trim());
    setInput('');
  };

  const statusText = agentStatus === 'starting'
    ? `${agentName || 'Agent'} starting...`
    : agentStatus === 'error'
    ? `${agentName || 'Agent'} error`
    : agentName || 'Agent';

  const isReady = agentStatus === 'ready';

  // Compute current activity from active tool calls
  const activityText = useMemo(() => {
    if (!isProcessing) return null;
    const activeTools: string[] = [];
    for (const msg of messages) {
      if (!msg.isStreaming) continue;
      for (const tc of msg.toolCalls) {
        if (tc.status === 'in_progress') activeTools.push(tc.title);
        else if (tc.status === 'pending') activeTools.push(tc.title);
      }
    }
    if (activeTools.length === 0) return 'Thinking...';
    if (activeTools.length === 1) return activeTools[0];
    return `${activeTools[0]} +${activeTools.length - 1}`;
  }, [messages, isProcessing]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#1e1e2e',
    }}>
      {/* Agent status bar */}
      <div style={{
        padding: '6px 12px',
        background: '#181825',
        borderBottom: '1px solid #313244',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: isReady ? '#a6e3a1' : agentStatus === 'error' ? '#f38ba8' : '#f9e2af',
        }} />
        <span style={{ color: '#cdd6f4', fontSize: 12 }}>{statusText}</span>
        {activityText && (
          <span style={{
            color: '#89b4fa',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}>
            <span style={{
              display: 'inline-block',
              width: 3,
              height: 3,
              borderRadius: '50%',
              background: '#89b4fa',
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
            {activityText}
          </span>
        )}
        {isProcessing && (
          <button
            onClick={onCancel}
            style={{
              marginLeft: 'auto',
              background: '#f38ba8',
              color: '#1e1e2e',
              border: 'none',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Stop
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px',
        WebkitOverflowScrolling: 'touch',
      }}>
        {messages.length === 0 && (
          <div style={{
            color: '#6c7086',
            textAlign: 'center',
            padding: '40px 20px',
            fontSize: 14,
          }}>
            {canSend
              ? `Send a message to start chatting with ${agentName}`
              : agentStatus === 'error'
              ? 'Failed to connect to agent'
              : 'Waiting for agent...'}
          </div>
        )}
        {messages.map(msg => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Permission dialog */}
      {permissionRequest && (
        <PermissionDialog
          request={permissionRequest}
          onRespond={onPermissionResponse}
        />
      )}

      {/* Input bar */}
      <form onSubmit={handleSubmit} style={{
        display: 'flex',
        gap: 0,
        padding: '8px 12px',
        background: '#181825',
        borderTop: '1px solid #313244',
        flexShrink: 0,
      }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={canSend ? 'Message...' : 'Waiting for agent...'}
          disabled={!canSend || isProcessing}
          style={{
            flex: 1,
            height: 36,
            border: '1px solid #313244',
            borderRadius: 6,
            background: '#1e1e2e',
            color: '#cdd6f4',
            fontSize: 14,
            padding: '0 10px',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <button
          type="submit"
          disabled={!input.trim() || isProcessing || !canSend}
          style={{
            height: 36,
            minWidth: 44,
            marginLeft: 8,
            border: 'none',
            borderRadius: 6,
            background: (!input.trim() || isProcessing) ? '#313244' : 'rgba(137, 180, 250, 0.8)',
            color: (!input.trim() || isProcessing) ? '#6c7086' : '#1e1e2e',
            fontSize: 13,
            fontWeight: 600,
            cursor: (!input.trim() || isProcessing) ? 'not-allowed' : 'pointer',
            padding: '0 10px',
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
