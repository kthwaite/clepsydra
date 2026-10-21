import { describe, expect, test } from 'claude-code/testing'

import {
  bindingKey,
  branchTaskCode,
  groupTasks,
  parseBoard,
  resolveTaskRef,
  shortCode,
  type BoardTask,
} from './tasks'

function task(code: string, over: Partial<BoardTask> = {}): BoardTask {
  return {
    code,
    title: `title of ${code}`,
    status: 'INTAKE',
    priority: null,
    project: 'clepsydra',
    path: `tasks/clepsydra/${code}.md`,
    checks: [0, 0],
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  }
}

describe('parseBoard', () => {
  test('keeps well-formed tasks and project slugs, drops junk', () => {
    const b = parseBoard({
      operations: [{ project: 'clepsydra', name: 'Clepsydra' }, { project: null, name: 'Shipping' }, { name: 'x' }],
      tasks: [
        {
          code: 'TSK-brave-finch-7q3zd',
          title: 'T',
          status: 'FIELD',
          priority: 'P1',
          project: 'clepsydra',
          path: 'tasks/clepsydra/TSK-brave-finch-7q3zd.md',
          checks: [3, 5],
          updated_at: '2026-10-02T00:00:00Z',
        },
        { code: null, title: 'no code', status: 'INTAKE' },
        'garbage',
      ],
    })
    expect(b?.projects).toEqual(['clepsydra', null, null])
    expect(b?.hubs).toEqual({ clepsydra: 'Clepsydra' })
    expect(b?.tasks).toEqual([
      {
        code: 'TSK-brave-finch-7q3zd',
        title: 'T',
        status: 'FIELD',
        priority: 'P1',
        project: 'clepsydra',
        path: 'tasks/clepsydra/TSK-brave-finch-7q3zd.md',
        checks: [3, 5],
        updatedAt: '2026-10-02T00:00:00Z',
      },
    ])
  })
  test('not a board is undefined', () => {
    expect(parseBoard(null)).toBeUndefined()
    expect(parseBoard({ tasks: 'x' })).toBeUndefined()
  })
})

describe('groupTasks', () => {
  const tasks = [
    task('TSK-a-a-1', { status: 'INTAKE', priority: 'P2' }),
    task('TSK-b-b-1', { status: 'FIELD', priority: null, updatedAt: '2026-10-03T00:00:00Z' }),
    task('TSK-c-c-1', { status: 'FIELD', priority: 'P0' }),
    task('TSK-d-d-1', { status: 'FIELD', priority: null, updatedAt: '2026-10-04T00:00:00Z' }),
    task('TSK-e-e-1', { status: 'SEALED' }),
    task('TSK-f-f-1', { status: 'REVIEW', project: 'xxii' }),
    task('TSK-g-g-1', { status: 'TRIAGE', priority: 'P3' }),
  ]
  test('FIELD, REVIEW, TRIAGE, INTAKE; project filter; SEALED hidden; priority then newest', () => {
    const g = groupTasks(tasks, 'clepsydra', false)
    expect(g.map(x => x.status)).toEqual(['FIELD', 'TRIAGE', 'INTAKE'])
    expect(g[0]?.tasks.map(t => t.code)).toEqual(['TSK-c-c-1', 'TSK-d-d-1', 'TSK-b-b-1'])
  })
  test('all includes SEALED last', () => {
    const g = groupTasks(tasks, 'clepsydra', true)
    expect(g.map(x => x.status)).toEqual(['FIELD', 'TRIAGE', 'INTAKE', 'SEALED'])
  })
})

describe('shortCode', () => {
  const codes = ['TSK-brave-finch-7q3zd', 'TSK-brave-fin-aaaaa', 'TSK-calm-owl-1', 'TSK-calm-owl-2']
  test('drops the tail when the stem is unambiguous', () => {
    expect(shortCode('TSK-brave-finch-7q3zd', codes)).toBe('TSK-brave-finch')
    expect(shortCode('TSK-calm-owl-1', codes)).toBe('TSK-calm-owl-1')
  })
  test('legacy and odd codes stay whole', () => {
    expect(shortCode('TSK-0042', codes)).toBe('TSK-0042')
    expect(shortCode('20260829.x.0j26', codes)).toBe('20260829.x.0j26')
  })
})

describe('resolveTaskRef', () => {
  const tasks = [
    task('TSK-brave-finch-7q3zd', { title: 'Board pane' }),
    task('TSK-brave-fox-aaaaa', { title: 'Journal on exit' }),
    task('TSK-calm-owl-bbbbb', { title: 'Board filters' }),
  ]
  test('exact code, case-insensitive', () => {
    expect(resolveTaskRef('tsk-calm-owl-bbbbb', tasks)).toEqual({ task: tasks[2] })
  })
  test('unique prefix', () => {
    expect(resolveTaskRef('TSK-brave-fi', tasks)).toEqual({ task: tasks[0] })
  })
  test('ambiguous prefix lists candidates', () => {
    expect(resolveTaskRef('TSK-brave', tasks)).toEqual({ candidates: [tasks[0], tasks[1]] })
  })
  test('unique title substring, else ambiguous, else none', () => {
    expect(resolveTaskRef('journal', tasks)).toEqual({ task: tasks[1] })
    expect(resolveTaskRef('board', tasks)).toEqual({ candidates: [tasks[0], tasks[2]] })
    expect(resolveTaskRef('nothing', tasks)).toEqual({ candidates: [] })
  })
})

describe('branchTaskCode', () => {
  test('petname code in a branch, normalised', () => {
    expect(branchTaskCode('feature/tsk-brave-finch-7q3zd-board')).toBe('TSK-brave-finch-7q3zd')
    expect(branchTaskCode('TSK-Brave-Finch-7Q3ZD')).toBe('TSK-brave-finch-7q3zd')
  })
  test('legacy four-digit code', () => {
    expect(branchTaskCode('fix/tsk-0042-thing')).toBe('TSK-0042')
  })
  test('none', () => {
    expect(branchTaskCode('develop')).toBeUndefined()
  })
})

test('bindingKey joins repo and branch', () => {
  expect(bindingKey('/w/r', 'feature/x')).toBe('binding:/w/r@feature/x')
})
