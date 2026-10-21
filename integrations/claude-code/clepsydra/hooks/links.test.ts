import { describe, expect, test } from 'claude-code/testing'

import { attachToast, extractWikilinks, formatAttachment, pageFromJson, pickExact, truncatePage } from './links'

describe('extractWikilinks', () => {
  test('plain, alias and heading forms give the target', () => {
    expect(extractWikilinks('see [[Clepsydra]], [[Moon Detail|the moon]] and [[Bases#Slices]]')).toEqual([
      'Clepsydra',
      'Moon Detail',
      'Bases',
    ])
  })
  test('ignores inline code and fenced blocks', () => {
    const text = 'use `[[Not This]]` but [[This]]\n```\n[[Nor This]]\n```\n~~~md\n[[Or This]]\n~~~\nand [[That]]'
    expect(extractWikilinks(text)).toEqual(['This', 'That'])
  })
  test('distinct case-insensitively, first spelling kept, at most 4', () => {
    expect(extractWikilinks('[[a]] [[A]] [[b]] [[c]] [[d]] [[e]]')).toEqual(['a', 'b', 'c', 'd'])
  })
  test('empty and block-ref-only targets skipped', () => {
    expect(extractWikilinks('[[ ]] [[#Heading]] [[|x]]')).toEqual([])
  })
})

describe('pickExact', () => {
  const results = [
    { path: 'notes/clepsydra-local.md', title: 'Clepsydra Local Deployment' },
    { path: 'projects/clepsydra/hub.md', title: 'Clepsydra' },
  ]
  test('exact title, case-insensitive', () => {
    expect(pickExact('clepsydra', results)).toEqual(results[1])
  })
  test('no exact title is no pick', () => {
    expect(pickExact('Clepsydra Local', results)).toBeUndefined()
  })
})

describe('truncatePage', () => {
  test('short body untouched', () => {
    expect(truncatePage('abc', 100)).toEqual({ text: 'abc', isTruncated: false })
  })
  test('cuts at the last heading inside the cap when it is past half', () => {
    const body = `${'a'.repeat(60)}\n## Two\n${'b'.repeat(60)}`
    const r = truncatePage(body, 100)
    expect(r.isTruncated).toBe(true)
    expect(r.text).toBe('a'.repeat(60))
  })
  test('else at the last newline, else hard', () => {
    expect(truncatePage(`${'a'.repeat(70)}\n${'b'.repeat(60)}`, 100).text).toBe('a'.repeat(70))
    expect(truncatePage('x'.repeat(150), 100).text).toBe('x'.repeat(100))
  })
})

test('pageFromJson reads title, path and body', () => {
  expect(pageFromJson({ path: 'p.md', meta: { title: 'T' }, body: 'B' })).toEqual({ path: 'p.md', title: 'T', body: 'B' })
  expect(pageFromJson({ path: 'p.md' })).toBeUndefined()
})

test('formatAttachment frames the page for the model', () => {
  expect(formatAttachment('Clepsydra', 'projects/c.md', 'body', false)).toBe('Vault page [[Clepsydra]] (projects/c.md):\nbody')
  expect(formatAttachment('C', 'c.md', 'body', true)).toBe('Vault page [[C]] (c.md):\nbody\n\n[truncated at ~8 KB; read the rest with vault_get_page]')
})

test('attachToast: one line for both lists, undefined for none', () => {
  expect(attachToast(['A', 'B'], ['C'])).toBe('attached [[A]], [[B]] · unresolved: [[C]]')
  expect(attachToast([], ['C'])).toBe('unresolved: [[C]]')
  expect(attachToast(['A'], [])).toBe('attached [[A]]')
  expect(attachToast([], [])).toBeUndefined()
})
