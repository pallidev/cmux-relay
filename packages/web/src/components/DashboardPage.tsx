import { useState, useEffect, useCallback } from 'react';
import { getPendingNavigation } from '../lib/push';

interface Viewer {
  ip: string;
  userAgent: string;
}

export function DashboardPage({ jwt }: { jwt: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [user, setUser] = useState<{ userId: string; username: string } | null>(null);

  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        const sessions = Array.isArray(data) ? data : [];
        if (sessions.length > 0) {
          setSessionId(sessions[0].sessionId);
          setViewers(sessions[0].viewers || []);
        } else {
          setSessionId(null);
          setViewers([]);
        }
      }
    } catch { /* ignore */ }
  }, [jwt]);

  useEffect(() => {
    fetch('/api/auth/me', { headers: authHeaders })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setUser(data); })
      .catch(() => {});

    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);
    return () => clearInterval(interval);
  }, [jwt, fetchSessions]);

  // Auto-navigate to terminal if arriving from push notification
  useEffect(() => {
    if (!sessionId) return;
    getPendingNavigation().then((nav) => {
      if (nav) {
        localStorage.setItem('cmux-session-id', sessionId);
        // Preserve navigation data for RelaySessionLayout to consume
        localStorage.setItem('cmux-relay-pending-nav', JSON.stringify(nav));
        window.location.href = '/terminal';
      }
    });
  }, [sessionId]);

  const handleLogout = () => {
    document.cookie = 'relay_jwt=; Path=/; Max-Age=0';
    window.location.reload();
  };

  const parseUA = (ua: string) => {
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('Mac OS')) return 'macOS';
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Linux')) return 'Linux';
    return 'Unknown';
  };

  const parseBrowser = (ua: string) => {
    if (ua.includes('CriOS')) return 'Chrome';
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
    if (ua.includes('Firefox')) return 'Firefox';
    return 'Browser';
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

        {sessionId ? (
          <>
            <a href="/terminal" onClick={() => { if (sessionId) localStorage.setItem('cmux-session-id', sessionId); }} className="terminal-open-btn">
              View Terminal
            </a>

            <section className="dashboard-section">
              <h2>Viewers <span className="viewer-badge">{viewers.length}</span></h2>
              {viewers.length > 0 ? (
                <ul className="viewer-list">
                  {viewers.map((v, i) => (
                    <li key={i} className="viewer-item">
                      <div className="viewer-device">{parseUA(v.userAgent)} · {parseBrowser(v.userAgent)}</div>
                      <div className="viewer-ip">{v.ip}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dashboard-hint">No viewers connected.</p>
              )}
            </section>
          </>
        ) : (
          <div className="dashboard-empty">
            <p>No agent connected.</p>
            <p className="dashboard-hint">Run <code>npx cmux-relay-agent</code> to start.</p>
          </div>
        )}
      </div>
    </div>
  );
}
