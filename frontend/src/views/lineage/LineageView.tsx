import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  lineageEvents,
  listEntries,
  locateLineageDownstream,
  moduleMeta,
  resumeLineage,
  runAction as applyAction,
} from '@/api/local-service'
import { effectiveVersion } from '@/data/lineage-graph'
import type { EntryRow } from '@/data/types'
import type { LineageEvent } from '@/data/lineage-propagation'

const meta = moduleMeta('lineage')
const columns = [
  "节点编号",
  "节点类型",
  "节点名称",
  "上游节点列表",
  "下游节点列表",
  "转换说明",
  "采集时间",
  "图谱版本"
]
const actions = [
  "提交校验",
  "启用节点",
  "停用节点"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]

type LocateResult = ReturnType<typeof locateLineageDownstream>

export default function LineageView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [events, setEvents] = useState<LineageEvent[]>([])
  const [locateName, setLocateName] = useState('')
  const [locateResult, setLocateResult] = useState<LocateResult | null>(null)
  // 每轮最多确认几个节点：留空表示一口气传播完；填数字可模拟传播中断并验证断点续传。
  const [stepLimit, setStepLimit] = useState('')
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setEvents(lineageEvents())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '血缘图谱列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const currentVersion = useMemo(() => effectiveVersion(rows), [rows])
  const effectiveRows = useMemo(
    () => rows.filter((row) => String(row.图谱版本 ?? '') === currentVersion),
    [rows, currentVersion],
  )
  const archivedCount = rows.length - effectiveRows.length

  const stats = useMemo(() => [
    { label: '血缘节点总数', value: effectiveRows.length },
    { label: '已启用节点', value: effectiveRows.filter((row) => row.status === '已启用').length },
    { label: '待校验节点', value: effectiveRows.filter((row) => row.status === '待校验').length },
  ], [effectiveRows])

  // 历次停用事件已确认的可达下游：表格里高亮，证明只有可达节点被改过状态。
  const impactedNames = useMemo(() => {
    const set = new Set<string>()
    for (const event of events) {
      event.impacted.forEach((name) => set.add(name))
    }
    return set
  }, [events])

  function parseStepLimit(): number {
    const value = Number(stepLimit.trim())
    return Number.isInteger(value) && value > 0 ? value : Number.POSITIVE_INFINITY
  }

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action, parseStepLimit())
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
    setNotice(result.message)
  }

  function handleResume(eventId: string) {
    setErrorMessage('')
    setNotice('')
    const result = resumeLineage(eventId, parseStepLimit())
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
    setNotice(result.message)
  }

  function handleLocate() {
    setErrorMessage('')
    setNotice('')
    const result = locateLineageDownstream(locateName)
    if (result.matched.length === 0) {
      setErrorMessage(`没有找到名称包含「${locateName.trim()}」的血缘节点`)
      setLocateResult(null)
      return
    }
    setLocateResult(result)
  }

  return (
    <section className="page" data-module="lineage">
      <header className="page-head">
        <div>
          <h2>血缘图谱管理</h2>
          <p className="page-desc">
            停用上游节点时只沿当前已生效图谱（{currentVersion ?? '—'}）向下游做可达性传播：
            仅真正可达的已启用节点标为待校验，已停用分支与版本不匹配分支跳过，无关分支保持原状态。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('血缘节点登记入口尚未接入审批流')}>
            登记血缘节点
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出血缘图谱清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
        <article className="stat-card">
          <span className="stat-label">历史版本留档节点</span>
          <strong className="stat-value">{archivedCount}</strong>
        </article>
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{effectiveRows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <div className="lineage-panel">
        <h3>下游影响定位</h3>
        <div className="filter-bar">
          <label className="filter-item">
            <span>节点名称</span>
            <input
              value={locateName}
              placeholder="按节点名称筛选并定位下游记录，如 ods_order"
              onChange={(event) => setLocateName(event.target.value)}
            />
          </label>
          <button className="btn primary" type="button" onClick={handleLocate}>定位下游</button>
          <button className="btn ghost" type="button" onClick={() => { setLocateName(''); setLocateResult(null) }}>
            清空定位
          </button>
        </div>
        {locateResult && (
          <div className="locate-result">
            <p>
              生效版本 <strong>{locateResult.version}</strong> 下，节点
              <strong> {locateResult.source} </strong>的传播分析（只读，不改变节点状态）：
            </p>
            <ul>
              <li>可达下游（停用后会标待校验）：{locateResult.impacted.join('、') || '无'}</li>
              <li>已停用/非启用分支（跳过，不向下扩散）：{locateResult.skippedDisabled.join('、') || '无'}</li>
              <li>版本不匹配分支（仅旧图谱存在，按旧关系留档）：{locateResult.skippedVersionMismatch.join('、') || '无'}</li>
              <li>悬空引用（图谱中不存在）：{locateResult.skippedMissing.join('、') || '无'}</li>
              <li>未受影响的已启用节点（保持原状态）：{locateResult.unaffected.join('、') || '无'}</li>
            </ul>
          </div>
        )}
      </div>

      <div className="lineage-panel">
        <h3>停用传播台账</h3>
        <div className="filter-bar">
          <label className="filter-item">
            <span>每轮确认节点上限（留空=一次性传播完）</span>
            <input
              value={stepLimit}
              placeholder="例如 1，触发停用后可在台账里断点续传"
              onChange={(event) => setStepLimit(event.target.value)}
            />
          </label>
        </div>
        {events.length === 0 ? (
          <p className="page-desc">暂无停用事件。对节点执行「停用节点」后，传播过程、检查点与联动清洗结果会记录在这里。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>停用节点</th>
                <th>图谱版本</th>
                <th>传播状态</th>
                <th>最后确认节点</th>
                <th>已标记待校验的可达下游</th>
                <th>跳过的分支</th>
                <th>联动清洗表（silver）</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td>{event.sourceName}</td>
                  <td>{event.version}</td>
                  <td>
                    <span className={event.status === 'finished' ? 'badge ok' : 'badge warn'}>
                      {event.status === 'finished' ? '已完成' : '中断待续跑'}
                    </span>
                  </td>
                  <td>{event.lastConfirmed ?? '—'}</td>
                  <td>{event.impacted.join('、') || '—'}</td>
                  <td>
                    {[
                      ...event.skippedDisabled.map((name) => `${name}(停用)`),
                      ...event.skippedVersionMismatch.map((name) => `${name}(版本不匹配)`),
                      ...event.skippedMissing.map((name) => `${name}(悬空)`),
                    ].join('、') || '—'}
                  </td>
                  <td>{event.affectedSilverIds.length > 0 ? `SILV-${event.affectedSilverIds.map((id) => String(id).padStart(4, '0')).join('、SILV-')}` : '—'}</td>
                  <td className="row-actions">
                    {event.status === 'interrupted' && (
                      <button className="link" type="button" onClick={() => handleResume(event.eventId)}>
                        从检查点续跑
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isArchived = String(row.图谱版本 ?? '') !== currentVersion
            const isImpacted = impactedNames.has(String(row.节点名称 ?? ''))
            return (
              <tr
                key={String(row.id)}
                className={isArchived ? 'row-archived' : isImpacted ? 'row-impacted' : ''}
              >
                {columns.map((column) => (
                  <td key={column}>
                    {row[column] === '' || row[column] === undefined || row[column] === null ? '—' : row[column]}
                    {column === '图谱版本' && isArchived && <span className="badge muted"> 历史留档</span>}
                    {column === '节点名称' && isImpacted && <span className="badge warn"> 传播命中</span>}
                  </td>
                ))}
                <td>{row.status}</td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无血缘图谱数据，可先登记血缘节点</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条血缘图谱记录（当前生效版本 {effectiveRows.length} 条，历史留档 {archivedCount} 条）</span>
        <span>
          {notice && <span className="notice-text">{notice}</span>}
          {errorMessage && <span className="error-text">{errorMessage}</span>}
        </span>
      </footer>
    </section>
  )
}
