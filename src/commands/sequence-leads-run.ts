// src/commands/sequence-leads-run.ts
//
// The run of `amdahl sequence --leads`: email k is ONE batch (POST
// /api/platform/v1/messages/optimize/batch) for every person whose emails 1 to
// k-1 came back, each item carrying THAT person's own earlier emails as
// `prior_touches`. The batch is read with `only_finished`, `finished_since` and
// `wait_ms` until it completes. A person whose email fails stops there, and
// the later batches skip them. An item the batch never reported counts as
// failed. A refused batch (quota, scope) or a lost read stops the whole run
// and keeps what finished. Copied from amdahl-frontend,
// apps/universal-ui/hooks/useSequencePeople.ts and lib/optimizer/batch.ts at
// commit d9a53a2b9 (#2286). Nothing here writes the text of an email anywhere.

import { randomUUID } from 'node:crypto'
import { apiClient, call, type Credential, type Ctx } from '../context'
import { CliError } from '../errors'
import { rememberRun } from '../history'
import { rowOfItem, type Lead, type LeadTable } from '../lead-people'
import type { FinalEmail } from '../sequence-parse'
import { personFinal, personItem, stepCount, type PeopleSource } from '../sequence-leads'
import { field, record, records } from '../text'
import { BATCH_WAIT_MS } from './batch'

const PLATFORM = '/api/platform/v1'
const PAGE = 100

/** One person in a run: the emails written so far (null for one not written), and where they stopped. */
export interface PersonState {
  lead: Lead
  finals: Array<FinalEmail | null>
  /** The email (from 0) that failed for this person, and why in words. */
  failed: { at: number; reason: string } | null
}

/** A refused batch or a lost read: the run stopped here, for everyone. */
export interface Halt {
  /** The email (from 0) whose batch it was. */
  at: number
  reason: string
  hint?: string
  exit: number
}

const FAILURES: Record<string, string> = {
  optimizer_timeout: 'took too long',
  optimizer_error: 'the optimizer hit an error',
  optimizer_unconfigured: 'not set up for this workspace',
  no_message: 'every version failed a check',
  quota_exceeded: 'monthly limit reached',
  not_available: 'no longer available',
  invalid_input: 'could not read this row',
  needs_input: 'Amdahl asked questions instead of writing it',
}

/** A failure's reason as a few plain words. */
export const failureWords = (reason: string) => FAILURES[reason] ?? 'could not write this one'

/** The progress line of one email step. */
export const progressText = (k: number, n: number, done: number, total: number) => `Email ${k + 1} of ${n}: ${done} of ${total} ${total === 1 ? 'person' : 'people'} done.`

function show(ctx: Ctx, line: string, last: boolean): void {
  if (ctx.out.json) return
  if (ctx.io.stderrIsTTY) ctx.io.stderr(`\r\u001b[2K${line}${last ? '\n' : ''}`)
  else if (last) ctx.out.info(line)
}

/**
 * Write every email for `people`, in order, one batch for each email. Returns
 * the halt when a batch was refused or a read was lost, else null. A person's
 * own failures are in their state, not thrown.
 */
export async function runPeople(ctx: Ctx, credential: Credential, src: PeopleSource, table: LeadTable, people: PersonState[]): Promise<Halt | null> {
  const client = apiClient(ctx, credential)
  const n = stepCount(src)
  for (let k = 0; k < n; k++) {
    const due = people.filter((p) => !p.failed && p.finals.slice(0, k).every(Boolean) && !p.finals[k])
    const byRow = new Map<number, PersonState>()
    const items: Record<string, unknown>[] = []
    for (const p of due) {
      try {
        items.push(personItem(src, k, p.lead, table, p.finals.slice(0, k) as FinalEmail[]))
        byRow.set(p.lead.row, p)
      } catch (err) {
        p.failed = { at: k, reason: err instanceof Error ? err.message : 'this email does not fit' }
      }
    }
    if (items.length === 0) continue
    let id: string
    try {
      const sent = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batch`, { method: 'POST', body: { items, idempotency_key: randomUUID() } }))
      id = field(sent.batch_id)
      if (!id) throw new CliError('no_batch_id', 'Amdahl accepted the emails but sent no batch id.', 1)
    } catch (err) {
      const e = err instanceof CliError ? err : new CliError('error', String(err), 1)
      return { at: k, reason: e.message, ...(e.hint ? { hint: e.hint } : {}), exit: e.exit }
    }
    const halt = await readBatch(ctx, credential, client, id, k, n, byRow, items.length, src)
    for (const p of byRow.values()) if (!p.failed && !p.finals[k] && !halt) p.failed = { at: k, reason: failureWords('') }
    if (halt) return halt
  }
  return null
}

/** Read one batch until it completes, settling each person as their email comes back. Returns the halt when the reads are lost. */
async function readBatch(ctx: Ctx, credential: Credential, client: ReturnType<typeof apiClient>, id: string, k: number, n: number, byRow: Map<number, PersonState>, total: number, src: PeopleSource): Promise<Halt | null> {
  const seen = new Set<number>()
  let since = ''
  let misses = 0
  show(ctx, progressText(k, n, 0, total), false)
  for (;;) {
    let page: Record<string, unknown>
    try {
      const query = `only_finished=true&limit=${PAGE}&wait_ms=${BATCH_WAIT_MS}${since ? `&finished_since=${encodeURIComponent(since)}` : ''}`
      page = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batches/${encodeURIComponent(id)}?${query}`))
    } catch (err) {
      misses += 1
      if (misses >= 3) {
        const e = err instanceof CliError ? err : new CliError('error', String(err), 1)
        show(ctx, progressText(k, n, seen.size, total), true)
        return { at: k, reason: `${e.message} The batch is still running, and its emails are not in the results.`, exit: e.exit }
      }
      await ctx.io.sleep(2000 * misses)
      continue
    }
    misses = 0
    since = field(page.finished_cursor) || since
    const items = records(page.items)
    for (const it of items) settle(ctx, credential, it, k, byRow, seen, src)
    const complete = page.status === 'completed' && Number(page.finished_remaining ?? 0) === 0
    show(ctx, progressText(k, n, seen.size, total), complete)
    if (complete) return null
    if (items.length === 0) await ctx.io.sleep(2000)
  }
}

/** Put one finished item into its person's state. */
function settle(ctx: Ctx, credential: Credential, it: Record<string, unknown>, k: number, byRow: Map<number, PersonState>, seen: Set<number>, src: PeopleSource): void {
  const p = byRow.get(rowOfItem(it.item_id, Number(it.index)))
  if (!p || seen.has(p.lead.row)) return
  const result = record(it.result)
  if (it.status !== 'done' && it.status !== 'failed') return
  seen.add(p.lead.row)
  if (it.status === 'failed' || !result || result.ok === false) {
    p.failed = { at: k, reason: failureWords(field(result?.reason)) }
    return
  }
  if (result.outcome !== 'needs_input' && typeof result.message !== 'string') {
    p.failed = { at: k, reason: failureWords('no_message') }
    return
  }
  rememberRun(ctx, { run_id: result.run_id, kind: 'optimize', channel: 'email' }, credential)
  const final = personFinal(src, k, p.lead, result)
  if (final) p.finals[k] = final
  else p.failed = { at: k, reason: failureWords('needs_input') }
}
