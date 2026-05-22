import { useState } from 'react';
import type { AcpChatMessage, AcpToolCall } from '../hooks/useAcpChat';

interface ChatMessageProps {
  message: AcpChatMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      marginBottom: 12,
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
    }}>
      {/* Message bubble */}
      {message.content && (
        <div style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
          background: isUser ? 'rgba(137, 180, 250, 0.2)' : '#313244',
          color: '#cdd6f4',
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: isUser ? 'inherit' : 'Menlo, Monaco, "Courier New", monospace',
        }}>
          {message.content}
          {message.isStreaming && (
            <span style={{
              display: 'inline-block',
              width: 2,
              height: 14,
              background: '#89b4fa',
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              animation: 'blink 1s step-end infinite',
            }} />
          )}
        </div>
      )}

      {/* Tool calls */}
      {message.toolCalls.length > 0 && (
        <div style={{
          marginTop: message.content ? 4 : 0,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}>
          {message.toolCalls.map(tc => (
            <ToolCallCard key={tc.id} toolCall={tc} isStreaming={message.isStreaming} />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_CONFIG: Record<string, { color: string; label: string; icon: string }> = {
  pending: { color: '#f9e2af', label: 'Waiting', icon: '●' },
  in_progress: { color: '#89b4fa', label: 'Running', icon: '⟳' },
  completed: { color: '#a6e3a1', label: 'Done', icon: '✓' },
  failed: { color: '#f38ba8', label: 'Failed', icon: '✗' },
};

function ToolCallCard({ toolCall, isStreaming }: { toolCall: AcpToolCall; isStreaming: boolean }) {
  const config = STATUS_CONFIG[toolCall.status] ?? { color: '#6c7086', label: toolCall.status, icon: '·' };
  const isActive = toolCall.status === 'in_progress' || toolCall.status === 'pending';
  const isDone = toolCall.status === 'completed' || toolCall.status === 'failed';

  return (
    <div style={{
      padding: '5px 10px',
      background: isActive ? 'rgba(137, 180, 250, 0.08)' : '#181825',
      borderRadius: 6,
      border: `1px solid ${isActive ? 'rgba(137, 180, 250, 0.3)' : '#313244'}`,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 12,
      opacity: isDone ? 0.7 : 1,
    }}>
      {/* Status icon */}
      <span style={{
        color: config.color,
        fontSize: isActive ? 11 : 12,
        flexShrink: 0,
        animation: toolCall.status === 'in_progress' ? 'spin 1s linear infinite' : undefined,
        display: 'inline-block',
        fontWeight: 600,
      }}>
        {config.icon}
      </span>

      {/* Title */}
      <span style={{
        color: '#cdd6f4',
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {toolCall.title}
      </span>

      {/* Status label */}
      <span style={{
        color: config.color,
        fontSize: 10,
        fontWeight: 500,
        flexShrink: 0,
      }}>
        {config.label}
      </span>
    </div>
  );
}
