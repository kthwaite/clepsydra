export const DEFAULT_API_BASE = 'https://clepsydra.localhost/api/vault'

/**
 * The `apiBase` option as a vault API URL. Only an http(s) URL is one; anything
 * else (a vault folder path, a bare host) falls back to the default and is
 * handed back as `rejected` so the session can say so.
 */
export function apiBaseOf(raw: string): { base: string; rejected?: string } {
  const v = raw.trim()
  if (v === '') return { base: DEFAULT_API_BASE }
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return { base: DEFAULT_API_BASE, rejected: v }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { base: DEFAULT_API_BASE, rejected: v }
  return { base: v.replace(/\/+$/, '') }
}
