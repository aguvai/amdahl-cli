// src/commands/sequencers.ts
//
// `amdahl sequencers campaigns [<connection>]` and `amdahl sequencers push
// <file|batch-id> --campaign <id>`: add leads, each with the message Amdahl
// wrote, to a campaign in a sequencer the workspace connected in the console
// (Instantly, Smartlead, lemlist, HeyReach, Amplemarket).
//
// The server holds every rule: the credential needs `sequencers:push`, one call
// adds at most 100 leads, and only to a campaign the vendor reports paused or
// draft. Amdahl never starts the campaign or sends an email. The CLI reads the
// campaign first and says its name, its status and how many leads it will add,
// then asks before it sends anything; `--yes` skips the question for a script,
// and with no terminal and no `--yes` it sends nothing (exit 2).
//
// The leads come from a CSV or JSONL file with an `amdahl_message` column (the
// file `amdahl optimize --list <list> --for other` writes), or from a finished
// batch and the list it was written from (`<batch-id> --list <list>`), read the
// way `--for` reads it: only messages Amdahl wrote, with a contact for the
// channel. More than 100 leads go in calls of 100. Each call's idempotency key
// comes from the connection, the campaign and the leads, so running the same
// command again adds nothing twice.

import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { buildSendToFile, leftOutLine, planSendTo, presetFor, writtenOf, type LeftOut } from '../send-to'
import { canAsk } from '../terminal'
import { clip, count, field, record, records } from '../text'
import { allItems, csvDelimiter, parseCsv, readList } from './batch'

const PLATFORM = '/api/platform/v1'

/** The connector types that take leads. */
export const SEQUENCER_TYPES = ['instantly', 'smartlead', 'lemlist', 'heyreach', 'amplemarket']

/** The most leads one call adds with a key or a sign-in (the server's cap). */
export const LEADS_PER_CALL = 100

/** The most leads one command adds: the console's cap for one push. */
export const MAX_LEADS = 1000

/** The campaign states the server accepts from a key or a sign-in. */
const OPEN_STATES = new Set(['paused', 'draft'])

const STATUS_WORDS: Record<string, string> = { paused: 'paused', draft: 'draft', active: 'live', other: 'status unknown' }

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How many times `push` reads one push while it waits for it to finish (20 seconds each). */
const MAX_READS = 30

const LEAD_FIELDS = ['email', 'first_name', 'last_name', 'company', 'linkedin_url', 'amdahl_subject', 'amdahl_message'] as const
type Lead = Partial<Record<(typeof LEAD_FIELDS)[number], string>>

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

interface Connection {
  id: string
  type: string
  name: string
}

interface Campaign {
  id: string
  name: string
  status: string
  url: string
}

const snake = (h: string) =>
  h
    .replace(/^﻿/, '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

// ---- The connection and the campaign ----

/** The workspace's sequencer connections. */
async function sequencerConnections(client: ReturnType<typeof apiClient>): Promise<Connection[]> {
  const body = await call(() => client.request<unknown>(`${PLATFORM}/connections`))
  return records(Array.isArray(body) ? body : record(body)?.connections)
    .map((c) => {
      const type = field(c.connector_type) || field(record(c.connector)?.type)
      return { id: field(c.id), type, name: field(record(c.connector)?.name) || field(c.name) || type }
    })
    .filter((c) => c.id && SEQUENCER_TYPES.includes(c.type))
}

/** The connection a person named (its id or its type), or the only one there is. */
async function pickConnection(client: ReturnType<typeof apiClient>, wanted: string | undefined): Promise<Connection> {
  const all = await sequencerConnections(client)
  if (all.length === 0) {
    throw new CliError('no_sequencer', 'This workspace has no sequencer connected.', EXIT.general, `Connect Instantly, Smartlead, lemlist, HeyReach or Amplemarket in the console: ${amdahlCommand('connect instantly')}`)
  }
  const list = all.map((c) => `${c.type} (${c.id})`).join(', ')
  if (!wanted) {
    if (all.length === 1 && all[0]) return all[0]
    throw usageError('This workspace has more than one sequencer connected. Name one.', `Connected: ${list}`)
  }
  const key = wanted.trim().toLowerCase()
  const byId = all.find((c) => c.id.toLowerCase() === key)
  if (byId) return byId
  const byType = all.filter((c) => c.type === key || c.name.toLowerCase() === key)
  if (byType.length === 1 && byType[0]) return byType[0]
  if (byType.length > 1) throw usageError(`This workspace has more than one ${byType[0]?.name ?? key} connection. Name it by id.`, `Connected: ${list}`)
  throw usageError(`No sequencer connection matches "${clip(wanted, 60)}".`, `Connected: ${list}`)
}

async function readCampaigns(client: ReturnType<typeof apiClient>, connection: Connection): Promise<Campaign[]> {
  const body = await call(() => client.request<unknown>(`${PLATFORM}/connections/${encodeURIComponent(connection.id)}/campaigns`))
  return records(record(body)?.campaigns).map((c) => ({ id: field(c.id), name: field(c.name), status: field(c.status), url: field(c.url) }))
}

const statusWord = (status: string) => STATUS_WORDS[status] ?? status

/** `amdahl sequencers campaigns [<connection>]`. */
export async function sequencersCampaigns(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length > 1) throw usageError('Name one connection at a time.', `Usage: ${amdahlCommand('sequencers campaigns [<connection>]')}`)
  const client = apiClient(ctx, await resolveCredential(ctx))
  const connection = await pickConnection(client, args[0])
  const campaigns = await readCampaigns(client, connection)
  if (ctx.out.json) {
    ctx.out.result({ ok: true, connection, campaigns })
    return EXIT.ok
  }
  if (campaigns.length === 0) {
    ctx.out.result({}, `${connection.name} has no campaigns yet. Create one there, and leave it paused or as a draft.`)
    return EXIT.ok
  }
  const width = Math.max(...campaigns.map((c) => [...c.id].length))
  const lines = campaigns.map((c) => `${c.id.padEnd(width)}  ${clip(c.name, 40)}  (${statusWord(c.status)})`)
  const note = `Leads can be added to a paused or draft campaign: ${amdahlCommand(`sequencers push <file> --campaign <id>${args[0] ? ` --connection ${connection.type}` : ''}`)}`
  ctx.out.result({}, [`${connection.name} campaigns:`, ...lines, '', note].join('\n'))
  return EXIT.ok
}

// ---- The leads ----

interface LeadsRead {
  leads: Lead[]
  leftOut: LeftOut | null
  channel: string
}

function leadOf(get: (f: (typeof LEAD_FIELDS)[number]) => string): Lead {
  const lead: Lead = {}
  for (const f of LEAD_FIELDS) {
    const value = get(f).trim()
    if (value) lead[f] = f === 'amdahl_message' ? get(f).replace(/\r\n?/g, '\n').trim() : value
  }
  return lead
}

/** A lead file: CSV with an `amdahl_message` column, or JSONL with one lead object a line. */
function leadsFromFile(path: string): Lead[] {
  const text = readTextFile(path)
  const ext = extname(path).toLowerCase()
  if (ext === '.jsonl' || ext === '.ndjson' || (ext !== '.csv' && text.trimStart().startsWith('{'))) {
    return text
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
        const o = obj
        return leadOf((f) => field(o[f]))
      })
  }
  const { rows } = parseCsv(text, csvDelimiter(text))
  const [header, ...body] = rows
  if (!header) throw usageError(`${path} is empty.`)
  const names = header.map(snake)
  const col = Object.fromEntries(LEAD_FIELDS.map((f) => [f, names.findIndex((n) => HEADER_NAMES[f].includes(n))])) as Record<(typeof LEAD_FIELDS)[number], number>
  if (col.amdahl_message < 0) {
    throw usageError(
      `${path} has no amdahl_message column.`,
      `Push a file that holds the messages Amdahl wrote: ${amdahlCommand('optimize --list <list.csv> --for other')} writes one, or push a finished batch with ${amdahlCommand('sequencers push <batch-id> --list <list.csv> --campaign <id>')}.`
    )
  }
  return body.map((cells) => leadOf((f) => (col[f] >= 0 ? (cells[col[f]] ?? '') : '')))
}

/** A finished batch and its list, read the way `--for other` reads them. */
async function leadsFromBatch(ctx: Ctx, credential: Credential, id: string, listPath: string, flagChannel: string | undefined): Promise<LeadsRead> {
  const list = readList(listPath)
  const preset = presetFor('other')
  if (!preset) throw new Error('the other preset is missing')
  const plan = planSendTo(preset, list, flagChannel)
  const { batch, items } = await allItems(ctx, credential, id)
  if (batch.status !== 'completed') {
    throw new CliError('batch_not_done', `Batch ${id} is not finished yet.`, EXIT.general, `Wait for it: ${amdahlCommand(`optimize --batch ${id} --list ${listPath}`)}`)
  }
  if (items.length !== (list.rows ?? []).length) {
    throw usageError(`Batch ${id} has ${count(items.length, 'message')} and ${listPath} has ${count((list.rows ?? []).length, 'row')}.`, 'Use the list the batch was written from.')
  }
  const byIndex = new Map(items.map((i) => [i.index, i]))
  const built = buildSendToFile({
    path: list.path,
    headers: list.header ?? [],
    rows: (list.rows ?? []).map((cells, i) => ({ cells, written: writtenOf(byIndex.get(i)) })),
    channel: plan.channel,
    preset,
  })
  const { rows } = parseCsv(built.csv)
  const [header, ...body] = rows
  const names = (header ?? []).map(snake)
  const at = (cells: string[], f: string) => (names.indexOf(f) >= 0 ? (cells[names.indexOf(f)] ?? '') : '')
  return { leads: body.map((cells) => leadOf((f) => at(cells, f))), leftOut: built.leftOut, channel: plan.channel }
}

/** Refuse a lead file the server would refuse, before anything is sent. */
function checkLeads(leads: Lead[], source: string): void {
  if (leads.length === 0) throw usageError(`${source} has no leads with a message.`)
  if (leads.length > MAX_LEADS) throw usageError(`${source} has ${count(leads.length, 'lead')}. One command adds up to ${MAX_LEADS.toLocaleString('en-US')}.`, 'Split the file.')
  const missing = leads.findIndex((l) => !l.amdahl_message)
  if (missing >= 0) throw usageError(`Lead ${missing + 1} of ${source} has no amdahl_message.`)
  const noContact = leads.findIndex((l) => !l.email && !l.linkedin_url)
  if (noContact >= 0) throw usageError(`Lead ${noContact + 1} of ${source} has no email and no LinkedIn URL.`)
}

/** The idempotency key of one call: the same leads into the same campaign always get the same key. */
export function pushKey(connectionId: string, campaignId: string, leads: Lead[], part: number): string {
  const digest = createHash('sha256').update(JSON.stringify([connectionId, campaignId, leads])).digest('hex').slice(0, 40)
  return `cli-${digest}-${part}`
}

// ---- The push ----

interface PushResult {
  push_id: string
  status: string
  counts: { added: number; skipped: number; failed: number }
}

async function waitForPush(ctx: Ctx, client: ReturnType<typeof apiClient>, connection: Connection, pushId: string): Promise<PushResult> {
  let read: Record<string, unknown> = {}
  for (let i = 0; i < MAX_READS; i++) {
    read = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/connections/${encodeURIComponent(connection.id)}/pushes/${encodeURIComponent(pushId)}?wait_ms=20000`))
    if (read.status === 'done' || read.status === 'failed') break
  }
  const c = record(read.counts) ?? {}
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  return { push_id: pushId, status: field(read.status), counts: { added: n(c.added), skipped: n(c.skipped), failed: n(c.failed) } }
}

/** `amdahl sequencers push <file|batch-id> --campaign <id> [--connection <c>] [--list <file>] [--channel email|linkedin] [--yes]`. */
export async function sequencersPush(ctx: Ctx, args: string[]): Promise<number> {
  const usage = `Usage: ${amdahlCommand('sequencers push <file|batch-id> --campaign <id> [--connection <id|type>] [--yes]')}`
  const source = args[0]
  if (!source || args.length > 1) throw usageError('Name one lead file or one batch id.', usage)
  const campaignId = typeof ctx.flags.campaign === 'string' ? ctx.flags.campaign.trim() : ''
  if (!campaignId) throw usageError('--campaign is required.', `List the campaigns: ${amdahlCommand('sequencers campaigns')}`)
  const yes = ctx.flags.yes === true
  if (!yes && !canAsk(ctx)) throw usageError('Nothing was added: adding leads needs a yes.', 'Run it at a terminal to answer the question, or pass --yes.')
  const flagChannel = typeof ctx.flags.channel === 'string' ? ctx.flags.channel : undefined
  if (flagChannel !== undefined && flagChannel !== 'email' && flagChannel !== 'linkedin') throw usageError('--channel must be email or linkedin.')
  const listPath = typeof ctx.flags.list === 'string' ? ctx.flags.list : undefined
  const isBatch = BATCH_ID.test(source)
  if (isBatch && !listPath) throw usageError('A batch holds no email addresses: name the list it was written from with --list <file>.', usage)
  if (!isBatch && listPath) throw usageError('--list goes with a batch id, not a lead file.', usage)

  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  const read: LeadsRead = isBatch ? await leadsFromBatch(ctx, credential, source, listPath ?? '', flagChannel) : { leads: leadsFromFile(source), leftOut: null, channel: flagChannel ?? '' }
  checkLeads(read.leads, isBatch ? `Batch ${source}` : source)

  const connection = await pickConnection(client, typeof ctx.flags.connection === 'string' ? ctx.flags.connection : undefined)
  const campaign = (await readCampaigns(client, connection)).find((c) => c.id === campaignId)
  if (!campaign) {
    throw new CliError('campaign_not_found', `${connection.name} has no campaign with the id ${clip(campaignId, 60)}.`, EXIT.general, `List them: ${amdahlCommand(`sequencers campaigns ${connection.type}`)}`)
  }
  if (!OPEN_STATES.has(campaign.status)) {
    throw new CliError(
      campaign.status === 'active' ? 'campaign_active' : 'campaign_status_unknown',
      `"${clip(campaign.name, 60)}" is ${campaign.status === 'active' ? 'live' : 'in a state Amdahl cannot read'}. Leads can be added only to a paused or draft campaign.`,
      EXIT.general,
      'Pause it in the sequencer, or pick another campaign. Nothing was added.'
    )
  }

  const calls = Math.ceil(read.leads.length / LEADS_PER_CALL)
  const summary = `Add ${count(read.leads.length, 'lead')} to the ${statusWord(campaign.status)} ${connection.name} campaign "${clip(campaign.name, 60)}" (${campaign.id})${calls > 1 ? `, in ${calls} calls of up to ${LEADS_PER_CALL}` : ''}.`
  const other = presetFor('other')
  const left = read.leftOut && other ? leftOutLine(read.leftOut, read.channel === 'linkedin' ? 'linkedin' : 'email', other) : null
  if (!yes) {
    ctx.out.info(summary)
    if (left) ctx.out.info(left)
    const first = read.leads[0]
    if (first) ctx.out.info(`First lead: ${first.email ?? first.linkedin_url}${first.amdahl_subject ? `, subject "${clip(first.amdahl_subject, 60)}"` : ''}.`)
    ctx.out.info('Amdahl adds the leads only. It does not start the campaign or send an email.')
    const answer = (await ctx.io.prompt('Add them? [y/N] ')).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') throw new CliError('cancelled', 'Nothing was added.', EXIT.cancelled)
  }

  const pushes: PushResult[] = []
  for (let part = 0; part < calls; part++) {
    const leads = read.leads.slice(part * LEADS_PER_CALL, (part + 1) * LEADS_PER_CALL)
    const started = await call(() =>
      client.request<Record<string, unknown>>(`${PLATFORM}/connections/${encodeURIComponent(connection.id)}/campaigns/${encodeURIComponent(campaign.id)}/leads`, {
        method: 'POST',
        body: { leads, idempotency_key: pushKey(connection.id, campaign.id, read.leads, part) },
      })
    )
    const pushId = field(started.push_id)
    if (calls > 1 && !ctx.out.json) ctx.out.info(`Call ${part + 1} of ${calls} sent.`)
    pushes.push(await waitForPush(ctx, client, connection, pushId))
  }
  const total = pushes.reduce((t, p) => ({ added: t.added + p.counts.added, skipped: t.skipped + p.counts.skipped, failed: t.failed + p.counts.failed }), { added: 0, skipped: 0, failed: 0 })
  const ok = pushes.every((p) => p.status === 'done')
  const human = [
    `Added ${total.added} to "${clip(campaign.name, 60)}" in ${connection.name}. ${total.skipped} skipped (already in the campaign), ${total.failed} failed.`,
    ...(ok ? [] : ['A push did not finish. Read it again in a minute, or check the campaign in the sequencer before you push the same leads again.']),
    'Amdahl did not start the campaign: start it in the sequencer when the messages look right.',
  ].join('\n')
  ctx.out.result({ ok, connection, campaign, counts: total, pushes, left_out: read.leftOut }, human)
  return ok ? EXIT.ok : EXIT.general
}
