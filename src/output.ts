// src/output.ts
//
// How commands talk. With `--json`, DATA goes to stdout as one JSON document
// and every message goes to stderr, so `amdahl ... --json | jq` always parses.
// Machine events the e2e harness reads (`open_url`, `approve`) are single JSON
// lines on stderr.

import type { Io } from './io'

// Every C0 control character (ESC among them), DEL and every C1 control character.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * `text` with every control character removed, newlines too: for a string
 * from the network (a skill's version or name, or an archive path), so it cannot
 * move the cursor, retitle the window or clear the screen when printed.
 */
export function printable(text: string): string {
  return text.replace(CONTROL_RE, '')
}

/** Writers bound to one invocation's flags. */
export interface Output {
  /** True under `--json`. */
  json: boolean
  /** True when colour is allowed: stderr is a terminal, not `--json`, `--no-color`, NO_COLOR or TERM=dumb. */
  color: boolean
  /** Print the command's result: JSON on stdout, or the human lines. */
  result: (data: Record<string, unknown> | Record<string, unknown>[], human?: string) => void
  /** Print a message to stderr (never stdout). */
  info: (text: string) => void
  /** Print a machine event as one JSON line on stderr (only under `--json`). */
  event: (data: Record<string, unknown>) => void
  /** Bold text when colour is allowed. */
  bold: (text: string) => string
}

/**
 * Build the writers.
 *
 * @param io - the process boundary.
 * @param json - whether `--json` was passed.
 * @param noColor - whether `--no-color` was passed.
 */
export function createOutput(io: Io, json: boolean, noColor: boolean): Output {
  const color = !noColor && !io.env.NO_COLOR && io.env.TERM !== 'dumb' && io.stderrIsTTY && !json
  return {
    json,
    color,
    result(data, human) {
      if (json) {
        io.stdout(`${JSON.stringify(data)}\n`)
      } else if (human !== undefined) {
        io.stdout(human.endsWith('\n') ? human : `${human}\n`)
      }
    },
    info(text) {
      io.stderr(text.endsWith('\n') ? text : `${text}\n`)
    },
    event(data) {
      if (json) io.stderr(`${JSON.stringify(data)}\n`)
    },
    bold(text) {
      return color ? `\u001b[1m${text}\u001b[22m` : text
    },
  }
}
