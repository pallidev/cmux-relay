import { Layout } from './components/Layout';
import { RelaySessionLayout } from './components/RelaySessionLayout';
import { LoginPage } from './components/LoginPage';
import { getSessionIdFromPath, getRelayWsUrl, getRelayHttpUrl } from './lib/helpers';
import { useState } from 'react';

export default function App() {
  const sessionId = getSessionIdFromPath();

  if (sessionId) {
    return <RelaySessionLayout sessionId={sessionId} />;
  }

  return <Layout />;
}
