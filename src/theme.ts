/**
 * Theme resolution and persistence.
 *
 * The stored preference (if any) wins; otherwise the OS `prefers-color-scheme`
 * decides. `localStorage` access is wrapped because it can throw (private
 * browsing, blocked site data) and a theme preference is a convenience, never
 * something worth crashing the app over.
 */

export type ThemePreference = 'light' | 'dark';

const STORAGE_KEY = 'perio-voice.theme';

function readStoredTheme(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): ThemePreference {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** The theme to apply on first load: the stored choice, else the OS preference. */
export function resolveInitialTheme(): ThemePreference {
  return readStoredTheme() ?? systemTheme();
}

/** Applies a theme to the document. Safe to call before React mounts. */
export function applyTheme(theme: ThemePreference): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Persists a theme choice. Best-effort: a failed write still leaves the theme applied. */
export function persistTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The session still reflects the chosen theme; only the memory of it is lost.
  }
}
