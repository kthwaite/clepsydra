type ToolName = `mcp__${string}__${string}`

// Plugin install first, then a repo-level `.mcp.json` entry. No other server counts.
const SERVERS = ['plugin_clepsydra_clepsydra', 'clepsydra'] as const

/** The full name of the clepsydra vault tool `suffix`, or `undefined` when no clepsydra server offers it. */
export function resolveVaultTool(names: readonly string[], suffix: string): ToolName | undefined {
  for (const server of SERVERS) {
    const wanted: ToolName = `mcp__${server}__${suffix}`
    if (names.includes(wanted)) return wanted
  }
  return undefined
}
