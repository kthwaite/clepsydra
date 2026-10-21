// Session journal: triviality, the bounded digest, the drafting prompt, the
// deterministic fallback, the entry text and the pending queue.

export type DigestFacts = {
  repo: string
  branch: string
  task?: { code: string; title?: string; status?: string }
  /** The person's own prompts this session, oldest first. */
  prompts: readonly string[]
  promptCount: number
  /** `git log --oneline` lines since the session started, newest first. */
  commits: readonly string[]
  /** `git diff --stat`'s summary line, '' when none. */
  diffStat: string
  finalMessage: string
}

export type PendingJournal = {
  id: string
  createdAt: number
  digest: string
  fallback: string
  repo: string
  branch: string
  hub?: string
  note?: string
}

export const PENDING_CAP = 10
const PROMPT_CHARS = 200
const PROMPTS_KEPT = 30
const COMMITS_KEPT = 30
const FINAL_CHARS = 1500

export function isTrivial(f: { promptCount: number; commitCount: number; hasTask: boolean }): boolean {
  return f.promptCount < 3 && f.commitCount === 0 && !f.hasTask
}

export function journalsOnEnd(reason: string): boolean {
  return reason !== 'resume'
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function taskLine(t: NonNullable<DigestFacts['task']>): string {
  const title = t.title === undefined ? '' : ` — ${t.title}`
  return `${t.code}${title}`
}

export function buildDigest(f: DigestFacts): string {
  const lines = [`repo: ${f.repo} @ ${f.branch}`]
  if (f.task !== undefined) lines.push(`task: ${taskLine(f.task)}${f.task.status === undefined ? '' : ` (${f.task.status})`}`)
  lines.push(`person prompts (${f.promptCount}):`)
  for (const p of f.prompts.slice(-PROMPTS_KEPT)) lines.push(`- ${cut(p.replace(/\s+/g, ' ').trim(), PROMPT_CHARS)}`)
  const commits = f.commits.slice(0, COMMITS_KEPT)
  lines.push(`commits (${commits.length}):`)
  for (const c of commits) lines.push(`- ${c}`)
  if (f.diffStat.trim() !== '') lines.push(`uncommitted: ${f.diffStat.trim()}`)
  if (f.finalMessage.trim() !== '') lines.push('final assistant message:', cut(f.finalMessage.trim(), FINAL_CHARS))
  return `${lines.join('\n')}\n`
}

export function journalPrompt(digest: string): string {
  return [
    'Write a work-log entry for this Claude Code session as 3-6 terse markdown bullets:',
    'what was done, decisions made, open threads / next step.',
    'Mention TSK codes and commit shas only if they appear in the digest below; invent nothing.',
    'Reply with the bullets only, no heading, no preamble.',
    '',
    '<digest>',
    digest.trim(),
    '</digest>',
  ].join('\n')
}

export function fallbackBody(f: Pick<DigestFacts, 'task' | 'commits' | 'promptCount'>): string {
  const lines: string[] = []
  if (f.task !== undefined) lines.push(`- task: ${taskLine(f.task)}`)
  if (f.commits.length === 0) lines.push('- no commits')
  else {
    const shas = f.commits.slice(0, 10).map(c => c.split(' ')[0] ?? c)
    lines.push(`- ${f.commits.length} commit${f.commits.length === 1 ? '' : 's'}: ${shas.join(', ')}`)
  }
  lines.push(`- ${f.promptCount} prompt${f.promptCount === 1 ? '' : 's'}`)
  return lines.join('\n')
}

const two = (n: number): string => String(n).padStart(2, '0')

/** Local `YYYY-MM-DD HH:MM` for a clock reading. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function entryContent(e: {
  repo: string
  branch: string
  hub?: string
  note?: string
  body: string
  /** When the session ended; entries posted later still carry their own day. */
  at?: number
}): string {
  const when = e.at === undefined ? '' : ` · ${stamp(e.at)}`
  const parts = [`### Claude Code session — ${e.repo}@${e.branch}${when}`]
  if (e.hub !== undefined) parts.push(`Project: [[${e.hub}]]`)
  if (e.note !== undefined && e.note.trim() !== '') parts.push(`Note: ${e.note.trim()}`)
  parts.push(e.body.trim())
  return parts.join('\n\n')
}

export function asPending(v: unknown): PendingJournal[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (x): x is PendingJournal =>
      typeof x === 'object' &&
      x !== null &&
      typeof x.id === 'string' &&
      typeof x.createdAt === 'number' &&
      typeof x.digest === 'string' &&
      typeof x.fallback === 'string' &&
      typeof x.repo === 'string' &&
      typeof x.branch === 'string',
  )
}

export function pushPending(list: readonly PendingJournal[], entry: PendingJournal): PendingJournal[] {
  return [...list, entry].slice(-PENDING_CAP)
}
