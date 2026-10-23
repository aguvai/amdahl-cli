// The guided `skills add`: a person at a terminal answers one question, where
// (Enter: this project), for the agents it sees in use. Ctrl+C writes nothing. Without a terminal (an
// agent, CI, a pipe), or with -y, -g, --agents or --json, nothing is asked,
// and an agent that ran it gets its own folder when it says who it is.

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
const WHERE = 'Press Enter for 1, or type 2: '
const KEEP = 'Press Enter to keep yours, or type y to replace it: '
const add = (io: FakeIo, ...flags: string[]) => cli(io, 'skills', 'add', 'amdahl/system-diagram', ...flags)

/** Put a different copy of the skill in the project's .claude/skills. */
function ownCopy(io: FakeIo) {
  mkdirSync(claudeDir(io.cwd), { recursive: true })
  writeFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'mine\n')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skills add, guided', () => {
  it('asks one question, where; Enter installs in this project', async () => {
    const fetchMock = serve()
    const io = terminal([], { CLAUDECODE: '1' })
    const here = `~${io.cwd.slice(io.homedir.length)}`
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([WHERE])
    expect(readdirSync(claudeDir(io.cwd)).sort()).toEqual(['SKILL.md', 'build.py', 'engine'])
    expect(existsSync(join(io.cwd, '.agents'))).toBe(false)
    expect(r.stderr).toBe(
      [
        'Checking amdahl/system-diagram on amdahl.ai... OK',
        '',
        'System diagram, by Amdahl (3 files), for Claude Code.',
        'Install it in:',
        `  1. This project (${here})`,
        '  2. Every project on this computer',
        'Open a new Claude Code chat in this folder to use it.',
        '',
      ].join('\n')
    )
    expect(r.stdout).toBe('\nDone. Added to ./.claude/skills.\n')
    // Still exactly the two requests.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([INDEX, ARCHIVE])
  })

  it.each<[string, (io: FakeIo) => void, Record<string, string>, boolean, boolean, string, string]>([
    ['nothing seen: both folders', () => {}, {}, true, true, 'Claude Code, Codex and Cursor', 'Claude Code, Codex or Cursor'],
    ['a .claude folder in the project', (io) => mkdirSync(join(io.cwd, '.claude')), {}, true, false, 'Claude Code', 'Claude Code'],
    ['a .claude folder at home', (io) => mkdirSync(join(io.homedir, '.claude')), {}, true, false, 'Claude Code', 'Claude Code'],
    ['a .codex folder at home', (io) => mkdirSync(join(io.homedir, '.codex')), {}, false, true, 'Codex', 'Codex'],
    ['a .cursor folder at home', (io) => mkdirSync(join(io.homedir, '.cursor')), {}, false, true, 'Cursor', 'Cursor'],
    ['CURSOR_AGENT set', () => {}, { CURSOR_AGENT: '1' }, false, true, 'Cursor', 'Cursor'],
    ['only an .agents folder', (io) => mkdirSync(join(io.homedir, '.agents')), {}, false, true, 'other agents', 'other agent'],
    [
      'Claude Code and Cursor',
      (io) => {
        mkdirSync(join(io.homedir, '.claude'))
        mkdirSync(join(io.homedir, '.cursor'))
      },
      {},
      true,
      true,
      'Claude Code and Cursor',
      'Claude Code or Cursor',
    ],
  ])('names the agents it sees and writes their folders (%s), with no agent question', async (_label, setUp, env, claude, agents, line, next) => {
    serve()
    const io = terminal([], env)
    setUp(io)
    const r = await add(io)
    expect(io.prompts).toEqual([WHERE])
    expect(r.stderr).toContain(`System diagram, by Amdahl (3 files), for ${line}.\n`)
    expect(existsSync(claudeDir(io.cwd))).toBe(claude)
    expect(existsSync(agentsDir(io.cwd))).toBe(agents)
    const folders = [claude && './.claude/skills', agents && './.agents/skills'].filter(Boolean).join(' and ')
    expect(r.stdout).toBe(`\nDone. Added to ${folders}.\n`)
    expect(r.stderr).toContain(`Open a new ${next} chat in this folder to use it.\n`)
  })

  it('2 installs for every project on this computer', async () => {
    serve()
    const io = terminal(['2'], { CLAUDECODE: '1' })
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(existsSync(claudeDir(io.homedir))).toBe(true)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
    expect(r.stdout).toBe('\nDone. Added to ~/.claude/skills.\n')
    expect(r.stderr).toContain('Open a new Claude Code chat in any folder to use it.')
  })

  it('1 is the same as Enter, and an answer it cannot read asks again', async () => {
    serve()
    const io = terminal(['three', '1'], { CLAUDECODE: '1' })
    expect((await add(io)).code).toBe(0)
    expect(io.prompts).toEqual([WHERE, WHERE])
    expect(io.err.join('')).toContain('Press Enter for 1, or type 2.\n')
    expect(existsSync(claudeDir(io.cwd))).toBe(true)
  })

  it('asks nothing in the home folder, and installs for every project', async () => {
    serve()
    const io = terminal([], { CLAUDECODE: '1' })
    io.cwd = io.homedir
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stderr).not.toContain('Install it in:')
    expect(existsSync(claudeDir(io.homedir))).toBe(true)
    expect(r.stderr).toContain('in any folder to use it.')
  })

  it.each([
    ['0.1.1', '(v0.1.1, 3 files)'],
    ['v2', '(v2, 3 files)'],
  ])('shows version %s from the index', async (version, shown) => {
    serve({ version })
    const io = terminal([], { CLAUDECODE: '1' })
    await add(io)
    expect(io.err.join('')).toContain(`System diagram, by Amdahl ${shown}, for Claude Code.\n`)
  })

  it.each<[string, (string | null)[], boolean]>([
    ['the where question', [null], false],
    ['a "no" at the where question', ['n'], false],
    ['the replace question', ['', null], true],
  ])('Ctrl+C at %s stops with nothing written', async (_label, answers, existing) => {
    serve()
    const io = terminal(answers, { CLAUDECODE: '1' })
    if (existing) ownCopy(io)
    const r = await add(io)
    expect(r.code).toBe(130)
    expect(r.stderr.endsWith('\nStopped. Nothing was written.\n')).toBe(true)
    expect(r.stdout).toBe('')
    if (existing) expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe('mine\n')
    else expect(readdirSync(io.cwd)).toEqual([])
  })

  it('a different copy: Enter keeps it, y replaces it', async () => {
    serve()
    const io = terminal(['', ''], { CLAUDECODE: '1' })
    ownCopy(io)
    const kept = await add(io)
    expect(kept.code).toBe(0)
    expect(io.prompts).toEqual([WHERE, KEEP])
    expect(kept.stderr).toContain(
      'A different copy of system-diagram is already at ./.claude/skills/system-diagram.\nReplacing it deletes that copy, with any changes you made to it.\n'
    )
    expect(kept.stderr).toContain('Kept your copy of system-diagram. Nothing was written.')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe('mine\n')

    io.prompts.length = 0
    io.answers.push('', 'y')
    const replaced = await add(io)
    expect(replaced.code).toBe(0)
    expect(io.prompts).toEqual([WHERE, KEEP])
    expect(replaced.stdout).toBe('\nDone. Added to ./.claude/skills.\n')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('--force at a terminal replaces a different copy without the replace question', async () => {
    serve()
    const io = terminal([''], { CLAUDECODE: '1' })
    ownCopy(io)
    const r = await add(io, '--force')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([WHERE])
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('says when it is already up to date', async () => {
    serve()
    const io = terminal(['', ''], { CLAUDECODE: '1' })
    await add(io)
    const r = await add(io)
    expect(r.stdout).toBe('\nAlready up to date in ./.claude/skills.\n')
    expect(r.stderr).toContain('Open a new Claude Code chat in this folder to use it.')
  })

  it('a skill that is not there: plain words, the progress line closed, no index URL', async () => {
    serve()
    const io = terminal()
    const r = await cli(io, 'skills', 'add', 'amdahl/nope')
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(
      'Checking amdahl/nope on amdahl.ai... \nError: amdahl.ai has no skill amdahl/nope.\nFind it at https://amdahl.ai/skills\n'
    )
    expect(io.prompts).toEqual([])
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
    expect(r.stderr).not.toContain('Checking ')
  })

  it.each<[string, Record<string, string>, boolean, boolean, string]>([
    [
      'no agent named',
      {},
      true,
      false,
      'Added for Claude Code, the default, in this project. For every project add -g; for Codex, Cursor and other agents add --agents.\n',
    ],
    [
      'Claude Code (CLAUDECODE)',
      { CLAUDECODE: '1' },
      true,
      false,
      'Added for Claude Code, which ran this, in this project. For every project add -g; for Codex, Cursor and other agents add --agents.\n',
    ],
    ['Cursor (CURSOR_AGENT)', { CURSOR_AGENT: '1' }, false, true, 'Added to .agents/skills in this project, for Cursor, which ran this. For every project add -g.\n'],
  ])('without a terminal, run by %s, it picks that folder and says so', async (_label, env, claude, agents, note) => {
    serve()
    const io = fakeIo(env)
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(existsSync(claudeDir(io.cwd))).toBe(claude)
    expect(existsSync(agentsDir(io.cwd))).toBe(agents)
    expect(r.stderr).toBe(note)
  })

  it('--agents wins over the agent that ran it; -y adds quietly', async () => {
    serve()
    const io = fakeIo({ CURSOR_AGENT: '1' })
    await add(io, '--agents')
    expect(existsSync(claudeDir(io.cwd))).toBe(true)
    expect(existsSync(agentsDir(io.cwd))).toBe(true)
    const yes = await add(terminal(), '-y')
    expect(yes.stderr).toBe('')
  })

  it('-y still refuses to replace a different copy without --force', async () => {
    serve()
    const io = terminal()
    ownCopy(io)
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
