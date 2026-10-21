import { describe, expect, test } from 'claude-code/testing'

import { resolveVaultTool } from './tools'

describe('resolveVaultTool', () => {
  test('prefers the plugin server', () => {
    const names = ['mcp__clepsydra__vault_task_update', 'mcp__plugin_clepsydra_clepsydra__vault_task_update']
    expect(resolveVaultTool(names, 'vault_task_update')).toBe('mcp__plugin_clepsydra_clepsydra__vault_task_update')
  })
  test('falls back to the repo server', () => {
    expect(resolveVaultTool(['mcp__clepsydra__vault_task_update'], 'vault_task_update')).toBe('mcp__clepsydra__vault_task_update')
  })
  test('ignores other servers', () => {
    expect(resolveVaultTool(['mcp__other__vault_task_update'], 'vault_task_update')).toBeUndefined()
  })
  test('exact suffix', () => {
    expect(resolveVaultTool(['mcp__clepsydra__vault_task_update_extra'], 'vault_task_update')).toBeUndefined()
  })
})
