import { AudioLines, Check, LoaderCircle, LockKeyhole } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { createAccount, signIn, type Account } from './api';

interface AuthScreenProps {
  onAuthenticated: (account: Account) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '');
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    setBusy(true);
    setError(null);
    try {
      const account = mode === 'register'
        ? await createAccount(name, email, password)
        : await signIn(email, password);
      onAuthenticated(account);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
  };

  return (
    <main className="auth-layout">
      <section className="auth-intro" aria-labelledby="auth-title">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true"><AudioLines size={24} /></span>
          <strong>Perio Voice</strong>
        </div>
        <div>
          <p className="eyebrow">Clinical charting workspace</p>
          <h1 id="auth-title">Stay focused on the patient, not the keyboard.</h1>
          <p className="auth-lead">
            Capture periodontal measurements by voice, review every structured entry, and keep
            each clinician's voice profile attached to their own account.
          </p>
        </div>
        <ul className="auth-benefits">
          <li><Check size={18} aria-hidden="true" /> Context-aware periodontal charting</li>
          <li><Check size={18} aria-hidden="true" /> Local-first clinical processing</li>
          <li><Check size={18} aria-hidden="true" /> Account-scoped voice enrollment</li>
        </ul>
      </section>

      <section className="auth-card" aria-labelledby="auth-form-title">
        <div className="auth-lock" aria-hidden="true"><LockKeyhole size={20} /></div>
        <p className="eyebrow">Secure workspace</p>
        <h2 id="auth-form-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
        <p className="auth-card-copy">
          {mode === 'login'
            ? 'Sign in to open your clinical workspace.'
            : 'Set up a hygienist profile for charting and voice enrollment.'}
        </p>

        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mode === 'register' && (
            <label>
              <span>Full name</span>
              <input name="name" type="text" autoComplete="name" required minLength={2} />
            </label>
          )}
          <label>
            <span>Email address</span>
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={12}
              aria-describedby={mode === 'register' ? 'password-help' : undefined}
            />
          </label>
          {mode === 'register' && (
            <p className="field-help" id="password-help">
              Use 12 or more characters with a letter and number.
            </p>
          )}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={18} aria-hidden="true" />}
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="auth-switch">
          {mode === 'login' ? 'New to Perio Voice?' : 'Already have an account?'}{' '}
          <button
            type="button"
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </section>
    </main>
  );
}
