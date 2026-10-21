import { describe, expect, test } from 'claude-code/testing'

import { bashSucceeded, deliveryAppend, deliveryLine, localDate, mergeTask, parseMerge } from './merge'
import type { BoardTask } from './tasks'

const task = (code: string, status: string): BoardTask => ({
  code,
  title: code,
  status,
  priority: null,
  project: 'clepsydra',
  path: `tasks/clepsydra/${code}.md`,
  checks: [0, 0],
  updatedAt: '',
})

describe('parseMerge', () => {
  test('plain merge', () => {
    expect(parseMerge('git merge --no-ff feature/TSK-brave-finch-7q3zd')).toEqual({ branch: 'feature/TSK-brave-finch-7q3zd' })
  })

  test('cd prefix', () => {
    expect(parseMerge('cd /repo && git merge x')).toEqual({ dir: '/repo', branch: 'x' })
  })

  test('-C', () => {
    expect(parseMerge('git -C /repo merge --no-ff -m "m" x')).toEqual({ dir: '/repo', branch: 'x' })
  })

  test('excluded', () => {
    for (const c of ['git merge --abort', 'git merge --squash x', 'git merge --no-commit x', 'git pull', 'git merge']) {
      expect(parseMerge(c)).toBeUndefined()
    }
    for (const c of ['git merge --continue', 'git merge --quit', 'git pull --no-rebase origin develop']) {
      expect(parseMerge(c)).toBeUndefined()
    }
  })

  test('options with a value do not count as the branch', () => {
    expect(parseMerge("git merge -m 'Merge it' --strategy ort -X theirs x")).toEqual({ branch: 'x' })
    expect(parseMerge('git merge --message="a b" --no-edit x')).toEqual({ branch: 'x' })
    expect(parseMerge('git merge -- x')).toEqual({ branch: 'x' })
  })

  test('a chain of && keeps the merge; a later cd does not move it', () => {
    expect(parseMerge('git checkout develop && git merge --no-ff x && git branch -d x')).toEqual({ branch: 'x' })
    expect(parseMerge('cd /a && cd b && git merge x && cd /c')).toEqual({ dir: '/a/b', branch: 'x' })
    expect(parseMerge('cd /repo && git -C sub merge x')).toEqual({ dir: '/repo/sub', branch: 'x' })
  })

  test('env prefix, global options and redirects', () => {
    expect(parseMerge('GIT_EDITOR=true git -c core.editor=true --no-pager merge x 2>&1')).toEqual({ branch: 'x' })
    expect(parseMerge('git merge x >/dev/null 2> err.log')).toEqual({ branch: 'x' })
  })

  test('an exit status that may not be the merge’s is refused', () => {
    for (const c of [
      'git merge x | tail -5',
      'git merge x; echo done',
      'git merge x || true',
      'git merge x &',
      'git merge x\necho done',
      '(cd /repo && git merge x)',
    ]) {
      expect(parseMerge(c)).toBeUndefined()
    }
  })

  test('two branches, two merges, or an unknown cd are refused', () => {
    for (const c of ['git merge a b', 'git merge a && git merge b', 'cd - && git merge x', 'cd && git merge x', "git merge 'x"]) {
      expect(parseMerge(c)).toBeUndefined()
    }
  })

  test('a quoted operator is part of a word', () => {
    expect(parseMerge('git merge -m "a; b | c && d" x')).toEqual({ branch: 'x' })
  })
})

describe('bashSucceeded', () => {
  const ok = { stdout: '', stderr: '', interrupted: false }
  test('answered, not an error, not interrupted, not backgrounded', () => {
    expect(bashSucceeded({ result: ok })).toBe(true)
    expect(bashSucceeded({ result: ok, isError: true })).toBe(false)
    expect(bashSucceeded({ deny: 'no' })).toBe(false)
    expect(bashSucceeded({ result: { ...ok, interrupted: true } })).toBe(false)
    expect(bashSucceeded({ result: { ...ok, backgroundTaskId: 'b1' } })).toBe(false)
    expect(bashSucceeded({ result: 'not a record' })).toBe(false)
  })
})

describe('mergeTask', () => {
  const tasks = [task('TSK-a-b-1', 'FIELD'), task('TSK-c-d-2', 'FIELD'), task('TSK-e-f-3', 'REVIEW'), task('TSK-g-h-4', 'SEALED')]

  test('mergeTask bound wins', () => {
    expect(mergeTask({ bound: 'TSK-a-b-1', mergedBranch: 'feature/TSK-c-d-2', tasks })?.code).toBe('TSK-a-b-1')
  })

  test('mergeTask from branch', () => {
    expect(mergeTask({ mergedBranch: 'feature/TSK-c-d-2-thing', tasks })?.code).toBe('TSK-c-d-2')
    expect(mergeTask({ mergedBranch: 'feature/tsk-C-D-2', tasks })?.code).toBe('TSK-c-d-2')
  })

  test('mergeTask skips review/sealed', () => {
    expect(mergeTask({ mergedBranch: 'feature/TSK-e-f-3', tasks })).toBeUndefined()
    expect(mergeTask({ mergedBranch: 'feature/TSK-g-h-4', tasks })).toBeUndefined()
  })

  test('not on the board, or no code', () => {
    expect(mergeTask({ mergedBranch: 'feature/TSK-z-z-9', tasks })).toBeUndefined()
    expect(mergeTask({ mergedBranch: 'feature/plain', tasks })).toBeUndefined()
  })
})

describe('delivery', () => {
  test('deliveryLine', () => {
    expect(deliveryLine('a1b2c3d', 'develop', '2026-10-21')).toBe('- merged a1b2c3d into develop (2026-10-21)')
  })

  test('deliveryAppend existing heading', () => {
    expect(deliveryAppend('# T\n\n## Delivery\n\n- merged 1 into develop (2026-10-01)\n', '- l')).toEqual({ heading: 'Delivery', content: '- l' })
    expect(deliveryAppend('# T\n## delivery  \n', '- l')).toEqual({ heading: 'Delivery', content: '- l' })
  })

  test('deliveryAppend missing heading', () => {
    expect(deliveryAppend('# T\n\nBody.\n', '- l')).toEqual({ content: '\n## Delivery\n\n- l\n' })
    expect(deliveryAppend('### Delivery notes\n', '- l')).toEqual({ content: '\n## Delivery\n\n- l\n' })
  })

  test('a heading inside a code fence does not count', () => {
    expect(deliveryAppend('```md\n## Delivery\n```\n', '- l')).toEqual({ content: '\n## Delivery\n\n- l\n' })
  })

  test('localDate', () => {
    expect(localDate(new Date(2026, 9, 1, 12).getTime())).toBe('2026-10-01')
  })
})
