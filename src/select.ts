// src/select.ts
//
// An arrow-key menu for a terminal, on node:readline alone (no dependency).
// Up and Down (also k and j) move the marker, a digit jumps to that row,
// Enter picks. Ctrl+C or Ctrl+D rejects with PromptCancelled. Raw mode, the
// keypress listener and the cursor are restored on every way out: a pick,
// a cancel, an input error, and a SIGINT sent to the process. After a pick
// the menu collapses into one line, "<question> <choice>", so the scrollback
// stays short.

import { emitKeypressEvents } from 'node:readline'
import { PromptCancelled } from './io'

/** The input side: a terminal that can switch raw mode. */
export interface MenuInput extends NodeJS.ReadableStream {
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
}

/** How the menu looks. */
export interface MenuOptions {
  /** The row the marker starts on. */
  initial?: number
  /** Mark the row in the brand colour; without it, bold. */
  color?: boolean
  /** Use 24-bit colour (COLORTERM=truecolor); otherwise the nearest of 256. */
  trueColor?: boolean
}

/** A key as readline's keypress event reports it. */
interface Key {
  name?: string
  ctrl?: boolean
  sequence?: string
}

const HINT = '(Use the arrow keys, then Enter)'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const CLEAR_LINE = '\u001b[2K'
const CLEAR_DOWN = '\u001b[0J'
const up = (n: number) => `\u001b[${n}A`

/**
 * Show the menu on `output`, read keys from `input`, and resolve the picked
 * row. Rejects with PromptCancelled on Ctrl+C, Ctrl+D or SIGINT, and with the
 * error on an input error; raw mode and the cursor are restored first.
 */
export function selectMenu(
  input: MenuInput,
  output: NodeJS.WritableStream,
  question: string,
  choices: string[],
  options: MenuOptions = {}
): Promise<number> {
  let current = Math.min(Math.max(options.initial ?? 0, 0), choices.length - 1)
  // #fd4b03, the brand primary; 202 is its nearest 256-colour code.
  const on = options.color ? (options.trueColor ? '\u001b[1;38;2;253;75;3m' : '\u001b[1;38;5;202m') : '\u001b[1m'
  const off = '\u001b[0m'
  const row = (i: number) => (i === current ? `${on}> ${choices[i]}${off}` : `  ${choices[i]}`)
  const draw = () => choices.map((_, i) => `${CLEAR_LINE}\r${row(i)}\n`).join('') + `${CLEAR_LINE}\r${HINT}\n`
  const wasRaw = input.isRaw === true

  return new Promise<number>((resolve, reject) => {
    let done = false
    const finish = (outcome: { pick: number } | { error: Error }) => {
      if (done) return
      done = true
      input.removeListener('keypress', onKey)
      input.removeListener('error', onError)
      process.removeListener('SIGINT', onSigint)
      try {
        input.setRawMode?.(wasRaw)
      } catch {
        // The terminal is already gone; nothing to restore.
      }
      input.pause()
      if ('pick' in outcome) {
        // Collapse the question, the rows and the hint into one line.
        output.write(`${up(choices.length + 2)}\r${CLEAR_DOWN}${question} ${choices[outcome.pick]}\n${SHOW_CURSOR}`)
        resolve(outcome.pick)
      } else {
        output.write(SHOW_CURSOR)
        reject(outcome.error)
      }
    }
    const onKey = (text: string | undefined, key: Key | undefined) => {
      const name = key?.name ?? text
      if (key?.ctrl && (name === 'c' || name === 'd')) return finish({ error: new PromptCancelled() })
      if (name === 'return' || name === 'enter') return finish({ pick: current })
      let next = current
      if (name === 'up' || name === 'k') next = (current - 1 + choices.length) % choices.length
      else if (name === 'down' || name === 'j') next = (current + 1) % choices.length
      else if (text && /^[1-9]$/.test(text) && Number(text) <= choices.length) next = Number(text) - 1
      if (next === current) return
      current = next
      output.write(`${up(choices.length + 1)}${draw()}`)
    }
    const onError = (err: Error) => finish({ error: err })
    const onSigint = () => finish({ error: new PromptCancelled() })

    try {
      emitKeypressEvents(input)
      input.setRawMode?.(true)
      output.write(`${HIDE_CURSOR}${question}\n${draw()}`)
      input.on('keypress', onKey)
      input.on('error', onError)
      process.on('SIGINT', onSigint)
      input.resume()
    } catch (err) {
      finish({ error: err instanceof Error ? err : new Error(String(err)) })
    }
  })
}
