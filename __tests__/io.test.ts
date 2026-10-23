// The real process boundary's install guard: Ctrl+C is held while files are
// written, then handed back.

import { describe, expect, it } from 'vitest'
import { realIo } from '../src/io'

const nextTick = () => new Promise((resolve) => setImmediate(resolve))

describe('realIo().uninterruptible', () => {
  it('holds SIGINT while it runs, returns the result, then gives SIGINT back', async () => {
    const before = process.listenerCount('SIGINT')
    let during = -1
    expect(
      realIo().uninterruptible(() => {
        during = process.listenerCount('SIGINT')
        return 42
      })
    ).toBe(42)
    expect(during).toBe(before + 1)
    await nextTick()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('gives SIGINT back when the writes throw', async () => {
    const before = process.listenerCount('SIGINT')
    expect(() =>
      realIo().uninterruptible(() => {
        throw new Error('disk full')
      })
    ).toThrow('disk full')
    await nextTick()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
