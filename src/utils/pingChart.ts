import type { PingRecord } from '@/utils/rpc'
import { cutPeakValues, interpolateNullsLinear } from '@/utils/recordHelper'

export interface PingChartRecord extends PingRecord {
  metric?: 'latency' | 'loss'
}

export interface PingChartRow {
  time: string
  [key: string]: string | number | null
}

export function lossKey(taskId: number): string {
  return `loss_${taskId}`
}

export function pingMetric(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean')
    return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function mergePingChartRecords(records: PingChartRecord[], toleranceMs: number, hours: number): PingChartRow[] {
  const rows: PingChartRow[] = []
  const ordered = records.map(record => ({ record, ts: Date.parse(record.time) }))
    .filter(item => Number.isFinite(item.ts))
    .sort((a, b) => a.ts - b.ts)
  let anchor = -Infinity
  for (const { record, ts } of ordered) {
    if (ts - anchor > toleranceMs) {
      anchor = ts
      rows.push({ time: new Date(ts).toISOString() })
    }
    const row = rows.at(-1)!
    const loss = pingMetric(record.loss)
    if (record.metric !== 'loss') {
      const latency = pingMetric(record.value)
      row[record.task_id] = latency !== undefined && latency >= 0 && loss !== 100 ? latency : null
    }
    if (loss !== undefined && loss >= 0 && loss <= 100)
      row[lossKey(record.task_id)] = loss
    if (loss === 100)
      row[record.task_id] = null
  }
  const end = rows.at(-1)
  if (!end)
    return rows
  const from = Date.parse(end.time) - hours * 3600_000
  const first = rows.findIndex(row => Date.parse(row.time) >= from)
  return rows.slice(Math.max(0, first - 1))
}

export function preparePingChartRows(rows: PingChartRow[], taskIds: number[], smooth: boolean): PingChartRow[] {
  if (!taskIds.length)
    return []
  const keys = taskIds.map(String)
  const smoothed = smooth ? cutPeakValues(rows, keys) : rows
  const data = interpolateNullsLinear(smoothed, keys, {
    maxGapMultiplier: 6,
    minCapMs: 2 * 60_000,
    maxCapMs: 30 * 60_000,
  }) as PingChartRow[]
  // Explicit timeouts stay gaps; smoothing never invents latency during an outage.
  return data.map((row, index) => {
    const result = { ...row }
    for (const key of keys) {
      if (rows[index]?.[key] === null)
        result[key] = null
    }
    return result
  })
}

export function buildPingMetricSeries(
  tasks: Array<{ id: number, name: string }>,
  rows: PingChartRow[],
  options: { showDelay: boolean, showLoss: boolean, smooth: boolean, colorFor: (id: number) => string },
) {
  return tasks.flatMap((task) => {
    const color = options.colorFor(task.id)
    const common = { name: task.name, type: 'line' as const, connectNulls: false, itemStyle: { color } }
    return [
      ...(options.showDelay
        ? [{
            ...common,
            id: `latency-${task.id}`,
            yAxisIndex: 0,
            data: rows.map(row => row[task.id] as number | null ?? null),
            smooth: options.smooth ? 0.6 : 0.1,
            showSymbol: rows.length === 1,
            symbolSize: 4,
            lineStyle: { width: 1.5, color },
          }]
        : []),
      ...(options.showLoss
        ? [{
            ...common,
            id: `loss-${task.id}`,
            yAxisIndex: 1,
            data: rows.map(row => row[lossKey(task.id)] as number | null ?? null),
            smooth: false,
            step: 'end' as const,
            showSymbol: rows.length === 1,
            symbolSize: 4,
            lineStyle: { width: 2, color, type: options.showDelay ? 'dashed' as const : 'solid' as const },
          }]
        : []),
    ]
  })
}

export function buildPingMetricAxes(showDelay: boolean, showLoss: boolean) {
  return [
    { id: 'latency-axis', name: '延迟 (ms)', show: showDelay, position: 'left' as const, min: 0 },
    { id: 'loss-axis', name: '丢包 (%)', show: showLoss, position: showDelay ? 'right' as const : 'left' as const, min: 0, max: 100 },
  ]
}
