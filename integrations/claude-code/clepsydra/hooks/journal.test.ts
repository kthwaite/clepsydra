import { describe, expect, test } from 'claude-code/testing'

import {
  asPending,
  buildDigest,
  entryContent,
  fallbackBody,
  isTrivial,
  journalPrompt,
  journalsOnEnd,
  pushPending,
  type DigestFacts,
} from './journal'

const FACTS: DigestFacts = {
  repo: 'clepsydra',
  branch: 'feature/board',
  task: { code: 'TSK-brave-finch-7q3zd', title: 'Board pane', status: 'FIELD' },
  prompts: ['build the board pane', 'x'.repeat(300)],
  promptCount: 2,
  commits: ['a1b2c3d feat: board pane', 'e4f5a6b test: board'],
  diffStat: ' 3 files changed, 120 insertions(+), 4 deletions(-)',
  finalMessage: 'Done. Gates green.',
}

describe('isTrivial', () => {
  test('trivial only when few prompts, no commits, no task', () => {
    expect(isTrivial({ promptCount: 2, commitCount: 0, hasTask: false })).toBe(true)
    expect(isTrivial({ promptCount: 3, commitCount: 0, hasTask: false })).toBe(false)
    expect(isTrivial({ promptCount: 0, commitCount: 1, hasTask: false })).toBe(false)
    expect(isTrivial({ promptCount: 0, commitCount: 0, hasTask: true })).toBe(false)
  })
})

test('journalsOnEnd: every reason but resume', () => {
  expect(['prompt_input_exit', 'clear', 'other', 'logout'].every(journalsOnEnd)).toBe(true)
  expect(journalsOnEnd('resume')).toBe(false)
})

describe('buildDigest', () => {
  test('carries repo, task, prompts cut to 200, commits, diff stat, final message', () => {
    const d = buildDigest(FACTS)
    expect(d).toContain('repo: clepsydra @ feature/board')
    expect(d).toContain('task: TSK-brave-finch-7q3zd — Board pane (FIELD)')
    expect(d).toContain('- build the board pane')
    expect(d).toContain(`- ${'x'.repeat(200)}…`)
    expect(d).not.toContain('x'.repeat(201))
    expect(d).toContain('- a1b2c3d feat: board pane')
    expect(d).toContain('3 files changed')
    expect(d).toContain('Done. Gates green.')
  })
  test('caps prompts to the last 30, commits to 30, final message to 1500', () => {
    const d = buildDigest({
      ...FACTS,
      prompts: Array.from({ length: 40 }, (_, i) => `p${i}`),
      commits: Array.from({ length: 40 }, (_, i) => `c${i}`),
      finalMessage: 'm'.repeat(2000),
    })
    expect(d).not.toContain('- p9\n')
    expect(d).toContain('- p10\n')
    expect(d).toContain('- c29\n')
    expect(d).not.toContain('- c30')
    expect(d).not.toContain('m'.repeat(1501))
  })
})

test('journalPrompt asks for terse bullets over the digest only', () => {
  const p = journalPrompt('DIGEST')
  expect(p).toContain('DIGEST')
  expect(p).toMatch(/3.6/)
  expect(p).toContain('only')
})

test('fallbackBody lists task, commits and prompt count', () => {
  const b = fallbackBody(FACTS)
  expect(b).toContain('- task: TSK-brave-finch-7q3zd — Board pane')
  expect(b).toContain('- 2 commits: a1b2c3d, e4f5a6b')
  expect(b).toContain('- 2 prompts')
  expect(fallbackBody({ ...FACTS, task: undefined, commits: [], promptCount: 5 })).toBe('- no commits\n- 5 prompts')
})

test('entryContent: heading, hub wikilink, note, body; no ai-generated tag', () => {
  const c = entryContent({ repo: 'clepsydra', branch: 'develop', hub: 'Clepsydra', note: 'wrapped up', body: '- did x' })
  expect(c).toBe('### Claude Code session — clepsydra@develop\n\nProject: [[Clepsydra]]\n\nNote: wrapped up\n\n- did x')
  expect(c).not.toContain('ai-generated')
  expect(entryContent({ repo: 'r', branch: 'b', body: '- y' })).toBe('### Claude Code session — r@b\n\n- y')
})

describe('pending queue', () => {
  test('asPending keeps well-formed entries only', () => {
    expect(asPending([{ id: 'a', createdAt: 1, digest: 'd', fallback: 'f', repo: 'r', branch: 'b' }, { id: 1 }, 'x'])).toEqual([
      { id: 'a', createdAt: 1, digest: 'd', fallback: 'f', repo: 'r', branch: 'b' },
    ])
    expect(asPending(undefined)).toEqual([])
  })
  test('pushPending caps at 10, dropping the oldest', () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, createdAt: i, digest: '', fallback: '', repo: 'r', branch: 'b' }))
    const next = pushPending(list, { id: 'new', createdAt: 99, digest: '', fallback: '', repo: 'r', branch: 'b' })
    expect(next.length).toBe(10)
    expect(next[0]?.id).toBe('e1')
    expect(next[9]?.id).toBe('new')
  })
})

test('entryContent dates the heading with the session time, so a late-posted entry keeps its own day', () => {
  const noonUtc = Date.UTC(2026, 9, 4, 12, 0)
  const c = entryContent({ repo: 'r', branch: 'b', body: '- y', at: noonUtc })
  expect(c.split('\n')[0]).toMatch(/^### Claude Code session — r@b · 2026-10-04 \d\d:\d\d$/)
})
