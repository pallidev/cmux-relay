import { useState, useEffect, useCallback } from 'react';

export function DashboardPage({ jwt }: { jwt: string }) {
  const apiBase = '/api';
  const [sessions, setSessions] = useState<{ sessionId: string; clientCount: number }[]>([]);
  const [user, setUser] = useState<{ userId: string; username: string } | null>(null);
  const [error, setError] = useState('');

  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/sessions`, { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setSessions(Array.isArray(data) ? data : []);
      }
    } catch { /* ignore */ }
  }, [jwt, apiBase]);

  useEffect(() => {
    fetch(`${apiBase}/api/auth/me`, { headers: authHeaders })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setUser(data); })
      .catch(() => {});

    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);
    return () => clearInterval(interval);
  }, [jwt, apiBase]);

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

        {error && <p className="dashboard-error">{error}</p>}

        {/* Active Sessions */}
        <section className="dashboard-section">
          <h2>Active Sessions</h2>
          {sessions.length > 0 ? (
            <ul className="session-list">
              {sessions.map((s) => (
                <li key={s.sessionId} className="session-item">
                  <div className="session-info">
                    <span className="session-id">{s.sessionId.slice(0, 8)}</span>
                    <span className="session-clients">{s.clientCount} client(s)</span>
                  </div>
                  <a href={`/s/${s.sessionId}`} className="session-connect-btn">
                    View Terminal
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dashboard-empty">
              <p>No active sessions.</p>
              <p className="dashboard-hint">Run <code>npx cmux-relay-agent</code> to start a session.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
