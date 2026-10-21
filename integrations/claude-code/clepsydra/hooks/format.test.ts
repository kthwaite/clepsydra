import { describe, expect, test } from 'claude-code/testing'

import { activeTaskSection, boardRowText, groupLabel, statusEntry, taskSummary } from './format'
import type { BoardTask } from './tasks'

const T: BoardTask = {
  code: 'TSK-brave-finch-7q3zd',
  title: 'Board pane for the clepsydra mod with a long title',
  status: 'FIELD',
  priority: 'P1',
  project: 'clepsydra',
  path: 'tasks/clepsydra/TSK-brave-finch-7q3zd.md',
  checks: [3, 5],
  updatedAt: '2026-10-04T00:00:00Z',
}

describe('statusEntry', () => {
  test('short code and status, at most 40 chars', () => {
    expect(statusEntry('TSK-brave-finch', 'FIELD')).toBe('TSK-brave-finch · FIELD')
    expect(statusEntry('TSK-brave-finch', undefined)).toBe('TSK-brave-finch')
    expect(statusEntry('TSK-extraordinarily-magnificent-7q3zd', 'REVIEW').length).toBeLessThanOrEqual(40)
  })
})

describe('boardRowText', () => {
  test('marker, code, priority, title, checks', () => {
    expect(boardRowText(T, 'TSK-brave-finch', 200, true)).toBe(
      '● TSK-brave-finch P1 Board pane for the clepsydra mod with a long title 3/5',
    )
  })
  test('no priority shows --, no checks when total is 0, inactive has a blank marker', () => {
    expect(boardRowText({ ...T, priority: null, checks: [0, 0], title: 'x' }, 'TSK-b', 200, false)).toBe('  TSK-b -- x')
  })
  test('title truncates to fit the columns', () => {
    const s = boardRowText(T, 'TSK-brave-finch', 40, false)
    expect(s.length).toBeLessThanOrEqual(40)
    expect(s).toContain('…')
    expect(s.endsWith('3/5')).toBe(true)
  })
})

test('groupLabel names the column and counts', () => {
  expect(groupLabel('FIELD', 2)).toBe('in field (2)')
  expect(groupLabel('INTAKE', 0)).toBe('intake (0)')
})

test('taskSummary is a short multi-line block', () => {
  const s = taskSummary(T, 'explicit')
  expect(s).toContain('TSK-brave-finch-7q3zd · FIELD · P1 · clepsydra')
  expect(s).toContain(T.title)
  expect(s).toContain('bound: explicit')
  expect(s).toContain('checks 3/5')
})

describe('activeTaskSection', () => {
  test('carries facts, body capped, and the scope instruction', () => {
    const text = activeTaskSection(T.code, T, 'b'.repeat(7000))
    expect(text).toContain('Active clepsydra task: TSK-brave-finch-7q3zd')
    expect(text).toContain(`title: ${T.title}`)
    expect(text).toContain('status: FIELD')
    expect(text).toContain('priority: P1')
    expect(text).toContain('project: clepsydra')
    expect(text).not.toContain('b'.repeat(6001))
    expect(text).toContain(
      'This session is working on TSK-brave-finch-7q3zd. Keep work scoped to it; when it is done, say so (the user ships with /ship, which moves it to REVIEW).',
    )
  })
  test('code alone when the board did not answer', () => {
    const text = activeTaskSection('TSK-x-y-z', undefined, undefined)
    expect(text).toContain('Active clepsydra task: TSK-x-y-z')
    expect(text).not.toContain('title:')
  })
})
