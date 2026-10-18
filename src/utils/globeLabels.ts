export interface GlobeLabel {
  key: string
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedGlobeLabel extends GlobeLabel {
  left: number
  top: number
}

export function placeGlobeLabels(labels: GlobeLabel[], width: number, height: number): PlacedGlobeLabel[] {
  const margin = 6
  const gap = 6
  const placed: PlacedGlobeLabel[] = []
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

  for (const label of labels) {
    if (label.width > width - margin * 2 || label.height > height - margin * 2)
      continue
    const maxLeft = width - margin - label.width
    const maxTop = height - margin - label.height
    const left = clamp(label.x + 10, margin, maxLeft)
    const top = clamp(label.y - label.height - 8, margin, maxTop)
    const xs = [left, clamp(label.x - label.width - 10, margin, maxLeft)]
    const ys = [top, ...placed.flatMap(other => [other.top + other.height + gap, other.top - label.height - gap])]
    const candidates = xs.flatMap(x => ys.map(y => ({ ...label, left: x, top: clamp(y, margin, maxTop) })))
    candidates.sort((a, b) => (a.left - left) ** 2 + (a.top - top) ** 2 - ((b.left - left) ** 2 + (b.top - top) ** 2))
    const candidate = candidates.find(box => placed.every(other =>
      box.left + box.width + gap <= other.left
      || other.left + other.width + gap <= box.left
      || box.top + box.height + gap <= other.top
      || other.top + other.height + gap <= box.top,
    ))
    // Crowded globes keep their markers, but never stack unreadable labels.
    if (candidate)
      placed.push(candidate)
  }
  return placed
}

export function sameGlobeLocation(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 0.0001 && Math.abs(a[1] - b[1]) < 0.0001
}
