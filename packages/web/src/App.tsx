import { Layout } from './components/Layout';
import { RelaySessionLayout } from './components/RelaySessionLayout';
import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';
import { PairPage } from './components/PairPage';
import { useState, useEffect } from 'react';

function getSessionIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/s\/([a-zA-Z0-9]+)$/);
  return match ? match[1] : null;
}

function getPairCodeFromPath(): string | null {
  const match = window.location.pathname.match(/^\/pair\/([A-Fa-f0-9]+)$/);
  return match ? match[1] : null;
}

export default function App() {
  const sessionId = getSessionIdFromPath();
  if (sessionId) return <RelaySessionLayout sessionId={sessionId} />;

  const pairCode = getPairCodeFromPath();
  if (pairCode) return <PairPage code={pairCode} />;

  return <HomePage />;
}

function HomePage() {
  const [jwt, setJwt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    if (match) setJwt(match[1]);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!jwt) return;
    fetch('/api/sessions', { headers: { Authorization: `Bearer ${jwt}` } })
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        const sessions = Array.isArray(data) ? data : data.sessions;
        if (sessions?.length > 0) {
          window.location.replace(`/s/${sessions[0].sessionId}`);
        }
      })
      .catch(() => {});
  }, [jwt]);

  if (loading) return null;
  if (!jwt) return <LoginPage />;
  return <DashboardPage jwt={jwt} />;
}
