// src/commands/sequence-run.ts
//
// The run of `amdahl sequence`: one POST /api/platform/v1/messages/optimize for
// each email, strictly in order, because each email is written as a follow-up
// to the final emails before it. Email i sends `context.prior_touches`, one
// entry for each earlier email, built from its FINAL text (the improved one,
// or the typed one when Amdahl kept the draft). Writing sends no message: the
// plan's two rules and the touches are the context. A failure (`ok: false`, or
// an error) stops the run: the emails before it are already printed, and the
// later ones are not sent. The emails print as each one comes back: the text
// on stdout, what changed on stderr. Nothing is written to disk here.

import { changeLines } from '../changes'
import { toCliError, type Credential, type Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import { rememberRun } from '../history'
import { planRules, type PlanStep } from '../sequence-plan'
import { emailText, finalEmail, lostFields, sentMessage, showsSubject, touchOf, type FinalEmail, type SeqEmail } from '../sequence-parse'
import { field, incompleteLine, records } from '../text'
import { optimizeOne, whatAmdahlDid } from './optimize'

/** What a sequence is written for, and its plan. */
export interface WritePlan {
  goal: string
  steps: PlanStep[]
}

/** One run: the emails (blank ones when writing), the plan when writing, and the request options. */
export interface Job {
  emails: SeqEmail[]
  plan: WritePlan | null
  /** `channel`, `evidence` and `on_unsupported`, sent with every email. */
  base: Record<string, unknown>
  /** The `--context` file: facts, rules, voice examples and the like, sent with every email. */
  fileContext: Record<string, unknown> | null
}

/** One email that came back. */
export interface Done {
  /** From 1. */
  index: number
  subject: string | null
  message: string
  run_id: unknown
  result: Record<string, unknown>
  final: FinalEmail
}

export interface Failure {
  index: number
  reason: string
  detail: string
  hint?: string
}

export interface Outcome {
  done: Done[]
  failed: Failure | null
  /** The fill-in fields: each once that no email lost, and the emails that lost one. */
  fields: { kept: string[]; lost: { email: number; fields: string[] }[] }
  exit: number
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

/** `4`, `4 and 5`, `4, 5 and 6`. */
function listOf(numbers: number[]): string {
  return numbers.length < 2 ? String(numbers[0] ?? '') : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}

/** The `context` of email `i`: the file's, the plan's rules first, and the touches so far. Only keys that carry something. */
function contextFor(job: Job, i: number, finals: FinalEmail[]): Record<string, unknown> | undefined {
  const { rules: fileRules, ...rest } = job.fileContext ?? {}
  const rules = [...(job.plan ? planRules(job.plan.goal, job.plan.steps, i) : []), ...(Array.isArray(fileRules) ? fileRules : [])]
  const touches = finals.slice(0, i).map((f) => touchOf(f)).filter((t) => t.summary)
  const context: Record<string, unknown> = { ...rest }
  if (rules.length) context.rules = rules
  if (touches.length) context.prior_touches = touches
  return Object.keys(context).length ? context : undefined
}

/** The first question a result asks the sender, as the line that says the email needs input. */
function needsInputLine(n: number, result: Record<string, unknown>, kept: boolean): string {
  const ask = field(records(result.ask)[0]?.asks)
  const first = `Email ${n} needs your input${ask ? `: ${sentence(ask)}` : '.'}`
  return kept ? `${first} Kept your draft.` : first
}

/** A reply keeps no subject, so a subject line the writer added is not shown as a change either. */
function withoutAddedSubject(result: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(result.changes)) return result
  return { ...result, changes: records(result.changes).filter((row) => !(row.before == null && /^\s*subject\s*:/i.test(field(row.after)))) }
}

/** The stderr lines of one email: what changed, a kept draft, a question, and what must be checked. */
function noteLines(n: number, result: Record<string, unknown>, needsInput: boolean, writing: boolean): string[] {
  if (needsInput) return [needsInputLine(n, result, !writing)]
  const lines = result.unchanged === true ? ['Kept your draft: no rewrite beat it.'] : changeLines(result)
  const incomplete = incompleteLine(result)
  if (incomplete) lines.push(`Email ${n}: ${incomplete}`)
  for (const flagged of whatAmdahlDid(result, true)) if (flagged.startsWith('Flagged ')) lines.push(`Email ${n}: ${flagged}`)
  return lines
}

/** The one stderr line, or one for each email, about the fill-in fields. Empty when there were none. */
export function fieldLines(fields: Outcome['fields'], kept: string[]): string[] {
  if (fields.lost.length) return fields.lost.map((l) => `Email ${l.email} lost ${l.fields.join(', ')}. Add ${l.fields.length === 1 ? 'it' : 'them'} back before you send.`)
  return kept.length ? [`Kept your fill-in fields: ${kept.join(', ')}.`] : []
}

/** The line that says which email stopped the run and which were not run. */
export function failureLine(failure: Failure, total: number, writing: boolean): string {
  const verb = writing ? 'written' : 'improved'
  const why = failure.detail ? `${failure.reason}): ${sentence(failure.detail)}` : `${failure.reason}).`
  const later = Array.from({ length: total - failure.index }, (_, k) => failure.index + 1 + k)
  const tail = later.length === 0 ? '' : later.length === 1 ? ` Email ${later[0]} was not run.` : ` Emails ${listOf(later)} were not run.`
  return `Email ${failure.index} was not ${verb} (${why}${tail}`
}

/**
 * Run every email in order and print each as it comes back (not under `--json`).
 * Never throws for a failed email: that is the outcome's `failed`.
 */
export async function runSequence(ctx: Ctx, credential: Credential, job: Job): Promise<Outcome> {
  const { io, out } = ctx
  const writing = job.plan !== null
  const total = job.emails.length
  const finals: FinalEmail[] = []
  const done: Done[] = []
  let failed: Failure | null = null
  let exit: number = EXIT.ok
  const now = new Date(io.now())
  for (let i = 0; i < total; i++) {
    const n = i + 1
    const email = job.emails[i] as SeqEmail
    if (!out.json && io.stderrIsTTY) out.info(`Amdahl is ${writing ? 'writing' : 'improving'} email ${n} of ${total}.${i === 0 ? ' Each email can take a minute.' : ''}`)
    const context = contextFor(job, i, finals)
    let result: Record<string, unknown>
    try {
      result = await optimizeOne(ctx, credential, writing ? '' : sentMessage(email, i), { ...job.base, ...(context ? { context } : {}) }, `email ${n}`)
    } catch (err) {
      const e = err instanceof CliError ? err : toCliError(err)
      failed = { index: n, reason: e.code, detail: e.message, ...(e.hint ? { hint: e.hint } : {}) }
      exit = e.exit
      break
    }
    if (result.ok === false) {
      failed = { index: n, reason: String(result.reason ?? 'unknown'), detail: field(result.detail) }
      exit = EXIT.general
      break
    }
    const needsInput = result.outcome === 'needs_input'
    if (!needsInput && typeof result.message !== 'string') {
      failed = { index: n, reason: 'no_message', detail: 'Amdahl did not return a message.' }
      exit = EXIT.general
      break
    }
    rememberRun(ctx, { run_id: result.run_id, kind: 'optimize', channel: 'email' }, credential)
    const final = finalEmail(email, i, needsInput ? null : String(result.message))
    finals.push(final)
    done.push({ index: n, subject: final.subject, message: final.body, run_id: result.run_id, result, final })
    if (!out.json) {
      const head = writing ? `Email ${n} of ${total}: ${job.plan?.steps[i]?.name.trim() || `Email ${n}`}` : `Email ${n} of ${total}`
      const text = needsInput && writing ? head : `${head}\n${emailText(final)}`
      out.result({}, `${i > 0 ? '\n' : ''}${text}`)
      const notes = noteLines(n, showsSubject(email, i) ? result : withoutAddedSubject(result), needsInput, writing)
      if (notes.length) out.info(notes.join('\n'))
    }
  }
  return { done, failed, fields: fieldsOf(job, done), exit }
}

/** Which fill-in fields each finished email kept and lost. A written sequence has no drafts, so none. */
function fieldsOf(job: Job, done: Done[]): Outcome['fields'] {
  if (job.plan) return { kept: [], lost: [] }
  const lost: { email: number; fields: string[] }[] = []
  const seen: string[] = []
  for (const d of done) {
    const check = lostFields(job.emails[d.index - 1] as SeqEmail, d.index - 1, d.final)
    for (const f of check.had) if (!seen.includes(f)) seen.push(f)
    if (check.lost.length) lost.push({ email: d.index, fields: check.lost })
  }
  const lostAll = new Set(lost.flatMap((l) => l.fields))
  return { kept: seen.filter((f) => !lostAll.has(f)), lost }
}

/** The document `--json` prints. */
export function jsonDocument(job: Job, outcome: Outcome, file: string | null): Record<string, unknown> {
  return {
    ok: outcome.failed === null,
    mode: job.plan ? 'write' : 'improve',
    emails: outcome.done.map((d) => ({ index: d.index, subject: d.subject, message: d.message, run_id: d.run_id ?? null, result: d.result })),
    fields: outcome.fields,
    ...(outcome.failed ? { failed: { index: outcome.failed.index, reason: outcome.failed.reason, detail: outcome.failed.detail } } : {}),
    ...(file ? { file } : {}),
  }
}
