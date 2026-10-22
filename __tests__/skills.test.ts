// `skills add` against a stubbed fetch: the two requests it makes, where it
// writes (project, -g, --agents), the digest and front matter refusals, the
// overwrite guard, the deadline and size caps, --site and the reference forms.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_INDEX_BYTES, MAX_SKILL_BYTES } from '../src/commands/skills'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'

const SITE = 'https://amdahl.ai'
const INDEX = `${SITE}/skills/amdahl/call-prep/.well-known/agent-skills/index.json`
const FILE = `${SITE}/skills/amdahl/call-prep.md`
const SKILL = '---\nname: call-prep\ndescription: "Brief a seller before a call: who is on it."\n---\n\n# Call prep\n'

/** A body, a full response, or `hang`: a fetch that never settles, not even on its abort signal. */
type Answer = string | 'hang' | { status?: number; body?: ConstructorParameters<typeof Response>[0]; headers?: Record<string, string> }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A body sent as `chunks` 16 KB pieces of `x`, then left open when `stall` is set. */
function stream(chunks: number, stall = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(16 * 1024).fill(120))
      if (!stall) controller.close()
    },
  })
}

/** A one-entry index for `markdown`, with any entry field overridden. */
function indexFor(markdown: string, entry: Record<string, unknown> = {}, file = FILE): string {
  return JSON.stringify({
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [{ name: 'call-prep', type: 'skill-md', description: 'Brief a seller.', url: file, digest: `sha256:${sha256(markdown)}`, ...entry }],
  })
}

/** Stub fetch with a site that answers these URLs; anything else is a 404. */
function serve(answers: Record<string, Answer>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const answer = answers[String(input)]
    if (answer === undefined) return new Response('Not found', { status: 404 })
    if (answer === 'hang') return new Promise<Response>(() => {})
    if (typeof answer === 'string') return new Response(answer, { status: 200 })
    return new Response(answer.body ?? null, { status: answer.status ?? 200, headers: answer.headers })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Serve SKILL (or `markdown`) under an index whose digest matches it. */
function serveSkill(markdown = SKILL, entry: Record<string, unknown> = {}) {
  return serve({ [INDEX]: indexFor(markdown, entry), [FILE]: markdown })
}

const projectSkill = (io: FakeIo, name = 'call-prep') => join(io.cwd, '.claude', 'skills', name, 'SKILL.md')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skills add', () => {
  it('reads the index, then the file, and writes ./.claude/skills/<name>/SKILL.md', async () => {
    const fetchMock = serveSkill()
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`Wrote ${projectSkill(io)}\n`)
    expect(r.stderr).toBe('')
    expect(readFileSync(projectSkill(io), 'utf8')).toBe(SKILL)
    // Exactly two requests, both to the site, with no redirect followed and a deadline each.
    expect(fetchMock.mock.calls).toEqual([
      [INDEX, { redirect: 'manual', signal: expect.any(AbortSignal) }],
      [FILE, { redirect: 'manual', signal: expect.any(AbortSignal) }],
    ])
    expect(existsSync(join(io.homedir, '.claude'))).toBe(false)
  })

  it('--json reports the source and every file', async () => {
    serveSkill()
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(r.json).toEqual({
      ok: true,
      publisher: 'amdahl',
      skill: 'call-prep',
      url: FILE,
      digest: `sha256:${sha256(SKILL)}`,
      files: [{ path: projectSkill(io), action: 'wrote' }],
    })
  })

  it.each([
    'https://amdahl.ai/skills/amdahl/call-prep',
    'https://amdahl.ai/skills/amdahl/call-prep/',
    'https://amdahl.ai/skills/amdahl/call-prep.md',
    'amdahl/call-prep.md',
  ])('accepts %s', async (ref) => {
    const fetchMock = serveSkill()
    const io = fakeIo()
    expect((await cli(io, 'skills', 'add', ref)).code).toBe(0)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([INDEX, FILE])
  })

  it('-g writes under the home folder, not the project', async () => {
    serveSkill()
    const io = fakeIo()
    const path = join(io.homedir, '.claude', 'skills', 'call-prep', 'SKILL.md')
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '-g')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`Wrote ${path}\n`)
    expect(readFileSync(path, 'utf8')).toBe(SKILL)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it('--agents also writes .agents/skills, under the home folder with -g', async () => {
    serveSkill()
    const io = fakeIo()
    const local = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--agents')
    const agents = join(io.cwd, '.agents', 'skills', 'call-prep', 'SKILL.md')
    expect(local.stdout).toBe(`Wrote ${projectSkill(io)}\nWrote ${agents}\n`)
    expect(readFileSync(agents, 'utf8')).toBe(SKILL)
    const global = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--agents', '--global', '--json')
    expect(global.json.files).toEqual([
      { path: join(io.homedir, '.claude', 'skills', 'call-prep', 'SKILL.md'), action: 'wrote' },
      { path: join(io.homedir, '.agents', 'skills', 'call-prep', 'SKILL.md'), action: 'wrote' },
    ])
  })

  it('refuses a file whose sha256 differs from the index digest, and writes nothing', async () => {
    serve({ [INDEX]: indexFor(SKILL), [FILE]: SKILL.replace('Call prep', 'Call prep, changed') })
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('digest_mismatch')
    expect(r.json.error.message).toContain(`the index says ${sha256(SKILL)}`)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it('refuses front matter that is not valid YAML (an unquoted ": " in the description)', async () => {
    const markdown = '---\nname: call-prep\ndescription: Brief a seller before a call: who is on it.\n---\n\n# Call prep\n'
    serveSkill(markdown)
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('invalid_skill')
    expect(r.json.error.message).toBe(
      `${FILE} is not a valid skill: its front matter is not valid YAML (line 3: Nested mappings are not allowed in compact mappings).`
    )
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it.each([
    ['no front matter', '# Call prep\n', 'it has no front matter'],
    ['a name other than the index', SKILL.replace('name: call-prep', 'name: other-skill'), 'its front matter names it "other-skill", but the index lists call-prep'],
    ['a name that is not a string', SKILL.replace('name: call-prep', 'name: [call-prep]'), 'its front matter has no string name'],
    ['a description that is not a string', SKILL.replace(/description: .*/, 'description: { text: hi }'), 'its front matter has no string description'],
    ['a duplicate key', SKILL.replace('---\n\n', 'name: call-prep\n---\n\n'), 'its front matter is not valid YAML (line 4: Map keys must be unique)'],
  ])('refuses a file with %s', async (_label, markdown, why) => {
    serveSkill(markdown)
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error).toEqual({ code: 'invalid_skill', message: `${FILE} is not a valid skill: ${why}.` })
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it('refuses to overwrite a different skill of the same name unless --force', async () => {
    serveSkill()
    const io = fakeIo()
    mkdirSync(join(io.cwd, '.claude', 'skills', 'call-prep'), { recursive: true })
    writeFileSync(projectSkill(io), 'my own call-prep\n')
    const kept = await cli(io, 'skills', 'add', 'amdahl/call-prep')
    expect(kept.code).toBe(1)
    expect(kept.stderr).toBe(
      `Error: A different call-prep skill is already at ${projectSkill(io)}.\nNothing was written. Run again with --force to replace it.\n`
    )
    expect(readFileSync(projectSkill(io), 'utf8')).toBe('my own call-prep\n')

    const forced = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--force')
    expect(forced.code).toBe(0)
    expect(forced.stdout).toBe(`Replaced ${projectSkill(io)}\n`)
    expect(readFileSync(projectSkill(io), 'utf8')).toBe(SKILL)

    const again = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(again.json.files).toEqual([{ path: projectSkill(io), action: 'unchanged' }])
  })

  it('checks every target before it writes any', async () => {
    serveSkill()
    const io = fakeIo()
    const agents = join(io.cwd, '.agents', 'skills', 'call-prep', 'SKILL.md')
    mkdirSync(join(io.cwd, '.agents', 'skills', 'call-prep'), { recursive: true })
    writeFileSync(agents, 'someone else\n')
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--agents', '--json')
    expect(r.json.error.code).toBe('skill_exists')
    expect(existsSync(projectSkill(io))).toBe(false)
  })

  it('--site points both requests at another origin; http only for localhost', async () => {
    const site = 'http://localhost:6782'
    const index = `${site}/skills/amdahl/call-prep/.well-known/agent-skills/index.json`
    const file = `${site}/skills/amdahl/call-prep.md`
    const fetchMock = serve({ [index]: indexFor(SKILL, {}, file), [file]: SKILL })
    const io = fakeIo()
    expect((await cli(io, 'skills', 'add', `${site}/skills/amdahl/call-prep`, '--site', site)).code).toBe(0)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([index, file])

    fetchMock.mockClear()
    for (const bad of ['http://example.com', 'https://amdahl.ai/skills', 'localhost:6782', 'ftp://localhost']) {
      expect((await cli(io, 'skills', 'add', 'amdahl/call-prep', '--site', bad)).code).toBe(2)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an index that points the file off the site, without fetching it', async () => {
    const fetchMock = serve({ [INDEX]: indexFor(SKILL, { url: 'https://evil.example/call-prep.md' }) })
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error).toEqual({
      code: 'invalid_index',
      message: `The index at ${INDEX} points call-prep at https://evil.example, not https://amdahl.ai.`,
    })
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([INDEX])
  })

  it('resolves a relative file URL against the index', async () => {
    const fetchMock = serve({ [INDEX]: indexFor(SKILL, { url: '/skills/amdahl/call-prep.md' }), [FILE]: SKILL })
    expect((await cli(fakeIo(), 'skills', 'add', 'amdahl/call-prep')).code).toBe(0)
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([INDEX, FILE])
  })

  it.each([
    ['not JSON', 'nope', 'is not JSON'],
    ['no skills list', '{"skills": {}}', 'has no skills list'],
    ['another skill only', indexFor(SKILL, { name: 'other' }), 'does not list call-prep'],
    ['the wrong type', indexFor(SKILL, { type: 'archive' }), 'lists call-prep as a type other than skill-md'],
    ['a bad digest', indexFor(SKILL, { digest: 'md5:abc' }), 'gives call-prep no sha256 digest'],
  ])('refuses an index with %s', async (_label, body, why) => {
    serve({ [INDEX]: body, [FILE]: SKILL })
    const r = await cli(fakeIo(), 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error).toEqual({ code: 'invalid_index', message: `The index at ${INDEX} ${why}.` })
  })

  it.each<[string, Record<string, Answer>, string, string[]]>([
    ['the index', { [INDEX]: 'hang' }, INDEX, [INDEX]],
    ['the index body', { [INDEX]: { body: stream(1, true) } }, INDEX, [INDEX]],
    ['the file', { [INDEX]: indexFor(SKILL), [FILE]: 'hang' }, FILE, [INDEX, FILE]],
    ['the file body', { [INDEX]: indexFor(SKILL), [FILE]: { body: stream(1, true) } }, FILE, [INDEX, FILE]],
  ])(
    'gives up waiting for %s after the deadline, exits 8 and writes nothing',
    async (_label, answers, url, calls) => {
      const fetchMock = serve(answers)
      const io = fakeIo()
      const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
      expect(r.code).toBe(8)
      expect(r.json.error).toEqual({ code: 'network_error', message: `No answer from ${url} within 0.1 seconds.` })
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(calls)
      expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
    },
    3000
  )

  it.each<[string, Record<string, Answer>, string, string, string[]]>([
    ['an index body over the cap', { [INDEX]: { body: stream(17) } }, INDEX, '256 KB, the most skills add reads for a skill index', [INDEX]],
    [
      'an index Content-Length over the cap',
      { [INDEX]: { body: indexFor(SKILL), headers: { 'content-length': String(MAX_INDEX_BYTES + 1) } }, [FILE]: SKILL },
      INDEX,
      '256 KB, the most skills add reads for a skill index',
      [INDEX],
    ],
    ['a SKILL.md body over the cap', { [INDEX]: indexFor(SKILL), [FILE]: { body: stream(5) } }, FILE, '64 KB, the most skills add reads for a SKILL.md', [INDEX, FILE]],
    [
      'a SKILL.md Content-Length over the cap',
      { [INDEX]: indexFor(SKILL), [FILE]: { body: SKILL, headers: { 'content-length': String(MAX_SKILL_BYTES + 1) } } },
      FILE,
      '64 KB, the most skills add reads for a SKILL.md',
      [INDEX, FILE],
    ],
  ])('refuses %s and writes nothing', async (_label, answers, url, limit, calls) => {
    const fetchMock = serve(answers)
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error).toEqual({ code: 'too_large', message: `${url} is over ${limit}.`, hint: 'Nothing was written.' })
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(calls)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it('installs a SKILL.md of exactly 64 KB, the most amdahl.ai accepts, and refuses one byte more', async () => {
    const exact = SKILL + 'x'.repeat(MAX_SKILL_BYTES - Buffer.byteLength(SKILL))
    serveSkill(exact)
    const io = fakeIo()
    expect((await cli(io, 'skills', 'add', 'amdahl/call-prep')).code).toBe(0)
    expect(readFileSync(projectSkill(io)).length).toBe(MAX_SKILL_BYTES)
    serveSkill(`${exact}x`)
    expect((await cli(fakeIo(), 'skills', 'add', 'amdahl/call-prep', '--json')).json.error.code).toBe('too_large')
  })

  it('a missing skill exits 1, a redirect is not followed, a network failure exits 8', async () => {
    serve({})
    const missing = await cli(fakeIo(), 'skills', 'add', 'amdahl/nope', '--json')
    expect(missing.code).toBe(1)
    expect(missing.json.error.code).toBe('skill_not_found')

    serve({ [INDEX]: { status: 301 } })
    const moved = await cli(fakeIo(), 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(moved.code).toBe(1)
    expect(moved.json.error.code).toBe('skill_redirect')

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    const down = await cli(fakeIo(), 'skills', 'add', 'amdahl/call-prep', '--json')
    expect(down.code).toBe(8)
    expect(down.json.error.code).toBe('network_error')
  })

  it('rejects anything that is not one skill on the site, before any request', async () => {
    const fetchMock = serveSkill()
    const io = fakeIo()
    for (const ref of ['amdahl', 'amdahl/call-prep/x', '../call-prep', 'amdahl/Call-Prep', 'amdahl/call--prep', 'https://evil.example/skills/amdahl/call-prep', 'https://amdahl.ai/blog/amdahl/call-prep']) {
      expect((await cli(io, 'skills', 'add', ref)).code, ref).toBe(2)
    }
    expect((await cli(io, 'skills', 'add')).code).toBe(2)
    expect((await cli(io, 'skills', 'add', 'a/b', 'c/d')).code).toBe(2)
    expect((await cli(io, 'skills')).code).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
