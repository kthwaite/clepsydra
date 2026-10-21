/** The vault's health as the status line and the session notice show it. */
export type Health = { reachable: boolean; conflicts: number; doctor?: { errors: number; warnings: number } }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function healthSegment(h: Health): string {
  if (!h.reachable) return 'vault ✗'
  if (h.conflicts > 0) return `vault · ${h.conflicts} conflicts`
  return 'vault ✓'
}

/** One sentence naming each problem, or undefined when there is none. Doctor warnings alone are not a problem. */
export function healthNotice(h: Health): string | undefined {
  const problems: string[] = []
  if (!h.reachable) problems.push('server unreachable — start clep serve')
  if (h.conflicts > 0) problems.push(`${plural(h.conflicts, 'sync conflict', 'sync conflicts')} — open /conflicts`)
  const errors = h.doctor?.errors ?? 0
  if (errors > 0) problems.push(`clep doctor reports ${plural(errors, 'error', 'errors')}`)
  return problems.length === 0 ? undefined : `clepsydra: ${problems.join('; ')}`
}

/** The host allows one status string per plugin: the task entry, then health. */
export function statusText(task: string | undefined, health: string): string {
  return task === undefined ? health : `${task} · ${health}`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `conflict_copies` of GET /sync/status; a vault without sync answers 0 there. */
export function conflictCount(json: unknown): number {
  const n = isRecord(json) ? json.conflict_copies : undefined
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0
}

/** Error and warning checks of `clep doctor --json` (`{ checks: [{ status }] }`, statuses lowercase); undefined when not that. */
export function doctorCounts(stdout: string): { errors: number; warnings: number } | undefined {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isRecord(json) || !Array.isArray(json.checks)) return undefined
  const counts = { errors: 0, warnings: 0 }
  for (const c of json.checks) {
    const status = isRecord(c) && typeof c.status === 'string' ? c.status.toLowerCase() : ''
    if (status === 'err') counts.errors += 1
    else if (status === 'warn') counts.warnings += 1
  }
  return counts
}
