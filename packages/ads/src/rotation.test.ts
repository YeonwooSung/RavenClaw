import { beforeEach, describe, expect, test } from 'bun:test'
import {
  ACTIVITY_WINDOW_MS,
  ROTATE_INTERVAL_MS,
  classifyClick,
  createRotationState,
  markActivity,
  recordImpression,
  resetRotationMounts,
  shouldRotate,
} from './rotation'

beforeEach(() => {
  resetRotationMounts()
})

describe('rotation', () => {
  test('pauses after 3 idle impressions; activity resets', () => {
    const state = createRotationState()
    expect(recordImpression(state, 'a', 0)).toBe(true)
    expect(recordImpression(state, 'b', ROTATE_INTERVAL_MS)).toBe(true)
    expect(recordImpression(state, 'c', ROTATE_INTERVAL_MS * 2)).toBe(true)
    expect(state.paused).toBe(true)
    expect(state.idleImpressions).toBe(3)
    expect(shouldRotate(state, ROTATE_INTERVAL_MS * 3)).toBe(false)

    markActivity(state, ROTATE_INTERVAL_MS * 3)
    expect(state.paused).toBe(false)
    expect(state.idleImpressions).toBe(0)
    expect(shouldRotate(state, ROTATE_INTERVAL_MS * 3)).toBe(true)
  })

  test('activity in the last 30s keeps impressions from counting as idle', () => {
    const state = createRotationState()
    markActivity(state, 1_000)
    expect(recordImpression(state, 'live', 1_000 + ACTIVITY_WINDOW_MS - 1)).toBe(true)
    expect(state.idleImpressions).toBe(0)
    expect(state.paused).toBe(false)
  })

  test('remount-dedupe ignores the same creative inside the rotate window', () => {
    const first = createRotationState()
    expect(recordImpression(first, 'dock', 0)).toBe(true)
    expect(recordImpression(first, 'dock', 10)).toBe(false)
    expect(first.idleImpressions).toBe(1)

    const remount = createRotationState()
    expect(recordImpression(remount, 'dock', 20)).toBe(false)
    expect(remount.idleImpressions).toBe(0)
  })

  test('clicks under 300 ms are labelled accidental, not dropped', () => {
    expect(classifyClick(0, 299)).toBe('accidental')
    expect(classifyClick(0, 300)).toBe('click')
    expect(classifyClick(1_000, 1_400)).toBe('click')
  })
})
