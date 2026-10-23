// The arrow-key menu (src/select.ts), driven through readline's own keypress
// decoding over a fake terminal: the keys a person presses, and that raw
// mode, the keypress listener and the cursor are put back on every way out.

import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PromptCancelled } from '../src/io'
import { selectMenu } from '../src/select'

const UP = '\u001b[A'
const DOWN = '\u001b[B'
const CHOICES = ['This project (~/proj)', 'Every project on this computer']

/** A terminal: input that records raw mode, output that keeps what was drawn. */
function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    rawCalls: [] as boolean[],
    setRawMode(mode: boolean) {
      this.isRaw = mode
      this.rawCalls.push(mode)
      return this
    },
  })
  let drawn = ''
  const output = new Writable({
    write(chunk, _enc, done) {
      drawn += String(chunk)
      done()
    },
  })
  return { input, output, drawn: () => drawn }
}

/** Open the menu, press `keys` one at a time, and settle. */
async function press(keys: string[], initial = 0, color = false) {
  const t = terminal()
  const result = selectMenu(t.input, t.output, 'Install it in:', CHOICES, { initial, color }).then(
    (pick) => ({ pick }),
    (error: unknown) => ({ error })
  )
  for (const key of keys) {
    t.input.write(key)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { ...(await result), ...t }
}

/** What a person sees: the drawing with every escape code removed. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')

describe('selectMenu', () => {
  it.each<[string, string[], number]>([
    ['Enter: the start row', ['\r'], 0],
    ['Down, Enter', [DOWN, '\r'], 1],
    ['j, Enter', ['j', '\r'], 1],
    ['Down, Up, Enter', [DOWN, UP, '\r'], 0],
    ['Down, k, Enter', [DOWN, 'k', '\r'], 0],
    ['Down twice wraps to the top', [DOWN, DOWN, '\r'], 0],
    ['Up from the top wraps to the bottom', [UP, '\r'], 1],
    ['2, Enter', ['2', '\r'], 1],
    ['2, 1, Enter', ['2', '1', '\r'], 0],
    ['a row number that does not exist is ignored', ['9', '\r'], 0],
    ['other keys are ignored', ['x', ' ', '\r'], 0],
  ])('%s', async (_label, keys, want) => {
    const r = await press(keys)
    expect(r).toMatchObject({ pick: want })
    expect(r.input.rawCalls).toEqual([true, false])
    expect(r.input.isRaw).toBe(false)
    expect(r.input.listenerCount('keypress')).toBe(0)
  })

  it('starts on the row it is given', async () => {
    expect(await press(['\r'], 1)).toMatchObject({ pick: 1 })
  })

  it('draws the rows with a marker, then collapses to one line and shows the cursor', async () => {
    const r = await press([DOWN, '\r'])
    const drawn = r.drawn()
    expect(drawn.startsWith('\u001b[?25l')).toBe(true)
    expect(drawn.endsWith('Install it in: Every project on this computer\n\u001b[?25h')).toBe(true)
    // First frame: the marker on the first row; bold, since colour is off.
    expect(drawn).toContain('\u001b[1m> This project (~/proj)\u001b[0m\n')
    expect(drawn).toContain('  Every project on this computer\n')
    expect(drawn).toContain('(Use the arrow keys, then Enter)\n')
    // After Down: the marker moved to the second row.
    expect(drawn).toContain('\u001b[1m> Every project on this computer\u001b[0m\n')
    expect(plain(drawn)).toContain('Install it in:\n> This project (~/proj)\n  Every project on this computer\n(Use the arrow keys, then Enter)\n')
  })

  it('marks the row in the brand colour when colour is on', async () => {
    const r = await press(['\r'], 0, true)
    expect(r.drawn()).toContain('\u001b[1;38;5;202m> This project (~/proj)\u001b[0m')
    const t = terminal()
    const done = selectMenu(t.input, t.output, 'Install it in:', CHOICES, { color: true, trueColor: true })
    t.input.write('\r')
    await done
    expect(t.drawn()).toContain('\u001b[1;38;2;253;75;3m> This project (~/proj)\u001b[0m')
  })

  it.each<[string, string]>([
    ['Ctrl+C', '\u0003'],
    ['Ctrl+D', '\u0004'],
  ])('%s rejects with PromptCancelled and restores the terminal', async (_label, key) => {
    const r = await press([DOWN, key])
    expect((r as { error?: unknown }).error).toBeInstanceOf(PromptCancelled)
    expect(r.input.rawCalls).toEqual([true, false])
    expect(r.input.listenerCount('keypress')).toBe(0)
    expect(r.drawn().endsWith('\u001b[?25h')).toBe(true)
  })

  it('a SIGINT sent to the process cancels and restores the terminal', async () => {
    const t = terminal()
    const before = process.listenerCount('SIGINT')
    const result = selectMenu(t.input, t.output, 'Install it in:', CHOICES).catch((e: unknown) => e)
    expect(process.listenerCount('SIGINT')).toBe(before + 1)
    process.emit('SIGINT')
    expect(await result).toBeInstanceOf(PromptCancelled)
    expect(t.input.rawCalls).toEqual([true, false])
    expect(process.listenerCount('SIGINT')).toBe(before)
    expect(t.drawn().endsWith('\u001b[?25h')).toBe(true)
  })

  it('an input error rejects with it and restores the terminal', async () => {
    const t = terminal()
    const result = selectMenu(t.input, t.output, 'Install it in:', CHOICES).catch((e: unknown) => e)
    t.input.emit('error', new Error('terminal closed'))
    expect(((await result) as Error).message).toBe('terminal closed')
    expect(t.input.rawCalls).toEqual([true, false])
    expect(t.input.listenerCount('keypress')).toBe(0)
  })

  it('puts back raw mode as it found it', async () => {
    const t = terminal()
    t.input.isRaw = true
    const done = selectMenu(t.input, t.output, 'Install it in:', CHOICES)
    t.input.write('\r')
    await done
    expect(t.input.rawCalls).toEqual([true, true])
  })
})
