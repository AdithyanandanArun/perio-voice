export interface Account {
  id: string;
  name: string;
  email: string;
  createdAt: number;
  voiceEnrolled: boolean;
}

interface AccountResponse {
  account: Account;
}

export class AuthRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function accountRequest(path: string, init?: Parameters<typeof fetch>[1]): Promise<Account> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body
        ? { 'Content-Type': 'application/json', ...init.headers }
        : init?.headers,
    });
  } catch {
    throw new AuthRequestError('The Perio Voice service is unavailable.', 0);
  }
  const body = await response.json().catch(() => ({})) as Partial<AccountResponse> & {
    detail?: string;
  };
  if (!response.ok || !body.account) {
    throw new AuthRequestError(body.detail ?? 'Your request could not be completed.', response.status);
  }
  return body.account;
}

export function resumeAccount(): Promise<Account> {
  return accountRequest('/api/auth/me');
}

export function signIn(email: string, password: string): Promise<Account> {
  return accountRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function createAccount(name: string, email: string, password: string): Promise<Account> {
  return accountRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  });
}

export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Local state still clears. An unreachable service cannot preserve a usable session.
  }
}
