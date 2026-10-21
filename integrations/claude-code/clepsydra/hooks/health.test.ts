import { describe, expect, test } from 'claude-code/testing'

import { conflictCount, doctorCounts, healthNotice, healthSegment, statusText } from './health'

const OK = { reachable: true, conflicts: 0 }

describe('healthSegment', () => {
  test('unreachable, conflicted and healthy', () => {
    expect(healthSegment({ reachable: false, conflicts: 0 })).toBe('vault ✗')
    expect(healthSegment({ reachable: false, conflicts: 3 })).toBe('vault ✗')
    expect(healthSegment({ reachable: true, conflicts: 2 })).toBe('vault · 2 conflicts')
    expect(healthSegment({ reachable: true, conflicts: 1 })).toBe('vault · 1 conflict')
    expect(healthSegment(OK)).toBe('vault ✓')
  })

  test('doctor findings do not change the segment', () => {
    expect(healthSegment({ ...OK, doctor: { errors: 2, warnings: 1 } })).toBe('vault ✓')
  })
})

describe('healthNotice', () => {
  test('healthy: nothing (warnings alone are not a problem)', () => {
    expect(healthNotice(OK)).toBeUndefined()
    expect(healthNotice({ ...OK, doctor: { errors: 0, warnings: 4 } })).toBeUndefined()
  })

  test('names each problem', () => {
    expect(healthNotice({ reachable: false, conflicts: 0 })).toBe('clepsydra: server unreachable — start clep serve')
    expect(healthNotice({ reachable: true, conflicts: 2 })).toBe('clepsydra: 2 sync conflicts — open /conflicts')
    expect(healthNotice({ reachable: true, conflicts: 1 })).toBe('clepsydra: 1 sync conflict — open /conflicts')
    expect(healthNotice({ ...OK, doctor: { errors: 1, warnings: 0 } })).toBe('clepsydra: clep doctor reports 1 error')
    expect(healthNotice({ ...OK, doctor: { errors: 3, warnings: 0 } })).toBe('clepsydra: clep doctor reports 3 errors')
  })

  test('unreachable plus a doctor error names both', () => {
    const n = healthNotice({ reachable: false, conflicts: 0, doctor: { errors: 1, warnings: 0 } })
    expect(n).toBe('clepsydra: server unreachable — start clep serve; clep doctor reports 1 error')
  })
})

describe('statusText', () => {
  test('joins task and health, or health alone', () => {
    expect(statusText('TSK-brave-finch · FIELD', 'vault ✓')).toBe('TSK-brave-finch · FIELD · vault ✓')
    expect(statusText(undefined, 'vault ✗')).toBe('vault ✗')
  })
})

describe('conflictCount', () => {
  test('reads conflict_copies from a sync status reply', () => {
    expect(conflictCount({ initialised: true, branch: 'main', unmerged_files: 5, conflict_copies: 2 })).toBe(2)
  })

  test('a non-sync vault, a bad reply and a bad count are 0', () => {
    expect(conflictCount({ initialised: false, conflict_copies: 0 })).toBe(0)
    expect(conflictCount({})).toBe(0)
    expect(conflictCount(null)).toBe(0)
    expect(conflictCount({ conflict_copies: -1 })).toBe(0)
    expect(conflictCount({ conflict_copies: 'many' })).toBe(0)
  })
})

describe('doctorCounts', () => {
  const check = (status: string) => ({ section: 's', name: 'n', status, detail: 'd' })

  test('counts err and warn checks from a --json report', () => {
    const report = {
      checks: [check('ok'), check('err'), check('warn'), check('warn'), check('info'), check('skip')],
      summary: { ok: 1, warn: 2, err: 1, info: 1, skip: 1 },
    }
    expect(doctorCounts(JSON.stringify(report, null, 2))).toEqual({ errors: 1, warnings: 2 })
  })

  test('status spellings are case-insensitive (ERR, WARN)', () => {
    expect(doctorCounts(JSON.stringify({ checks: [check('ERR'), check('WARN')] }))).toEqual({ errors: 1, warnings: 1 })
  })

  test('unparsable or unshaped output is undefined', () => {
    expect(doctorCounts('not json')).toBeUndefined()
    expect(doctorCounts('')).toBeUndefined()
    expect(doctorCounts('{"summary":{}}')).toBeUndefined()
    expect(doctorCounts('[]')).toBeUndefined()
  })
})
