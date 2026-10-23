// `skills add` for a folder skill (`type: archive`) against a stubbed fetch:
// the round trip through an archive built the way amdahl.ai builds one, where
// it writes, the overwrite guard, the digest check before any read, the
// download cap, and every archive the reader must refuse.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_ARCHIVE_BYTES } from '../src/commands/skills'
import { MAX_ARCHIVE_FILES, MAX_UNPACKED_BYTES } from '../src/tar-gz'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { gzip, rawTar, skillTar, skillTarGz, type RawEntry, type TarFileSpec } from './helpers/tar'

const SITE = 'https://amdahl.ai'
const INDEX = `${SITE}/skills/amdahl/system-diagram/.well-known/agent-skills/index.json`
const ARCHIVE = `${SITE}/skills/amdahl/system-diagram.tar.gz`
const SKILL = '---\nname: system-diagram\ndescription: "Turn a spec into a diagram: one HTML page."\n---\n\n# System diagram\n'
const FILES: Record<string, TarFileSpec> = {
  'SKILL.md': SKILL,
  'README.md': '# system-diagram\n',
  'build.py': { body: '#!/usr/bin/env python3\nprint("hi")\n', mode: 0o755 },
  'engine/engine.js': 'export {}\n',
  'examples/skeleton/data.json': '{"steps": []}\n',
  'examples/skeleton/screenshot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]),
}
const CONTENTS = ['README.md', 'SKILL.md', 'build.py', 'engine/engine.js', 'examples/skeleton/data.json', 'examples/skeleton/screenshot.png']

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** A one-entry archive index for `archive`, with any entry field overridden. */
function indexFor(archive: Buffer, entry: Record<string, unknown> = {}): string {
  return JSON.stringify({
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [{ name: 'system-diagram', type: 'archive', description: 'Diagrams.', url: ARCHIVE, digest: `sha256:${sha256(archive)}`, ...entry }],
  })
}

/** Stub fetch: the index, then `body` at the archive URL; `promised` sets the digest (default: body's own). */
function serve(body: Buffer | ReadableStream<Uint8Array>, promised?: Buffer, headers?: Record<string, string>) {
  const index = indexFor(promised ?? (body as Buffer))
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input) === INDEX) return new Response(index)
    if (String(input) === ARCHIVE) return new Response(body, { headers })
    return new Response('Not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const projectDir = (io: FakeIo) => join(io.cwd, '.claude', 'skills', 'system-diagram')

/** Every file under `dir`, relative, sorted. */
function listFiles(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]))
    .sort()
}

const bodyOf = (spec: TarFileSpec) => Buffer.from(typeof spec === 'object' && !Buffer.isBuffer(spec) ? spec.body : spec)

/** Run `skills add` with --json and expect a refusal that wrote nothing. */
async function refused(io = fakeIo()) {
  const r = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--json')
  expect(r.code).toBe(1)
  expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  return r.json.error as { code: string; message: string; hint?: string }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skills add, folder skill', () => {
  it('downloads the archive, checks it, and unpacks it into ./.claude/skills/<name>/', async () => {
    const archive = skillTarGz(FILES)
    const fetchMock = serve(archive)
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/system-diagram')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('Added for Claude Code in this project, the default. For every project add -g; for Codex, Cursor and other agents add --agents.\n')
    expect(r.stdout).toBe(`Wrote ${projectDir(io)} (6 files)\n${CONTENTS.map((p) => `  ${p}`).join('\n')}\n`)
    expect(listFiles(projectDir(io))).toEqual(CONTENTS)
    for (const [path, spec] of Object.entries(FILES)) expect(readFileSync(join(projectDir(io), path)).equals(bodyOf(spec))).toBe(true)
    expect(statSync(join(projectDir(io), 'build.py')).mode & 0o111).not.toBe(0)
    expect(statSync(join(projectDir(io), 'README.md')).mode & 0o111).toBe(0)
    // The skill folder itself is 0755, not the temp folder's 0700.
    expect(statSync(projectDir(io)).mode & 0o777).toBe(0o755)
    // No temp folder left beside it, and exactly two requests, both to the site.
    expect(readdirSync(join(io.cwd, '.claude', 'skills'))).toEqual(['system-diagram'])
    expect(fetchMock.mock.calls).toEqual([
      [INDEX, { redirect: 'manual', signal: expect.any(AbortSignal) }],
      [ARCHIVE, { redirect: 'manual', signal: expect.any(AbortSignal) }],
    ])
  })

  it('writes an archive any gzip and tar reader reads the same way', () => {
    // The helper's bytes are a real gzip'd ustar: Node's own gunzip agrees.
    expect(gunzipSync(skillTarGz(FILES)).equals(skillTar(FILES))).toBe(true)
  })

  it('--json lists the folder and its contents; a second run leaves it as it is', async () => {
    const archive = skillTarGz(FILES)
    serve(archive)
    const io = fakeIo()
    const first = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--json')
    expect(first.json).toEqual({
      ok: true,
      publisher: 'amdahl',
      skill: 'system-diagram',
      url: ARCHIVE,
      digest: `sha256:${sha256(archive)}`,
      files: [{ path: projectDir(io), action: 'wrote' }],
      contents: CONTENTS,
    })
    const again = await cli(io, 'skills', 'add', 'amdahl/system-diagram')
    expect(again.code).toBe(0)
    expect(again.stdout).toBe(`Already up to date: ${projectDir(io)}\n`)
  })

  it('-g writes under the home folder; --agents writes .agents/skills too', async () => {
    serve(skillTarGz(FILES))
    const io = fakeIo()
    const global = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '-g', '--json')
    expect(global.json.files).toEqual([{ path: join(io.homedir, '.claude', 'skills', 'system-diagram'), action: 'wrote' }])
    expect(listFiles(join(io.homedir, '.claude', 'skills', 'system-diagram'))).toEqual(CONTENTS)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)

    const both = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--agents', '--json')
    expect(both.json.files).toEqual([
      { path: projectDir(io), action: 'wrote' },
      { path: join(io.cwd, '.agents', 'skills', 'system-diagram'), action: 'wrote' },
    ])
    expect(listFiles(join(io.cwd, '.agents', 'skills', 'system-diagram'))).toEqual(CONTENTS)
  })

  it('refuses to replace a different folder unless --force, which replaces all of it', async () => {
    serve(skillTarGz(FILES))
    const io = fakeIo()
    mkdirSync(projectDir(io), { recursive: true })
    writeFileSync(join(projectDir(io), 'SKILL.md'), 'my own\n')
    writeFileSync(join(projectDir(io), 'notes.md'), 'mine\n')

    const kept = await cli(io, 'skills', 'add', 'amdahl/system-diagram')
    expect(kept.code).toBe(1)
    expect(kept.stderr).toBe(
      `Error: A different system-diagram skill is already at ${projectDir(io)}.\nNothing was written. Run again with --force to replace it.\n`
    )
    expect(listFiles(projectDir(io))).toEqual(['SKILL.md', 'notes.md'])

    const forced = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--force')
    expect(forced.code).toBe(0)
    expect(forced.stdout.split('\n')[0]).toBe(`Replaced ${projectDir(io)} (6 files)`)
    expect(listFiles(projectDir(io))).toEqual(CONTENTS)
    expect(readdirSync(join(io.cwd, '.claude', 'skills'))).toEqual(['system-diagram'])
  })

  it.each<[string, (dir: string) => void]>([
    ['one file more', (dir) => writeFileSync(join(dir, 'extra.md'), 'x')],
    ['one file changed', (dir) => writeFileSync(join(dir, 'README.md'), 'changed')],
    ['one folder more', (dir) => mkdirSync(join(dir, 'more'))],
  ])('counts a folder with %s as different', async (_label, change) => {
    serve(skillTarGz(FILES))
    const io = fakeIo()
    expect((await cli(io, 'skills', 'add', 'amdahl/system-diagram')).code).toBe(0)
    change(projectDir(io))
    expect((await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--json')).json.error.code).toBe('skill_exists')
  })

  it('checks the digest before it reads the archive', async () => {
    // A hostile archive served in place of the promised one: the digest refuses it, not the reader.
    serve(gzip(rawTar([{ path: 'SKILL.md', type: '2', linkname: '/etc/passwd' }])), skillTarGz(FILES))
    const error = await refused()
    expect(error.code).toBe('digest_mismatch')
    expect(error.message).toContain(`${ARCHIVE} does not match its index`)
  })

  it('refuses a download over 4 MB, by Content-Length or as it streams', async () => {
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 65; i++) c.enqueue(new Uint8Array(64 * 1024))
        c.close()
      },
    })
    serve(big, skillTarGz(FILES))
    expect(await refused()).toEqual({ code: 'too_large', message: `${ARCHIVE} is over 4 MB, the most skills add reads for a skill archive.`, hint: 'Nothing was written.' })

    serve(skillTarGz(FILES), undefined, { 'content-length': String(MAX_ARCHIVE_BYTES + 1) })
    expect((await refused()).code).toBe('too_large')
  })

  it('requires SKILL.md at the root, naming the skill', async () => {
    serve(skillTarGz({ 'docs/SKILL.md': SKILL }))
    expect(await refused()).toEqual({ code: 'invalid_skill', message: `${ARCHIVE} is not a valid skill: it has no SKILL.md at its root.` })

    serve(skillTarGz({ 'SKILL.md': SKILL.replace('name: system-diagram', 'name: other') }))
    expect((await refused()).message).toBe(
      `The SKILL.md in ${ARCHIVE} is not a valid skill: its front matter names it "other", but the index lists system-diagram.`
    )

    serve(skillTarGz({ 'SKILL.md': SKILL.replace(/description: .*/, 'description: a: b') }))
    expect((await refused()).message).toContain('its front matter is not valid YAML')
  })

  const skill: RawEntry = { path: 'SKILL.md', body: SKILL }
  it.each<[string, Buffer, string]>([
    ['an absolute path', gzip(rawTar([skill, { path: '/etc/cron.d/x', body: 'x' }])), 'it has an absolute path, "/etc/cron.d/x"'],
    ['a ../ path', gzip(rawTar([skill, { path: '../escape.md', body: 'x' }])), 'it has a path with ".." in it, "../escape.md"'],
    ['a .. inside a path', gzip(rawTar([skill, { path: 'a/../../x', body: 'x' }])), 'it has a path with ".." in it, "a/../../x"'],
    ['a ./ path', gzip(rawTar([skill, { path: './x', body: 'x' }])), 'it has a path with "." in it, "./x"'],
    ['an empty segment', gzip(rawTar([skill, { path: 'a//b', body: 'x' }])), 'it has a path with an empty segment, "a//b"'],
    ['a backslash', gzip(rawTar([skill, { path: 'a\\..\\x', body: 'x' }])), 'it has a path with a backslash, "a\\\\..\\\\x"'],
    ['a control character', gzip(rawTar([skill, { path: 'a\nb', body: 'x' }])), 'it has a path with a control character, "a\\nb"'],
    ['a symbolic link', gzip(rawTar([skill, { path: 'evil', type: '2', linkname: '/etc/passwd' }])), '"evil" is a symbolic link; a skill archive holds only files and folders'],
    ['a hard link', gzip(rawTar([skill, { path: 'evil', type: '1', linkname: 'SKILL.md' }])), '"evil" is a hard link; a skill archive holds only files and folders'],
    ['a device', gzip(rawTar([skill, { path: 'dev', type: '3' }])), '"dev" is a character device; a skill archive holds only files and folders'],
    ['a fifo', gzip(rawTar([skill, { path: 'pipe', type: '6' }])), '"pipe" is a fifo; a skill archive holds only files and folders'],
    ['a pax header', gzip(rawTar([{ path: 'PaxHeader', type: 'x', body: '30 path=../../etc/x\n' }, skill])), '"PaxHeader" is a pax header; a skill archive holds only files and folders'],
    ['a setuid file', gzip(rawTar([skill, { path: 'run', mode: 0o4755, body: 'x' }])), '"run" has mode 4755; a file must be 0644 or 0755'],
    ['a world-writable file', gzip(rawTar([skill, { path: 'run', mode: 0o666, body: 'x' }])), '"run" has mode 0666; a file must be 0644 or 0755'],
    ['the same path twice', gzip(rawTar([skill, { path: 'SKILL.md', body: 'x' }])), 'it lists "SKILL.md" twice'],
    ['paths that differ only in case', gzip(rawTar([skill, { path: 'skill.md', body: 'x' }])), 'it lists "skill.md" twice'],
    ['a file inside a file', gzip(rawTar([skill, { path: 'SKILL.md/x', body: 'x' }])), 'it puts "SKILL.md/x" inside a file'],
    ['a wrong header checksum', gzip(rawTar([{ ...skill, tamper: (h) => void (h[0] = 0x73) }])), 'it has a tar header with a wrong checksum'],
    ['a body cut short', gzip(rawTar([{ ...skill, size: 4096 }])), 'its tar is cut short inside "SKILL.md"'],
    ['no end marker', gzip(rawTar([skill], false)), 'its tar has no end marker'],
    ['data after the end marker', gzip(Buffer.concat([rawTar([skill]), rawTar([{ path: 'late', body: 'x' }])])), 'it has data after its tar end marker'],
    ['a tar of partial blocks', gzip(rawTar([skill]).subarray(0, 1500)), 'its tar is not a whole number of 512-byte blocks'],
    ['not gzip', rawTar([skill]), 'it is not gzip'],
  ])('refuses an archive with %s and writes nothing', async (_label, archive, why) => {
    serve(archive)
    expect(await refused()).toEqual({ code: 'invalid_archive', message: `${ARCHIVE} is not a safe skill archive: ${why}.`, hint: 'Nothing was written.' })
  })

  it('refuses a tar header that is not ustar, with a valid checksum', async () => {
    const tar = rawTar([{ path: 'SKILL.md', body: SKILL }])
    tar.write('ustar ', 257, 'latin1')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (tar[i] as number)
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    serve(gzip(tar))
    expect((await refused()).message).toBe(`${ARCHIVE} is not a safe skill archive: its tar is not ustar.`)
  })

  it.each<[string, (gz: Buffer) => Buffer, string]>([
    ['a wrong CRC-32', (gz) => (gz.writeUInt32LE(gz.readUInt32LE(gz.length - 8) ^ 1, gz.length - 8), gz), 'its gzip CRC-32 does not match its contents'],
    ['a wrong length', (gz) => (gz.writeUInt32LE(gz.readUInt32LE(gz.length - 4) + 512, gz.length - 4), gz), 'its gzip length does not match its contents'],
    ['bytes after the trailer', (gz) => Buffer.concat([gz, Buffer.from([0])]), 'it has bytes after its gzip trailer'],
    ['a second gzip member', (gz) => Buffer.concat([gz, gz]), 'it has bytes after its gzip trailer'],
    ['a trailer cut short', (gz) => gz.subarray(0, gz.length - 3), 'its gzip trailer is cut short'],
    ['a deflate stream cut short', (gz) => gz.subarray(0, 600), 'its gzip data is broken (unexpected end of file)'],
    ['reserved header flags', (gz) => ((gz[3] = 0x20), gz), 'its gzip header sets reserved flags'],
  ])('refuses gzip with %s', async (_label, breakIt, why) => {
    serve(breakIt(skillTarGz(FILES)))
    expect((await refused()).message).toBe(`${ARCHIVE} is not a safe skill archive: ${why}.`)
  })

  it(`unpacks ${MAX_ARCHIVE_FILES} files and refuses one more`, async () => {
    const files: Record<string, string> = { 'SKILL.md': SKILL }
    for (let i = 1; i < MAX_ARCHIVE_FILES; i++) files[`refs/${String(i).padStart(3, '0')}.md`] = 'x'
    serve(skillTarGz(files))
    const io = fakeIo()
    expect((await cli(io, 'skills', 'add', 'amdahl/system-diagram')).code).toBe(0)
    expect(listFiles(projectDir(io))).toHaveLength(MAX_ARCHIVE_FILES)

    serve(skillTarGz({ ...files, 'refs/one-more.md': 'x' }))
    expect(await refused()).toEqual({
      code: 'too_large',
      message: `${ARCHIVE} is too large: it has more than ${MAX_ARCHIVE_FILES} files.`,
      hint: 'Nothing was written.',
    })
  })

  it('unpacks exactly 4 MB of files and refuses one byte more (a small download that unpacks large)', async () => {
    const fill = (n: number) => ({ 'SKILL.md': SKILL, 'big.bin': Buffer.alloc(n - Buffer.byteLength(SKILL)) })
    serve(gzip(skillTar(fill(MAX_UNPACKED_BYTES)), true))
    const io = fakeIo()
    expect((await cli(io, 'skills', 'add', 'amdahl/system-diagram')).code).toBe(0)
    expect(statSync(join(projectDir(io), 'big.bin')).size + Buffer.byteLength(SKILL)).toBe(MAX_UNPACKED_BYTES)

    serve(gzip(skillTar(fill(MAX_UNPACKED_BYTES + 1)), true))
    expect((await refused()).message).toBe(`${ARCHIVE} is too large: its files come to more than 4 MB.`)
  })

  it('stops inflating a gzip bomb at 5 MB, before reading any tar header', async () => {
    serve(gzip(Buffer.alloc(64 * 1024 * 1024), true))
    expect((await refused()).message).toBe(`${ARCHIVE} is too large: it unpacks to more than 5 MB.`)
  })

  it('reads a path split into the ustar prefix', async () => {
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.md`
    serve(skillTarGz({ 'SKILL.md': SKILL, [deep]: 'deep' }))
    const io = fakeIo()
    expect((await cli(io, 'skills', 'add', 'amdahl/system-diagram')).code).toBe(0)
    expect(readFileSync(join(projectDir(io), deep), 'utf8')).toBe('deep')
  })
})
