// Project hub: the PROJECT page whose status the session starts with.

export type HubRow = { project: string; path: string; board: boolean }
export type HubSettings = { integrationBranch?: string; triageIndex?: string }

/** The row for `slug`; a `board: true` row wins, else the first. */
export function pickHub(rows: readonly HubRow[], slug: string): HubRow | undefined {
  const mine = rows.filter(r => r.project === slug)
  return mine.find(r => r.board) ?? mine[0]
}

/** `integration_branch` and `triage_index` from page meta; non-strings ignored. */
export function hubSettings(meta: Record<string, unknown>): HubSettings {
  const out: HubSettings = {}
  if (typeof meta.integration_branch === 'string') out.integrationBranch = meta.integration_branch
  if (typeof meta.triage_index === 'string') out.triageIndex = meta.triage_index
  return out
}

/**
 * The named `##` sections of `body` in body order, each with its heading,
 * joined by a blank line and cut at `cap` chars with `…`. Names match ignoring
 * case and trailing spaces. `undefined` when none match.
 */
export function hubSections(body: string, names: readonly string[], cap: number): string | undefined {
  const wanted = new Set(names.map(n => n.trim().toLowerCase()))
  const found: string[] = []
  let current: string[] | undefined
  let fence: string | undefined
  for (const line of body.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (f?.[1] !== undefined) {
      if (fence === undefined) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined
    }
    const h = fence === undefined && f === null ? /^(#{1,2})\s+(.*?)\s*$/.exec(line) : null
    if (h?.[1] !== undefined && h[2] !== undefined) {
      if (current !== undefined) found.push(current.join('\n').trim())
      current = h[1] === '##' && wanted.has(h[2].toLowerCase()) ? [`## ${h[2]}`] : undefined
      continue
    }
    current?.push(line)
  }
  if (current !== undefined) found.push(current.join('\n').trim())
  if (found.length === 0) return undefined
  const text = found.join('\n\n')
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text
}
