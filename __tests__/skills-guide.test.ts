// The guided `skills add`: a person at a terminal is asked only what cannot
// be worked out, Enter always takes the right answer, and Ctrl+C writes
// nothing. Without a terminal (an agent, CI, a pipe), or with -y, -g,
// --agents or --json, nothing is asked.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { skillTarGz } from './helpers/tar'

const SITE = 'https://amdahl.ai'
const INDEX = `${SITE}/skills/amdahl/system-diagram/.well-known/agent-skills/index.json`
const ARCHIVE = `${SITE}/skills/amdahl/system-diagram.tar.gz`
const SKILL = '---\nname: system-diagram\ndescription: "Turn a spec into a diagram page: one HTML file."\n---\n'
const archive = skillTarGz({ 'SKILL.md': SKILL, 'build.py': 'print(1)\n', 'engine/engine.js': 'export {}\n' })
const SHA = createHash('sha256').update(archive).digest('hex')

function serve(entry: Record<string, unknown> = {}) {
  const index = JSON.stringify({
    skills: [{ name: 'system-diagram', type: 'archive', description: 'Turn a spec into a diagram page: one HTML file.', url: ARCHIVE, digest: `sha256:${SHA}`, ...entry }],
  })
  const fetchMock = vi.fn(async (input: string) =>
    input === INDEX ? new Response(index) : input === ARCHIVE ? new Response(archive) : new Response('', { status: 404 })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A person at a terminal: stdin and stdout are both a TTY. */
function terminal(answers: (string | null)[] = [], env: Record<string, string> = {}): FakeIo {
  const io = fakeIo(env)
  io.stdoutIsTTY = true
  io.answers.push(...answers)
  return io
}

const claudeDir = (base: string) => join(base, '.claude', 'skills', 'system-diagram')
const agentsDir = (base: string) => join(base, '.agents', 'skills', 'system-diagram')
const SCOPE = 'Press Enter for 1, or type a number: '
const AGENTS = 'Press Enter for 3, or type a number: '
const CONFIRM = 'Press Enter to add it, or Ctrl+C to stop: '
const add = (io: FakeIo, ...flags: string[]) => cli(io, 'skills', 'add', 'amdahl/system-diagram', ...flags)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skills add, guided', () => {
  it('walks a person through it: Enter at every question is right', async () => {
    const fetchMock = serve()
    const io = terminal()
    const here = `~${io.cwd.slice(io.homedir.length)}`
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([SCOPE, AGENTS, CONFIRM])
    // Nothing seen of any agent, so Both: right for whichever one they use.
    expect(readdirSync(claudeDir(io.cwd)).sort()).toEqual(['SKILL.md', 'build.py', 'engine'])
    expect(readdirSync(agentsDir(io.cwd)).sort()).toEqual(['SKILL.md', 'build.py', 'engine'])
    expect(r.stderr).toBe(
      [
        'This adds the system-diagram skill from amdahl.ai to a folder your AI agent reads.',
        'Nothing is written until you say so.',
        '',
        '  Skill:     system-diagram, by amdahl',
        '  Does:      Turn a spec into a diagram page',
        `  Files:     3 files, ${archiveFilesSize()}`,
        `  Checksum:  sha256 ${SHA.slice(0, 12)}, matches amdahl.ai`,
        '',
        'Where should it go?',
        `  1. This project only (${here}) (recommended)`,
        '     Your agent uses it when you work in this folder.',
        '  2. Every project (your home folder)',
        '     Your agent uses it in any folder on this computer.',
        '',
        'Which AI agents should use it?',
        '  1. Claude Code',
        '     Writes it to .claude/skills.',
        '  2. Codex, Cursor and other agents',
        '     Writes it to .agents/skills.',
        '  3. Both (recommended)',
        '     Writes it to both folders. Right if you are not sure.',
        '',
        'Ready to add system-diagram for Claude Code, Codex, Cursor and other agents:',
        '  ./.claude/skills/system-diagram',
        '  ./.agents/skills/system-diagram',
        '',
        'Next: start a new session in your agent, in this folder. The skill loads by itself when a request matches what it does.',
        '',
      ].join('\n')
    )
    expect(r.stdout).toBe('Done. Added system-diagram (3 files) to:\n  ./.claude/skills/system-diagram\n  ./.agents/skills/system-diagram\n')
    // Still exactly the two requests.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([INDEX, ARCHIVE])
  })

  it.each<[string, (io: FakeIo) => void, Record<string, string>]>([
    ['a .claude folder in the project', (io) => mkdirSync(join(io.cwd, '.claude')), {}],
    ['a .claude folder at home', (io) => mkdirSync(join(io.homedir, '.claude')), {}],
    ['CLAUDECODE set', () => {}, { CLAUDECODE: '1' }],
  ])('skips the agents question when only Claude Code is in use (%s)', async (_label, setUp, env) => {
    serve()
    const io = terminal([], env)
    setUp(io)
    expect((await add(io)).code).toBe(0)
    expect(io.prompts).toEqual([SCOPE, CONFIRM])
    expect(existsSync(claudeDir(io.cwd))).toBe(true)
    expect(existsSync(join(io.cwd, '.agents'))).toBe(false)
  })

  it.each(['.agents', '.codex', '.cursor'])('skips it too when only other agents are in use (%s)', async (dir) => {
    serve()
    const io = terminal()
    mkdirSync(join(io.homedir, dir))
    const r = await add(io)
    expect(io.prompts).toEqual([SCOPE, CONFIRM])
    expect(existsSync(agentsDir(io.cwd))).toBe(true)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
    expect(r.stderr).toContain('Next: start a new session in Codex, Cursor or your other agent, in this folder.')
  })

  it('takes typed choices: every project, Claude Code only', async () => {
    serve()
    const io = terminal(['2', '1', ''])
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(existsSync(claudeDir(io.homedir))).toBe(true)
    expect(existsSync(agentsDir(io.homedir))).toBe(false)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
    expect(r.stderr).toContain('Ready to add system-diagram for Claude Code:\n  ~/.claude/skills/system-diagram\n')
    expect(r.stderr).toContain('Next: start a new session in Claude Code, in any folder.')
  })

  it('asks again after an answer it cannot read', async () => {
    serve()
    const io = terminal(['seven', '', '2', ''])
    expect((await add(io)).code).toBe(0)
    expect(io.prompts).toEqual([SCOPE, SCOPE, AGENTS, CONFIRM])
    expect(io.err.join('')).toContain('Type a number from 1 to 2, or press Enter.')
    expect(existsSync(agentsDir(io.cwd))).toBe(true)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it('does not ask where when this folder is the home folder', async () => {
    serve()
    const io = terminal([], { CLAUDECODE: '1' })
    io.cwd = io.homedir
    expect((await add(io)).code).toBe(0)
    expect(io.prompts).toEqual([CONFIRM])
    expect(existsSync(claudeDir(io.homedir))).toBe(true)
  })

  it('shows the version when the index gives one', async () => {
    serve({ version: '0.1.1' })
    const io = terminal()
    await add(io)
    expect(io.err.join('')).toContain('  Skill:     system-diagram, by amdahl, version 0.1.1\n')
  })

  it.each<[string, (string | null)[]]>([
    ['the first question', [null]],
    ['the agents question', ['', null]],
    ['the last step', ['', '', null]],
    ['a "no" at the last step', ['', '', 'n']],
  ])('Ctrl+C at %s stops with nothing written', async (_label, answers) => {
    serve()
    const io = terminal(answers)
    const r = await add(io)
    expect(r.code).toBe(130)
    expect(r.stderr.endsWith('\nStopped. Nothing was written.\n')).toBe(true)
    expect(r.stdout).toBe('')
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('keeps a different copy on Enter, and replaces it only on y', async () => {
    serve()
    const io = terminal(['', ''], { CLAUDECODE: '1' })
    mkdirSync(claudeDir(io.cwd), { recursive: true })
    writeFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'mine\n')
    const kept = await add(io)
    expect(kept.code).toBe(0)
    expect(io.prompts).toEqual([SCOPE, 'Type y to replace it, or press Enter to keep yours: '])
    expect(kept.stderr).toContain(
      'A different copy of system-diagram is already at ./.claude/skills/system-diagram.\nReplacing it deletes that copy, with any changes you made to it.\n'
    )
    expect(kept.stderr).toContain('Kept your copy of system-diagram. Nothing was written.')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe('mine\n')

    io.prompts.length = 0
    io.answers.push('', 'y')
    const replaced = await add(io)
    expect(replaced.code).toBe(0)
    // The y was the go-ahead: no second confirmation.
    expect(io.prompts).toHaveLength(2)
    expect(replaced.stdout).toBe('Done. Added system-diagram (3 files) to:\n  ./.claude/skills/system-diagram\n')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('says so, without asking to confirm, when it is already up to date', async () => {
    serve()
    const io = terminal(['', ''], { CLAUDECODE: '1' })
    await add(io)
    io.prompts.length = 0
    io.answers.push('')
    const r = await add(io)
    expect(io.prompts).toEqual([SCOPE])
    expect(r.stdout).toBe('Already up to date: ./.claude/skills/system-diagram\n')
    expect(r.stderr).toContain('Next: start a new session in Claude Code, in this folder.')
  })
})

describe('skills add, never asks', () => {
  it.each<[string, (io: FakeIo) => void, string[]]>([
    ['-y', () => {}, ['-y']],
    ['--yes', () => {}, ['--yes']],
    ['-g', () => {}, ['-g']],
    ['--agents', () => {}, ['--agents']],
    ['--json', () => {}, ['--json']],
    ['stdout piped', (io) => void (io.stdoutIsTTY = false), []],
    ['stdin piped (an agent or CI)', (io) => void (io.stdinIsTTY = false), []],
    ['AMDAHL_NO_PROMPT=1', (io) => void (io.env.AMDAHL_NO_PROMPT = '1'), []],
  ])('with %s', async (_label, setUp, flags) => {
    serve()
    const io = terminal()
    setUp(io)
    const r = await add(io, ...flags)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
  })

  it('without a terminal it uses the defaults and says so; -y uses them quietly', async () => {
    serve()
    const piped = fakeIo()
    const r = await add(piped)
    expect(existsSync(claudeDir(piped.cwd))).toBe(true)
    expect(existsSync(join(piped.cwd, '.agents'))).toBe(false)
    expect(r.stderr).toBe(
      'Added for Claude Code in this project, the default. For every project add -g; for Codex, Cursor and other agents add --agents.\n'
    )
    const yes = await add(terminal(), '-y')
    expect(yes.stderr).toBe('')
  })

  it('-y still refuses to replace a different copy without --force', async () => {
    serve()
    const io = terminal()
    mkdirSync(claudeDir(io.cwd), { recursive: true })
    writeFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'mine\n')
    const r = await add(io, '-y', '--json')
    expect(r.json.error.code).toBe('skill_exists')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe('mine\n')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder it may not write to is named in plain words', async () => {
    serve()
    const io = fakeIo()
    chmodSync(io.cwd, 0o555)
    try {
      const r = await add(io, '--json')
      expect(r.json.error).toEqual({
        code: 'write_failed',
        message: `Could not write ${claudeDir(io.cwd)}: you do not have permission to write there`,
        hint: 'Nothing was written. Run the command from a folder you can write to.',
      })
    } finally {
      chmodSync(io.cwd, 0o755)
    }
  })
})

/** The file sizes in the test archive, as the guide prints them. */
function archiveFilesSize(): string {
  const bytes = Buffer.byteLength(SKILL) + Buffer.byteLength('print(1)\n') + Buffer.byteLength('export {}\n')
  return `${bytes} bytes`
}
