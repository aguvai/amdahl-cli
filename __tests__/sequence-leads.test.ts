// `amdahl sequence --leads`: a whole sequence for each person in a lead list, through the real entry
// point against the strict mock server. The mock builds each batch item's result from THAT item's own
// body, so a test can tell whether a person's email 2 carried their own email 1 (never another person's).
// The request bodies and the CSV text follow the console's own tests (amdahl-frontend,
// e2e-stub/optimizer-sequence-people.spec.ts, optimizer-sequence-write-people.spec.ts and
// optimizer-sequence-send-to.spec.ts at commit d9a53a2b9).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 18, 12))
})
afterEach(async () => {
  vi.useRealTimers()
  await server?.close()
  server = null
})

const BATCH = '/api/platform/v1/messages/optimize/batch'
const DAY = '2026-11-18'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RULE = "Write the message from the sender's message in the facts. Keep its substance, order and voice, and improve the wording."

type Item = Record<string, any>
type Result = { status: string; result: Record<string, unknown> }

const LEADS = ['First Name,Last Name,Email,Company,Notes', 'Sam,Lee,sam@example.com,Acme,Posted about onboarding', ',Park,jo@example.com,Northwind,Raised a Series B'].join('\n')
const EMAILS = ['Subject: Ramping at {{company}}', '', 'Hi {{first_name}}, most teams take 4 months.', '---', 'Hi {{first_name}}, bumping this up.'].join('\n')

/** The touches an item carries, as their first lines (the subject says whose email it is). */
const touchLines = (item: Item): string[] => ((item.context?.prior_touches ?? []) as { summary: string }[]).map((t) => t.summary.split('\n')[0] as string)

/** What a rewrite or a written email looks like, made from the item's own body: an improved email is `Better: <its message>`, a written one names the person and the first line of the touch it carried. */
function answer(item: Item): Result {
  const message = String(item.message ?? '')
  if (message) return { status: 'done', result: { ok: true, message: message.startsWith('Subject: ') ? message.replace('\n\n', '!\n\nBetter: ') : `Better: ${message}`, run_id: 'r' } }
  const place = /email (\d+) of (\d+): ([^.]*)\./.exec((item.context?.rules as string[] | undefined)?.[1] ?? '')
  const who = item.recipient?.name ?? 'someone'
  const after = touchLines(item)[0]
  return { status: 'done', result: { ok: true, message: `Subject: ${place?.[3]} ${place?.[1]} for ${who}\n\nWritten for ${who}${after ? ` after: ${after}` : ''}.`, run_id: 'r' } }
}

/** `answer`, except the people named fail at the email given (1 is the first), with this reason. */
const failing = (emails: string[], at: number, reason = 'optimizer_timeout') => (item: Item): Result => {
  const k = touchLines(item).length + 1
  if (emails.includes(item.recipient?.email) && k === at) return { status: 'failed', result: { ok: false, reason, detail: 'It failed.' } }
  return answer(item)
}

async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  await server?.close()
  server = await startMockServer({ batchPolls: 0, batchResults: (item) => answer(item as Item), ...options })
  const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
  io.stdinIsTTY = false
  return io
}

/** The same, at a terminal: stdin, stdout and stderr are terminals, so questions are asked. */
async function atTerminal(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  const io = await withKey(options)
  io.stdinIsTTY = true
  io.stdoutIsTTY = true
  io.stderrIsTTY = true
  return io
}

const file = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}
const read = (io: FakeIo, name: string) => readFileSync(join(io.cwd, name), 'utf8')

/** Every batch the CLI queued, in order, with the key it sent split off (each is a different UUID). */
const batches = (): Item[][] => {
  const keys: string[] = []
  const all = (server?.log ?? []).filter((r) => r.path === BATCH).map((r) => {
    const body = JSON.parse(r.body) as { items: Item[]; idempotency_key: string }
    keys.push(body.idempotency_key)
    expect(Object.keys(body).sort()).toEqual(['idempotency_key', 'items'])
    return body.items
  })
  expect(keys.every((k) => UUID.test(k))).toBe(true)
  expect(new Set(keys).size).toBe(keys.length)
  return all
}
const polls = () => (server?.log ?? []).filter((r) => r.path.startsWith(`${BATCH}es/`) && r.method === 'GET')

const touch = (summary: string) => ({ on: DAY, channel: 'email', summary })
const SAM = { email: 'sam@example.com', name: 'Sam Lee', company: 'Acme', attributes: { Notes: 'Posted about onboarding' } }
const PARK = { email: 'jo@example.com', name: 'Park', company: 'Northwind', attributes: { Notes: 'Raised a Series B' } }

describe('improving a sequence for each person', () => {
  it('sends email 2 as one batch, and each person carries their OWN email 1', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', leads)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`Results: ${join(io.cwd, 'leads-amdahl-sequence.csv')}\n`)
    expect(r.stderr).toBe('Email 1 of 2: 2 of 2 people done.\nEmail 2 of 2: 2 of 2 people done.\nWrote 2 emails for 2 of 2 people.\n')
    const [one, two] = batches()
    expect(one).toEqual([
      {
        item_id: 'row-2',
        channel: 'email',
        recipient: SAM,
        context: { rules: [RULE], facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding', "The sender's message, word for word:\nSubject: Ramping at Acme\n\nHi Sam, most teams take 4 months."] },
        message: 'Subject: Ramping at Acme\n\nHi Sam, most teams take 4 months.',
      },
      {
        item_id: 'row-3',
        channel: 'email',
        recipient: PARK,
        context: { rules: [RULE], facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B', "The sender's message, word for word:\nSubject: Ramping at Northwind\n\nHi there, most teams take 4 months."] },
        message: 'Subject: Ramping at Northwind\n\nHi there, most teams take 4 months.',
      },
    ])
    expect(two).toEqual([
      {
        item_id: 'row-2',
        channel: 'email',
        recipient: SAM,
        context: {
          rules: [RULE],
          facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding', "The sender's message, word for word:\nHi Sam, bumping this up."],
          prior_touches: [touch('Subject: Ramping at Acme!\n\nBetter: Hi Sam, most teams take 4 months.')],
        },
        message: 'Hi Sam, bumping this up.',
      },
      {
        item_id: 'row-3',
        channel: 'email',
        recipient: PARK,
        context: {
          rules: [RULE],
          facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B', "The sender's message, word for word:\nHi there, bumping this up."],
          prior_touches: [touch('Subject: Ramping at Northwind!\n\nBetter: Hi there, most teams take 4 months.')],
        },
        message: 'Hi there, bumping this up.',
      },
    ])
    expect(read(io, 'leads-amdahl-sequence.csv')).toBe(
      [
        'First Name,Last Name,Email,Company,Notes,amdahl_subject,amdahl_message,amdahl_message_2,amdahl_status',
        'Sam,Lee,sam@example.com,Acme,Posted about onboarding,Ramping at Acme!,"Better: Hi Sam, most teams take 4 months.","Better: Hi Sam, bumping this up.",written',
        ',Park,jo@example.com,Northwind,Raised a Series B,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.","Better: Hi there, bumping this up.",written',
      ].join('\r\n')
    )
  })

  it('reads each batch with only_finished, and keeps the cursor between reads', async () => {
    const io = await withKey({ batchFinishPerRead: 1 })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    const paths = polls().map((p) => p.path + (p.query ?? ''))
    expect(paths.length).toBeGreaterThanOrEqual(4)
    expect(paths.every((p) => /only_finished=true&limit=100&wait_ms=15000/.test(p))).toBe(true)
    expect(paths.some((p) => p.includes('finished_since=f.1'))).toBe(true)
    expect(batches()).toHaveLength(2)
  })

  it('fills fields from the flags: --match, --fallback, --same and --drop', async () => {
    const io = await withKey()
    const leads = file(io, 'l.csv', 'Name,Email,Org,Notes\nSam,sam@example.com,Acme,Likes ramp\n,jo@example.com,,Hiring')
    const emails = file(io, 'e.md', 'Hi {{first_name}} at {{company}}, {{icebreaker}} Open to a call?\n---\nHi {{first_name}}, bumping this.')
    const r = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'company=Org', '--fallback', 'company=your team', '--fallback', 'first_name=friend', '--drop', 'icebreaker')
    expect(r.code).toBe(0)
    const [one] = batches()
    expect(one?.map((i) => i.message)).toEqual(['Hi Sam at Acme,  Open to a call?', 'Hi friend at your team,  Open to a call?'])
    const same = await cli(io, 'sequence', emails, '--leads', leads, '--force', '--same', 'company=Initech', '--match', 'icebreaker=Notes')
    expect(same.code).toBe(0)
    expect(batches().slice(2)[0]?.map((i) => i.message)).toEqual(['Hi Sam at Initech, Likes ramp Open to a call?', 'Hi there at Initech, Hiring Open to a call?'])
  })

  it('refuses a flag that names a field not in the emails, or a column not in the file, before anything is sent', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const emails = file(io, 'emails.md', EMAILS)
    const a = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'city=Notes')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe('Error: --match city: {{city}} is not in your emails.\nThe fields in your emails: {{company}}, {{first_name}}.\n')
    const b = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'company=Org')
    expect(b.code).toBe(2)
    expect(b.stderr).toBe('Error: --match company: leads.csv has no column "Org".\nThe columns: First Name, Last Name, Email, Company, Notes.\n')
    const c = await cli(io, 'sequence', emails, '--leads', leads, '--same', 'company=Acme', '--drop', 'company')
    expect(c.stderr).toBe('Error: {{company}} has --same and --drop. Pick one.\n')
    const d = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'company')
    expect(d.stderr).toBe('Error: --match takes <field>=<column>, like --match first_name="First Name".\n')
    expect(batches()).toEqual([])
    expect(existsSync(join(io.cwd, 'leads-amdahl-sequence.csv'))).toBe(false)
  })

  it('refuses, not at a terminal, a field with no column and no flag: one line for each, with the flag that fixes it', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', 'Hi {{first_name}} at {{company}}, {{icebreaker}}\n---\nHi {{first_name}}, a follow-up.')
    const r = await cli(io, 'sequence', emails, '--leads', file(io, 'leads.csv', 'First Name,Email\nSam,sam@example.com'))
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(
      'Error: {{company}} has no column in leads.csv. Add --match company=<column>, --same company="<text>" or --drop company.\n' +
        '{{icebreaker}} has no column in leads.csv. Add --match icebreaker=<column>, --same icebreaker="<text>" or --drop icebreaker.\n'
    )
    expect(batches()).toEqual([])
  })

  it('goes ahead with empty cells and no text for them, and says how many people have it empty', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', 'Hi, a note for {{company}}.\n---\nBumping {{company}}.')
    const r = await cli(io, 'sequence', emails, '--leads', file(io, 'leads.csv', 'Email,Company\nsam@example.com,Acme\njo@example.com,'))
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('Email 1 of 2: 2 of 2 people done.\nEmail 2 of 2: 2 of 2 people done.\nWrote 2 emails for 2 of 2 people.\n'.replace(/^/, '{{company}} is empty for 1 of 2 people, so it is left out for them.\n'))
    expect(batches()[0]?.map((i) => i.message)).toEqual(['Hi, a note for Acme.', 'Hi, a note for.'])
  })

  it('refuses a file with no people before anything is sent, with the console\'s sentence', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'drafts.csv', 'Subject,Body\nHi,Some text here'))
    expect(r.code).toBe(2)
    expect(r.stderr).toBe('Error: No people in this file. It needs an email, LinkedIn, or name and company column.\n')
    expect(batches()).toEqual([])
  })

  it('skips empty rows and says how many', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi there.\n---\nBumping.'), '--leads', file(io, 'leads.csv', 'Email,Name\nsam@example.com,Sam\n,\n,\njo@example.com,Jo'))
    expect(r.code).toBe(0)
    expect(r.stderr.startsWith('Skipped 2 empty rows.\n')).toBe(true)
    expect(batches()[0]?.map((i) => i.item_id)).toEqual(['row-2', 'row-5'])
  })
})

describe('the results file', () => {
  it('is not replaced without --force or --resume, and is refused before anything is sent', async () => {
    const io = await withKey()
    const out = join(io.cwd, 'leads-amdahl-sequence.csv')
    writeFileSync(out, 'old')
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`Error: ${out} already exists.\nAdd --resume to pick up where it stopped, or --force to start again.\n`)
    expect(batches()).toEqual([])
    expect(readFileSync(out, 'utf8')).toBe('old')
    const forced = await cli(io, 'sequence', join(io.cwd, 'emails.md'), '--leads', join(io.cwd, 'leads.csv'), '--force')
    expect(forced.code).toBe(0)
    expect(readFileSync(out, 'utf8')).toMatch(/^First Name,Last Name,Email,Company,Notes,amdahl_subject,/)
  })

  it('guards a formula cell, strips <unverified>, and keeps every original column', async () => {
    const io = await withKey({ batchResults: (item) => (String(item.message).startsWith('Hi') ? { status: 'done', result: { ok: true, message: '-Hi <unverified>Sam</unverified>, a note.' } } : answer(item as Item)) })
    const leads = file(io, 'leads.csv', 'Email,Name,Tag\nsam@example.com,Sam,=SUM(A1)')
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi, a note.\n---\nHi again.'), '--leads', leads)
    expect(r.code).toBe(0)
    expect(read(io, 'leads-amdahl-sequence.csv')).toBe(['Email,Name,Tag,amdahl_subject,amdahl_message,amdahl_message_2,amdahl_status', `sam@example.com,Sam,'=SUM(A1),,"'-Hi Sam, a note.","'-Hi Sam, a note.",written`].join('\r\n'))
  })
})

describe('a person who fails, and a run that stops', () => {
  it('stops that person there: later batches skip them, and the file and summary say where', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 1) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(1)
    const [one, two] = batches()
    expect(one?.map((i) => i.item_id)).toEqual(['row-2', 'row-3'])
    expect(two?.map((i) => i.item_id)).toEqual(['row-2'])
    expect(r.stderr).toBe(
      'Email 1 of 2: 2 of 2 people done.\nEmail 2 of 2: 1 of 1 person done.\nWrote 2 emails for 1 of 2 people. 1 stopped: 1 at email 1 (took too long).\n' +
        `To write the rest: amdahl sequence ${join(io.cwd, 'emails.md')} --leads ${join(io.cwd, 'leads.csv')} --resume\n`
    )
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n')[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,,,,email 1 failed')
  })

  it('treats an item the batch never reported as failed', async () => {
    const io = await withKey({ batchResults: (item) => ((item as Item).recipient?.email === 'jo@example.com' ? { status: 'running', result: {} as Record<string, unknown> } : answer(item as Item)) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('1 stopped: 1 at email 1 (could not write this one).')
  })

  it('stops the whole run on a refused batch, keeps what finished, and still writes the results file', async () => {
    const io = await withKey({ batchRefuse: { 2: { status: 402, code: 'quota_exceeded', message: 'The monthly limit is reached.' } } })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/^Email 1 of 2: 2 of 2 people done\.\nWrote 2 emails for 0 of 2 people\. Email 2 was refused: .*monthly limit/)
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(rows[1]).toBe('Sam,Lee,sam@example.com,Acme,Posted about onboarding,Ramping at Acme!,"Better: Hi Sam, most teams take 4 months.",,not written yet')
    expect(batches()).toHaveLength(2)
  })
})

describe('writing a sequence for each person', () => {
  const PLAN = ['Opener: Why now', 'Last try: Close politely'].join('\n')

  it('not at a terminal, writes everyone with no sample: no message, the plan rules, and each person\'s own email 1', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--plan', file(io, 'plan.txt', PLAN), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    const rules = (k: number) => [
      'This sequence: Book a first meeting.',
      k === 1 ? 'This is email 1 of 2: Opener. Its job: why now.' : 'This is email 2 of 2: Last try. Its job: close politely.',
    ]
    const [one, two] = batches()
    expect(one).toEqual([
      { item_id: 'row-2', channel: 'email', recipient: SAM, context: { rules: rules(1), facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding'] } },
      { item_id: 'row-3', channel: 'email', recipient: PARK, context: { rules: rules(1), facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B'] } },
    ])
    expect(two).toEqual([
      { item_id: 'row-2', channel: 'email', recipient: SAM, context: { rules: rules(2), facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding'], prior_touches: [touch('Subject: Opener 1 for Sam Lee\n\nWritten for Sam Lee.')] } },
      { item_id: 'row-3', channel: 'email', recipient: PARK, context: { rules: rules(2), facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B'], prior_touches: [touch('Subject: Opener 1 for Park\n\nWritten for Park.')] } },
    ])
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n')[1]).toBe(
      'Sam,Lee,sam@example.com,Acme,Posted about onboarding,Opener 1 for Sam Lee,Written for Sam Lee.,Last try 2 for Sam Lee,Written for Sam Lee after: Subject: Opener 1 for Sam Lee.,written'
    )
  })

  it('at a terminal, writes a sample first as batches of one, shows it, and asks before writing for the rest', async () => {
    const io = await atTerminal()
    io.answers = ['', '', '']
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual(['Write these 2 emails? [Y/n]', 'Write for the other 1 person? [Y/n]'])
    expect(batches().map((b) => b.map((i) => i.item_id))).toEqual([['row-2'], ['row-2'], ['row-3'], ['row-3']])
    expect(batches()[1]?.[0]?.context?.prior_touches).toEqual([touch('Subject: Opener 1 for Sam Lee\n\nWritten for Sam Lee.')])
    expect(batches()[3]?.[0]?.context?.prior_touches).toEqual([touch('Subject: Opener 1 for Park\n\nWritten for Park.')])
    expect(r.stdout).toBe(
      [
        'Sample for Sam Lee:',
        '',
        'Email 1 of 2: Opener',
        'Subject: Opener 1 for Sam Lee',
        '',
        'Written for Sam Lee.',
        '',
        'Email 2 of 2: Last try',
        'Subject: Last try 2 for Sam Lee',
        '',
        'Written for Sam Lee after: Subject: Opener 1 for Sam Lee.',
        `Results: ${join(io.cwd, 'leads-amdahl-sequence.csv')}`,
        '',
      ].join('\n')
    )
  })

  it('stops after the sample when the answer is no: the sample stays in the file, the rest are marked not written', async () => {
    const io = await atTerminal()
    io.answers = ['', 'n']
    const leads = file(io, 'leads.csv', LEADS)
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', leads)
    expect(r.code).toBe(0)
    expect(batches()).toHaveLength(2)
    expect(r.stderr).toContain('Wrote 2 emails for 1 of 2 people. The other 1 were not written.')
    expect(r.stderr).toContain(`To write the rest: amdahl sequence --write 'Book a first meeting.' --leads ${leads} --emails 2 --resume`)
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(rows[1]?.endsWith(',written')).toBe(true)
    expect(rows[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,,,,,not written yet')
  })
})

describe('at a terminal', () => {
  const FIELDS = ['Subject: Call notes at {{company}}', '', 'Hi {{first_name}},', '', '{{icebreaker}}', '', 'We turn call recordings into talk tracks.', '---', 'Hi {{first_name}}, bumping this up.'].join('\n')

  it('asks about each real problem, then the start question, and rewrites a progress line as people finish', async () => {
    const io = await atTerminal({ batchFinishPerRead: 1 })
    io.answers = ['', '4', '']
    const leads = file(io, 'leads.csv', 'First Name,Email,Company,Notes\nSam,sam@example.com,Acme,Saw your post\n,jo@example.com,Fabrikam,Series B')
    const r = await cli(io, 'sequence', file(io, 'emails.md', FIELDS), '--leads', leads)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([
      'What fills {{first_name}}? [Write instead: there | Column: Email | Column: Company | Column: Notes | Same text for everyone | Leave it out]',
      'What fills {{icebreaker}}? [Column: First Name | Column: Email | Column: Company | Column: Notes | Same text for everyone | Leave it out]',
      'This improves 2 emails for each of 2 people: up to 4 runs. Start? [Y/n]',
    ])
    const line = (text: string) => `\r\u001b[2K${text}`
    expect(r.stderr).toBe(
      [
        '{{first_name}}: empty for 1 of 2 people',
        '{{icebreaker}}: no column in leads.csv',
        '{{company}}: from column "Company".',
        '{{first_name}}: from column "First Name", "there" where it is empty.',
        '{{icebreaker}}: from column "Notes".',
        line('Email 1 of 2: 0 of 2 people done.') + line('Email 1 of 2: 1 of 2 people done.') + line('Email 1 of 2: 2 of 2 people done.'),
        line('Email 2 of 2: 0 of 2 people done.') + line('Email 2 of 2: 1 of 2 people done.') + line('Email 2 of 2: 2 of 2 people done.'),
        'Wrote 2 emails for 2 of 2 people.',
        '',
      ].join('\n')
    )
    expect(batches()[0]?.[1]?.message).toBe('Subject: Call notes at Fabrikam\n\nHi there,\n\nSeries B\n\nWe turn call recordings into talk tracks.')
  })

  it('stops at the start question when the answer is no: nothing is sent and no file is written', async () => {
    const io = await atTerminal()
    io.answers = ['n']
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi.\n---\nBumping.'), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual(['This improves 2 emails for each of 2 people: up to 4 runs. Start? [Y/n]'])
    expect(r.stderr).toBe('Nothing was sent.\n')
    expect(batches()).toEqual([])
    expect(existsSync(join(io.cwd, 'leads-amdahl-sequence.csv'))).toBe(false)
  })
})

describe('--for', () => {
  const THREE = ['Subject: Ramping at {{company}}', '', 'Hi {{first_name}}, most teams take 4 months.', '---', 'Hi {{first_name}}, bumping this up.', '---', 'Subject: Close the loop?', '', 'Hi {{first_name}}, should I stop?'].join('\n')

  it('writes the import file with each email\'s columns, a subject column only for an email with its own subject, and the steps for each email', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const r = await cli(io, 'sequence', file(io, 'emails.md', THREE), '--leads', leads, '--for', 'lemlist')
    expect(r.code).toBe(0)
    const results = join(io.cwd, 'leads-amdahl-sequence.csv')
    const imported = join(io.cwd, 'leads-lemlist.csv')
    expect(r.stdout).toBe(`Results: ${results}\nImport file for lemlist: ${imported}\n`)
    expect(read(io, 'leads-lemlist.csv')).toBe(
      [
        'email,firstName,lastName,companyName,amdahl_subject,amdahl_message,amdahl_message_2,amdahl_subject_3,amdahl_message_3,notes',
        'sam@example.com,Sam,Lee,Acme,Ramping at Acme!,"Better: Hi Sam, most teams take 4 months.","Better: Hi Sam, bumping this up.",Close the loop?!,"Better: Hi Sam, should I stop?",Posted about onboarding',
        'jo@example.com,Park,Park,Northwind,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.","Better: Hi there, bumping this up.",Close the loop?!,"Better: Hi there, should I stop?",Raised a Series B',
      ].join('\r\n')
    )
    expect(r.stderr).toBe(
      [
        'Email 1 of 3: 2 of 2 people done.',
        'Email 2 of 3: 2 of 2 people done.',
        'Email 3 of 3: 2 of 2 people done.',
        'Wrote 3 emails for 2 of 2 people.',
        '2 people ready for lemlist.',
        '  1. Import: In your campaign, open Leads list > Import new leads > CSV.',
        '  2. email and the name columns map on their own. amdahl_subject and',
        "     amdahl_message become custom variables. Map amdahl_message_2 and each later",
        "     email's columns the same way.",
        '  3. Paste into your step, one email per step:',
        '     Email 1: Subject {{amdahl_subject}}, Body {{amdahl_message}}',
        '     Email 2: Body {{amdahl_message_2}}',
        '     Email 3: Subject {{amdahl_subject_3}}, Body {{amdahl_message_3}}',
        '',
      ].join('\n')
    )
  })

  it('names email 2\'s subject column in the mapping step when email 2 has its own subject', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', file(io, 'leads.csv', LEADS), '--for', 'instantly')
    expect(r.code).toBe(0)
    expect(r.stderr.replace(/\n\s+/g, ' ')).toContain("Map amdahl_subject_2, amdahl_message_2 and each later email's columns the same way.")
  })

  it('leaves out a person who is missing an email, and counts them', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--for', 'instantly')
    expect(r.code).toBe(1)
    expect(read(io, 'leads-instantly.csv').split('\r\n')).toHaveLength(2)
    expect(r.stderr).toContain('1 person ready for Instantly. 1 left out: 1 failed.')
  })

  it('refuses a tool that takes LinkedIn only, a tool it does not know, and a list with no email column, before anything is sent', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', EMAILS)
    const a = await cli(io, 'sequence', emails, '--leads', file(io, 'leads.csv', LEADS), '--for', 'heyreach')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe('Error: HeyReach takes LinkedIn lists only, and this one is email.\nPick a tool for this channel, or use --for other.\n')
    const b = await cli(io, 'sequence', emails, '--leads', join(io.cwd, 'leads.csv'), '--for', 'mailchimp')
    expect(b.stderr).toContain('Error: --for must be one of: instantly, smartlead')
    const c = await cli(io, 'sequence', file(io, 'e2.md', 'Hi.\n---\nBump.'), '--leads', file(io, 'li.csv', 'LinkedIn,Name\nlinkedin.com/in/sam,Sam'), '--for', 'instantly')
    expect(c.stderr).toBe(`Error: ${join(io.cwd, 'li.csv')} has no email column.\nName the column email, email_address or work_email, so the tool can import it.\n`)
    expect(batches()).toEqual([])
  })

  it('refuses an existing import file without --force, before anything is sent', async () => {
    const io = await withKey()
    writeFileSync(join(io.cwd, 'leads-instantly.csv'), 'old')
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--for', 'instantly')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`Error: ${join(io.cwd, 'leads-instantly.csv')} already exists.\nMove it, or add --force to replace it.\n`)
    expect(batches()).toEqual([])
  })

  it('checks every email against the tool\'s limit for a variable', async () => {
    const io = await withKey({ batchResults: (item) => (touchLines(item as Item).length === 1 ? { status: 'done', result: { ok: true, message: 'x'.repeat(2001) } } : answer(item as Item)) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--for', 'lemlist')
    expect(r.stderr).toContain("2 messages are over lemlist's 2,000 character limit for a variable.")
  })
})

describe('--json', () => {
  it('prints one document instead of the results file', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--json')
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('')
    expect(r.json).toEqual({
      ok: false,
      mode: 'improve',
      people: 2,
      written: 1,
      stopped: [{ row: 3, email: 'jo@example.com', at_email: 2, reason: 'took too long' }],
      rows: [
        { row: 2, emails: [{ subject: 'Ramping at Acme!', message: 'Better: Hi Sam, most teams take 4 months.' }, { subject: null, message: 'Better: Hi Sam, bumping this up.' }], status: 'written' },
        { row: 3, emails: [{ subject: 'Ramping at Northwind!', message: 'Better: Hi there, most teams take 4 months.' }, null], status: 'email 2 failed' },
      ],
    })
    expect(existsSync(join(io.cwd, 'leads-amdahl-sequence.csv'))).toBe(false)
  })

  it('adds send_to with --for, and a halted run says where it stopped', async () => {
    const io = await withKey({ batchRefuse: { 2: { status: 402, code: 'quota_exceeded', message: 'The monthly limit is reached.' } } })
    const r = await cli(io, 'sequence', '--write', 'Book a meeting.', '--emails', '2', '--leads', file(io, 'leads.csv', LEADS), '--for', 'smartlead', '--json')
    expect(r.code).not.toBe(0)
    expect(r.json.ok).toBe(false)
    expect(r.json.mode).toBe('write')
    expect(r.json.halted.at_email).toBe(2)
    expect(r.json.halted.reason).toMatch(/monthly limit/)
    expect(r.json.send_to).toEqual({ tool: 'smartlead', channel: 'email', file: null, ready: 0, left_out: { failed: 0, not_written: 2, needs_input: 0, no_contact: 0 }, over_limit: 0 })
  })
})

describe('--resume', () => {
  it('keeps the people who are written, and continues the rest from their first empty email with their own written emails as prior_touches', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const leads = file(io, 'leads.csv', LEADS)
    const emails = file(io, 'emails.md', EMAILS)
    const first = await cli(io, 'sequence', emails, '--leads', leads)
    expect(first.code).toBe(1)
    expect(first.stderr).toContain(`To write the rest: amdahl sequence ${emails} --leads ${leads} --resume`)
    const before = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(before[1]).toContain(',written')
    expect(before[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.",,email 2 failed')

    await server?.close()
    server = await startMockServer({ batchPolls: 0, batchResults: (item) => answer(item as Item) })
    io.env.AMDAHL_API_URL = server.url
    const again = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(again.code).toBe(0)
    expect(batches()).toEqual([
      [
        {
          item_id: 'row-3',
          channel: 'email',
          recipient: PARK,
          context: {
            rules: [RULE],
            facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B', "The sender's message, word for word:\nHi there, bumping this up."],
            prior_touches: [touch('Subject: Ramping at Northwind!\n\nBetter: Hi there, most teams take 4 months.')],
          },
          message: 'Hi there, bumping this up.',
        },
      ],
    ])
    expect(again.stderr).toBe('Email 2 of 2: 1 of 1 person done.\nWrote 2 emails for 2 of 2 people.\n')
    const after = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.","Better: Hi there, bumping this up.",written')
  })

  it('sends nothing for a list that is already written, and writes the same file', async () => {
    const io = await withKey()
    const args = ['sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS)]
    await cli(io, ...args)
    const text = read(io, 'leads-amdahl-sequence.csv')
    const sent = batches().length
    const r = await cli(io, ...args, '--resume')
    expect(r.code).toBe(0)
    expect(batches()).toHaveLength(sent)
    expect(r.stderr).toBe('Wrote 2 emails for 2 of 2 people.\n')
    expect(read(io, 'leads-amdahl-sequence.csv')).toBe(text)
  })

  it('picks up a written sequence after the sample: the sample person is kept, and only the rest are written', async () => {
    const io = await atTerminal()
    io.answers = ['', 'n']
    const leads = file(io, 'leads.csv', LEADS)
    const args = ['sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', leads]
    await cli(io, ...args)
    expect(batches()).toHaveLength(2)
    io.answers = ['']
    const r = await cli(io, ...args, '--resume')
    expect(r.code).toBe(0)
    expect(io.prompts.slice(-1)).toEqual(['Write these 2 emails? [Y/n]'])
    expect(batches().slice(2).map((b) => b.map((i) => i.item_id))).toEqual([['row-3'], ['row-3']])
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1).map((l) => l.endsWith(',written'))).toEqual([true, true])
  })

  it('reads the same file with --json, and writes none', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const args = ['sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS)]
    await cli(io, ...args)
    const text = read(io, 'leads-amdahl-sequence.csv')
    await server?.close()
    server = await startMockServer({ batchPolls: 0, batchResults: (item) => answer(item as Item) })
    io.env.AMDAHL_API_URL = server.url
    const r = await cli(io, ...args, '--resume', '--json')
    expect(r.code).toBe(0)
    expect(r.json.written).toBe(2)
    expect(batches().map((b) => b.map((i) => i.item_id))).toEqual([['row-3']])
    expect(read(io, 'leads-amdahl-sequence.csv')).toBe(text)
  })

  it('refuses a results file that is not this list\'s, and says why, before anything is sent', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const emails = file(io, 'emails.md', EMAILS)
    const out = join(io.cwd, 'leads-amdahl-sequence.csv')
    await cli(io, 'sequence', emails, '--leads', leads)
    const sent = batches().length
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    writeFileSync(out, [rows[0], rows[1]].join('\r\n'))
    const a = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe(`Error: ${out} has 1 people, and ${leads} has 2.\nRun it without --resume to write every email again; add --force to replace the file.\n`)
    writeFileSync(out, [rows[0], rows[2], rows[1]].join('\r\n'))
    const b = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(b.stderr).toBe(`Error: Row 2 of ${out} is not row 2 of ${leads} (Sam Lee).\nRun it without --resume to write every email again; add --force to replace the file.\n`)
    writeFileSync(out, ['Email,Other', 'a,b'].join('\r\n'))
    const c = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(c.stderr).toBe(`Error: ${out} does not fit this run: its columns are not ${leads}'s columns followed by 2 emails.\nRun it without --resume to write every email again; add --force to replace the file.\n`)
    expect(batches()).toHaveLength(sent)
  })

  it('refuses --resume when there is no results file, and with --force', async () => {
    const io = await withKey()
    const args = ['sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS)]
    const a = await cli(io, ...args, '--resume')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe(`Error: ${join(io.cwd, 'leads-amdahl-sequence.csv')} does not exist, so there is nothing to pick up.\nRun the command without --resume to write the emails.\n`)
    const b = await cli(io, ...args, '--resume', '--force')
    expect(b.stderr).toBe('Error: --resume and --force do not go together: one picks up the results file, the other replaces it.\n')
    expect(batches()).toEqual([])
  })
})

describe('flags', () => {
  it('refuses the flags that need --leads without it, and the ones that do not go with it', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', EMAILS)
    const leads = file(io, 'leads.csv', LEADS)
    const says = async (...args: string[]) => (await cli(io, 'sequence', ...args)).stderr
    expect(await says(emails, '--resume')).toBe('Error: --resume goes with --leads <list.csv>.\n')
    expect(await says(emails, '--for', 'instantly')).toBe('Error: --for goes with --leads <list.csv>.\n')
    expect(await says(emails, '--drop', 'company')).toBe('Error: --drop goes with --leads <list.csv>.\n')
    expect(await says(emails, '--leads', leads, '--csv')).toBe('Error: --csv does not go with --leads: the results are saved next to the list.\n')
    expect(await says(emails, '--leads', leads, '--context', 'ctx.json')).toBe("Error: --context does not go with --leads: each person's row is their context.\n")
    expect(await says('--leads', leads)).toBe('Error: Give a file of emails, or --write "<goal>", with --leads.\n')
    expect(await says('--write', 'A goal.', '--leads', leads, '--drop', 'x')).toBe('Error: --drop goes with emails you improve, not with --write: a written email has no fill-in fields.\n')
    expect(await says(emails, '--leads', join(io.cwd, 'nope.csv'))).toMatch(/nope\.csv/)
    expect(batches()).toEqual([])
  })

  it('leaves amdahl sequence without --leads as it was: --force still goes with --csv', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--force')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe('Error: --force goes with --csv.\n')
  })
})
