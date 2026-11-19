// src/sequencer-leads.ts
//
// The leads `amdahl sequencers push` reads from a CSV or JSONL file: the
// contact, the first email (`amdahl_subject`, `amdahl_message`) and, for a
// sequence, email N from 2 to 10 as `amdahl_subject_N` and `amdahl_message_N`,
// the names the server takes (amdahl-app stepFields.ts). The file `amdahl
// sequence <emails> --leads <list>` writes holds them, with an `amdahl_status`
// column, and so do the `--for` import files.
//
// A person goes in only when every email came back: a row whose status is not
// `written`, or with an empty email, is left out and counted. The columns must
// have no gap (no `_3` without `_2`), or the file is refused before anything
// is sent.

import { extname } from 'node:path'
import { amdahlCommand } from './command-name'
import { usageError } from './errors'
import { readTextFile } from './files'
import { field, record } from './text'
import { csvDelimiter, parseCsv } from './commands/batch'

/** The most emails one lead carries: the server's `MAX_STEP`. */
export const MAX_STEPS = 10

export const LEAD_FIELDS = ['email', 'first_name', 'last_name', 'company', 'linkedin_url', 'amdahl_subject', 'amdahl_message'] as const

/** A lead as the server takes it: the fields above and `amdahl_subject_N`, `amdahl_message_N`. */
export type Lead = Record<string, string | undefined>

/** Header spellings, as snake_case, for each lead field: the `--for` files name some fields their tool's way. */
const HEADER_NAMES: Record<(typeof LEAD_FIELDS)[number], string[]> = {
  email: ['email', 'email_address', 'work_email'],
  first_name: ['first_name', 'firstname'],
  last_name: ['last_name', 'lastname'],
  company: ['company', 'company_name', 'companyname'],
  linkedin_url: ['linkedin_url', 'linkedinurl', 'linkedin', 'linkedin_profile'],
  amdahl_subject: ['amdahl_subject'],
  amdahl_message: ['amdahl_message'],
}

const STEP_NAME = /^amdahl_(subject|message)_?(\d+)$/

export const snake = (h: string) =>
  h
    .replace(/^﻿/, '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const subjectName = (step: number) => (step === 1 ? 'amdahl_subject' : `amdahl_subject_${step}`)
const messageName = (step: number) => (step === 1 ? 'amdahl_message' : `amdahl_message_${step}`)

/** One lead from its fields, with message newlines normalised. Step fields are added by the caller. */
export function leadOf(get: (f: (typeof LEAD_FIELDS)[number]) => string): Lead {
  const lead: Lead = {}
  for (const f of LEAD_FIELDS) {
    const value = get(f).trim()
    if (value) lead[f] = f === 'amdahl_message' ? get(f).replace(/\r\n?/g, '\n').trim() : value
  }
  return lead
}

/** What a file gave: the leads that have every email, how many emails each carries, and how many rows were left out. */
export interface FileLeads {
  leads: Lead[]
  emails: number
  leftOut: number
}

interface Sheet {
  /** Every column name, as snake_case. */
  names: Set<string>
  /** A row's value for a snake_case name, or ''. */
  rows: ((name: string) => string)[]
}

function leadsFromSheet(sheet: Sheet, path: string): FileLeads {
  const steps = new Map<number, { subject: boolean; message: boolean }>()
  for (const n of sheet.names) {
    const m = STEP_NAME.exec(n)
    if (!m) continue
    const step = Number(m[2])
    if (step < 2) continue
    if (step > MAX_STEPS) throw usageError(`${path} has the column ${n}. A sequence holds at most ${MAX_STEPS} emails.`)
    const seen = steps.get(step) ?? { subject: false, message: false }
    seen[m[1] === 'subject' ? 'subject' : 'message'] = true
    steps.set(step, seen)
  }
  const emails = Math.max(1, ...steps.keys())
  for (let step = 2; step <= emails; step++) {
    if (steps.get(step)?.message) continue
    throw usageError(
      `${path} has no ${messageName(step)} column, but it has columns for email ${emails}.`,
      `A sequence needs every email in order: add ${messageName(step)}, or remove the later columns. Nothing was sent.`
    )
  }
  const hasStatus = sheet.names.has('amdahl_status')
  const leads: Lead[] = []
  let leftOut = 0
  for (const get of sheet.rows) {
    if (hasStatus && get('amdahl_status').trim().toLowerCase() !== 'written') {
      leftOut += 1
      continue
    }
    const lead = leadOf((f) => {
      const names = HEADER_NAMES[f].filter((n) => sheet.names.has(n))
      return names.map((n) => get(n)).find((v) => v.trim()) ?? ''
    })
    if (emails > 1) {
      let whole = !!lead.amdahl_message
      for (let step = 2; step <= emails; step++) {
        const message = get(messageName(step)).replace(/\r\n?/g, '\n').trim()
        const subject = get(subjectName(step)).trim()
        if (message) lead[messageName(step)] = message
        else whole = false
        if (subject) lead[subjectName(step)] = subject
      }
      if (!whole) {
        leftOut += 1
        continue
      }
    }
    leads.push(lead)
  }
  return { leads, emails, leftOut }
}

/** A lead file: CSV with an `amdahl_message` column, or JSONL with one lead object a line. */
export function leadsFromFile(path: string): FileLeads {
  const text = readTextFile(path)
  const ext = extname(path).toLowerCase()
  if (ext === '.jsonl' || ext === '.ndjson' || (ext !== '.csv' && text.trimStart().startsWith('{'))) {
    const names = new Set<string>()
    const rows = text
      .split(/\r?\n/)
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.trim())
      .map(({ line, i }) => {
        let obj: Record<string, unknown> | null = null
        try {
          obj = record(JSON.parse(line))
        } catch {
          obj = null
        }
        if (!obj) throw usageError(`Line ${i + 1} of ${path} is not a JSON object.`)
        const byName = new Map(Object.entries(obj).map(([k, v]) => [snake(k), field(v)]))
        for (const n of byName.keys()) names.add(n)
        return (name: string) => byName.get(name) ?? ''
      })
    return leadsFromSheet({ names, rows }, path)
  }
  const { rows } = parseCsv(text, csvDelimiter(text))
  const [header, ...body] = rows
  if (!header) throw usageError(`${path} is empty.`)
  const names = header.map(snake)
  if (!names.includes('amdahl_message')) {
    throw usageError(
      `${path} has no amdahl_message column.`,
      `Push a file that holds the messages Amdahl wrote: ${amdahlCommand('optimize --list <list.csv> --for other')} writes one, so does ${amdahlCommand('sequence <emails.md> --leads <list.csv>')}, or push a finished batch with ${amdahlCommand('sequencers push <batch-id> --list <list.csv> --campaign <id>')}.`
    )
  }
  return leadsFromSheet(
    {
      names: new Set(names),
      rows: body.map((cells) => (name: string) => {
        const at = names.indexOf(name)
        return at >= 0 ? (cells[at] ?? '') : ''
      }),
    },
    path
  )
}
