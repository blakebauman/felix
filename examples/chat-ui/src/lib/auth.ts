/**
 * Shared-key gate for the chat UI.
 *
 * The proxy Worker (worker/index.ts) checks an `x-chat-key` header on every
 * `/api/*` request against its `CHAT_UI_KEY` secret. This module is the
 * browser side: it stashes the key in localStorage, exposes the header for the
 * API client, and lets the Gate component re-prompt when a request comes back
 * 401 (wrong / rotated key).
 *
 * In `vite dev` the Worker isn't in the loop (Vite proxies `/api` straight to
 * Felix), so the Gate is skipped entirely — see components/gate.tsx.
 */

const KEY_STORAGE = 'felix.apiKey';

let onUnauthorized: (() => void) | null = null;

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function setApiKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

/** Header merged into every `/api` fetch; empty when no key is stored. */
export function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { 'x-chat-key': key } : {};
}

/** The Gate registers here so a 401 anywhere flips back to the key prompt. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * Called by the API client when a request returns 401. Drops the stored key
 * and notifies the Gate so the user is re-prompted instead of seeing a wall
 * of failed requests.
 */
export function handleUnauthorized(): void {
  clearApiKey();
  onUnauthorized?.();
}
