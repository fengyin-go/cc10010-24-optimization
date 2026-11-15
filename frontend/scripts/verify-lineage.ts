/**
 * 血缘传播需求核验脚本（node --experimental-strip-types scripts/verify-lineage.ts）。
 * 不依赖浏览器：用内存版 localStorage 跑通引擎 + 编排 + 跨模块联动全链路。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- 内存版 localStorage，必须在导入 local-store 之前挂好 ----
const memory = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
} as unknown as typeof window

import { SEED_ROWS } from '../src/data/seed.ts'
import { resetRows, listRows, saveRows } from '../src/data/local-store.ts'
import {
  advancePropagation,
  buildAdjacency,
  effectiveVersion,
  planReachable,
  splitNodeRefs,
  LINEAGE_STATUS,
} from '../src/data/lineage-graph.ts'
import {
  deactivateLineageNode,
  resumeLineagePropagation,
  locateDownstream,
  listLineageEvents,
  clearLineageEvents,
  markReachableSilver,
} from '../src/data/lineage-propagation.ts'
import type { EntryRow } from '../src/data/types.ts'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
function statusOf(rows: EntryRow[], nodeName: string): string {
  const row = rows.find((item) => String(item.节点名称) === nodeName && String(item.图谱版本) === effectiveVersion(rows))
  if (!row) {
    throw new Error(`缺少节点 ${nodeName}`)
  }
  return String(row.status)
}
function resetAll(): void {
  memory.clear()
  for (const key of Object.keys(SEED_ROWS)) {
    resetRows(key)
  }
  clearLineageEvents()
}

// ========== 1. 纯引擎：图构建与版本选择 ==========
console.log('\n[1] 生效版本与邻接表：旧版本关系不参与计算')
resetAll()
let rows = listRows('lineage')
check('生效版本取采集时间最新的 v2026.10', effectiveVersion(rows) === 'v2026.10')
const graph = buildAdjacency(rows)
const uniqueNodes = new Set(graph.edges.keys()).size
check('邻接表只收录生效版本节点（8 个）', uniqueNodes === 8, `实际 ${uniqueNodes}`)
check('旧版 ods_order→legacy_etl 关系被新版本覆盖（不含 legacy_etl 出边冲突）',
  JSON.stringify(graph.edges.get('ods_order')) === JSON.stringify(['dwd_order_detail', 'dim_channel']))
check('legacy_etl 不在生效版本图中', !graph.byName.has('legacy_etl'))
check('节点引用分隔解析', JSON.stringify(splitNodeRefs('a，b、c; d|e')) === JSON.stringify(['a', 'b', 'c', 'd', 'e']))

// ========== 2. 只标记可达节点；停用/版本不匹配分支跳过；无关分支保持 ==========
console.log('\n[2] 停用 ods_order：只标记可达下游，跳过停用与版本不匹配分支')
const plan = planReachable(rows, 'ods_order')
check('可达下游 = dwd_order_detail,dws_order_agg,ads_sales_report',
  JSON.stringify(plan.impacted) === JSON.stringify(['dwd_order_detail', 'dws_order_agg', 'ads_sales_report']),
  JSON.stringify(plan.impacted))
check('已停用分支 dim_channel 被跳过', plan.skippedDisabled.includes('dim_channel'))
check('版本不匹配分支 legacy_etl 被跳过（仅旧版本存在）', plan.skippedVersionMismatch.includes('legacy_etl'))
check('未受影响已启用节点包含 ods_user/dwd_user_info/ads_channel_report',
  ['ods_user', 'dwd_user_info', 'ads_channel_report'].every((n) => plan.unaffected.includes(n)))

const full = advancePropagation(rows, null, 'ods_order')
check('一次性传播 finished=true 且无检查点', full.step.finished && full.nextCheckpoint === null)
check('dwd_order_detail 标为待校验', statusOf(full.step.rows, 'dwd_order_detail') === LINEAGE_STATUS.pending)
check('dws_order_agg 标为待校验', statusOf(full.step.rows, 'dws_order_agg') === LINEAGE_STATUS.pending)
check('ads_sales_report 标为待校验', statusOf(full.step.rows, 'ads_sales_report') === LINEAGE_STATUS.pending)
check('停用节点 dim_channel 保持已停用', statusOf(full.step.rows, 'dim_channel') === LINEAGE_STATUS.disabled)
check('停用节点下游 ads_channel_report 保持已启用（不跨停用点传播）',
  statusOf(full.step.rows, 'ads_channel_report') === LINEAGE_STATUS.enabled)
check('无关分支 ods_user 保持已启用', statusOf(full.step.rows, 'ods_user') === LINEAGE_STATUS.enabled)
check('无关分支 dwd_user_info 保持已启用', statusOf(full.step.rows, 'dwd_user_info') === LINEAGE_STATUS.enabled)
const archived = full.step.rows.filter((r) => String(r.图谱版本) === 'v2026.09')
check('旧版本 3 条记录全部原样留档（仍为已停用，关系字段未改）',
  archived.length === 3 && archived.every((r) => r.status === LINEAGE_STATUS.disabled) &&
  String(archived.find((r) => String(r.节点名称) === 'legacy_etl')!.下游节点列表) === 'legacy_report')

// ========== 3. 中断 + 检查点续传：不整体重算 ==========
console.log('\n[3] 传播中断后从最后确认节点续跑，已确认节点不重新计算')
resetAll()
rows = listRows('lineage')
const round1 = advancePropagation(rows, null, 'ods_order', 1)
check('每轮 1 个节点：首轮中断且留下检查点', !round1.step.finished && round1.nextCheckpoint !== null)
check('首轮只确认 dwd_order_detail', JSON.stringify(round1.step.confirmedThisRound) === JSON.stringify(['dwd_order_detail']))
check('检查点记录最后确认节点', round1.nextCheckpoint!.lastConfirmed === 'dwd_order_detail')
check('首轮中断时 dws/ads 仍是已启用（没被提前改动）',
  statusOf(round1.step.rows, 'dws_order_agg') === LINEAGE_STATUS.enabled &&
  statusOf(round1.step.rows, 'ads_sales_report') === LINEAGE_STATUS.enabled)
const round2 = advancePropagation(round1.step.rows, round1.nextCheckpoint, undefined, 1)
check('第二轮确认 dws_order_agg', JSON.stringify(round2.step.confirmedThisRound) === JSON.stringify(['dws_order_agg']))
check('已确认的 dwd_order_detail 不在第二轮结果里重复确认',
  !round2.step.confirmedThisRound.includes('dwd_order_detail'))
check('第二轮仍中断，最后确认节点推进到 dws_order_agg', round2.nextCheckpoint?.lastConfirmed === 'dws_order_agg')
const round3 = advancePropagation(round2.step.rows, round2.nextCheckpoint)
check('第三轮跑完且检查点清空', round3.step.finished && round3.nextCheckpoint === null)
check('累计 impacted 与一次性传播完全一致',
  JSON.stringify(round3.step.impacted.sort()) === JSON.stringify([...plan.impacted].sort()))
check('续跑结果与一次性传播的最终状态一致',
  ['dwd_order_detail', 'dws_order_agg', 'ads_sales_report'].every((n) => statusOf(round3.step.rows, n) === LINEAGE_STATUS.pending) &&
  ['ods_user', 'dwd_user_info', 'ads_channel_report'].every((n) => statusOf(round3.step.rows, n) === LINEAGE_STATUS.enabled))

// ========== 4. 编排层：幂等、断点续传 API、源节点状态 ==========
console.log('\n[4] 停用事件编排：重复触发只传播一次，续跑复用同一事件')
resetAll()
const first = deactivateLineageNode(1, 1)
check('首次停用返回中断事件', first.ok && first.event?.status === 'interrupted')
check('源节点 ods_order 已置为已停用', statusOf(listRows('lineage'), 'ods_order') === LINEAGE_STATUS.disabled)
const eventId = first.event!.eventId
const again = deactivateLineageNode(1, 1)
check('对已停用源节点重复触发：事件数不增加（仍只有 1 条）', listLineageEvents().length === 1)
check('重复触发复用同一 eventId 且不产生新确认', again.event?.eventId === eventId)
const resumed = resumeLineagePropagation(eventId)
check('续跑完成同一事件', resumed.ok && resumed.event?.status === 'finished' && resumed.event?.eventId === eventId)
check('台账始终只有一条事件（幂等）', listLineageEvents().length === 1)
const afterFinish = deactivateLineageNode(1)
check('完成后再次触发直接幂等返回，不二次传播', afterFinish.ok && afterFinish.event?.status === 'finished' &&
  listLineageEvents().length === 1)

// ========== 5. 跨模块清洗结果：只标记可达下游 ==========
console.log('\n[5] 跨模块：清洗层 silver 只标记可达下游')
resetAll()
deactivateLineageNode(1)
const silver = listRows('silver')
const silverStatus = (id: number) => String(silver.find((r) => Number(r.id) === id)!.status)
check('SILV-0001（上游 ods_order）标待校验', silverStatus(1) === LINEAGE_STATUS.pending)
check('SILV-0002（上游 dwd_order_detail）标待校验', silverStatus(2) === LINEAGE_STATUS.pending)
check('SILV-0003（上游 dws_order_agg）标待校验', silverStatus(3) === LINEAGE_STATUS.pending)
check('SILV-0004（上游 ods_user，无关分支）保持已启用', silverStatus(4) === LINEAGE_STATUS.enabled)

console.log('\n[6] 已停用清洗表不被跨模块标记改写')
resetAll()
const silverRows = listRows('silver').map((r) =>
  Number(r.id) === 3 ? { ...r, status: LINEAGE_STATUS.disabled, pending: false } : r)
saveRows('silver', silverRows)
const ids = markReachableSilver(['ods_order', 'dwd_order_detail', 'dws_order_agg'])
check('已停用的 SILV-0003 不在联动标记名单里', !ids.includes(3))
check('已停用清洗表状态保持已停用',
  String(listRows('silver').find((r) => Number(r.id) === 3)!.status) === LINEAGE_STATUS.disabled)

// ========== 7. 按节点名称筛选定位下游（只读） ==========
console.log('\n[7] 按节点名称筛选并定位下游记录')
resetAll()
const located = locateDownstream('ods_order')
check('名称命中生效版本节点', located.matched.some((r) => String(r.节点名称) === 'ods_order' && String(r.图谱版本) === 'v2026.10'))
check('定位结果给出可达下游清单', JSON.stringify(located.impacted) === JSON.stringify(['dwd_order_detail', 'dws_order_agg', 'ads_sales_report']))
const miss = locateDownstream('不存在的节点')
check('查无名称时 matched 为空且不抛异常', miss.matched.length === 0 && miss.impacted.length === 0)
check('定位是只读操作：节点状态未被改动',
  statusOf(listRows('lineage'), 'dwd_order_detail') === LINEAGE_STATUS.enabled)

// ========== 8. 旧版本冲突以当前生效图谱为准 ==========
console.log('\n[8] 新旧版本冲突以当前已生效图谱为准，旧关系留档')
resetAll()
rows = listRows('lineage')
const conflictPlan = planReachable(rows, 'ods_order')
check('按新版本传播：legacy_etl 不计入可达，dwd_order_detail 计入可达',
  !conflictPlan.impacted.includes('legacy_etl') && conflictPlan.impacted.includes('dwd_order_detail'))
const oldRows = rows.filter((r) => String(r.图谱版本) === 'v2026.09')
check('旧版 ods_order 的下游仍是 legacy_etl（当时关系留档）',
  String(oldRows.find((r) => String(r.节点名称) === 'ods_order')!.下游节点列表) === 'legacy_etl')

// 导出一份最终内存态，方便人工核对
const outDir = mkdtempSync(join(tmpdir(), 'lineage-verify-'))
writeFileSync(join(outDir, 'lineage-after.json'), JSON.stringify(listRows('lineage'), null, 2))
writeFileSync(join(outDir, 'silver-after.json'), JSON.stringify(listRows('silver'), null, 2))

console.log(`\n结果：${passed} 通过 / ${failed} 失败；状态快照目录 ${outDir}`)
if (failed > 0) {
  process.exitCode = 1
}
