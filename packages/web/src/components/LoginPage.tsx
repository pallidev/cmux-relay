export function LoginPage() {
  const handleGithubLogin = () => {
    window.location.href = '/api/auth/github';
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>cmux-relay</h1>
        <p>Access your terminal from anywhere</p>
        <button className="github-login-btn" onClick={handleGithubLogin}>
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
}
