import { RelaySessionLayout } from './components/RelaySessionLayout';
import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';
import { PairPage } from './components/PairPage';
import { Layout } from './components/Layout';
import { InstallBanner } from './components/InstallBanner';
import { getJwtFromBrowser } from './hooks/useAuth';
import { useState, useEffect, useCallback } from 'react';

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
  const [jwt] = useState<string | null>(() => getJwtFromBrowser());
  const [sessionId, setSessionId] = useState<string | null>(() => {
    return localStorage.getItem('cmux-session-id');
  });
  const [loading, setLoading] = useState(true);
  const [retryCount, setRetryCount] = useState(0);

  const fetchSession = useCallback(() => {
    if (!jwt) return;
    setLoading(true);
    fetch('/api/sessions', { headers: { Authorization: `Bearer ${jwt}` } })
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        const sessions = Array.isArray(data) ? data : [];
        if (sessions.length > 0) {
          const id = sessions[0].sessionId;
          localStorage.setItem('cmux-session-id', id);
          setSessionId(id);
          setRetryCount(0);
        } else {
          localStorage.removeItem('cmux-session-id');
          setSessionId(null);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [jwt]);

  useEffect(() => {
    if (!jwt) { setLoading(false); return; }
    fetchSession();
  }, [jwt, fetchSession]);

  const handleDisconnect = useCallback(() => {
    setRetryCount(prev => {
      const next = prev + 1;
      if (next > 3) {
        localStorage.removeItem('cmux-session-id');
        window.location.href = '/';
        return prev;
      }
      setTimeout(fetchSession, 3000);
      return next;
    });
  }, [fetchSession]);

  // Called when user clicks "retry" on permanent error — re-fetch session and reconnect
  const handleRetry = useCallback(() => {
    setRetryCount(0);
    fetchSession();
  }, [fetchSession]);

  if (!jwt) return <LoginPage />;
  if (loading) return null;
  if (!sessionId) {
    window.location.href = '/';
    return null;
  }
  return <RelaySessionLayout key={sessionId} sessionId={sessionId} onDisconnect={handleDisconnect} onRetry={handleRetry} />;
}

function HomePage() {
  const [jwt, setJwt] = useState<string | null>(() => getJwtFromBrowser());
  const { isLocal } = useLocalMode();

  if (!jwt) return <LoginPage />;
  if (isLocal === null) return null;
  if (isLocal) return <Layout />;
  return <DashboardPage jwt={jwt} />;
}
