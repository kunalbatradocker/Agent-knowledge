import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.logoRow}>
          <img src="/logo_pf.svg" alt="Logo" style={styles.logo} />
          <h2 style={styles.title}>Purple Fabric</h2>
        </div>
        <p style={styles.subtitle}>Knowledge Graph Platform</p>

        {error && <div style={styles.error}>{error}</div>}

        <label style={styles.label}>Email</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          style={styles.input}
          required
          autoFocus
          autoComplete="email"
        />

        <label style={styles.label}>Password</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          style={styles.input}
          required
          autoComplete="current-password"
        />

        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', background: 'linear-gradient(135deg, #F5F3FF 0%, #EDE9FE 50%, #DDD6FE 100%)',
  },
  form: {
    background: '#fff', borderRadius: 12, padding: '40px 36px', width: 360,
    boxShadow: '0 4px 24px rgba(107,33,168,0.10)',
    display: 'flex', flexDirection: 'column',
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
  logo: { width: 36, height: 36 },
  title: { margin: 0, fontSize: 22, color: '#6B21A8', fontWeight: 700 },
  subtitle: { margin: '0 0 24px', fontSize: 13, color: '#888' },
  label: { fontSize: 13, fontWeight: 500, color: '#444', marginBottom: 4 },
  input: {
    padding: '10px 12px', borderRadius: 6, border: '1px solid #D1D5DB',
    fontSize: 14, marginBottom: 16, outline: 'none',
  },
  button: {
    padding: '11px 0', borderRadius: 6, border: 'none',
    background: '#7C3AED', color: '#fff', fontSize: 15, fontWeight: 600,
    cursor: 'pointer', marginTop: 4,
  },
  error: {
    background: '#FEF2F2', color: '#DC2626', padding: '8px 12px',
    borderRadius: 6, fontSize: 13, marginBottom: 16,
  },
};
