export function LoginPage({ pairCode }: { pairCode?: string }) {
  const handleGithubLogin = () => {
    const base = '/api/auth/github';
    window.location.href = pairCode ? `${base}?pair=${pairCode}` : base;
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>cmux-relay</h1>
        <p>{pairCode ? 'Sign in to approve this agent' : 'Access your terminal from anywhere'}</p>
        <button className="github-login-btn" onClick={handleGithubLogin}>
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
}
