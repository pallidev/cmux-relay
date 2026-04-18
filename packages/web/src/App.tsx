import { RelaySessionLayout } from './components/RelaySessionLayout';
import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';
import { PairPage } from './components/PairPage';
import { useState, useEffect } from 'react';

function getPairCodeFromPath(): string | null {
  const match = window.location.pathname.match(/^\/pair\/([A-Fa-f0-9]+)$/);
  return match ? match[1] : null;
}

function isTerminalPath(): boolean {
  return window.location.pathname === '/terminal';
}

export default function App() {
  const pairCode = getPairCodeFromPath();
  if (pairCode) return <PairPage code={pairCode} />;

  if (isTerminalPath()) return <TerminalPage />;

  return <HomePage />;
}

function TerminalPage() {
  const [jwt, setJwt] = useState<string | null>(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    return match ? match[1] : null;
  });
  const [sessionId, setSessionId] = useState<string | null>(() => {
    return localStorage.getItem('cmux-session-id');
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (sessionId) {
      setLoading(false);
      return;
    }
    if (!jwt) {
      setLoading(false);
      return;
    }
    fetch('/api/sessions', { headers: { Authorization: `Bearer ${jwt}` } })
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        const sessions = Array.isArray(data) ? data : [];
        if (sessions.length > 0) {
          const id = sessions[0].sessionId;
          localStorage.setItem('cmux-session-id', id);
          setSessionId(id);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [jwt, sessionId]);

  if (!jwt) return <LoginPage />;
  if (loading) return null;
  if (!sessionId) {
    window.location.href = '/';
    return null;
  }
  return <RelaySessionLayout sessionId={sessionId} />;
}

function HomePage() {
  const [jwt, setJwt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    if (match) setJwt(match[1]);
    setLoading(false);
  }, []);

  if (loading) return null;
  if (!jwt) return <LoginPage />;
  return <DashboardPage jwt={jwt} />;
}
