/**
 * 血缘停用事件编排：事件台账（幂等）、检查点（断点续传）、跨模块清洗结果联动。
 *
 * 与纯引擎 lineage-graph.ts 的分工：
 * - lineage-graph.ts 只做图遍历与状态推演，可脱离浏览器单测；
 * - 本文件负责 localStorage 持久化、事件去重、silver（清洗层）跨模块标记。
 */

import { listRows, saveRows } from './local-store'
import {
  advancePropagation,
  effectiveVersion,
  LINEAGE_KEY,
  LINEAGE_STATUS,
  planReachable,
  SILVER_KEY,
  splitNodeRefs,
  type LineageCheckpoint,
  type ReachabilityPlan,
} from './lineage-graph'
import type { ActionResult, EntryRow } from './types'

const EVENT_STORAGE_KEY = 'lake-govern-config:lineage-events'

/** 一次停用传播事件的完整台账。eventId 相同的重复触发直接复用，不再传播第二次。 */
export type LineageEvent = {
  eventId: string
  sourceId: number
  sourceName: string
  version: string
  status: 'interrupted' | 'finished'
  impacted: string[]
  skippedDisabled: string[]
  skippedVersionMismatch: string[]
  skippedMissing: string[]
  affectedSilverIds: number[]
  lastConfirmed: string | null
  createdAt: string
  updatedAt: string
  checkpoint: LineageCheckpoint | null
}

function readEvents(): LineageEvent[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const raw = window.localStorage.getItem(EVENT_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as LineageEvent[]) : []
  } catch {
    return []
  }
}

function writeEvents(events: LineageEvent[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(EVENT_STORAGE_KEY, JSON.stringify(events))
  }
}

function upsertEvent(event: LineageEvent): void {
  const events = readEvents()
  const index = events.findIndex((item) => item.eventId === event.eventId)
  const stamped = { ...event, updatedAt: new Date().toISOString() }
  if (index >= 0) {
    events[index] = stamped
  } else {
    events.unshift(stamped)
  }
  writeEvents(events)
}

export function listLineageEvents(): LineageEvent[] {
  return readEvents()
}

export function clearLineageEvents(): void {
  writeEvents([])
}

/** 停用事件 ID 只与「哪个节点的哪次停用」绑定，节点重新启用后再次停用才算新事件。 */
function eventIdOf(sourceId: number, rows: EntryRow[]): string {
  const row = rows.find((item) => Number(item.id) === sourceId)
  const version = String(row?.图谱版本 ?? effectiveVersion(rows) ?? '')
  return `lineage:disable:${sourceId}:${version}`
}

export function findEvent(sourceId: number, rows: EntryRow[] = listRows(LINEAGE_KEY)): LineageEvent | undefined {
  const eventId = eventIdOf(sourceId, rows)
  return readEvents().find((event) => event.eventId === eventId)
}

/**
 * 跨模块：清洗层（silver）只标记可达下游。
 * silver 行的「上游原始表」里出现任意一个受影响血缘节点名称，才标成待校验；
 * 已停用的清洗表与无关清洗表保持原状态。
 */
export function markReachableSilver(impactedNames: string[]): number[] {
  const silverRows = listRows(SILVER_KEY)
  if (silverRows.length === 0 || impactedNames.length === 0) {
    return []
  }
  const impactedSet = new Set(impactedNames)
  const affectedIds: number[] = []
  const next = silverRows.map((row) => {
    if (String(row.status) === LINEAGE_STATUS.disabled) {
      return row
    }
    const refs = splitNodeRefs(row.上游原始表)
    if (!refs.some((ref) => impactedSet.has(ref))) {
      return row
    }
    affectedIds.push(Number(row.id))
    return { ...row, status: LINEAGE_STATUS.pending, pending: true }
  })
  if (affectedIds.length > 0) {
    saveRows(SILVER_KEY, next)
  }
  return affectedIds
}

export type DeactivateOutcome = ActionResult & {
  event?: LineageEvent
  resumed?: boolean
}

/**
 * 停用血缘节点并启动传播。
 * - 节点已是停用态：直接拒绝（沿用平台「不用重复操作」的约定）；
 * - 同一停用事件已存在且已完成：幂等返回，绝不二次传播；
 * - 事件中断过：从最后确认节点的检查点续跑，已确认节点不重算；
 * - maxSteps 有限时模拟中断，检查点落盘等待续跑。
 */
export function deactivateLineageNode(sourceId: number, maxSteps: number = Number.POSITIVE_INFINITY): DeactivateOutcome {
  const rows = listRows(LINEAGE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === sourceId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${sourceId} 的血缘节点` }
  }
  const sourceRow = rows[index]
  const sourceName = String(sourceRow.节点名称 ?? '')
  const version = String(sourceRow.图谱版本 ?? effectiveVersion(rows) ?? '')
  const eventId = eventIdOf(sourceId, rows)
  const existing = readEvents().find((event) => event.eventId === eventId)

  // 幂等：同一停用事件只传播一次。
  if (existing && existing.status === 'finished') {
    return {
      ok: true,
      message: `节点「${sourceName}」的停用传播已完成，重复触发不再二次传播`,
      event: existing,
    }
  }

  // 首次触发：先把源节点本身置为已停用（源节点不是「下游待校验节点」）。
  let baseRows = rows
  if (String(sourceRow.status) !== LINEAGE_STATUS.disabled) {
    baseRows = [...rows]
    baseRows[index] = {
      ...sourceRow,
      status: LINEAGE_STATUS.disabled,
      pending: false,
      abnormal: true,
    }
  }

  const checkpoint = existing?.checkpoint ?? null
  const { step, nextCheckpoint } = advancePropagation(baseRows, checkpoint, sourceName, maxSteps)
  saveRows(LINEAGE_KEY, step.rows)

  // 清洗层跨模块结果只按可达下游标记；已完成事件的银层标记也只做一次。
  let affectedSilverIds = existing?.affectedSilverIds ?? []
  if (step.finished && affectedSilverIds.length === 0) {
    affectedSilverIds = markReachableSilver([sourceName, ...step.impacted])
  }

  const now = new Date().toISOString()
  const event: LineageEvent = {
    eventId,
    sourceId,
    sourceName,
    version,
    status: step.finished ? 'finished' : 'interrupted',
    impacted: step.impacted,
    skippedDisabled: step.skippedDisabled,
    skippedVersionMismatch: step.skippedVersionMismatch,
    skippedMissing: step.skippedMissing,
    affectedSilverIds,
    lastConfirmed: step.lastConfirmed,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    checkpoint: nextCheckpoint,
  }
  upsertEvent(event)

  const verb = existing ? '续跑' : '传播'
  const tail = step.finished
    ? `已完成：${step.impacted.length} 个可达下游标为待校验，联动清洗表 ${affectedSilverIds.length} 张`
    : `已中断：确认到节点「${step.lastConfirmed ?? sourceName}」，剩余分支待续跑`
  return {
    ok: true,
    message: `节点「${sourceName}」已停用，${verb}${tail}`,
    event,
    resumed: Boolean(existing),
  }
}

/** 从中断检查点继续传播；没有中断中的事件时返回提示。 */
export function resumeLineagePropagation(
  eventId: string,
  maxSteps: number = Number.POSITIVE_INFINITY,
): DeactivateOutcome {
  const events = readEvents()
  const event = events.find((item) => item.eventId === eventId)
  if (!event) {
    return { ok: false, message: '没有找到对应的停用传播事件' }
  }
  if (event.status === 'finished' || !event.checkpoint) {
    return { ok: true, message: `节点「${event.sourceName}」的传播已完成，无需续跑`, event }
  }
  const rows = listRows(LINEAGE_KEY)
  const { step, nextCheckpoint } = advancePropagation(rows, event.checkpoint, undefined, maxSteps)
  saveRows(LINEAGE_KEY, step.rows)

  let affectedSilverIds = event.affectedSilverIds
  if (step.finished && affectedSilverIds.length === 0) {
    affectedSilverIds = markReachableSilver([event.sourceName, ...step.impacted])
  }

  const next: LineageEvent = {
    ...event,
    status: step.finished ? 'finished' : 'interrupted',
    impacted: step.impacted,
    skippedDisabled: step.skippedDisabled,
    skippedVersionMismatch: step.skippedVersionMismatch,
    skippedMissing: step.skippedMissing,
    affectedSilverIds,
    lastConfirmed: step.lastConfirmed,
    checkpoint: nextCheckpoint,
    updatedAt: new Date().toISOString(),
  }
  upsertEvent(next)

  const tail = step.finished
    ? `续跑完成：累计 ${step.impacted.length} 个可达下游标为待校验，联动清洗表 ${affectedSilverIds.length} 张`
    : `续跑中断：已确认到节点「${step.lastConfirmed ?? event.sourceName}」，可再次续跑`
  return { ok: true, message: tail, event: next, resumed: true }
}

/** 按节点名称筛选并定位下游记录（只读，不改任何状态）。 */
export function locateDownstream(nodeName: string): ReachabilityPlan & { matched: EntryRow[] } {
  const rows = listRows(LINEAGE_KEY)
  const keyword = nodeName.trim()
  const matched = keyword
    ? rows.filter((row) => String(row.节点名称 ?? '').includes(keyword))
    : []
  if (matched.length === 0) {
    return {
      version: effectiveVersion(rows),
      source: keyword,
      impacted: [],
      skippedDisabled: [],
      skippedVersionMismatch: [],
      skippedMissing: [],
      unaffected: [],
      matched: [],
    }
  }
  const sourceName = String(matched[0].节点名称 ?? '')
  const plan = planReachable(rows, sourceName)
  return { ...plan, matched }
}

/** 节点重新启用：清掉它名下的停用事件台账，之后再次停用会作为新事件传播。 */
export function reenableLineageNode(sourceId: number): void {
  const events = readEvents()
  const rows = listRows(LINEAGE_KEY)
  const targetId = eventIdOf(sourceId, rows)
  const next = events.filter((event) => event.eventId !== targetId)
  if (next.length !== events.length) {
    writeEvents(next)
  }
}
