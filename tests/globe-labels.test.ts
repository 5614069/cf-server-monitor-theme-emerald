import type { PlacedGlobeLabel } from '../src/utils/globeLabels'
import { describe, expect, test } from 'bun:test'
import { placeGlobeLabels, sameGlobeLocation } from '../src/utils/globeLabels'

function overlap(a: PlacedGlobeLabel, b: PlacedGlobeLabel): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left
    && a.top < b.top + b.height && a.top + a.height > b.top
}

describe('globe labels', () => {
  test('separates nearby Japan and Korea labels without moving their anchors', () => {
    const labels = placeGlobeLabels([
      { key: 'JP', x: 75, y: 116, width: 96, height: 32 },
      { key: 'KR', x: 72, y: 112, width: 96, height: 32 },
    ], 408, 408)
    expect(labels).toHaveLength(2)
    expect(overlap(labels[0]!, labels[1]!)).toBe(false)
    expect(labels[1]?.x).toBe(72)
    expect(labels[1]?.y).toBe(112)
  })

  test('keeps rotating labels inside mobile and desktop bounds', () => {
    for (const width of [288, 326, 358, 408, 448]) {
      for (let frame = 0; frame < 32; frame++) {
        const x = (Math.sin(frame / 5) + 1) * width / 2
        const labels = placeGlobeLabels(['JP', 'KR', 'SG', 'US'].map((key, i) => ({
          key,
          x: x + i * 3,
          y: frame / 32 * width + i * 2,
          width: 96,
          height: 32,
        })), width, width)
        expect(labels).toHaveLength(4)
        for (const [i, label] of labels.entries()) {
          expect(label.left).toBeGreaterThanOrEqual(0)
          expect(label.top).toBeGreaterThanOrEqual(0)
          expect(label.left + label.width).toBeLessThanOrEqual(width)
          expect(label.top + label.height).toBeLessThanOrEqual(width)
          expect(labels.slice(i + 1).some(other => overlap(label, other))).toBe(false)
        }
      }
    }
  })

  test('does not stack labels when there is no remaining space', () => {
    const labels = placeGlobeLabels(Array.from({ length: 20 }, (_, i) => ({
      key: `${i}`,
      x: 60,
      y: 50,
      width: 96,
      height: 32,
    })), 120, 100)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.length).toBeLessThan(20)
    expect(labels.every((label, i) => labels.slice(i + 1).every(other => !overlap(label, other)))).toBe(true)
  })

  test('handles empty or unmeasured containers', () => {
    expect(placeGlobeLabels([], 0, 0)).toEqual([])
    expect(placeGlobeLabels([{ key: 'JP', x: 0, y: 0, width: 96, height: 32 }], 0, 0)).toEqual([])
  })

  test('detects identical endpoints without conflating neighboring countries', () => {
    expect(sameGlobeLocation([36.2, 138.2], [36.2, 138.2])).toBe(true)
    expect(sameGlobeLocation([36.2, 138.2], [36.20001, 138.20001])).toBe(true)
    expect(sameGlobeLocation([36.2, 138.2], [35.9, 127.8])).toBe(false)
  })
})
