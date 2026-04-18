import { useState, useEffect, useCallback } from 'react';

export function DashboardPage({ jwt }: { jwt: string }) {
  const apiBase = '/api';
  const [tokens, setTokens] = useState<{ id: string; name: string | null; last_used_at: string | null; created_at: string }[]>([]);
  const [sessions, setSessions] = useState<{ sessionId: string; clientCount: number }[]>([]);
  const [newTokenName, setNewTokenName] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [user, setUser] = useState<{ userId: string; username: string } | null>(null);
  const [error, setError] = useState('');

  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/tokens`, { headers: authHeaders });
      if (res.ok) setTokens(await res.json());
    } catch { /* ignore */ }
  }, [jwt, apiBase]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/sessions`, { headers: authHeaders });
      if (res.ok) setSessions(await res.json());
    } catch { /* ignore */ }
  }, [jwt, apiBase]);

  useEffect(() => {
    fetch(`${apiBase}/api/auth/me`, { headers: authHeaders })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setUser(data); })
      .catch(() => {});

    fetchTokens();
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [jwt, apiBase]);

  const handleCreateToken = async () => {
    setError('');
    setNewToken(null);
    try {
      const res = await fetch(`${apiBase}/api/tokens`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTokenName || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewToken(data.token);
        setNewTokenName('');
        fetchTokens();
      } else {
        setError('Failed to create token');
      }
    } catch {
      setError('Network error');
    }
  };

  const handleDeleteToken = async (id: string) => {
    await fetch(`${apiBase}/api/tokens/${id}`, { method: 'DELETE', headers: authHeaders });
    fetchTokens();
  };

  const handleLogout = () => {
    document.cookie = 'relay_jwt=; Path=/; Max-Age=0';
    window.location.reload();
  };

  return (
    <div className="login-screen">
      <div className="dashboard-card">
        <div className="dashboard-header">
          <h1>cmux-relay</h1>
          <div className="dashboard-user">
            {user && <span>@{user.username}</span>}
            <button className="logout-btn" onClick={handleLogout}>Logout</button>
          </div>
        </div>

        {/* API Tokens */}
        <section className="dashboard-section">
          <h2>API Tokens</h2>
          <p className="dashboard-hint">Create a token to connect your local agent.</p>

          <div className="token-create">
            <input
              type="text"
              placeholder="Token name (e.g. my-macbook)"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
            />
            <button onClick={handleCreateToken}>Create</button>
          </div>

          {newToken && (
            <div className="token-reveal">
              <p>Copy this token now. It won't be shown again.</p>
              <code>{newToken}</code>
              <p className="token-usage">
                Run: <code>CMUX_RELAY_TOKEN={newToken} pnpm dev -- --relay-url wss://relay.jaz.duckdns.org/ws/agent</code>
              </p>
            </div>
          )}

          {error && <p className="dashboard-error">{error}</p>}

          {tokens.length > 0 ? (
            <ul className="token-list">
              {tokens.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.name || 'Unnamed'}</strong>
                    <span className="token-date">Created: {new Date(t.created_at).toLocaleDateString()}</span>
                  </div>
                  <button className="delete-btn" onClick={() => handleDeleteToken(t.id)}>Delete</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dashboard-empty">No tokens yet.</p>
          )}
        </section>

        {/* Active Sessions */}
        <section className="dashboard-section">
          <h2>Active Sessions</h2>
          {sessions.length > 0 ? (
            <ul className="session-list">
              {sessions.map((s) => (
                <li key={s.sessionId}>
                  <a href={`/s/${s.sessionId}`} className="session-link">
                    {window.location.origin}/s/{s.sessionId}
                  </a>
                  <span className="session-clients">{s.clientCount} client(s)</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dashboard-empty">No active sessions. Start an agent to create one.</p>
          )}
        </section>
      </div>
    </div>
  );
}
