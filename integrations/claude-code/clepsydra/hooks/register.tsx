import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, PromptOrigin, Register } from 'claude-code'

import type { ClepsydraBinding, ClepsydraRepo } from '../types'
import { activeTaskSection, boardRowText, groupLabel, HUB_CAP, hubSection, statusEntry, taskSummary } from './format'
import { conflictCount, doctorCounts, healthNotice, healthSegment, statusText, type Health } from './health'
import { hubSections, hubSettings, pickHub, type HubRow } from './hub'
import {
  asPending,
  buildDigest,
  entryContent,
  fallbackBody,
  isTrivial,
  journalPrompt,
  journalsOnEnd,
  pushPending,
  type PendingJournal,
} from './journal'
import { attachToast, extractWikilinks, formatAttachment, pageFromJson, pickExact, searchHits, truncatePage } from './links'
import { bashSucceeded, deliveryAppend, deliveryLine, isAlreadyUpToDate, localDate, mergeCode, mergeTask, parseMerge, type MergeCall } from './merge'
import { basename, mainCheckoutOf, parseProjectMap, resolveProject } from './project'
import { resolveVaultTool } from './tools'
import { bindingKey, branchTaskCode, groupTasks, parseBoard, resolveTaskRef, shortCode, type BoardTask } from './tasks'

type $ = EngineInterface

const PANE = 'clepsydra-board'
const POLL_MS = 30_000
const HEALTH_MS = 60_000
const HTTP_TIMEOUT_MS = 6000
const GROUP_ROWS = 25
const PENDING = 'pendingJournal'
const PROMPT_CHARS = 200
const PROMPTS_KEPT = 30

const repoRef = atom({ plugin: 'clepsydra', key: 'repo' } as const, null)
const projectRef = atom({ plugin: 'clepsydra', key: 'project' } as const, null)
const boardRef = atom({ plugin: 'clepsydra', key: 'board' } as const, null)
const hubsRef = atom({ plugin: 'clepsydra', key: 'hubs' } as const, {})
const boardErrorRef = atom({ plugin: 'clepsydra', key: 'boardError' } as const, null)
const hubRef = atom({ plugin: 'clepsydra', key: 'hub' } as const, null)
const healthRef = atom({ plugin: 'clepsydra', key: 'health' } as const, { reachable: true, conflicts: 0 })
const bindingRef = atom({ plugin: 'clepsydra', key: 'binding' } as const, null)
const bodyRef = atom({ plugin: 'clepsydra', key: 'activeBody' } as const, null)
const paneOpenRef = atom({ plugin: 'clepsydra', key: 'isPaneOpen' } as const, false)
const showAllRef = atom({ plugin: 'clepsydra', key: 'showAll' } as const, false)
const promptsRef = atom({ plugin: 'clepsydra', key: 'prompts' } as const, [])
const toolNamesRef = atom({ plugin: 'clepsydra', key: 'toolNames' } as const, null)
const promptCountRef = atom({ plugin: 'clepsydra', key: 'promptCount' } as const, 0)

type Config = { apiBase: string; projectMap: Record<string, string>; journalModel: string }

const DEFAULTS: Config = {
  apiBase: 'https://clepsydra.localhost/api/vault',
  projectMap: {},
  journalModel: 'claude-haiku-5-5',
}

// Module variables on purpose: a reload re-reads options, drops the old timer
// and re-probes the transport.
let cfg: Config = DEFAULTS
let transport: 'http' | 'curl' = 'http'
let poll: { cancel: () => void } | undefined
// The health timer runs with the pane closed too; a reload replaces it.
let healthTimer: { cancel: () => void } | undefined
let isFlushing = false
// The last board answer's hub candidates; `loadHub` reads them.
let hubRows: HubRow[] = []

function readConfig(o: PluginOptions): Config {
  const s = (k: string, d: string) => {
    const v = o[k]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : d
  }
  return {
    apiBase: s('apiBase', DEFAULTS.apiBase).replace(/\/+$/, ''),
    projectMap: parseProjectMap(s('projectMap', '')),
    journalModel: s('journalModel', DEFAULTS.journalModel),
  }
}

// ---------- host helpers ----------

async function exec($: $, argv: string[], timeoutMs = 10_000) {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
  }
}

/** Resolves `p`, or `undefined` once `ms` pass on the clock (the timer outlives the dispatch). */
function withTimeout<T>($: $, p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const t = $.clock.after(ms, () => resolve(undefined))
    p.then(
      v => {
        t.cancel()
        resolve(v)
      },
      err => {
        t.cancel()
        reject(err)
      },
    )
  })
}

type Got = { ok: true; json: unknown } | { ok: false; error: string }

function parseJson(text: string): Got {
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch {
    return { ok: false, error: 'not JSON' }
  }
}

async function curlJson($: $, url: string): Promise<Got> {
  const r = await exec($, ['curl', '-sS', '--max-time', '5', '-H', 'Accept: application/json', '-w', '\n%{http_code}', url], 8000)
  if (r.exitCode !== 0) return { ok: false, error: `curl exit ${r.exitCode}: ${r.stderr.trim().slice(0, 120)}` }
  const at = r.stdout.lastIndexOf('\n')
  const code = Number(r.stdout.slice(at + 1).trim())
  if (!(code >= 200 && code < 300)) return { ok: false, error: `HTTP ${code}` }
  return parseJson(r.stdout.slice(0, at))
}

/**
 * Read-only GET against the vault API. `$.http.fetch` first; when it throws
 * (TLS against Caddy's local CA, a fetch policy) the module switches to curl,
 * which reads the macOS keychain. An HTTP error status is an answer, not a
 * transport failure.
 */
async function getJson($: $, path: string): Promise<Got> {
  const url = `${cfg.apiBase}${path}`
  if (transport === 'http') {
    try {
      const r = await withTimeout($, $.http.fetch(url, { headers: { Accept: 'application/json' } }), HTTP_TIMEOUT_MS)
      if (r === undefined) return { ok: false, error: 'timed out' }
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
      return parseJson(r.text)
    } catch {
      transport = 'curl'
    }
  }
  return curlJson($, url)
}

const pagePath = (path: string) => `/pages/${path.split('/').map(encodeURIComponent).join('/')}`

function isPersonOrigin(o: PromptOrigin | undefined): boolean {
  return o === undefined || o.kind === 'composer' || o.kind === 'bridge'
}

/**
 * The full name of vault tool `suffix`. Only a list that holds it is cached:
 * the MCP server may not have connected yet, so a miss re-lists next time.
 */
async function findVaultTool($: $, suffix: string) {
  const cached = await read($, toolNamesRef)
  const known = cached === null ? undefined : resolveVaultTool(cached, suffix)
  if (known !== undefined) return known
  const names = (await $.tool.list()).map(t => t.name)
  const found = resolveVaultTool(names, suffix)
  if (found !== undefined) await update($, toolNamesRef, () => names)
  return found
}

/** A clepsydra vault tool by suffix, called through `$.tool.call`, reduced to ok + text. */
async function callVault($: $, suffix: string, input: Record<string, unknown>, consent?: string) {
  try {
    const tool = await findVaultTool($, suffix)
    if (tool === undefined) return { ok: false, text: `clepsydra MCP tool ${suffix} not available` }
    const r = await $.tool.call({ tool, ...input, ...(consent === undefined ? {} : { consent }) })
    if (r.deny !== undefined) return { ok: false, text: r.deny }
    const text = r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''))
    return { ok: r.isError !== true, text }
  } catch (err) {
    return { ok: false, text: String(err) }
  }
}

// ---------- repo, board, binding ----------

async function loadRepo($: $): Promise<ClepsydraRepo | null> {
  const top = (await exec($, ['git', 'rev-parse', '--show-toplevel'])).stdout.trim()
  if (top === '') {
    await update($, repoRef, () => null)
    return null
  }
  const branch = (await exec($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD'
  const common = (await exec($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
  const main = mainCheckoutOf(common) ?? top
  const repo: ClepsydraRepo = { top, branch, repoBase: basename(top), mainBase: basename(main) }
  await update($, repoRef, () => repo)
  return repo
}

async function currentRepo($: $): Promise<ClepsydraRepo | null> {
  return (await read($, repoRef)) ?? (await loadRepo($))
}

async function showStatus($: $): Promise<void> {
  const health = healthSegment(await read($, healthRef))
  const binding = await read($, bindingRef)
  if (binding === null) {
    $.ui.status(statusText(undefined, health))
    return
  }
  const tasks = (await read($, boardRef)) ?? []
  const t = tasks.find(x => x.code === binding.code)
  const entry = statusEntry(
    shortCode(
      binding.code,
      tasks.map(x => x.code),
    ),
    t?.status,
  )
  $.ui.status(statusText(entry, health))
}

async function setHealth($: $, patch: Partial<Health>): Promise<void> {
  await update($, healthRef, h => ({ ...h, ...patch }))
}

/** Sync conflicts from GET /sync/status; a failed read keeps the last count (the board read decides reachability). */
async function probeConflicts($: $): Promise<void> {
  if (!(await read($, healthRef)).reachable) return
  const got = await getJson($, '/sync/status')
  if (got.ok) await setHealth($, { conflicts: conflictCount(got.json) })
  await showStatus($)
}

/** Timer tick: `/sync/status` is the cheap vault GET. It answering decides `reachable`, and its conflict count is kept. Never a notice. */
async function healthTick($: $): Promise<void> {
  const got = await getJson($, '/sync/status')
  await setHealth($, got.ok ? { reachable: true, conflicts: conflictCount(got.json) } : { reachable: false })
  await showStatus($)
}

/** `clep doctor --json` on the real config (read-only); undefined when it does not answer. */
async function probeDoctor($: $): Promise<void> {
  const r = await exec($, ['clep', 'doctor', '--json'], 10_000)
  const doctor = doctorCounts(r.stdout)
  if (doctor !== undefined) await setHealth($, { doctor })
}

/** The one health notice of the session; later probes only move the status line. */
async function noticeHealth($: $): Promise<void> {
  const text = healthNotice(await read($, healthRef))
  if (text !== undefined) $.ui.log(text)
}

async function refreshBoard($: $): Promise<BoardTask[] | null> {
  const got = await getJson($, '/board')
  const board = got.ok ? parseBoard(got.json) : undefined
  await setHealth($, { reachable: got.ok })
  if (board === undefined) {
    await update($, boardErrorRef, () => (got.ok ? 'not a board reply' : got.error))
    await showStatus($)
    return null
  }
  const repo = await currentRepo($)
  const project =
    repo === null
      ? undefined
      : resolveProject({ repoBase: repo.repoBase, mainBase: repo.mainBase, map: cfg.projectMap, projects: board.projects })
  const before = await read($, projectRef)
  await update($, boardRef, () => board.tasks)
  await update($, hubsRef, () => board.hubs)
  hubRows = board.hubRows
  await update($, projectRef, () => project ?? null)
  await update($, boardErrorRef, () => null)
  // The hub loads on the first good board read, and again when the project changes.
  if ((await read($, hubRef)) === null || before !== (project ?? null)) await loadHub($)
  await showStatus($)
  return board.tasks
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads the project's hub page into `hubRef`; null (and nothing added) on any failure. */
async function loadHub($: $): Promise<void> {
  try {
    const project = await read($, projectRef)
    const row = project === null ? undefined : pickHub(hubRows, project)
    const got = row === undefined ? undefined : await getJson($, pagePath(row.path))
    const page = got?.ok === true && isRecord(got.json) ? got.json : undefined
    if (row === undefined || page === undefined || typeof page.body !== 'string') {
      await update($, hubRef, () => null)
      return
    }
    const meta = isRecord(page.meta) ? page.meta : {}
    const section = hubSections(page.body, ['Status', 'Threads'], HUB_CAP)
    await update($, hubRef, () => ({
      path: row.path,
      title: typeof meta.title === 'string' ? meta.title : row.path,
      settings: hubSettings(meta),
      ...(section === undefined ? {} : { section }),
    }))
  } catch {
    await update($, hubRef, () => null)
  }
}

async function boardTasks($: $): Promise<BoardTask[] | null> {
  return (await read($, boardRef)) ?? (await refreshBoard($))
}

async function fetchBody($: $, t: BoardTask): Promise<void> {
  const got = await getJson($, pagePath(t.path))
  const page = got.ok ? pageFromJson(got.json) : undefined
  await update($, bodyRef, () => (page === undefined ? null : { code: t.code, body: page.body }))
}

async function bind($: $, t: BoardTask, source: ClepsydraBinding['source']): Promise<void> {
  await update($, bindingRef, () => ({ code: t.code, source }))
  const repo = await currentRepo($)
  if (source === 'explicit' && repo !== null) await $.store.set(bindingKey(repo.top, repo.branch), t.code)
  await showStatus($)
  await fetchBody($, t)
}

async function unbind($: $): Promise<void> {
  await update($, bindingRef, () => null)
  await update($, bodyRef, () => null)
  const repo = await currentRepo($)
  if (repo !== null) await $.store.delete(bindingKey(repo.top, repo.branch))
  await showStatus($)
}

/** Stored explicit binding for this repo+branch, else a TSK code in the branch name. */
async function restoreBinding($: $, tasks: readonly BoardTask[]): Promise<void> {
  const repo = await currentRepo($)
  if (repo === null) return
  const stored = await $.store.get(bindingKey(repo.top, repo.branch))
  const explicit = typeof stored === 'string' ? tasks.find(t => t.code === stored) : undefined
  if (explicit !== undefined) return bind($, explicit, 'explicit')
  const fromBranch = branchTaskCode(repo.branch)
  if (fromBranch === undefined) return
  const r = resolveTaskRef(fromBranch, tasks)
  if ('task' in r) await bind($, r.task, 'branch')
}

async function setField($: $, t: BoardTask, consent: string): Promise<string> {
  if (t.status === 'FIELD') return `${t.code} already FIELD`
  const r = await callVault($, 'vault_task_update', { task: t.code, status: 'FIELD' }, consent)
  await refreshBoard($)
  return r.ok ? `${t.code} → FIELD` : `could not set ${t.code} FIELD: ${r.text.slice(0, 160)}`
}

/** Board `start`: bind, move to FIELD unless there, put `work on …` in the composer. */
async function startTask($: $, code: string): Promise<void> {
  const t = ((await boardTasks($)) ?? []).find(x => x.code === code)
  if (t === undefined) return
  await bind($, t, 'explicit')
  const said = await setField($, t, `The user pressed "start" on ${t.code} in the clepsydra board pane.`)
  await $.prompt.fill({ text: `work on ${t.code}: ${t.title}` })
  $.ui.toast(`clepsydra: ${said}`)
}

async function bindFromPane($: $, code: string): Promise<void> {
  const t = ((await boardTasks($)) ?? []).find(x => x.code === code)
  if (t === undefined) return
  await bind($, t, 'explicit')
  $.ui.toast(`clepsydra: bound ${t.code}`)
}

// ---------- pane ----------

async function tick($: $): Promise<void> {
  if (!(await read($, paneOpenRef))) {
    poll?.cancel()
    poll = undefined
    return
  }
  await refreshBoard($)
  await probeConflicts($)
}

function ensurePoll($: $): void {
  if (poll !== undefined) return
  poll = $.clock.every(POLL_MS, () => void tick($).catch(() => undefined))
}

function boardSummary(tasks: readonly BoardTask[], project: string, all: boolean): string {
  const groups = groupTasks(tasks, project, all)
  if (groups.length === 0) return `board · ${project}: nothing open`
  return `board · ${project}: ${groups.map(g => `${g.tasks.length} ${g.status.toLowerCase()}`).join(' · ')}`
}

async function openBoard($: $, all: boolean): Promise<string> {
  await loadRepo($)
  const tasks = await refreshBoard($)
  if (tasks === null) return `clepsydra: board unreachable (${(await read($, boardErrorRef)) ?? 'unknown'})`
  const project = await read($, projectRef)
  if (project === null) {
    const repo = await read($, repoRef)
    return `clepsydra: no project for ${repo?.repoBase ?? 'this directory'}; set projectMap`
  }
  await update($, showAllRef, () => all)
  await update($, paneOpenRef, () => true)
  await $.ui.open({ id: PANE, title: `Board · ${project}` })
  ensurePoll($)
  return boardSummary(tasks, project, all)
}

// ---------- /task ----------

function candidateList(arg: string, candidates: readonly BoardTask[]): string {
  if (candidates.length === 0) return `clepsydra: no task matches "${arg}"`
  const rows = candidates.slice(0, 10).map(t => `  ${t.code} · ${t.status} · ${t.title}`)
  if (candidates.length > 10) rows.push(`  … ${candidates.length - 10} more`)
  return [`clepsydra: "${arg}" is ambiguous:`, ...rows].join('\n')
}

async function taskCommand($: $, args: string): Promise<string> {
  const arg = args.trim()
  await loadRepo($)
  const tasks = await refreshBoard($)
  const binding = await read($, bindingRef)
  if (arg === '') {
    if (binding === null) return 'clepsydra: no task bound. /task <code|prefix|title> binds one.'
    const t = tasks?.find(x => x.code === binding.code)
    return t === undefined ? `clepsydra: bound ${binding.code} (${binding.source}); not on the board` : taskSummary(t, binding.source)
  }
  if (arg === 'clear') {
    await unbind($)
    return binding === null ? 'clepsydra: nothing was bound' : `clepsydra: unbound ${binding.code}`
  }
  if (tasks === null) return `clepsydra: board unreachable (${(await read($, boardErrorRef)) ?? 'unknown'})`
  if (arg === 'start') {
    if (binding === null) return 'clepsydra: no task bound'
    const t = tasks.find(x => x.code === binding.code)
    if (t === undefined) return `clepsydra: ${binding.code} not on the board`
    return `clepsydra: ${await setField($, t, `The user ran /task start for ${t.code}.`)}`
  }
  const r = resolveTaskRef(arg, tasks)
  if (!('task' in r)) return candidateList(arg, r.candidates)
  await bind($, r.task, 'explicit')
  return `clepsydra: bound ${r.task.code} · ${r.task.status} · ${r.task.title}`
}

// ---------- merge → REVIEW ----------

async function git($: $, dir: string, args: string[]): Promise<string> {
  const r = await exec($, ['git', '-C', dir, ...args], 5000)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

function pageBody(text: string): string | undefined {
  const got = parseJson(text)
  return got.ok && isRecord(got.json) && typeof got.json.body === 'string' ? got.json.body : undefined
}

/** The checkout the merge ran in: its own dir (relative to the repo top), else the repo top. */
async function mergeDir($: $, call: MergeCall): Promise<string | undefined> {
  if (call.dir?.startsWith('/') === true) return call.dir
  const repo = await currentRepo($)
  if (repo === null) return undefined
  return call.dir === undefined ? repo.top : `${repo.top}/${call.dir}`
}

/**
 * After a completed merge: when the merge's checkout is on the hub's
 * integration branch, move the delivered task to REVIEW and add a Delivery
 * line to its page. When the vault keeps the hub from being read, or a step
 * fails once the task is known, a toast names the task.
 */
async function afterMerge($: $, call: MergeCall): Promise<void> {
  const dir = await mergeDir($, call)
  if (dir === undefined) return
  const bound = (await read($, bindingRef))?.code
  const withBound = bound === undefined ? {} : { bound }
  // No hub yet (startup's board read failed): a board read loads it.
  const early = (await read($, hubRef)) === null ? await refreshBoard($) : undefined
  const hub = await read($, hubRef)
  if (hub === null) {
    // Unreachable: the board read failed, or the project has a hub that could not be read.
    const project = await read($, projectRef)
    const isUnreachable = early === null || (project !== null && pickHub(hubRows, project) !== undefined)
    const code = mergeCode({ ...withBound, mergedBranch: call.branch })
    if (isUnreachable && code !== undefined) $.ui.toast(`clepsydra: could not check ${code}: vault unreachable`)
    return
  }
  const integration = hub.settings.integrationBranch
  if (integration === undefined) return
  const head = await git($, dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head !== integration) return
  const sha = await git($, dir, ['rev-parse', '--short', 'HEAD'])
  // Current statuses; the cached board when the vault does not answer. A hub
  // only loads after a good board read, so the cache is set here.
  const tasks = (early ?? (await refreshBoard($))) ?? (await read($, boardRef)) ?? []
  const t = mergeTask({ ...withBound, mergedBranch: call.branch, integrationBranch: integration, tasks })
  if (t === undefined) return
  if (sha === '') {
    $.ui.toast(`clepsydra: could not update ${t.code}: no commit sha for ${dir}`)
    return
  }
  const moved = await callVault($, 'vault_task_update', { task: t.code, status: 'REVIEW' })
  if (!moved.ok) {
    $.ui.toast(`clepsydra: could not update ${t.code}: ${moved.text.slice(0, 160)}`)
    await refreshBoard($)
    return
  }
  const line = deliveryLine(sha, head, localDate(await $.clock.now()))
  const page = await callVault($, 'vault_get_page', { path: t.path })
  const body = page.ok ? pageBody(page.text) : undefined
  const appended =
    body === undefined
      ? { ok: false, text: page.ok ? 'task page has no body' : page.text }
      : await callVault($, 'vault_append_page', { path: t.path, ...deliveryAppend(body, line) })
  $.ui.toast(
    appended.ok
      ? `clepsydra: ${t.code} → REVIEW (${sha})`
      : `clepsydra: could not update ${t.code}: moved to REVIEW, delivery line not added: ${appended.text.slice(0, 160)}`,
  )
  await refreshBoard($)
}

// ---------- [[wikilink]] attach ----------

type Resolved = { target: string; block?: string; title?: string; isUnreachable?: boolean }

async function resolveLink($: $, target: string): Promise<Resolved> {
  const found = await getJson($, `/index/search?q=${encodeURIComponent(target)}&limit=5`)
  if (!found.ok) return { target, isUnreachable: true }
  const hit = pickExact(target, searchHits(found.json))
  if (hit === undefined) return { target }
  const got = await getJson($, pagePath(hit.path))
  const page = got.ok ? pageFromJson(got.json) : undefined
  if (page === undefined) return { target, isUnreachable: !got.ok }
  const cut = truncatePage(page.body)
  return { target, title: page.title, block: formatAttachment(page.title, page.path, cut.text, cut.isTruncated) }
}

async function recordPrompt($: $, text: string): Promise<void> {
  const one = text.length > PROMPT_CHARS ? text.slice(0, PROMPT_CHARS) : text
  await update($, promptsRef, list => [...list, one].slice(-PROMPTS_KEPT))
  await update($, promptCountRef, n => n + 1)
}

async function attachLinks($: $, text: string): Promise<string[]> {
  const targets = extractWikilinks(text)
  if (targets.length === 0) return []
  const resolved = await Promise.all(targets.map(t => resolveLink($, t)))
  const blocks = resolved.flatMap(r => (r.block === undefined ? [] : [r.block]))
  const attached = resolved.flatMap(r => (r.title === undefined ? [] : [r.title]))
  const unresolved = resolved.filter(r => r.block === undefined).map(r => r.target)
  const toast = resolved.every(r => r.isUnreachable === true)
    ? `clepsydra: vault unreachable; not attached: ${unresolved.map(x => `[[${x}]]`).join(', ')}`
    : attachToast(attached, unresolved)
  if (toast !== undefined) $.ui.toast(toast)
  return blocks
}

// ---------- journal ----------

async function gatherEntry($: $, note: string | undefined, isManual: boolean): Promise<PendingJournal | undefined> {
  const repo = await currentRepo($)
  const binding = await read($, bindingRef)
  const promptCount = await read($, promptCountRef)
  const since = new Date((await $.session.usage()).startedAt).toISOString()
  const log = repo === null ? '' : (await exec($, ['git', 'log', '--oneline', '-n', '30', `--since=${since}`], 3000)).stdout
  const commits = log
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  if (!isManual && isTrivial({ promptCount, commitCount: commits.length, hasTask: binding !== null })) return undefined
  const diffStat = repo === null ? '' : (await exec($, ['git', 'diff', '--shortstat', 'HEAD'], 3000)).stdout.trim()
  const messages = await $.session.messages()
  const rows = Array.isArray(messages) ? messages : []
  const finalMessage = [...rows].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')?.text ?? ''
  const t = binding === null ? undefined : ((await read($, boardRef)) ?? []).find(x => x.code === binding.code)
  const task =
    binding === null ? undefined : { code: binding.code, ...(t === undefined ? {} : { title: t.title, status: t.status }) }
  const facts = {
    repo: repo?.repoBase ?? 'no repo',
    branch: repo?.branch ?? '-',
    ...(task === undefined ? {} : { task }),
    prompts: await read($, promptsRef),
    promptCount,
    commits,
    diffStat,
    finalMessage,
  }
  const project = await read($, projectRef)
  const hub = project === null ? undefined : (await read($, hubsRef))[project]
  const now = await $.clock.now()
  return {
    id: `${await $.session.id()}-${now}`,
    createdAt: now,
    digest: buildDigest(facts),
    fallback: fallbackBody(facts),
    repo: facts.repo,
    branch: facts.branch,
    ...(hub === undefined ? {} : { hub }),
    ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
  }
}

/** Stores the entry in the pending queue first, so an exit cannot lose it. */
async function queueJournal($: $, note: string | undefined, isManual: boolean): Promise<PendingJournal | undefined> {
  const entry = await gatherEntry($, note, isManual)
  if (entry === undefined) return undefined
  await $.store.set(PENDING, pushPending(asPending(await $.store.get(PENDING)), entry))
  return entry
}

async function draftBody($: $, p: PendingJournal): Promise<string> {
  try {
    const r = await $.model.complete({ model: cfg.journalModel, prompt: journalPrompt(p.digest), maxTokens: 400, timeoutMs: 20_000 })
    return r.isAnswered && r.text.trim() !== '' ? r.text.trim() : p.fallback
  } catch {
    return p.fallback
  }
}

/** Drafts and writes each pending entry, oldest first; stops at the first failed write. */
async function flushPending($: $): Promise<{ posted: number; failed?: string }> {
  if (isFlushing) return { posted: 0 }
  isFlushing = true
  let posted = 0
  try {
    for (const p of asPending(await $.store.get(PENDING))) {
      const body = await draftBody($, p)
      const content = entryContent({
        repo: p.repo,
        branch: p.branch,
        at: p.createdAt,
        ...(p.hub === undefined ? {} : { hub: p.hub }),
        ...(p.note === undefined ? {} : { note: p.note }),
        body,
      })
      const r = await callVault($, 'vault_ai_journal_capture', { content, author: 'claude-code' })
      if (!r.ok) return { posted, failed: r.text.slice(0, 160) }
      await $.store.set(
        PENDING,
        asPending(await $.store.get(PENDING)).filter(x => x.id !== p.id),
      )
      posted += 1
    }
    return { posted }
  } finally {
    isFlushing = false
  }
}

const entries = (n: number) => `${n} journal entr${n === 1 ? 'y' : 'ies'}`

async function flushAndToast($: $): Promise<void> {
  const r = await flushPending($)
  if (r.posted > 0) $.ui.toast(`clepsydra: posted ${r.posted} pending journal entr${r.posted === 1 ? 'y' : 'ies'}`)
}

async function journalCommand($: $, note: string): Promise<string> {
  const entry = await queueJournal($, note, true)
  if (entry === undefined) return 'clepsydra: nothing to journal'
  const r = await flushPending($)
  if (r.failed !== undefined) return `clepsydra: journal entry queued; write failed: ${r.failed}`
  return `clepsydra: posted ${entries(r.posted)}`
}

async function startup($: $): Promise<void> {
  await loadRepo($)
  const tasks = await refreshBoard($)
  if (tasks !== null && (await read($, bindingRef)) === null) await restoreBinding($, tasks)
  try {
    await flushAndToast($)
  } finally {
    await probeConflicts($)
    await probeDoctor($)
    await showStatus($)
    await noticeHealth($)
  }
}

async function endSession($: $, reason: string): Promise<void> {
  if (journalsOnEnd(reason)) {
    try {
      await queueJournal($, undefined, false)
    } catch {
      // never hold up an exit
    }
  }
  if (reason === 'clear') {
    await update($, promptsRef, () => [])
    await update($, promptCountRef, () => 0)
    // The process lives on after /clear: write now, outside the end bound.
    $.clock.after(0, () => void flushAndToast($).catch(() => undefined))
  }
}

// ---------- register ----------

export const register: Register = (on, options) => {
  cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'clepsydra task board for this repo in a pane', argumentHint: '[all]' })
    await $.command.register({
      name: 'task',
      description: 'show, bind, start or clear the active clepsydra task',
      argumentHint: '[<code|prefix|title> | start | clear]',
    })
    await $.command.register({
      name: 'journal',
      description: 'write a session entry to the clepsydra AI journal now',
      argumentHint: '[note]',
    })
    healthTimer?.cancel()
    healthTimer = $.clock.every(HEALTH_MS, () => void healthTick($).catch(() => undefined))
    const ran = await next(e)
    // Network work runs after the hook, so the first prompt never waits on the vault.
    $.clock.after(0, () => void startup($).catch(() => undefined))
    return ran
  })

  on('command.run', { command: 'board' }, async ($, e) => ({ text: await openBoard($, e.args.trim() === 'all') }))
  on('command.run', { command: 'task' }, async ($, e) => ({ text: await taskCommand($, e.args) }))
  on('command.run', { command: 'journal' }, async ($, e) => ({ text: await journalCommand($, e.args) }))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, paneOpenRef, () => false)
      poll?.cancel()
      poll = undefined
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections = [...composed.sections]
    const hub = await read($, hubRef)
    if (hub?.section !== undefined) {
      sections.push({ id: 'clepsydra:hub', text: hubSection(hub.title, hub.path, hub.section), scope: 'session' as const })
    }
    const binding = await read($, bindingRef)
    if (binding !== null) {
      const t = ((await read($, boardRef)) ?? []).find(x => x.code === binding.code)
      const body = await read($, bodyRef)
      const text = activeTaskSection(binding.code, t, body?.code === binding.code ? body.body : undefined)
      sections.push({ id: 'clepsydra:active-task', text, scope: 'session' as const })
    }
    return { sections }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isPersonOrigin(e.origin)) return next(e)
    await recordPrompt($, e.text)
    const blocks = await attachLinks($, e.text)
    if (blocks.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...blocks] })
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      const call = bashSucceeded(r) && !isAlreadyUpToDate(r) ? parseMerge(e.command) : undefined
      // Vault work runs after the hook, so the tool result never waits on it.
      if (call !== undefined) $.clock.after(0, () => void afterMerge($, call).catch(() => undefined))
    } catch {
      // never throw into the host
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    await endSession($, e.reason)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const tasks = (await read($, boardRef)) ?? []
    const project = await read($, projectRef)
    const error = await read($, boardErrorRef)
    const binding = await read($, bindingRef)
    const all = await read($, showAllRef)
    const cols = Math.max(30, e.props.bodyColumns)
    const codes = tasks.map(t => t.code)
    const groups = project === null ? [] : groupTasks(tasks, project, all)
    const head =
      error !== null
        ? `vault unreachable: ${error}`
        : project === null
          ? 'no project for this repo; set projectMap'
          : boardSummary(tasks, project, all)
    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" gap={1}>
          <Text key="summary" dimColor wrap="truncate">
            {head.slice(0, Math.max(10, cols - 12))}
          </Text>
          <Button key="refresh" label="refresh" plain onPress={() => void refreshBoard($)} />
        </Box>
        {groups.map(g => (
          <Box key={`group-${g.status}`} flexDirection="column">
            <Text key={`label-${g.status}`} bold>
              {groupLabel(g.status, g.tasks.length)}
            </Text>
            {g.tasks.slice(0, GROUP_ROWS).map(t => (
              <Box key={`row-${t.code}`} flexDirection="row" gap={1}>
                <Text key={`text-${t.code}`} wrap="truncate">
                  {boardRowText(t, shortCode(t.code, codes), cols - 14, binding?.code === t.code)}
                </Text>
                <Button key={`start-${t.code}`} label="start" plain onPress={() => void startTask($, t.code)} />
                <Button key={`bind-${t.code}`} label="bind" plain onPress={() => void bindFromPane($, t.code)} />
              </Box>
            ))}
            {g.tasks.length > GROUP_ROWS && (
              <Text key={`more-${g.status}`} dimColor>
                {`  … ${g.tasks.length - GROUP_ROWS} more`}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
