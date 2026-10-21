import { describe, expect, test } from 'claude-code/testing'

import { basename, mainCheckoutOf, parseProjectMap, resolveProject } from './project'

describe('parseProjectMap', () => {
  test('dir=slug pairs, trimmed, keys lowercased', () => {
    expect(parseProjectMap(' Clepsydra=clepsydra , viii = xxii,bad,=x,y=')).toEqual({ clepsydra: 'clepsydra', viii: 'xxii' })
  })
  test('empty string is an empty map', () => {
    expect(parseProjectMap('')).toEqual({})
  })
})

describe('basename / mainCheckoutOf', () => {
  test('basename strips trailing slashes', () => {
    expect(basename('/a/b/clepsydra/')).toBe('clepsydra')
    expect(basename('')).toBe('')
  })
  test('main checkout from an absolute git common dir', () => {
    expect(mainCheckoutOf('/w/clepsydra/.git')).toBe('/w/clepsydra')
    expect(mainCheckoutOf('/w/clepsydra/.git/')).toBe('/w/clepsydra')
    expect(mainCheckoutOf('/w/bare.git')).toBeUndefined()
  })
})

describe('resolveProject', () => {
  const projects = ['clepsydra', 'falls', null, 'xxii']
  test('projectMap wins, on repo basename', () => {
    expect(resolveProject({ repoBase: 'client', mainBase: 'client', map: { client: 'xxii' }, projects })).toBe('xxii')
  })
  test('projectMap matches the main checkout basename for a worktree', () => {
    expect(resolveProject({ repoBase: 'feat-x', mainBase: 'viii', map: { viii: 'xxii' }, projects })).toBe('xxii')
  })
  test('falls back to an operations project equal to the basename, case-insensitive', () => {
    expect(resolveProject({ repoBase: 'Clepsydra', mainBase: 'Clepsydra', map: {}, projects })).toBe('clepsydra')
    expect(resolveProject({ repoBase: 'task-x', mainBase: 'falls', map: {}, projects })).toBe('falls')
  })
  test('none when nothing matches', () => {
    expect(resolveProject({ repoBase: 'logseq', mainBase: 'logseq', map: {}, projects })).toBeUndefined()
  })
})
