import { RelaySessionLayout } from './components/RelaySessionLayout';
import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';
import { PairPage } from './components/PairPage';
import { Layout } from './components/Layout';
import { InstallBanner } from './components/InstallBanner';
import { useState, useEffect } from 'react';

function getPairCodeFromPath(): string | null {
  const match = window.location.pathname.match(/^\/pair\/([A-Fa-f0-9]+)$/);
  return match ? match[1] : null;
}

function isTerminalPath(): boolean {
  return window.location.pathname === '/terminal';
}

function useLocalMode(): { isLocal: boolean | null } {
  const [isLocal, setIsLocal] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/mode')
      .then(res => res.ok ? res.json() : null)
      .then(data => setIsLocal(data?.mode === 'local'))
      .catch(() => setIsLocal(false));
  }, []);
  return { isLocal };
}

export default function App() {
  const pairCode = getPairCodeFromPath();
  if (pairCode) return <PairPage code={pairCode} />;

  if (isTerminalPath()) return <TerminalPage />;

  return (
    <>
      <HomePage />
      <InstallBanner />
    </>
  );
}

function TerminalPage() {
  const [jwt] = useState<string | null>(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    return match ? match[1] : null;
  });
  const [sessionId, setSessionId] = useState<string | null>(() => {
    return localStorage.getItem('cmux-session-id');
  });
  const [loading, setLoading] = useState(true);

  const fetchSession = () => {
    if (!jwt) return;
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
  };

  useEffect(() => {
    if (!jwt) { setLoading(false); return; }
    if (!sessionId) { fetchSession(); return; }
    setLoading(false);
  }, [jwt]);

  const handleDisconnect = () => {
    setTimeout(fetchSession, 2000);
  };

  if (!jwt) return <LoginPage />;
  if (loading) return null;
  if (!sessionId) {
    window.location.href = '/';
    return null;
  }
  return <RelaySessionLayout key={sessionId} sessionId={sessionId} onDisconnect={handleDisconnect} />;
}

function HomePage() {
  const [jwt, setJwt] = useState<string | null>(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    return match ? match[1] : null;
  });
  const { isLocal } = useLocalMode();

  if (!jwt) return <LoginPage />;
  if (isLocal === null) return null;
  if (isLocal) return <Layout />;
  return <DashboardPage jwt={jwt} />;
}
