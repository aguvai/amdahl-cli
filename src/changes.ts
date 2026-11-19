// src/changes.ts
//
// "What Amdahl changed": the server's own reason for each sentence it cut,
// added or reworded, from the `changes` rows of an optimize result, a stored
// run or an improved prompt run, said in plain words. Nothing here is made up:
// every line is a row the API returned, or a source quote from `added_claims`.
// A result with no `changes` (an older server, a grade) has no lines and no
// cell, so the surfaces that print them print what they printed before. The
// text of a run is shown to the person who made it and is never stored.

import { COLUMNS, cutAtWord, field, record, records, wrap } from './text'

/** The header over the rows of an optimize result. */
export const CHANGES_HEADER = 'What Amdahl changed:'

/** The header over the rows of an improved prompt run. */
export const PROMPT_CHANGES_HEADER = 'What changed in your prompt:'

/** A source quote is cut to about this many characters. */
const SOURCE_CHARS = 100

/** One usable row: a cut (no `after`), an added sentence (no `before`) or a reworded one. */
interface Change {
  before: string
  after: string
  cut: string
  added: string
  why: string
}

/** A reason as a sentence: as the server sent it, with a full stop when it has no end mark. */
function reason(value: unknown): string {
  const text = field(value)
  return text && !/[.!?]$/.test(text) ? `${text}.` : text
}

/** The rows of `result.changes` worth showing, in the order the server sent them. */
function rows(result: Record<string, unknown>): Change[] {
  return records(result.changes)
    .map((row) => ({
      before: field(row.before),
      after: field(row.after),
      cut: reason(row.why_cut),
      added: reason(row.why_added),
      why: reason(row.why),
    }))
    .filter((row) => (row.before || row.after) && row.before !== row.after)
}

/** Whether `result` carries any row to show. */
export function hasChanges(result: unknown): boolean {
  const r = record(result)
  return r !== null && rows(r).length > 0
}

/** A tag is shown only when it is one short plain word, such as `call`. */
function plainTag(value: unknown): string {
  const tag = field(value)
  return /^[A-Za-z][A-Za-z-]{0,19}$/.test(tag) ? tag : ''
}

/**
 * The line a new sentence rests on: the first `added_claims` entry whose
 * sentence and `after` contain one another, its first source's text cut at a
 * word, then `(+N more)` when it has other sources. Empty when none matches.
 */
function sourceText(result: Record<string, unknown>, after: string): string {
  const claim = records(result.added_claims).find((c) => {
    const sentence = field(c.sentence)
    return sentence !== '' && (sentence.includes(after) || after.includes(sentence))
  })
  const sources = records(claim?.sources)
  const first = sources[0]
  const text = field(first?.text)
  if (!first || !text) return ''
  const tag = plainTag(first.tag)
  const more = sources.length > 1 ? ` (+${sources.length - 1} more)` : ''
  return `"${cutAtWord(text, SOURCE_CHARS)}"${tag ? ` (${tag})` : ''}${more}`
}

/** `text` wrapped under a two-space margin, with `mark` in front of the first line and the rest under the text. */
function marked(mark: string, text: string, width: number): string[] {
  const lines = wrap(text, width, '    ')
  lines[0] = `  ${mark} ${(lines[0] ?? '').slice(4)}`
  return lines
}

/** An indented label and text, wrapped under the marker's text. */
function note(label: string, text: string, width: number): string[] {
  return wrap(`${label}: ${text}`, width, '    ')
}

/** Rows as terminal lines under `header`, wrapped to `width`. Empty when there is nothing to show. */
function blockLines(result: Record<string, unknown>, header: string, width: number): string[] {
  const shown = rows(result)
  if (shown.length === 0) return []
  const lines = [header]
  for (const row of shown) {
    if (row.before) lines.push(...marked('-', `"${row.before}"`, width))
    if (row.after) lines.push(...marked('+', `"${row.after}"`, width))
    if (row.before && row.after) {
      if (row.cut || row.added) {
        if (row.cut) lines.push(...note('Cut', row.cut, width))
        if (row.added) lines.push(...note('New', row.added, width))
      } else if (row.why) lines.push(...note('Why', row.why, width))
    } else if (row.before) {
      const why = row.cut || row.why
      if (why) lines.push(...note('Cut', why, width))
    } else {
      const why = row.added || row.why
      if (why) lines.push(...note('New', why, width))
    }
    const source = row.after ? sourceText(result, row.after) : ''
    if (source) lines.push(...note('Source', source, width))
  }
  return lines
}

/**
 * The "What Amdahl changed" block for an optimize result, as lines for stderr.
 * Empty when `changes` is absent, empty or has no usable row.
 */
export function changeLines(result: Record<string, unknown>, width = COLUMNS): string[] {
  return blockLines(result, CHANGES_HEADER, width)
}

/**
 * The "What changed in your prompt" block for an improved prompt run, as
 * lines. Empty when the run has no `changes`.
 */
export function promptChangeLines(run: Record<string, unknown>, width = COLUMNS): string[] {
  return blockLines(run, PROMPT_CHANGES_HEADER, width)
}

/**
 * One results-file cell for a result: a line per change, as `Cut "X": why.`,
 * `Changed "X" to "Y": why.` or `Added "Y": why.`. Empty when there is none.
 * A line is not cut, so the file keeps the whole sentence. The caller guards
 * the cell against a spreadsheet formula.
 */
export function changeCell(result: Record<string, unknown> | null | undefined): string {
  if (!result) return ''
  return rows(result)
    .map((row) => {
      if (!row.after) return `Cut "${row.before}"${row.cut || row.why ? `: ${row.cut || row.why}` : '.'}`
      if (!row.before) return `Added "${row.after}"${row.added || row.why ? `: ${row.added || row.why}` : '.'}`
      const why = [row.added, row.cut].filter(Boolean).join(' ') || row.why
      return `Changed "${row.before}" to "${row.after}"${why ? `: ${why}` : '.'}`
    })
    .join('\n')
}
