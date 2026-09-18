import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_ROUTE, parseRoute, ROUTE_HASH, type Route } from './routes';

function currentRoute(): Route {
  if (typeof window === 'undefined') return DEFAULT_ROUTE;
  return parseRoute(window.location.hash);
}

/** Reads and writes the active page from `location.hash`, reacting to back/forward too. */
export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const target = ROUTE_HASH[next];
    if (window.location.hash === target) {
      setRoute(next);
    } else {
      window.location.hash = target;
    }
  }, []);

  return [route, navigate];
}
