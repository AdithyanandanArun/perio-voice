import { AudioLines, LogOut } from 'lucide-react';
import type { Account } from '../auth/api';
import { ROUTE_HASH, ROUTE_LABEL, type Route } from './routes';

const ROUTES: readonly Route[] = ['perio', 'profile', 'graph'];

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

interface TopNavProps {
  route: Route;
  account: Account;
  onLogout: () => void;
}

export function TopNav({ route, account, onLogout }: TopNavProps) {
  return (
    <header className="topnav" aria-label="Perio Voice">
      <div className="topnav-brand">
        <span className="brand-mark" aria-hidden="true"><AudioLines size={20} /></span>
        <strong>Perio Voice</strong>
      </div>
      <nav className="topnav-links" aria-label="Primary navigation">
        {ROUTES.map((candidate) => (
          <a
            key={candidate}
            href={ROUTE_HASH[candidate]}
            aria-current={route === candidate ? 'page' : undefined}
            className={route === candidate ? 'is-active' : ''}
          >
            {ROUTE_LABEL[candidate]}
          </a>
        ))}
      </nav>
      <div className="topnav-account">
        <span className="account-avatar" aria-hidden="true">{initials(account.name)}</span>
        <span className="topnav-account-name">{account.name}</span>
        <button type="button" className="button button-quiet" onClick={onLogout}>
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </button>
      </div>
    </header>
  );
}
