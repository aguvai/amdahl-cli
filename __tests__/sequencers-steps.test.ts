// `amdahl sequencers push` with a whole sequence per lead (email 1 to 10 as
// amdahl_subject[_N] / amdahl_message[_N]), against the strict mock, which holds
// the server's step rules (stepFields.ts, push.ts).

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const INSTANTLY = { id: '55555555-5555-4555-8555-555555555555', type: 'instantly', name: 'Instantly' }

async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer({ sequencers: [INSTANTLY], ...options })
  const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
  io.stdoutIsTTY = true
  return io
}

const HEADER = 'email,first_name,amdahl_subject,amdahl_message,amdahl_subject_2,amdahl_message_2,amdahl_subject_3,amdahl_message_3,amdahl_status'

/** The results file of a three-email sequence: row i can be changed with `edit`. */
function sequenceFile(io: FakeIo, n: number, edit: (i: number, cells: string[]) => void = () => {}, header = HEADER, name = 'leads-amdahl-sequence.csv'): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const cells = [`l${i}@example.com`, 'Ada', `S1 ${i}`, `"Hi Ada,\nM1 ${i}"`, '', `M2 ${i}`, `S3 ${i}`, `M3 ${i}`, 'written']
    edit(i, cells)
    return cells.join(',')
  })
  const path = join(io.cwd, name)
  writeFileSync(path, [header, ...rows].join('\n'))
  return path
}

const posts = () => (server?.log ?? []).filter((r) => r.method === 'POST' && r.path.endsWith('/leads'))
const push = (io: FakeIo, file: string, ...rest: string[]) => cli(io, 'sequencers', 'push', file, '--campaign', 'camp-paused', ...rest)

describe('amdahl sequencers push, a whole sequence per lead', () => {
  it('sends each email as the server names its fields', async () => {
    const io = await withKey()
    const r = await push(io, sequenceFile(io, 2), '--yes', '--json')
    expect(r.code).toBe(0)
    expect(server?.pushes[0]?.body.leads[0]).toEqual({
      email: 'l0@example.com',
      first_name: 'Ada',
      amdahl_subject: 'S1 0',
      amdahl_message: 'Hi Ada,\nM1 0',
      amdahl_message_2: 'M2 0',
      amdahl_subject_3: 'S3 0',
      amdahl_message_3: 'M3 0',
    })
  })

  it('reads any header case, and JSONL', async () => {
    const io = await withKey()
    const csv = sequenceFile(io, 1, () => {}, 'Email,First Name,Amdahl Subject,Amdahl Message,Amdahl_Subject_2,AMDAHL_MESSAGE_2,amdahl_subject_3,amdahl_message_3,Amdahl Status')
    expect((await push(io, csv, '--yes')).code).toBe(0)
    expect(server?.pushes[0]?.body.leads[0]).toMatchObject({ amdahl_message_2: 'M2 0', amdahl_message_3: 'M3 0' })
    const jsonl = join(io.cwd, 'leads.jsonl')
    writeFileSync(jsonl, `${JSON.stringify({ email: 'j@example.com', amdahl_message: 'A', amdahl_message_2: 'B' })}\n`)
    expect((await push(io, jsonl, '--yes')).code).toBe(0)
    expect(server?.pushes[1]?.body.leads[0]).toEqual({ email: 'j@example.com', amdahl_message: 'A', amdahl_message_2: 'B' })
  })

  it('leaves out a lead whose email 2 is empty, or whose status is not written, and counts it', async () => {
    const io = await withKey()
    const file = sequenceFile(io, 4, (i, c) => {
      if (i === 1) c[5] = ''
      if (i === 2) c[8] = 'failed'
    })
    io.answers.push('y')
    const r = await push(io, file)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('2 left out: an email did not come back.')
    expect(server?.pushes[0]?.body.leads.map((l) => l.email)).toEqual(['l0@example.com', 'l3@example.com'])
    const json = await push(io, file, '--yes', '--json')
    expect(json.json).toMatchObject({ emails_per_lead: 3, leads_left_out: 2 })
  })

  it('refuses a file with email 3 but no email 2 column, before it sends anything', async () => {
    const io = await withKey()
    const file = sequenceFile(io, 2, () => {}, 'email,amdahl_subject,amdahl_message,amdahl_message_2x,amdahl_message_3,amdahl_status')
    const r = await push(io, file, '--yes')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('has no amdahl_message_2 column')
    expect(posts()).toHaveLength(0)
  })

  it('refuses a column past email 10', async () => {
    const io = await withKey()
    const file = join(io.cwd, 'big.csv')
    writeFileSync(file, 'email,amdahl_message,amdahl_message_11\na@example.com,x,y\n')
    const r = await push(io, file, '--yes')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('at most 10 emails')
    expect(posts()).toHaveLength(0)
  })

  it('says how many emails each lead carries when it asks', async () => {
    const io = await withKey()
    io.answers.push('y')
    const r = await push(io, sequenceFile(io, 3))
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Add 3 leads, 3 emails each, to the paused Instantly campaign "Q4 founders" (camp-paused).')
    expect(r.stderr).toContain('First lead: l0@example.com, subject "S1 0".')
    expect(io.prompts).toEqual(['Add them? [y/N] '])
  })

  it('changes the idempotency key when email 2 changes', async () => {
    const io = await withKey()
    await push(io, sequenceFile(io, 2), '--yes')
    await push(io, sequenceFile(io, 2, (i, c) => void (c[5] = i === 1 ? 'M2 changed' : c[5] ?? '')), '--yes')
    const [a, b] = server?.pushes ?? []
    expect(server?.pushes).toHaveLength(2)
    expect(a?.body.idempotency_key).not.toBe(b?.body.idempotency_key)
  })

  it('sends 150 three-email leads as 100 and 50', async () => {
    const io = await withKey()
    const r = await push(io, sequenceFile(io, 150), '--yes', '--json')
    expect(r.code).toBe(0)
    expect(server?.pushes.map((p) => p.body.leads.length)).toEqual([100, 50])
    expect(server?.pushes[1]?.body.leads[49]).toMatchObject({ amdahl_message_3: 'M3 149' })
  })

  it('names the missing step when the campaign has too few', async () => {
    const io = await withKey({ campaignSteps: 2 })
    const r = await push(io, sequenceFile(io, 2), '--yes', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('campaign_missing_field')
    expect(r.json.error.message).toContain('The campaign has no step for email 3. Add it in the sequencer.')
    expect(r.json.error.message).toContain('This sequence does not use {{amdahl_message_3}}')
    expect(server?.pushes).toHaveLength(0)
  })

  it('reports emails_per_lead, and a one-email file stays as it was', async () => {
    const io = await withKey()
    const one = join(io.cwd, 'one.csv')
    writeFileSync(one, 'email,amdahl_subject,amdahl_message\na@example.com,S,M\n')
    io.answers.push('y')
    const r = await push(io, one)
    expect(r.stderr).toContain('Add 1 lead to the paused Instantly campaign "Q4 founders" (camp-paused).')
    expect(r.stderr).not.toContain('emails each')
    expect(server?.pushes[0]?.body.leads[0]).toEqual({ email: 'a@example.com', amdahl_subject: 'S', amdahl_message: 'M' })
    const json = await push(io, one, '--yes', '--json')
    expect(json.json.emails_per_lead).toBe(1)
  })
})
