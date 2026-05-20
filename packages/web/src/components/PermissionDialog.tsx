import type { AcpPermissionState } from '../hooks/useAcpChat';

interface PermissionDialogProps {
  request: AcpPermissionState;
  onRespond: (optionId: string) => void;
}

export function PermissionDialog({ request, onRespond }: PermissionDialogProps) {
  return (
    <div style={{
      padding: '12px',
      background: '#181825',
      borderTop: '1px solid #45475a',
      flexShrink: 0,
    }}>
      <div style={{
        color: '#f9e2af',
        fontSize: 12,
        fontWeight: 600,
        marginBottom: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span>Permission required</span>
      </div>
      <div style={{
        color: '#cdd6f4',
        fontSize: 13,
        marginBottom: 10,
      }}>
        {request.toolName}
      </div>
      <div style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
      }}>
        {request.options.map((opt) => (
          <button
            key={opt.optionId}
            onClick={() => onRespond(opt.optionId)}
            style={{
              padding: '6px 14px',
              border: 'none',
              borderRadius: 6,
              background: opt.kind === 'allow' || opt.kind === 'always_allow'
                ? 'rgba(166, 227, 161, 0.2)'
                : opt.kind === 'deny'
                ? 'rgba(243, 139, 168, 0.2)'
                : '#313244',
              color: opt.kind === 'allow' || opt.kind === 'always_allow'
                ? '#a6e3a1'
                : opt.kind === 'deny'
                ? '#f38ba8'
                : '#cdd6f4',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  );
}
