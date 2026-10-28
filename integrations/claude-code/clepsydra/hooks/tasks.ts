// Board tasks: parsing GET /board, grouping, short codes, ref resolution, branch codes.

import type { HubRow } from './hub'

export type BoardTask = {
  code: string
  title: string
  status: string
  priority: string | null
  project: string | null
  path: string
  taskType: string | null
  parentEpic: string | null
  childTasks: string[]
  childProgress: [number, number]
  /** `[done, total]`. */
  checks: [number, number]
  updatedAt: string
}

/** `projects`: `operations[].project`; `hubs`: project slug → its hub page name (`operations[].name`). */
export type Board = {
  tasks: BoardTask[]
  projects: (string | null)[]
  hubs: Record<string, string>
  /**
   * Hub candidates from `operations[]`. The server omits `board: false` pages and
   * lists one operation per slug (board: true first), so every row counts as `board: true`.
   */
  hubRows: HubRow[]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function toTask(raw: unknown): BoardTask | undefined {
  if (!isRecord(raw)) return undefined
  const code = str(raw.code)
  const title = str(raw.title)
  const status = str(raw.status)
  const path = str(raw.path)
  if (code === undefined || code === '' || title === undefined || status === undefined || path === undefined) return undefined
  const checks = Array.isArray(raw.checks) ? raw.checks : []
  const done = typeof checks[0] === 'number' ? checks[0] : 0
  const total = typeof checks[1] === 'number' ? checks[1] : 0
  const progress = Array.isArray(raw.child_progress) ? raw.child_progress : []
  return {
    code,
    title,
    status,
    priority: str(raw.priority) ?? null,
    project: str(raw.project) ?? null,
    path,
    taskType: str(raw.task_type) ?? null,
    parentEpic: str(raw.parent_epic) ?? null,
    childTasks: Array.isArray(raw.child_tasks) ? raw.child_tasks.filter((code): code is string => typeof code === 'string') : [],
    childProgress: [typeof progress[0] === 'number' ? progress[0] : 0, typeof progress[1] === 'number' ? progress[1] : 0],
    checks: [done, total],
    updatedAt: str(raw.updated_at) ?? '',
  }
}

/** The board reply reduced to what the mod uses; undefined when it is not a board. */
export function parseBoard(json: unknown): Board | undefined {
  if (!isRecord(json) || !Array.isArray(json.tasks)) return undefined
  const tasks = json.tasks.map(toTask).filter((t): t is BoardTask => t !== undefined)
  const ops = Array.isArray(json.operations) ? json.operations : []
  const projects = ops.map(o => (isRecord(o) ? (str(o.project) ?? null) : null))
  const hubs: Record<string, string> = {}
  const hubRows: HubRow[] = []
  for (const o of ops) {
    const slug = isRecord(o) ? str(o.project) : undefined
    const name = isRecord(o) ? str(o.name) : undefined
    if (slug !== undefined && name !== undefined) hubs[slug] = name
    const path = isRecord(o) ? str(o.path) : undefined
    if (slug !== undefined && path !== undefined) hubRows.push({ project: slug, path, board: true })
  }
  return { tasks, projects, hubs, hubRows }
}
/** Epics are planning containers; execution and merge hooks operate on leaf Tasks. */
export function isExecutableTask(task: BoardTask): boolean {
  return task.taskType?.trim().toUpperCase() !== 'EPIC'
}


export const GROUP_ORDER = ['FIELD', 'REVIEW', 'TRIAGE', 'INTAKE'] as const

function priorityRank(p: string | null): number {
  const m = p === null ? null : /^P(\d)$/i.exec(p)
  return m === null ? 99 : Number(m[1])
}

export function sortTasks(tasks: readonly BoardTask[]): BoardTask[] {
  return [...tasks].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt.localeCompare(a.updatedAt),
  )
}

export type TaskGroup = { status: string; tasks: BoardTask[] }

/** The project's executable tasks in board order; SEALED only with `all`. */
export function groupTasks(tasks: readonly BoardTask[], project: string, all: boolean): TaskGroup[] {
  const mine = tasks.filter(t => t.project === project && isExecutableTask(t))
  const order: string[] = all ? [...GROUP_ORDER, 'SEALED'] : [...GROUP_ORDER]
  return order
    .map(status => ({ status, tasks: sortTasks(mine.filter(t => t.status === status)) }))
    .filter(g => g.tasks.length > 0)
}

const PETNAME = /^(TSK-[a-z]+-[a-z]+)-[a-z0-9]+$/i

/** `TSK-brave-finch-7q3zd` → `TSK-brave-finch` when no other code shares that stem. */
export function shortCode(code: string, codes: readonly string[]): string {
  const m = PETNAME.exec(code)
  if (m === null || m[1] === undefined) return code
  const stem = m[1].toLowerCase()
  const clash = codes.some(c => c !== code && c.toLowerCase().startsWith(stem))
  return clash ? code : m[1]
}

export type TaskRef = { task: BoardTask } | { candidates: BoardTask[] }

/** Exact code, else unique code prefix, else unique title substring (all case-insensitive). */
export function resolveTaskRef(ref: string, tasks: readonly BoardTask[]): TaskRef {
  tasks = tasks.filter(isExecutableTask)
  const q = ref.trim().toLowerCase()
  const exact = tasks.find(t => t.code.toLowerCase() === q)
  if (exact !== undefined) return { task: exact }
  const byPrefix = tasks.filter(t => t.code.toLowerCase().startsWith(q))
  if (byPrefix.length === 1 && byPrefix[0] !== undefined) return { task: byPrefix[0] }
  if (byPrefix.length > 1) return { candidates: byPrefix }
  const byTitle = tasks.filter(t => t.title.toLowerCase().includes(q))
  if (byTitle.length === 1 && byTitle[0] !== undefined) return { task: byTitle[0] }
  return { candidates: byTitle }
}

/** A TSK code in a branch name (petname, else legacy four digits), normalised. */
export function branchTaskCode(branch: string): string | undefined {
  const pet = /TSK-[a-z]+-[a-z]+-[a-z0-9]+/i.exec(branch)
  if (pet !== null) return `TSK-${pet[0].slice(4).toLowerCase()}`
  const legacy = /TSK-\d{4}(?!\d)/i.exec(branch)
  return legacy === null ? undefined : legacy[0].toUpperCase()
}

/** `$.store` key of an explicit binding for one repo checkout and branch. */
export function bindingKey(repoTop: string, branch: string): string {
  return `binding:${repoTop}@${branch}`
}
