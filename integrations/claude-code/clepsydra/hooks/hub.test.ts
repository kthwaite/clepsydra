import { describe, expect, test } from 'claude-code/testing'

import { hubSections, hubSettings, pickHub } from './hub'

describe('hubSections', () => {
  test('keeps only Status and Threads', () => {
    const body = '# Hub\n\n## Status\nGreen.\n\n## Notes\nSecret notes.\n\n## Threads\n- one\n'
    const out = hubSections(body, ['Status', 'Threads'], 2000)
    expect(out).toBe('## Status\nGreen.\n\n## Threads\n- one')
    expect(out).not.toContain('Notes')
  })

  test('caps at 2000 chars', () => {
    const out = hubSections(`## Status\n${'x'.repeat(5000)}`, ['Status', 'Threads'], 2000)
    expect(out?.length).toBeLessThanOrEqual(2000)
    expect(out?.endsWith('…')).toBe(true)
  })

  test('undefined without sections', () => {
    expect(hubSections('## Notes\nhi', ['Status', 'Threads'], 2000)).toBeUndefined()
  })

  test('heading match ignores case and trailing spaces', () => {
    expect(hubSections('## status  \nok', ['Status'], 2000)).toBe('## status\nok')
  })

  test('a ### subheading stays inside its section; a # heading ends it', () => {
    const out = hubSections('## Status\n### Detail\nmore\n# Next\nafter', ['Status'], 2000)
    expect(out).toBe('## Status\n### Detail\nmore')
  })

  test('a heading inside a code fence does not end a section', () => {
    const out = hubSections('## Status\n```\n## Notes\n```\nend', ['Status'], 2000)
    expect(out).toContain('end')
  })
})

describe('hubSettings', () => {
  test('reads the two string keys', () => {
    expect(hubSettings({ integration_branch: 'develop', triage_index: '[[X]]', other: 1 })).toEqual({
      integrationBranch: 'develop',
      triageIndex: '[[X]]',
    })
  })

  test('ignores non-strings', () => {
    expect(hubSettings({ integration_branch: 3 })).toEqual({})
  })
})

describe('pickHub', () => {
  test('prefers board true', () => {
    const rows = [
      { project: 'clepsydra', path: 'a.md', board: false },
      { project: 'clepsydra', path: 'b.md', board: true },
    ]
    expect(pickHub(rows, 'clepsydra')?.path).toBe('b.md')
  })

  test('first when none is board true', () => {
    const rows = [
      { project: 'x', path: 'a.md', board: false },
      { project: 'x', path: 'b.md', board: false },
    ]
    expect(pickHub(rows, 'x')?.path).toBe('a.md')
  })

  test('none', () => {
    expect(pickHub([{ project: 'x', path: 'a.md', board: true }], 'y')).toBeUndefined()
  })
})
