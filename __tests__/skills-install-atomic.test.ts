// A folder skill installs all or nothing. node:fs is wrapped so a test can
// make one write or one rename fail part way, then check that every target
// is as it was before: no half-unpacked folder, no temp folder, no parent
// folder the run created, and a replaced folder put back.

import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { skillTarGz } from './helpers/tar'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, default: real, writeFileSync: vi.fn(real.writeFileSync), renameSync: vi.fn(real.renameSync) }
})

const { existsSync, mkdirSync, readdirSync, readFileSync } = fs
const realWrite = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeFileSync
const realRename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync

const SITE = 'https://amdahl.ai'
const INDEX = `${SITE}/skills/amdahl/system-diagram/.well-known/agent-skills/index.json`
const ARCHIVE = `${SITE}/skills/amdahl/system-diagram.tar.gz`
const SKILL = '---\nname: system-diagram\ndescription: Diagrams.\n---\n'
const archive = skillTarGz({ 'SKILL.md': SKILL, 'a.md': 'a', 'b/c.md': 'c', 'b/d.md': 'd' })

const claudeDir = (io: FakeIo) => join(io.cwd, '.claude', 'skills', 'system-diagram')
const agentsDir = (io: FakeIo) => join(io.cwd, '.agents', 'skills', 'system-diagram')

/** Fail the nth call (1-based) whose first argument contains `marker`. */
function failNth(fn: typeof fs.writeFileSync | typeof fs.renameSync, real: (...a: any[]) => any, n: number, marker = '.amdahl-tmp-') {
  let seen = 0
  vi.mocked(fn).mockImplementation((...args: any[]) => {
    if (String(args[0]).includes(marker) && ++seen === n) throw new Error('disk full')
    return real(...args)
  })
}

beforeEach(() => {
  const index = JSON.stringify({
    skills: [{ name: 'system-diagram', type: 'archive', url: ARCHIVE, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` }],
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => (input === INDEX ? new Response(index) : input === ARCHIVE ? new Response(archive) : new Response('', { status: 404 })))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(fs.writeFileSync).mockImplementation(realWrite)
  vi.mocked(fs.renameSync).mockImplementation(realRename)
})

describe('skills add, folder skill, all or nothing', () => {
  it('a write that fails part way through unpacking leaves nothing, not even the parent folders', async () => {
    failNth(fs.writeFileSync, realWrite, 3)
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--agents', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error).toEqual({ code: 'write_failed', message: `Could not write ${claudeDir(io)}: disk full`, hint: 'Nothing was written.' })
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('a failure unpacking the second target removes the first, already unpacked', async () => {
    failNth(fs.writeFileSync, realWrite, 6) // the 4 files of the first target, then the second's 2nd
    const io = fakeIo()
    const r = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--agents', '--json')
    expect(r.json.error.message).toBe(`Could not write ${agentsDir(io)}: disk full`)
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('a rename that fails after the first target is in place puts both back as they were', async () => {
    const io = fakeIo()
    for (const dir of [claudeDir(io), agentsDir(io)]) {
      mkdirSync(dir, { recursive: true })
      fs.writeFileSync(join(dir, 'SKILL.md'), `old ${dir}\n`)
    }
    // Renames, in order: claude old -> backup, claude temp -> target, agents old -> backup, agents temp -> target.
    failNth(fs.renameSync, realRename, 4, '')
    const r = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--agents', '--force', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error).toEqual({ code: 'write_failed', message: `Could not write ${agentsDir(io)}: disk full`, hint: 'Nothing was written.' })
    for (const dir of [claudeDir(io), agentsDir(io)]) {
      expect(readdirSync(dir)).toEqual(['SKILL.md'])
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(`old ${dir}\n`)
      // No temp or backup folder beside it.
      expect(readdirSync(join(dir, '..'))).toEqual(['system-diagram'])
    }
  })

  it('with no fault, the same run replaces both and leaves no backup', async () => {
    const io = fakeIo()
    for (const dir of [claudeDir(io), agentsDir(io)]) {
      mkdirSync(dir, { recursive: true })
      fs.writeFileSync(join(dir, 'SKILL.md'), 'old\n')
    }
    const r = await cli(io, 'skills', 'add', 'amdahl/system-diagram', '--agents', '--force')
    expect(r.code).toBe(0)
    for (const dir of [claudeDir(io), agentsDir(io)]) {
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(SKILL)
      expect(readdirSync(join(dir, '..'))).toEqual(['system-diagram'])
    }
    expect(existsSync(join(claudeDir(io), 'b', 'c.md'))).toBe(true)
  })
})
