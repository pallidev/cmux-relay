import { useState, useEffect } from 'react';
import { LoginPage } from './LoginPage';

export function PairPage({ code }: { code: string }) {
  const [jwt, setJwt] = useState<string | null>(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    return match ? match[1] : null;
  });
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/pair/${code}`)
      .then(res => res.json())
      .then(data => {
        setExists(data.exists);
        setLoading(false);
      })
      .catch(() => {
        setError('Failed to check pairing status');
        setLoading(false);
      });
  }, [code]);

  if (!jwt) {
    return <LoginPage pairCode={code} />;
  }

  const handleApprove = async () => {
    setApproving(true);
    setError('');
    try {
      const res = await fetch(`/api/pair/${code}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        setDone(true);
      } else {
        setError('Failed to approve pairing');
      }
    } catch {
      setError('Network error');
    }
    setApproving(false);
  };

  return (
    <div className="login-screen">
      <div className="dashboard-card" style={{ maxWidth: 400, textAlign: 'center' }}>
        <h1 style={{ marginBottom: '1rem' }}>Agent Pairing</h1>

        {loading && <p>Checking pairing request...</p>}

        {error && <p className="dashboard-error">{error}</p>}

        {!loading && !exists && (
          <div>
            <p className="dashboard-error">This pairing code is invalid or has expired.</p>
            <p className="dashboard-hint">Try running the agent command again.</p>
          </div>
        )}

        {!loading && exists && !done && (
          <div>
            <p style={{ marginBottom: '0.5rem', color: 'var(--text-sub)' }}>
              Code: <strong style={{ color: 'var(--text)', letterSpacing: '0.1em', fontSize: '1.2rem' }}>{code}</strong>
            </p>
            <p className="dashboard-hint" style={{ marginBottom: '1.5rem' }}>
              Allow this agent to connect to your account?
            </p>
            <button
              className="token-create"
              style={{ width: '100%', justifyContent: 'center', cursor: approving ? 'wait' : 'pointer' }}
              onClick={handleApprove}
              disabled={approving}
            >
              {approving ? 'Approving...' : 'Allow Agent'}
            </button>
          </div>
        )}

        {!loading && exists && done && (
          <div>
            <p style={{ color: 'var(--green)', fontSize: '1.1rem', marginBottom: '0.5rem' }}>
              Agent linked successfully!
            </p>
            <p className="dashboard-hint">You can close this page.</p>
          </div>
        )}
      </div>
    </div>
  );
}
