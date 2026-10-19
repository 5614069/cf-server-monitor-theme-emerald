import type { PingChartRecord } from '../src/utils/pingChart'
import { describe, expect, spyOn, test } from 'bun:test'
import { fetchPingHistory } from '../src/utils/api'
import { buildPingMetricAxes, buildPingMetricSeries, lossKey, mergePingChartRecords, pingMetric, preparePingChartRows } from '../src/utils/pingChart'

const start = Date.parse('2026-10-19T12:00:00Z')
const time = (offset = 0) => new Date(start + offset).toISOString()
const tasks = [{ id: 1, name: '电信' }, { id: 2, name: '联通' }, { id: 3, name: '移动' }]
const colorFor = (id: number) => ['red', 'green', 'blue'][id - 1]!

describe('ping chart metrics', () => {
  test('aligns separate latency and loss records, including loss-only timestamps', () => {
    const records: PingChartRecord[] = [
      { client: 'test', task_id: 1, time: time(), value: 120 },
      { client: 'test', task_id: 1, time: time(500), value: -1, metric: 'loss', loss: 0 },
      { client: 'test', task_id: 2, time: time(), value: 200, loss: 16 },
      { client: 'test', task_id: 1, time: time(60_000), value: -1, metric: 'loss', loss: 100 },
    ]
    const rows = mergePingChartRecords(records.reverse(), 1000, 1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ 1: 120, 2: 200, loss_1: 0, loss_2: 16 })
    expect(rows[1]).toMatchObject({ 1: null, loss_1: 100 })
  })

  test('distinguishes missing loss from valid zero and rejects invalid values', () => {
    for (const value of [null, undefined, '', false, true, Number.NaN, Infinity])
      expect(pingMetric(value)).toBeUndefined()
    expect(pingMetric(0)).toBe(0)
    const rows = mergePingChartRecords([
      { client: 'test', task_id: 1, time: time(), value: 120 },
      { client: 'test', task_id: 2, time: time(), value: 200, loss: 101 },
      { client: 'test', task_id: 3, time: time(), value: 250, loss: 0 },
    ], 1000, 1)
    expect(rows[0]?.loss_1).toBeUndefined()
    expect(rows[0]?.loss_2).toBeUndefined()
    expect(rows[0]?.loss_3).toBe(0)
  })

  test('renders zero, partial and total packet loss when latency is hidden', () => {
    const rows = [0, 16, 100].map((loss, i) => ({ time: time(i * 60_000), loss_1: loss }))
    const series = buildPingMetricSeries([tasks[0]!], rows, { showDelay: false, showLoss: true, smooth: true, colorFor })
    expect(series).toHaveLength(1)
    expect(series[0]?.id).toBe('loss-1')
    expect(series[0]?.data).toEqual([0, 16, 100])
    expect(series[0]?.yAxisIndex).toBe(1)
    expect(series[0]?.smooth).toBe(false)
    const axes = buildPingMetricAxes(false, true)
    expect(axes[0]?.show).toBe(false)
    expect(axes[1]).toMatchObject({ name: '丢包 (%)', position: 'left', min: 0, max: 100, show: true })
  })

  test('uses independent axes, stable series ids and provider colors in every mode', () => {
    const rows = [{ time: time(), 1: 120, loss_1: 0, 2: 200, loss_2: 4, 3: 250, loss_3: 8 }]
    const both = buildPingMetricSeries(tasks, rows, { showDelay: true, showLoss: true, smooth: false, colorFor })
    expect(both).toHaveLength(6)
    for (const task of tasks) {
      expect(both.find(series => series.id === `loss-${task.id}`)?.itemStyle.color).toBe(colorFor(task.id))
      expect(both.find(series => series.id === `latency-${task.id}`)?.yAxisIndex).toBe(0)
    }
    const delay = buildPingMetricSeries(tasks, rows, { showDelay: true, showLoss: false, smooth: true, colorFor })
    expect(delay.map(series => series.id)).toEqual(['latency-1', 'latency-2', 'latency-3'])
    expect(delay.every(series => series.smooth === 0.6)).toBe(true)
    expect(buildPingMetricAxes(true, false)[1]?.show).toBe(false)
    expect(buildPingMetricAxes(true, true)[1]?.position).toBe('right')
  })

  test('smooths latency without changing loss, raw records or outage gaps', () => {
    const rows = [100, 102, 100, 900, null, 108, 106].map((latency, i) => ({
      time: time(i * 60_000),
      1: latency,
      loss_1: i === 4 ? 100 : i * 2,
    }))
    const before = structuredClone(rows)
    const smoothed = preparePingChartRows(rows, [1], true)
    expect(smoothed.some((row, i) => row[1] !== rows[i]?.[1])).toBe(true)
    expect(smoothed[4]?.[1]).toBeNull()
    expect(smoothed.map(row => row[lossKey(1)])).toEqual(rows.map(row => row.loss_1))
    expect(rows).toEqual(before)
    expect(preparePingChartRows(rows, [], true)).toEqual([])
  })

  test('retains a bounded time window and ignores invalid timestamps', () => {
    const records = [-7_200_000, -3_660_000, 0].map(offset => ({ client: 'test', task_id: 1, time: time(offset), value: 120, loss: 0 }))
    records.push({ client: 'test', task_id: 1, time: 'invalid', value: 120, loss: 0 })
    const rows = mergePingChartRecords(records, 1000, 1)
    expect(rows.map(row => row.time)).toEqual([time(-3_660_000), time()])
  })

  test('the API adapter preserves missing packet loss instead of fabricating 0%', async () => {
    const request = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([
      { timestamp: start, ping_ct: 120, loss_ct: null, ping_cu: 200, loss_cu: 0, ping_cm: null, loss_cm: 100 },
    ]))
    try {
      const result = await fetchPingHistory('chart-test', 1)
      expect(result.records.find(record => record.task_id === 1)?.loss).toBeUndefined()
      expect(result.records.find(record => record.task_id === 2)?.loss).toBe(0)
      expect(result.records.find(record => record.task_id === 3)).toMatchObject({ value: -1, loss: 100 })
      expect(result.tasks.find(task => task.id === 1)?.loss).toBeUndefined()
    }
    finally {
      request.mockRestore()
    }
  })
})
