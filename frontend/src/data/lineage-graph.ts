/**
 * 血缘图谱传播引擎（纯函数，不碰 localStorage / React，方便单测）。
 *
 * 设计要点（对应需求）：
 * 1. 停用一个上游节点后，只沿「当前已生效图谱版本」的下游边做可达性遍历，
 *    只有真正可达的已启用节点才标成「待校验」，无关分支原状态保持不变。
 * 2. 遍历时跳过两类分支：
 *    - 已停用 / 草稿 / 待校验节点：不继续向下扩散（停用节点本身就是断点）；
 *    - 版本不匹配节点：下游引用只在旧图谱版本里存在、当前生效版本没有同名节点，
 *      该分支不再继续。旧版本记录按当时关系原样留档，不参与计算。
 * 3. 新版本与旧版本对同名节点关系描述冲突时，一律以当前已生效图谱为准。
 * 4. 传播按「确认一个节点、落一个检查点」推进，中断后从最后确认节点的下游继续，
 *    已确认节点不会被重新计算。
 */

import type { EntryRow } from './types'

export const LINEAGE_KEY = 'lineage'
export const SILVER_KEY = 'silver'

export const LINEAGE_STATUS = {
  draft: '草稿',
  pending: '待校验',
  enabled: '已启用',
  disabled: '已停用',
} as const

const NAME_FIELDS = ['节点名称', '节点编号']
const UPSTREAM_FIELD = '上游节点列表'
const DOWNSTREAM_FIELD = '下游节点列表'
const VERSION_FIELD = '图谱版本'

/** 上游/下游列表字段允许的分隔写法：逗号、顿号、分号、竖线、空白。 */
export function splitNodeRefs(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,，、;；|\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 取当前已生效图谱版本：采集时间最新的那条记录所属版本即当前版本。 */
export function effectiveVersion(rows: EntryRow[]): string | undefined {
  if (rows.length === 0) {
    return undefined
  }
  const sorted = [...rows].sort((a, b) =>
    String(b.采集时间 ?? '').localeCompare(String(a.采集时间 ?? '')),
  )
  return String(sorted[0][VERSION_FIELD] ?? '')
}

/** 按节点名称（名称找不到再退回节点编号）建索引，只收录当前生效版本的记录。 */
export function buildIndex(
  rows: EntryRow[],
  version?: string,
): { version: string | undefined; byName: Map<string, EntryRow> } {
  const current = version ?? effectiveVersion(rows)
  const byName = new Map<string, EntryRow>()
  for (const row of rows) {
    if (String(row[VERSION_FIELD] ?? '') !== current) {
      continue
    }
    for (const field of NAME_FIELDS) {
      const key = String(row[field] ?? '').trim()
      if (key && !byName.has(key)) {
        byName.set(key, row)
      }
    }
  }
  return { version: current, byName }
}

/** 当前生效图谱的邻接表：节点名称 -> 下游节点名称列表（旧版本关系不进图）。 */
export function buildAdjacency(
  rows: EntryRow[],
  version?: string,
): { version: string | undefined; byName: Map<string, EntryRow>; edges: Map<string, string[]> } {
  const { version: current, byName } = buildIndex(rows, version)
  const edges = new Map<string, string[]>()
  for (const row of byName.values()) {
    const name = String(row.节点名称 ?? '').trim()
    if (!name) {
      continue
    }
    edges.set(name, splitNodeRefs(row[DOWNSTREAM_FIELD]))
  }
  return { version: current, byName, edges }
}

/** 只读取，不写状态：规划一次停用事件最终会影响哪些节点（定位面板用）。 */
export type ReachabilityPlan = {
  version: string | undefined
  source: string
  impacted: string[]
  skippedDisabled: string[]
  skippedVersionMismatch: string[]
  skippedMissing: string[]
  unaffected: string[]
}

export function planReachable(
  rows: EntryRow[],
  sourceName: string,
  version?: string,
): ReachabilityPlan {
  const { version: current, byName, edges } = buildAdjacency(rows, version)
  const impacted: string[] = []
  const skippedDisabled: string[] = []
  const skippedVersionMismatch: string[] = []
  const skippedMissing: string[] = []
  const seen = new Set<string>([sourceName])
  const queue = [sourceName]

  while (queue.length > 0) {
    const currentName = queue.shift() as string
    for (const next of edges.get(currentName) ?? []) {
      if (seen.has(next)) {
        continue
      }
      seen.add(next)
      const node = byName.get(next)
      if (!node) {
        // 生效版本里查无此名：若整张图谱（含旧版本）都没有，是悬空引用；
        // 只在旧版本出现，就是版本不匹配的过期分支。
        const archived = rows.some((row) => NAME_FIELDS.some((field) => String(row[field] ?? '') === next))
        ;(archived ? skippedVersionMismatch : skippedMissing).push(next)
        continue
      }
      if (String(node.status) !== LINEAGE_STATUS.enabled) {
        // 已停用 / 草稿 / 待校验节点：分支到此为止，不再向下扩散。
        skippedDisabled.push(next)
        continue
      }
      impacted.push(next)
      queue.push(next)
    }
  }

  const impactedSet = new Set(impacted)
  const unaffected = [...byName.values()]
    .map((row) => String(row.节点名称 ?? ''))
    .filter((name) => name && name !== sourceName && !impactedSet.has(name) && !skippedDisabled.includes(name))

  return {
    version: current,
    source: sourceName,
    impacted,
    skippedDisabled,
    skippedVersionMismatch,
    skippedMissing,
    unaffected,
  }
}

/** 一次推进的结果。impacted 是本事件累计已确认（已标待校验）的节点名称。 */
export type PropagationStep = {
  finished: boolean
  version: string | undefined
  source: string
  impacted: string[]
  confirmedThisRound: string[]
  skippedDisabled: string[]
  skippedVersionMismatch: string[]
  skippedMissing: string[]
  /** 中断时停在哪个已确认节点，续跑从它的下游开始。 */
  lastConfirmed: string | null
  rows: EntryRow[]
}

/** 检查点：事件重放 / 续跑的全部依据，序列化后落 localStorage。 */
export type LineageCheckpoint = {
  sourceName: string
  version: string
  queue: string[]
  impacted: string[]
  skippedDisabled: string[]
  skippedVersionMismatch: string[]
  skippedMissing: string[]
  seen: string[]
  lastConfirmed: string | null
  finished: boolean
}

/**
 * 推进传播。
 * @param rows        最新的血缘节点行（每次都从存储重读，保证不拿过期图计算）
 * @param checkpoint  上次中断留下的检查点；首轮传 null
 * @param sourceName  首轮必填：被停用的上游节点名称
 * @param maxSteps    本轮最多确认几个节点；Infinity 表示一口气跑完
 */
export function advancePropagation(
  rows: EntryRow[],
  checkpoint: LineageCheckpoint | null,
  sourceName?: string,
  maxSteps: number = Number.POSITIVE_INFINITY,
): { step: PropagationStep; nextCheckpoint: LineageCheckpoint | null } {
  const graph = buildAdjacency(rows)
  const version = graph.version ?? ''
  const source = checkpoint?.sourceName ?? (sourceName as string)
  if (!source) {
    throw new Error('首轮传播必须提供被停用的上游节点名称')
  }

  const queue: string[] = checkpoint ? [...checkpoint.queue] : [source]
  const impacted: string[] = checkpoint ? [...checkpoint.impacted] : []
  const skippedDisabled: string[] = checkpoint ? [...checkpoint.skippedDisabled] : []
  const skippedVersionMismatch: string[] = checkpoint
    ? [...checkpoint.skippedVersionMismatch]
    : []
  const skippedMissing: string[] = checkpoint ? [...checkpoint.skippedMissing] : []
  const seen = new Set<string>(checkpoint ? checkpoint.seen : [source])
  let lastConfirmed: string | null = checkpoint?.lastConfirmed ?? null

  // 以最新行数据做一份可变副本，只改本轮确认的可达节点。
  const working = new Map<number, EntryRow>()
  const nextRows = rows.map((row) => {
    const copy = { ...row }
    working.set(Number(copy.id), copy)
    return copy
  })

  const confirmedThisRound: string[] = []
  let steps = 0

  while (queue.length > 0 && steps < maxSteps) {
    const currentName = queue.shift() as string
    for (const next of graph.edges.get(currentName) ?? []) {
      if (seen.has(next)) {
        continue
      }
      seen.add(next)
      const target = graph.byName.get(next)
      if (!target) {
        const archived = rows.some((row) =>
          NAME_FIELDS.some((field) => String(row[field] ?? '') === next),
        )
        ;(archived ? skippedVersionMismatch : skippedMissing).push(next)
        continue
      }
      if (String(target.status) !== LINEAGE_STATUS.enabled) {
        skippedDisabled.push(next)
        continue
      }
      const mutable = working.get(Number(target.id))
      if (!mutable) {
        continue
      }
      // 只有「沿边真正可达且当前已启用」的节点才会被改成待校验。
      mutable.status = LINEAGE_STATUS.pending
      mutable.pending = true
      impacted.push(next)
      confirmedThisRound.push(next)
      lastConfirmed = next
      queue.push(next)
      steps += 1
      if (steps >= maxSteps) {
        break
      }
    }
  }

  const finished = queue.length === 0
  const nextCheckpoint: LineageCheckpoint | null = finished
    ? null
    : {
        sourceName: source,
        version,
        queue,
        impacted,
        skippedDisabled,
        skippedVersionMismatch,
        skippedMissing,
        seen: [...seen],
        lastConfirmed,
        finished: false,
      }

  return {
    step: {
      finished,
      version: graph.version,
      source,
      impacted,
      confirmedThisRound,
      skippedDisabled,
      skippedVersionMismatch,
      skippedMissing,
      lastConfirmed,
      rows: nextRows,
    },
    nextCheckpoint,
  }
}
