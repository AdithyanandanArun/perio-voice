/**
 * Hash-based routing for the three top-level pages.
 *
 * No router dependency: the History/hashchange API is enough for three
 * destinations. An unrecognised hash (including none at all) resolves to
 * Perio test, which is also where a signed-in clinician lands by default.
 */

export type Route = 'profile' | 'perio' | 'graph';

export const ROUTE_HASH: Record<Route, string> = {
  profile: '#/profile',
  perio: '#/perio',
  graph: '#/graph',
};

export const ROUTE_LABEL: Record<Route, string> = {
  profile: 'Profile',
  perio: 'Perio test',
  graph: 'Graph',
};

export const DEFAULT_ROUTE: Route = 'perio';

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/profile') return 'profile';
  if (path === '/graph') return 'graph';
  return DEFAULT_ROUTE;
}
