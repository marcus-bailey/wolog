/**
 * The login in front of apps.marcusbailey.com (oauth2-proxy). These paths belong to the site,
 * not the app, so they are absolute. In development there's no login, so API calls never get 401.
 */
export const SIGN_IN_URL = '/oauth2/start';
export const SIGN_OUT_URL = '/oauth2/sign_out';

/**
 * At most this many trips to the sign-in page in REDIRECT_WINDOW_MS. If signing in doesn't help
 * (a real loop), they're used up within seconds and the app stops going and says so.
 */
const MAX_REDIRECTS = 3;
const REDIRECT_WINDOW_MS = 120_000;
const REDIRECT_KEY = 'wolog.signInRedirects';

/** Leaves the app for another page. Tests replace it. */
export const browser = {
  leave(url: string): void {
    window.location.assign(url);
  },
};

/** The sign-in page, coming back to this page afterwards. */
export function signInUrl(): string {
  const { pathname, search, hash } = window.location;
  return `${SIGN_IN_URL}?rd=${encodeURIComponent(pathname + search + hash)}`;
}

/**
 * Called on a 401: go and sign in. Returns false, and stays, if that has already happened
 * MAX_REDIRECTS times in a short while.
 */
export function goToSignIn(now: number = Date.now()): boolean {
  const recent = remembered().filter((at) => now - at < REDIRECT_WINDOW_MS);
  if (recent.length >= MAX_REDIRECTS) return false;
  try {
    sessionStorage.setItem(REDIRECT_KEY, JSON.stringify([...recent, now]));
  } catch {
    // Storage blocked: still go, there's just no loop guard.
  }
  browser.leave(signInUrl());
  return true;
}

function remembered(): number[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(REDIRECT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((at): at is number => typeof at === 'number') : [];
  } catch {
    return [];
  }
}
