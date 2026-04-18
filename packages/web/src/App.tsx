import { Layout } from './components/Layout';
import { RelaySessionLayout } from './components/RelaySessionLayout';
import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';
import { getSessionIdFromPath } from './lib/helpers';
import { useState, useEffect } from 'react';

export default function App() {
  const sessionId = getSessionIdFromPath();

  if (sessionId) {
    return <RelaySessionLayout sessionId={sessionId} />;
  }

  return <HomePage />;
}

function HomePage() {
  const [jwt, setJwt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    if (match) {
      setJwt(match[1]);
    }
    setLoading(false);
  }, []);

  if (loading) return null;

  if (!jwt) {
    return <LoginPage />;
  }

  return <DashboardPage jwt={jwt} />;
}
