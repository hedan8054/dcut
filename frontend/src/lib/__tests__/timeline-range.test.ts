import { describe, expect, it } from 'vitest'
import {
  clampFocusIntoCoarse,
  clampRange,
  makeCenteredRange,
  rangeCenter,
  rangeSpan,
  type TimeRange,
} from '@/lib/timeline-range'

describe('timeline-range utilities', () => {
  it('rangeSpan/rangeCenter should compute deterministic values', () => {
    const range: TimeRange = [10, 30]
    expect(rangeSpan(range)).toBe(20)
    expect(rangeCenter(range)).toBe(20)
  })

  it('clampRange should keep values inside duration and satisfy min span', () => {
    expect(clampRange([-5, 8], 100, 20)).toEqual([0, 20])
    expect(clampRange([95, 120], 100, 10)).toEqual([90, 100])
  })

  it('clampRange should normalize reversed ranges', () => {
    expect(clampRange([80, 40], 100, 0)).toEqual([40, 80])
  })

  it('makeCenteredRange should honor duration boundaries', () => {
    expect(makeCenteredRange(5, 20, 100)).toEqual([0, 20])
    expect(makeCenteredRange(97, 20, 100)).toEqual([80, 100])
  })

  it('clampFocusIntoCoarse should fit focus window in coarse window', () => {
    const coarse: TimeRange = [100, 220]
    expect(clampFocusIntoCoarse([90, 130], coarse, 600, 20)).toEqual([100, 140])
    expect(clampFocusIntoCoarse([210, 260], coarse, 600, 20)).toEqual([170, 220])
  })

  it('clampFocusIntoCoarse should not exceed coarse span', () => {
    const coarse: TimeRange = [40, 60]
    expect(clampFocusIntoCoarse([0, 200], coarse, 300, 5)).toEqual([40, 60])
  })
})
