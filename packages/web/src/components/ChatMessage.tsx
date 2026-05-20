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
          gap: 4,
        }}>
          {message.toolCalls.map(tc => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#f9e2af',
  in_progress: '#89b4fa',
  completed: '#a6e3a1',
  failed: '#f38ba8',
};

function ToolCallCard({ toolCall }: { toolCall: AcpToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        padding: '6px 10px',
        background: '#181825',
        borderRadius: 6,
        border: '1px solid #313244',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
      }}
    >
      <div style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: STATUS_COLORS[toolCall.status] ?? '#6c7086',
        flexShrink: 0,
      }} />
      <span style={{ color: '#cdd6f4', flex: 1 }}>
        {toolCall.title}
      </span>
      <span style={{ color: '#6c7086', fontSize: 11, textTransform: 'uppercase' }}>
        {toolCall.status.replace('_', ' ')}
      </span>
      <span style={{ color: '#6c7086' }}>{expanded ? '▾' : '▸'}</span>
    </div>
  );
}
