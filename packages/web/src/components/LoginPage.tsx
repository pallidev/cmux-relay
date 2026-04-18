import { getRelayHttpUrl } from '../lib/helpers';

export function LoginPage() {
  const relayHttpUrl = getRelayHttpUrl();

  const handleGithubLogin = () => {
    window.location.href = `${relayHttpUrl}/api/auth/github`;
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
