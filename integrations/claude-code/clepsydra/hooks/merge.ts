// A completed `git merge` in a Bash command: which branch, in which directory,
// which board task it delivers, and the Delivery line for the task page.

import { branchTaskCode, type BoardTask } from './tasks'

export type MergeCall = { dir?: string; branch: string }

type Token = { op: '&&' } | { word: string }

/**
 * Shell words split on `&&`. Undefined when the exit status may not be the
 * last `&&` command's own (`|`, `;`, `||`, `&`, a newline, a subshell, a
 * heredoc) or a quote is left open. Redirections are dropped with their target.
 */
function tokenize(cmd: string): Token[] | undefined {
  const out: Token[] = []
  let word = ''
  let hasWord = false
  let dropNext = false
  const push = () => {
    if (hasWord) {
      if (dropNext) dropNext = false
      else out.push({ word })
    }
    word = ''
    hasWord = false
  }
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i] as string
    const n = cmd[i + 1]
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1)
      if (end < 0) return undefined
      word += cmd.slice(i + 1, end)
      hasWord = true
      i = end + 1
    } else if (c === '"') {
      i += 1
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length) i += 1
        word += cmd[i]
        i += 1
      }
      if (i >= cmd.length) return undefined
      hasWord = true
      i += 1
    } else if (c === '\\') {
      if (n !== '\n' && n !== undefined) {
        word += n
        hasWord = true
      }
      i += 2
    } else if (c === ' ' || c === '\t') {
      push()
      i += 1
    } else if (c === '#' && !hasWord) {
      break
    } else if (c === '&' && n === '&') {
      push()
      out.push({ op: '&&' })
      i += 2
    } else if (c === '>' || c === '<' || (c === '&' && n === '>')) {
      if (c === '<' && n === '<') return undefined
      // `2>`: the fd digits are not a word.
      if (/^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else push()
      i += c === '&' ? 2 : 1
      if (cmd[i] === '>' || cmd[i] === '|') i += 1
      if (cmd[i] === '&') {
        i += 1
        while (i < cmd.length && /[\d-]/.test(cmd[i] as string)) i += 1
      } else dropNext = true
    } else if (c === '|' || c === ';' || c === '&' || c === '\n' || c === '\r' || c === '(' || c === ')' || c === '`') {
      return undefined
    } else {
      word += c
      hasWord = true
      i += 1
    }
  }
  push()
  return dropNext ? undefined : out
}

const joinDir = (base: string | undefined, next: string) =>
  base === undefined || next.startsWith('/') ? next : `${base.replace(/\/+$/, '')}/${next}`

/** `git merge` options that take the next word as their value. */
const VALUE_OPTS = new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup'])
/** Merges that do not complete one: control verbs, and merges that leave no merge commit. */
const NOT_A_MERGE = new Set(['--abort', '--continue', '--quit', '--squash', '--no-commit'])

type GitCommand = { sub?: string; dir?: string; args: string[]; isElsewhere: boolean }

/**
 * One `&&` command's words as `git [-C dir | -c kv | --flag]… <sub> <args>`.
 * `isElsewhere`: `--git-dir`/`--work-tree` point git away from the dir.
 */
function gitCommand(words: readonly string[]): GitCommand {
  let i = 1
  let dir: string | undefined
  let isElsewhere = false
  while (i < words.length && (words[i] as string).startsWith('-')) {
    const w = words[i] as string
    if (w.startsWith('--git-dir') || w.startsWith('--work-tree')) isElsewhere = true
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree') {
      const v = words[i + 1]
      if (v === undefined) return { args: [], isElsewhere }
      if (w === '-C') dir = joinDir(dir, v)
      i += 2
    } else i += 1
  }
  const sub = words[i]
  return { ...(sub === undefined ? {} : { sub }), ...(dir === undefined ? {} : { dir }), args: words.slice(i + 1), isElsewhere }
}

/** The one branch a completing `git merge`'s args name; undefined for anything else. */
function mergedBranch(args: readonly string[]): string | undefined {
  const branches: string[] = []
  for (let j = 0; j < args.length; j += 1) {
    const w = args[j] as string
    if (w === '--') {
      branches.push(...args.slice(j + 1))
      break
    }
    if (NOT_A_MERGE.has(w)) return undefined
    if (VALUE_OPTS.has(w)) j += 1
    else if (!w.startsWith('-')) branches.push(w)
  }
  return branches.length === 1 ? branches[0] : undefined
}

/** Commands that move HEAD after the merge; the mod reads HEAD after the whole command. */
const MOVES_HEAD = new Set(['checkout', 'switch'])

/**
 * The completed merge a Bash command runs: `git merge <opts> <branch>`, after
 * `cd <dir> &&` or as `git -C <dir> merge …`, inside an `&&` chain. Undefined
 * for control verbs, `--squash`, `--no-commit`, `git pull`, no or several
 * branches, several merges, a `checkout`/`switch` after the merge,
 * `--git-dir`/`--work-tree`, and any command whose exit status may not be the
 * merge's.
 */
export function parseMerge(command: string): MergeCall | undefined {
  const tokens = tokenize(command)
  if (tokens === undefined) return undefined
  const segments: string[][] = [[]]
  for (const t of tokens) {
    if ('op' in t) segments.push([])
    else segments[segments.length - 1]?.push(t.word)
  }
  let cwd: string | undefined
  let found: MergeCall | undefined
  for (const seg of segments) {
    // `GIT_EDITOR=true git merge …`: assignments lead the command.
    const at = seg.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    if (at < 0) continue
    const words = seg.slice(at)
    const head = words[0]
    if (head === 'cd' || head === 'pushd' || head === 'popd') {
      if (found !== undefined) continue
      const to = words[1]
      if (head === 'popd' || words.length !== 2 || to === undefined || to === '-') return undefined
      cwd = joinDir(cwd, to)
      continue
    }
    if (head !== 'git') continue
    const g = gitCommand(words)
    if (found !== undefined && g.sub !== undefined && MOVES_HEAD.has(g.sub)) return undefined
    if (g.sub !== 'merge') continue
    const branch = mergedBranch(g.args)
    if (branch === undefined || g.isElsewhere || found !== undefined) return undefined
    const dir = g.dir === undefined ? cwd : joinDir(cwd, g.dir)
    found = { ...(dir === undefined ? {} : { dir }), branch }
  }
  return found
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A Bash `tool.call` result that ran to the end with exit 0. The host exposes
 * no exit code: a non-zero exit, an interrupt or a throw sets `isError`; a
 * deny means it never ran; a background run has not finished yet.
 */
export function bashSucceeded(r: { deny?: string; isError?: boolean; result?: unknown }): boolean {
  if (r.deny !== undefined || r.isError === true || !isRecord(r.result)) return false
  return r.result.interrupted !== true && r.result.backgroundTaskId === undefined
}

/** git's "Already up to date." (older: "Already up-to-date."): the merge made no commit. */
export function isAlreadyUpToDate(r: { result?: unknown }): boolean {
  return isRecord(r.result) && typeof r.result.stdout === 'string' && /Already up[ -]to[ -]date/i.test(r.result.stdout)
}

/** HEAD-like refs and `@{…}` (upstream, reflog): never a feature branch. */
const NOT_A_BRANCH = /^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)([~^].*)?$|@\{/

/**
 * The TSK code a merge of `mergedBranch` delivers: the branch's own code, else
 * `bound`. The caller passes `bound` only for a binding made on the merged
 * branch (R-T). None for a HEAD-like ref, nor for the integration branch
 * itself or `<remote>/<integration>` (bringing the integration branch in
 * delivers nothing).
 */
export function mergeCode(input: { bound?: string; mergedBranch: string; integrationBranch?: string }): string | undefined {
  const ref = input.mergedBranch.replace(/^refs\/(heads|remotes)\//, '')
  if (NOT_A_BRANCH.test(ref)) return undefined
  const integ = input.integrationBranch
  if (integ !== undefined) {
    const isRemote = ref.endsWith(`/${integ}`) && ref.split('/').length === integ.split('/').length + 1
    if (ref === integ || isRemote) return undefined
  }
  return branchTaskCode(ref) ?? input.bound
}

const DONE = new Set(['REVIEW', 'SEALED'])

/** The board task `mergeCode` names; undefined when it is not on the board or is already REVIEW or SEALED. */
export function mergeTask(input: {
  bound?: string
  mergedBranch: string
  integrationBranch?: string
  tasks: readonly BoardTask[]
}): BoardTask | undefined {
  const code = mergeCode(input)
  if (code === undefined) return undefined
  const t = input.tasks.find(x => x.code.toLowerCase() === code.toLowerCase())
  return t === undefined || DONE.has(t.status) ? undefined : t
}

export function deliveryLine(sha: string, branch: string, date: string): string {
  return `- merged ${sha} into ${branch} (${date})`
}

/** `YYYY-MM-DD` of `ms` in local time. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `vault_append_page` arguments for the line under an existing `Delivery` heading (tried first). */
export function deliveryUnderHeading(line: string): { heading: 'Delivery'; content: string } {
  return { heading: 'Delivery', content: line }
}

/** `vault_append_page` arguments for a new `## Delivery` section at the end (when the page has none). */
export function deliverySection(line: string): { content: string } {
  return { content: `\n## Delivery\n\n${line}\n` }
}

/** The append tool's error for a page without a `Delivery` heading. */
export function isHeadingMissing(text: string): boolean {
  return /heading "Delivery" not found/i.test(text)
}
