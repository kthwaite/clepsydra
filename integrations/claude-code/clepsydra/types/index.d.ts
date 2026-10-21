/** One board task as the mod keeps it (GET /board `tasks[]`, reduced). */
export type ClepsydraTask = {
  code: string
  title: string
  status: string
  priority: string | null
  project: string | null
  path: string
  checks: [number, number]
  updatedAt: string
}

/** The repo checkout the session runs in. */
export type ClepsydraRepo = {
  /** The worktree's own top level. */
  top: string
  branch: string
  repoBase: string
  /** The main checkout's basename (repoBase outside a linked worktree). */
  mainBase: string
}

/** The active task: explicit (`/task`, a board press; persisted per repo+branch) or from the branch name. */
export type ClepsydraBinding = { code: string; source: 'explicit' | 'branch' }

declare module 'claude-code' {
  interface PluginState {
    clepsydra: {
      repo: ClepsydraRepo | null
      /** Resolved project slug; null when none matched. */
      project: string | null
      /** Board tasks (all projects); null before the first answer. */
      board: ClepsydraTask[] | null
      /** project slug → hub page name. */
      hubs: Record<string, string>
      /** Why the last board read failed; null after a good one. */
      boardError: string | null
      binding: ClepsydraBinding | null
      /** The bound task's page body (for the system-prompt section). */
      activeBody: { code: string; body: string } | null
      isPaneOpen: boolean
      /** `/board all`: SEALED shown too. */
      showAll: boolean
      /** The person's own prompts this session (cut to 200 chars, last 30). */
      prompts: string[]
      promptCount: number
      /** Tool names `$.tool.list` returned this session; null until listed. */
      toolNames: string[] | null
    }
  }
}
