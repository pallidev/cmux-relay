import { useState, useEffect } from 'react';

export function LoginPage({ pairCode }: { pairCode?: string }) {
  const [isLocal, setIsLocal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/mode')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.mode === 'local') setIsLocal(true);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleGithubLogin = () => {
    const base = '/api/auth/github';
    window.location.href = pairCode ? `${base}?pair=${pairCode}` : base;
  };

  const handleLocalLogin = async () => {
    const res = await fetch('/api/local/auth', { method: 'POST' });
    if (res.ok) {
      window.location.reload();
    }
  };

  if (loading) return null;

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>cmux-relay</h1>
        <p>{pairCode ? 'Sign in to approve this agent' : 'Access your terminal from anywhere'}</p>
        {isLocal ? (
          <button className="github-login-btn" onClick={handleLocalLogin}>
            Connect (Local)
          </button>
        ) : (
          <button className="github-login-btn" onClick={handleGithubLogin}>
            Sign in with GitHub
          </button>
        )}
      </div>
    </div>
  );
}
