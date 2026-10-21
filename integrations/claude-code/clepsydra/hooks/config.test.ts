import { describe, expect, test } from 'claude-code/testing'

import { apiBaseOf, DEFAULT_API_BASE } from './config'

describe('apiBaseOf', () => {
  test('blank is the default, not rejected', () => {
    expect(apiBaseOf('')).toEqual({ base: DEFAULT_API_BASE })
    expect(apiBaseOf('   ')).toEqual({ base: DEFAULT_API_BASE })
  })
  test('an https URL is kept, trailing slashes trimmed', () => {
    expect(apiBaseOf(' https://vault.example/api/vault// ')).toEqual({ base: 'https://vault.example/api/vault' })
  })
  test('an http URL is kept', () => {
    expect(apiBaseOf('http://127.0.0.1:8080/api/vault')).toEqual({ base: 'http://127.0.0.1:8080/api/vault' })
  })
  test('a vault folder path is rejected for the default', () => {
    expect(apiBaseOf('~/Documents/vault')).toEqual({ base: DEFAULT_API_BASE, rejected: '~/Documents/vault' })
    expect(apiBaseOf('/Users/kit/vault')).toEqual({ base: DEFAULT_API_BASE, rejected: '/Users/kit/vault' })
  })
  test('a non-http scheme is rejected', () => {
    expect(apiBaseOf('file:///Users/kit/vault')).toEqual({ base: DEFAULT_API_BASE, rejected: 'file:///Users/kit/vault' })
    expect(apiBaseOf('clepsydra.localhost/api/vault')).toEqual({ base: DEFAULT_API_BASE, rejected: 'clepsydra.localhost/api/vault' })
  })
})
