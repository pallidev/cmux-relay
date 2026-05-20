import { useState, useRef, useEffect } from 'react';
import { ChatMessage } from './ChatMessage';
import { PermissionDialog } from './PermissionDialog';
import type { AcpChatMessage, AcpPermissionState } from '../hooks/useAcpChat';

interface ChatViewProps {
  messages: AcpChatMessage[];
  isProcessing: boolean;
  agentStatus: 'starting' | 'ready' | 'error' | null;
  agentName: string;
  permissionRequest: AcpPermissionState | null;
  onSendPrompt: (text: string) => void;
  onCancel: () => void;
  onPermissionResponse: (optionId: string) => void;
  onNewSession: () => void;
}

const SLASH_COMMANDS = [
  { cmd: '/new', desc: 'Start a new session' },
  { cmd: '/cancel', desc: 'Cancel current prompt' },
  { cmd: '/help', desc: 'Show available commands' },
];

export function ChatView({
  messages,
  isProcessing,
  agentStatus,
  agentName,
  permissionRequest,
  onSendPrompt,
  onCancel,
  onPermissionResponse,
  onNewSession,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [selectedCmd, setSelectedCmd] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredCommands = input.startsWith('/')
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(input.toLowerCase()))
    : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    setShowCommands(filteredCommands.length > 0 && input.length > 0);
    setSelectedCmd(0);
  }, [input]);

  const executeCommand = (cmd: string) => {
    setInput('');
    setShowCommands(false);
    switch (cmd) {
      case '/new':
        onNewSession();
        break;
      case '/cancel':
        onCancel();
        break;
      case '/help':
        // Show help as a system message via prompt (agent will respond)
        onSendPrompt('/help');
        break;
      default:
        onSendPrompt(cmd);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (showCommands && filteredCommands.length > 0) {
      executeCommand(filteredCommands[selectedCmd].cmd);
      return;
    }
    if (!input.trim() || isProcessing) return;
    if (input.startsWith('/')) {
      executeCommand(input.trim().toLowerCase());
      return;
    }
    onSendPrompt(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showCommands) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedCmd(i => Math.min(i + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedCmd(i => Math.max(i - 1, 0));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (filteredCommands.length > 0) {
        setInput(filteredCommands[selectedCmd].cmd + ' ');
        setShowCommands(false);
      }
    } else if (e.key === 'Escape') {
      setShowCommands(false);
    }
  };

  const statusText = agentStatus === 'starting'
    ? `${agentName || 'Agent'} starting...`
    : agentStatus === 'error'
    ? `${agentName || 'Agent'} error`
    : agentName || 'Agent';

  const isReady = agentStatus === 'ready';

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
            {isReady
              ? `Send a message to start chatting with ${agentName}`
              : agentStatus === 'error'
              ? 'Failed to connect to agent'
              : 'Waiting for agent...'}
            <div style={{ marginTop: 16, fontSize: 12, color: '#585b70' }}>
              Type / for commands
            </div>
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

      {/* Command autocomplete */}
      {showCommands && (
        <div style={{
          background: '#181825',
          borderTop: '1px solid #313244',
          maxHeight: 120,
          overflowY: 'auto',
        }}>
          {filteredCommands.map((c, i) => (
            <div
              key={c.cmd}
              onClick={() => executeCommand(c.cmd)}
              style={{
                padding: '6px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                background: i === selectedCmd ? '#313244' : 'transparent',
                color: '#cdd6f4',
                fontSize: 13,
              }}
            >
              <span style={{ color: '#89b4fa', fontFamily: 'monospace', fontWeight: 600 }}>{c.cmd}</span>
              <span style={{ color: '#6c7086', fontSize: 12 }}>{c.desc}</span>
            </div>
          ))}
        </div>
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
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isReady ? 'Message... (type / for commands)' : 'Waiting for agent...'}
          disabled={!isReady || isProcessing}
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
          disabled={!input.trim() || isProcessing || !isReady}
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
