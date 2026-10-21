// [[wikilink]] attach: extraction outside code, exact-title pick, page truncation.

export const MAX_LINKS = 4
export const PAGE_CAP = 8000

/** Removes fenced blocks (``` / ~~~) and inline code spans. */
function stripCode(text: string): string {
  const out: string[] = []
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence !== undefined) {
      if (m?.[1] !== undefined && m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined
      continue
    }
    if (m?.[1] !== undefined) {
      fence = m[1]
      continue
    }
    out.push(line.replace(/(`+)[^`]*?\1/g, ''))
  }
  return out.join('\n')
}

/** Distinct `[[Target]]` targets (alias and heading dropped), first spelling kept, at most `max`. */
export function extractWikilinks(text: string, max = MAX_LINKS): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of stripCode(text).matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    const inner = m[1] ?? ''
    const target = (inner.split('|')[0] ?? '').split('#')[0]?.trim() ?? ''
    if (target === '') continue
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
    if (out.length >= max) break
  }
  return out
}

export type SearchHit = { path: string; title: string }

export function searchHits(json: unknown): SearchHit[] {
  if (!Array.isArray(json)) return []
  return json.flatMap(r =>
    typeof r === 'object' && r !== null && typeof r.path === 'string' && typeof r.title === 'string'
      ? [{ path: r.path, title: r.title }]
      : [],
  )
}

/** The hit whose title equals the target (case-insensitive); no guessing past that. */
export function pickExact<T extends SearchHit>(target: string, hits: readonly T[]): T | undefined {
  const q = target.trim().toLowerCase()
  return hits.find(h => h.title.trim().toLowerCase() === q)
}

export type Page = { path: string; title: string; body: string }

/** GET /pages/{path} → path, `meta.title`, body. */
export function pageFromJson(json: unknown): Page | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const j = json as { path?: unknown; body?: unknown; meta?: { title?: unknown } }
  if (typeof j.path !== 'string' || typeof j.body !== 'string') return undefined
  const title = typeof j.meta?.title === 'string' ? j.meta.title : j.path
  return { path: j.path, title, body: j.body }
}

/** Cuts to `cap`: at the last heading past half the cap, else the last newline past half, else hard. */
export function truncatePage(body: string, cap = PAGE_CAP): { text: string; isTruncated: boolean } {
  if (body.length <= cap) return { text: body, isTruncated: false }
  const head = body.slice(0, cap + 1)
  const heading = head.lastIndexOf('\n#')
  if (heading > cap / 2) return { text: body.slice(0, heading), isTruncated: true }
  const nl = head.lastIndexOf('\n')
  if (nl > cap / 2) return { text: body.slice(0, nl), isTruncated: true }
  return { text: body.slice(0, cap), isTruncated: true }
}

export function formatAttachment(title: string, path: string, content: string, isTruncated: boolean): string {
  const note = isTruncated ? '\n\n[truncated at ~8 KB; read the rest with vault_get_page]' : ''
  return `Vault page [[${title}]] (${path}):\n${content}${note}`
}

export function attachToast(attached: readonly string[], unresolved: readonly string[]): string | undefined {
  const parts: string[] = []
  const list = (xs: readonly string[]) => xs.map(x => `[[${x}]]`).join(', ')
  if (attached.length > 0) parts.push(`attached ${list(attached)}`)
  if (unresolved.length > 0) parts.push(`unresolved: ${list(unresolved)}`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}
