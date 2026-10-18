import type { PingWindowPoint } from '@/utils/rpc'

export const THREE_NETWORKS = [
  { key: 'ct', label: '电信' },
  { key: 'cu', label: '联通' },
  { key: 'cm', label: '移动' },
] as const

export const NETWORK_BAR_COUNT = 20
export type NetworkMetric = 'latency' | 'loss'

export function validNetworkValue(value: number | null | undefined, metric: NetworkMetric): number | null {
  if (value === null || value === undefined || !Number.isFinite(value))
    return null
  return metric === 'latency'
    ? value > 0 ? value : null
    : value >= 0 && value <= 100 ? value : null
}

export function networkTone(value: number | null, metric: NetworkMetric): string {
  if (value === null)
    return 'bg-muted-foreground/15'
  const thresholds = metric === 'latency' ? [60, 120, 180, 240] : [1, 3, 6, 9]
  const colors = ['bg-emerald-600/90', 'bg-green-500/80', 'bg-lime-400/80', 'bg-yellow-400/80']
  const index = thresholds.findIndex(threshold => value <= threshold)
  return index >= 0 ? colors[index]! : 'bg-rose-500/80'
}

export function buildNetworkBars(history: PingWindowPoint[], key: string, metric: NetworkMetric) {
  const count = Math.min(NETWORK_BAR_COUNT, history.length)
  const padding = NETWORK_BAR_COUNT - count
  return Array.from({ length: NETWORK_BAR_COUNT }, (_, index) => {
    const bucket = index - padding
    const points = bucket < 0
      ? []
      : history.slice(
          Math.floor(bucket * history.length / count),
          Math.floor((bucket + 1) * history.length / count),
        )
    const values = points
      .map(point => validNetworkValue(point.networks?.[key]?.[metric], metric))
      .filter((value): value is number => value !== null)
    const value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : null
    return {
      key: `${key}-${metric}-${index}`,
      value,
      time: points.at(-1)?.time,
      className: networkTone(value, metric),
    }
  })
}
