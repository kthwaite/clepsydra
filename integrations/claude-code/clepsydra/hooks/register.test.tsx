import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const API = 'https://clepsydra.localhost/api/vault'
const REPO = '/work/clepsydra'
const NOW = Date.UTC(2026, 9, 4, 12)
const PANE_PROPS = {
  title: 'Board · clepsydra',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const task = (code: string, status: string, priority: string | null, title: string, project = 'clepsydra') => ({
  id: code,
  path: `tasks/${project}/${code}.md`,
  code,
  title,
  body_excerpt: '',
  project,
  status,
  priority,
  checks: [1, 2],
  updated_at: '2026-10-01T00:00:00Z',
})

const BOARD = {
  columns: [],
  cycles: [],
  operations: [
    { id: 'o1', project: 'clepsydra', name: 'Clepsydra' },
    { id: 'o2', project: 'xxii', name: 'XXII' },
  ],
  tasks: [
    task('TSK-brave-finch-7q3zd', 'TRIAGE', 'P1', 'Board pane'),
    task('TSK-calm-owl-bbbbb', 'FIELD', 'P2', 'Journal on exit'),
    task('TSK-dark-elm-ccccc', 'SEALED', 'P0', 'Old thing'),
    task('TSK-eager-yak-ddddd', 'INTAKE', null, 'Elsewhere', 'xxii'),
  ],
}

const PAGES: Record<string, unknown> = {
  'tasks/clepsydra/TSK-brave-finch-7q3zd.md': {
    path: 'tasks/clepsydra/TSK-brave-finch-7q3zd.md',
    meta: { title: 'Board pane' },
    body: 'Build the board pane.',
  },
  'projects/clepsydra/hub.md': { path: 'projects/clepsydra/hub.md', meta: { title: 'Clepsydra' }, body: '# Hub\nRepo notes.' },
}

const SEARCH: Record<string, unknown> = {
  Clepsydra: [
    { page_id: '1', path: 'notes/local.md', title: 'Clepsydra Local Deployment', snippet: '' },
    { page_id: '2', path: 'projects/clepsydra/hub.md', title: 'Clepsydra', snippet: '' },
  ],
  Nope: [{ page_id: '3', path: 'notes/nopeish.md', title: 'Nope-ish', snippet: '' }],
}

type World = {
  branch?: string
  commits?: string
  isFetchBroken?: boolean
  modelText?: string
  journalDeny?: string
  top?: string
}

function world(on: On, opts: World = {}) {
  const seen = {
    toasts: [] as string[],
    status: undefined as string | undefined,
    opened: [] as string[],
    filled: [] as string[],
    taskCalls: [] as Record<string, unknown>[],
    journalCalls: [] as Record<string, unknown>[],
    fetched: [] as string[],
    curled: [] as string[],
    models: [] as string[],
  }
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: { startedAt: NOW - 3_600_000, context: { window: 200000 }, rateLimits: [] } }))
  on('session.messages', () => ({ value: [{ role: 'assistant' as const, text: 'All gates green.', toolUses: [] }] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  on('prompt.submit', (_$, e) => ({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))
  on('prompt.fill', (_$, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  const answer = (url: string): { status: number; text: string } => {
    const path = url.slice(API.length)
    if (path === '/board') return { status: 200, text: JSON.stringify(BOARD) }
    if (path.startsWith('/index/search?')) {
      const q = new URL(url).searchParams.get('q') ?? ''
      return { status: 200, text: JSON.stringify(SEARCH[q] ?? []) }
    }
    if (path.startsWith('/pages/')) {
      const page = PAGES[decodeURIComponent(path.slice('/pages/'.length))]
      return page === undefined ? { status: 404, text: '{}' } : { status: 200, text: JSON.stringify(page) }
    }
    return { status: 404, text: '{}' }
  }
  on('http.fetch', (_$, e) => {
    seen.fetched.push(e.url)
    if (opts.isFetchBroken === true) throw new Error('self signed certificate in certificate chain')
    const a = answer(e.url)
    return { value: { status: a.status, ok: a.status < 300, headers: {}, text: a.text } }
  })
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'curl') {
      const url = argv[argv.length - 1] ?? ''
      seen.curled.push(url)
      const a = answer(url)
      return ok(`${a.text}\n${a.status}`)
    }
    const key = argv.slice(1).join(' ')
    if (key === 'rev-parse --show-toplevel') return ok(`${opts.top ?? REPO}\n`)
    if (key === 'rev-parse --abbrev-ref HEAD') return ok(`${opts.branch ?? 'develop'}\n`)
    if (key === 'rev-parse --path-format=absolute --git-common-dir') return ok(`${opts.top ?? REPO}/.git\n`)
    if (key.startsWith('log --oneline')) return ok(opts.commits ?? '')
    if (key.startsWith('diff --shortstat')) return ok(' 2 files changed, 10 insertions(+)\n')
    return ok('')
  })
  on('tool.call', { tool: 'mcp__clepsydra__vault_task_update' }, (_$, e) => {
    seen.taskCalls.push({ ...e })
    return { result: 'updated' }
  })
  on('tool.call', { tool: 'mcp__clepsydra__vault_ai_journal_capture' }, (_$, e) => {
    seen.journalCalls.push({ ...e })
    return opts.journalDeny === undefined ? { result: 'appended' } : { deny: opts.journalDeny }
  })
  on('model.complete', (_$, e) => {
    seen.models.push(e.model)
    return {
      value:
        opts.modelText === undefined
          ? { isAnswered: false as const, reason: 'empty-reply' as const, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
          : { isAnswered: true as const, text: opts.modelText, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }
  })
  return { seen, clock, store }
}

describe('/board pane', () => {
  test('opens a pane of the project tasks; start sets FIELD via MCP and fills the composer', async ($, on) => {
    const { seen } = world(on)
    const r = await $.command.run({ ...TYPED, command: 'board', args: '' })
    expect(r.text).toBe('board · clepsydra: 1 field · 1 triage')
    expect(seen.opened).toEqual(['clepsydra-board'])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'clepsydra', surface, component: 'Pane', requestId: 'clepsydra-board', props: PANE_PROPS })
      expect((await ui.find({ type: 'Text', text: /^in field/ }))?.text).toBe('in field (1)')
      expect(await ui.find({ key: 'start-TSK-brave-finch-7q3zd' })).toBeDefined()
      expect(await ui.find({ key: 'start-TSK-dark-elm-ccccc' })).toBeUndefined()
      expect(await ui.find({ key: 'start-TSK-eager-yak-ddddd' })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /TSK-brave-finch P1/ }))?.text).toBe('  TSK-brave-finch P1 Board pane 1/2')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ plugin: 'clepsydra', surface: 'terminal', component: 'Pane', requestId: 'clepsydra-board', props: PANE_PROPS })
    await ui.press({ key: 'start-TSK-brave-finch-7q3zd' })
    expect(seen.taskCalls.length).toBe(1)
    expect(seen.taskCalls[0]?.task).toBe('TSK-brave-finch-7q3zd')
    expect(seen.taskCalls[0]?.status).toBe('FIELD')
    expect(seen.filled).toEqual(['work on TSK-brave-finch-7q3zd: Board pane'])
    expect(seen.status).toBe('TSK-brave-finch · TRIAGE')
    expect((await ui.find({ type: 'Text', text: /TSK-brave-finch P1/ }))?.text.startsWith('●')).toBe(true)
    await ui.press({ key: 'bind-TSK-calm-owl-bbbbb' })
    expect(seen.taskCalls.length).toBe(1)
    expect(seen.status).toBe('TSK-calm-owl · FIELD')
    await ui.unmount()
  })

  test('start on a FIELD task makes no write', async ($, on) => {
    const { seen } = world(on)
    await $.command.run({ ...TYPED, command: 'board', args: 'all' })
    const ui = await $.ui.mount({ plugin: 'clepsydra', surface: 'desktop', component: 'Pane', requestId: 'clepsydra-board', props: PANE_PROPS })
    expect(await ui.find({ key: 'start-TSK-dark-elm-ccccc' })).toBeDefined()
    await ui.press({ key: 'start-TSK-calm-owl-bbbbb' })
    expect(seen.taskCalls).toEqual([])
    expect(seen.filled).toEqual(['work on TSK-calm-owl-bbbbb: Journal on exit'])
    await ui.unmount()
  })

  test('no project for the repo says so', async ($, on) => {
    const { seen } = world(on, { top: '/work/logseq' })
    const r = await $.command.run({ ...TYPED, command: 'board', args: '' })
    expect(r.text).toBe('clepsydra: no project for logseq; set projectMap')
    expect(seen.opened).toEqual([])
  })

  test('projectMap maps the repo to a project', { options: { projectMap: 'logseq=xxii' } }, async ($, on) => {
    world(on, { top: '/work/logseq' })
    const r = await $.command.run({ ...TYPED, command: 'board', args: '' })
    expect(r.text).toBe('board · xxii: 1 intake')
  })
})

describe('/task binding', () => {
  test('binds by prefix, adds the compose section with the page body, clears', async ($, on) => {
    const { seen } = world(on)
    const r = await $.command.run({ ...TYPED, command: 'task', args: 'TSK-brave' })
    expect(r.text).toContain('bound TSK-brave-finch-7q3zd')
    expect(seen.status).toBe('TSK-brave-finch · TRIAGE')
    const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const section = composed.sections.find(s => s.id === 'clepsydra:active-task')
    expect(section?.scope).toBe('session')
    expect(section?.text).toContain('Build the board pane.')
    expect(section?.text).toContain('This session is working on TSK-brave-finch-7q3zd.')
    const shown = await $.command.run({ ...TYPED, command: 'task', args: '' })
    expect(shown.text).toContain('bound: explicit')
    const start = await $.command.run({ ...TYPED, command: 'task', args: 'start' })
    expect(start.text).toContain('→ FIELD')
    expect(seen.taskCalls[0]?.status).toBe('FIELD')
    const cleared = await $.command.run({ ...TYPED, command: 'task', args: 'clear' })
    expect(cleared.text).toContain('unbound')
    const after = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(after.sections.map(s => s.id)).toEqual(['intro'])
  })

  test('ambiguous ref lists candidates', async ($, on) => {
    world(on)
    const r = await $.command.run({ ...TYPED, command: 'task', args: 'o' })
    expect(r.text).toContain('ambiguous')
  })

  test('session start binds from the branch name', async ($, on) => {
    const { seen, clock } = world(on, { branch: 'feature/tsk-calm-owl-bbbbb-journal' })
    await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
    await clock.advance(10)
    expect(seen.status).toBe('TSK-calm-owl · FIELD')
  })

  test('falls back to curl when the engine fetch throws', async ($, on) => {
    const { seen } = world(on, { isFetchBroken: true })
    const r = await $.command.run({ ...TYPED, command: 'board', args: '' })
    expect(r.text).toBe('board · clepsydra: 1 field · 1 triage')
    expect(seen.curled).toEqual([`${API}/board`])
  })
})

describe('[[wikilink]] attach', () => {
  test('exact titles attach as hidden context; others are reported unresolved', async ($, on) => {
    const { seen } = world(on)
    const r = await $.prompt.submit({ text: 'see [[Clepsydra|hub]] and [[Nope]] but not `[[Code]]`', wait: false, origin: { kind: 'composer' } })
    expect(r.text).toBe('see [[Clepsydra|hub]] and [[Nope]] but not `[[Code]]`')
    expect(r.context).toEqual(['Vault page [[Clepsydra]] (projects/clepsydra/hub.md):\n# Hub\nRepo notes.'])
    expect(seen.toasts).toEqual(['attached [[Clepsydra]] · unresolved: [[Nope]]'])
  })

  test("a plugin's prompt is left alone", async ($, on) => {
    const { seen } = world(on)
    const r = await $.prompt.submit({ text: '[[Clepsydra]]', wait: false, origin: { kind: 'plugin', name: 'ship' } })
    expect(r.context).toBeUndefined()
    expect(seen.fetched).toEqual([])
  })
})

describe('session journal', () => {
  test('session.end queues the entry; the next session.start drafts and writes it', async ($, on) => {
    const { seen, clock, store } = world(on, { commits: 'a1b2c3d feat: board\n', modelText: '- built the board pane (a1b2c3d)' })
    await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
    await clock.advance(10)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(seen.journalCalls).toEqual([])
    const pending = store.get('pendingJournal') as { digest: string }[]
    expect(pending.length).toBe(1)
    expect(pending[0]?.digest).toContain('a1b2c3d feat: board')
    await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
    await clock.advance(10)
    expect(seen.models).toEqual(['claude-haiku-5-5'])
    expect(seen.journalCalls.length).toBe(1)
    const content = String(seen.journalCalls[0]?.content)
    expect(content).toContain('### Claude Code session — clepsydra@develop')
    expect(content).toContain('Project: [[Clepsydra]]')
    expect(content).toContain('- built the board pane (a1b2c3d)')
    expect(content).not.toContain('ai-generated')
    expect(seen.journalCalls[0]?.author).toBe('claude-code')
    expect(store.get('pendingJournal')).toEqual([])
    expect(seen.toasts).toContain('clepsydra: posted 1 pending journal entry')
  })

  test('a trivial session and a resume queue nothing', async ($, on) => {
    const { store } = world(on, { commits: 'a1b2c3d feat: board\n' })
    await $.session.end({ reason: 'resume', sessionId: 'sess-1', resume: { id: 'sess-2' } })
    expect(store.get('pendingJournal')).toBeUndefined()
  })

  test('a quiet session (no prompts, commits or task) queues nothing', async ($, on) => {
    const { store } = world(on)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(store.get('pendingJournal')).toBeUndefined()
  })

  test('/journal writes now with a note; model failure falls back; a refused write stays pending', async ($, on) => {
    const { seen, store } = world(on, { journalDeny: 'permission denied' })
    const r = await $.command.run({ ...TYPED, command: 'journal', args: 'wrapped up' })
    expect(r.text).toContain('queued; write failed: permission denied')
    expect(String(seen.journalCalls[0]?.content)).toContain('Note: wrapped up')
    expect(String(seen.journalCalls[0]?.content)).toContain('- no commits')
    expect((store.get('pendingJournal') as unknown[]).length).toBe(1)
  })
})
