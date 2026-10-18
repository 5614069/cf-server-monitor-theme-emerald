import { beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { useNodesStore } from '../src/stores/nodes'
import { adaptServer } from '../src/utils/api'
import { buildNetworkBars, validNetworkValue } from '../src/utils/networkQuality'

const start = Date.parse('2026-10-18T12:00:00Z')

beforeEach(() => setActivePinia(createPinia()))

describe('per-network latency and loss', () => {
  test('keeps each provider separate and aligns loss-only samples by time', () => {
    const { status } = adaptServer({
      id: 'test',
      ping: [{ ts: start, ct: 120, cu: 240, cm: 360, bd: false }],
      loss: [{ ts: start, ct: 0, cu: 5, cm: 100 }, { ts: start + 60_000, ct: 0 }],
    }, 0)
    expect(status.pingWindow).toHaveLength(2)
    expect(status.pingWindow?.[0]?.networks?.ct).toEqual({ latency: 120, loss: 0 })
    expect(status.pingWindow?.[0]?.networks?.cu).toEqual({ latency: 240, loss: 5 })
    expect(status.pingWindow?.[0]?.networks?.cm).toEqual({ latency: 360, loss: 100 })
    expect(status.pingWindow?.[1]?.networks?.ct).toEqual({ latency: null, loss: 0 })
  })

  test('does not turn missing data into a successful zero-loss reading', () => {
    const { status } = adaptServer({ id: 'test', ping_ct: 120, loss_ct: null, ping_cu: 'null', loss_cu: 100 }, 0)
    expect(status.ping?.ct?.lossAvailable).toBe(false)
    expect(status.ping?.cu?.latencyAvailable).toBe(false)
    expect(status.ping?.cu?.lossAvailable).toBe(true)
    expect(validNetworkValue(-1, 'latency')).toBeNull()
    expect(validNetworkValue(0, 'loss')).toBe(0)
    expect(validNetworkValue(100, 'loss')).toBe(100)
    expect(validNetworkValue(101, 'loss')).toBeNull()
    expect(validNetworkValue(Number.NaN, 'latency')).toBeNull()
  })

  test('keeps initial history and live updates separated by provider', () => {
    const store = useNodesStore()
    const { client, status } = adaptServer({
      id: 'test',
      last_updated: start,
      ping_ct: 120,
      loss_ct: 0,
      ping_cu: 240,
      loss_cu: 4,
      ping_cm: 360,
      loss_cm: 8,
      ping: [{ ts: start - 120_000, ct: 100, cu: 200, cm: 300 }],
      loss: [{ ts: start - 120_000, ct: 0, cu: 1, cm: 2 }],
    }, 0)
    store.initNodes({ [client.uuid]: client }, { [client.uuid]: status })
    store.updateNodeStatuses({ [client.uuid]: status })
    const points = store.pingHistoryByUuid[client.uuid]!
    expect(points).toHaveLength(2)
    expect(points[0]?.networks?.cu?.latency).toBe(200)
    expect(points[1]?.networks?.cu).toEqual({ latency: 240, loss: 4 })
    const next = adaptServer({ id: 'test', last_updated: start + 10_000, ping_ct: 'null', loss_ct: 100 }, 0).status
    store.updateNodeStatuses({ [client.uuid]: next })
    expect(store.pingHistoryByUuid[client.uuid]).toHaveLength(2)
    expect(store.pingHistoryByUuid[client.uuid]?.[1]?.networks?.ct).toEqual({ latency: null, loss: 100 })
    expect(store.pingHistoryByUuid[client.uuid]?.[1]?.networks?.cu?.latency).toBe(240)
  })

  test('uses exactly 20 stable slots without inventing samples', () => {
    const points = [{ time: new Date(start).toISOString(), latency: 120, loss: 0, networks: { ct: { latency: 120, loss: 0 } } }]
    const bars = buildNetworkBars(points, 'ct', 'loss')
    expect(bars).toHaveLength(20)
    expect(bars.slice(0, 19).every(bar => bar.value === null)).toBe(true)
    expect(bars[19]?.value).toBe(0)
    expect(bars[19]?.className).toContain('emerald')
    expect(buildNetworkBars(points, 'cu', 'loss').every(bar => bar.value === null)).toBe(true)
    expect(buildNetworkBars([], 'ct', 'latency').every(bar => bar.value === null)).toBe(true)
  })

  test('preserves provider detail when reducing longer windows', () => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      time: new Date(start + i * 60_000).toISOString(),
      latency: 200,
      loss: 10,
      networks: { ct: { latency: i, loss: 0 }, cu: { latency: i + 100, loss: 20 } },
    }))
    expect(buildNetworkBars(points, 'ct', 'loss').every(bar => bar.value === 0)).toBe(true)
    expect(buildNetworkBars(points, 'cu', 'loss').every(bar => bar.value === 20)).toBe(true)
  })

  test('retains the backend visibility switch and bounds live history', () => {
    const store = useNodesStore()
    store.configurePingHistory({ showThreeNetDetails: false, points: 2, hours: 1 })
    expect(store.showThreeNetDetails).toBe(false)
    for (let i = 0; i < 4; i++) {
      const { client, status } = adaptServer({ id: 'test', last_updated: start + i * 1_800_000, ping_ct: 120, loss_ct: 0 }, 0)
      store.recordPingSample(client.uuid, status)
    }
    expect(store.pingHistoryByUuid.test).toHaveLength(2)
  })
})
