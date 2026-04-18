import { useState, useEffect, useRef } from 'react';
import { LoginPage } from './LoginPage';

export function PairPage({ code }: { code: string }) {
  const [jwt, setJwt] = useState<string | null>(() => {
    const match = document.cookie.match(/(?:^|;\s*)relay_jwt=([^;]+)/);
    return match ? match[1] : null;
  });
  const [error, setError] = useState('');
  const autoApproved = useRef(false);

  // 로그인 + 페어링 존재 확인 → 자동 승인 → 세션 대기 → 터미널 이동
  useEffect(() => {
    if (!jwt || autoApproved.current) return;

    (async () => {
      try {
        const checkRes = await fetch(`/api/pair/${code}`);
        const checkData = await checkRes.json();
        if (!checkData.exists) {
          setError('This pairing code is invalid or has expired.');
          return;
        }

        autoApproved.current = true;
        const approveRes = await fetch(`/api/pair/${code}/approve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!approveRes.ok) {
          setError('Failed to approve pairing');
          return;
        }

        // 세션 생성 대기 후 터미널로 이동
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const res = await fetch('/api/sessions', {
              headers: { Authorization: `Bearer ${jwt}` },
            });
            if (res.ok) {
              const data = await res.json();
              const sessions = Array.isArray(data) ? data : data.sessions;
              if (sessions?.length > 0) {
                window.location.href = `/s/${sessions[0].sessionId}`;
                return;
              }
            }
          } catch { /* retry */ }
        }
        window.location.href = '/';
      } catch {
        setError('Connection failed');
      }
    })();
  }, [jwt, code]);

  if (!jwt) {
    return <LoginPage pairCode={code} />;
  }

  if (error) {
    return (
      <div className="login-screen">
        <div className="dashboard-card" style={{ maxWidth: 400, textAlign: 'center' }}>
          <h1 style={{ marginBottom: '1rem' }}>Agent Pairing</h1>
          <p className="dashboard-error">{error}</p>
          <p className="dashboard-hint">Try running the agent command again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="dashboard-card" style={{ maxWidth: 400, textAlign: 'center' }}>
        <h1 style={{ marginBottom: '1rem' }}>Connecting...</h1>
        <p className="dashboard-hint">Setting up your terminal session</p>
      </div>
    </div>
  );
}
