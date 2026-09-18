import { useEffect, useRef } from 'react';

/**
 * Sets the document title and moves focus to a page's main heading when the
 * page mounts (i.e. on every navigation, since each page unmounts when it is
 * not the active route). Returns the ref to attach to that heading.
 */
export function usePageTitle(title: string) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = `${title} · Perio Voice`;
    headingRef.current?.focus();
  }, [title]);

  return headingRef;
}
