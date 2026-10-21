// Project resolution: which clepsydra project slug this repo belongs to.

/** `"dir=slug,dir=slug"` → `{ dir: slug }`, keys lowercased; malformed pairs dropped. */
export function parseProjectMap(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of text.split(',')) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const dir = pair.slice(0, at).trim().toLowerCase()
    const slug = pair.slice(at + 1).trim()
    if (dir !== '' && slug !== '') out[dir] = slug
  }
  return out
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

/** The main checkout from `git rev-parse --path-format=absolute --git-common-dir`. */
export function mainCheckoutOf(commonDir: string): string | undefined {
  const dir = commonDir.trim().replace(/\/+$/, '')
  return dir.endsWith('/.git') ? dir.slice(0, -'/.git'.length) : undefined
}

export type ProjectFacts = {
  /** The repo's (worktree's own) top-level basename. */
  repoBase: string
  /** The main checkout's basename (same as repoBase outside a linked worktree). */
  mainBase: string
  map: Record<string, string>
  /** `operations[].project` from the board. */
  projects: readonly (string | null)[]
}

/** projectMap first (repo, then main checkout), then a board project named like either. */
export function resolveProject(f: ProjectFacts): string | undefined {
  const names = [f.repoBase, f.mainBase].map(n => n.toLowerCase()).filter(n => n !== '')
  for (const n of names) {
    const hit = f.map[n]
    if (hit !== undefined) return hit
  }
  for (const n of names) {
    const hit = f.projects.find(p => p !== null && p.toLowerCase() === n)
    if (hit !== undefined && hit !== null) return hit
  }
  return undefined
}
