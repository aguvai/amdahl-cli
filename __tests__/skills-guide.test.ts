// The guided `skills add`: a person at a terminal presses Enter once. It
// shows where the skill goes (this project, for the agents in use) and asks
// once; `c` changes where, Ctrl+C writes nothing. Without a terminal (an
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
const GO = 'Press Enter to add it. Type c to change where, or Ctrl+C to stop: '
const KEEP = 'Press Enter to keep yours. Type y to replace it, c to change where, or Ctrl+C to stop: '
const SCOPE = 'Press Enter for 1, or type a number: '
const add = (io: FakeIo, ...flags: string[]) => cli(io, 'skills', 'add', 'amdahl/system-diagram', ...flags)
const NEXT_TAIL = 'The skill loads by itself when a request matches what it does.'

/** Put a different copy of the skill in the project's .claude/skills. */
function ownCopy(io: FakeIo) {
  mkdirSync(claudeDir(io.cwd), { recursive: true })
  writeFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'mine\n')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skills add, guided', () => {
  it('the main path is one Enter: it says what and where, then adds it', async () => {
    const fetchMock = serve()
    const io = terminal([], { CLAUDECODE: '1' })
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([GO])
    expect(readdirSync(claudeDir(io.cwd)).sort()).toEqual(['SKILL.md', 'build.py', 'engine'])
    expect(existsSync(join(io.cwd, '.agents'))).toBe(false)
    expect(r.stderr).toBe(
      [
        'Checking amdahl/system-diagram on amdahl.ai... OK',
        '',
        'This adds the system-diagram skill, by amdahl, to a folder your AI agent reads.',
        '  What it does: Turn a spec into a diagram page',
        '  Size: 3 files, 111 bytes',
        '',
        'It goes to this project, for Claude Code:',
        '  ./.claude/skills/system-diagram',
        '',
        `Next: start a new session in Claude Code, in this folder. ${NEXT_TAIL}`,
        '',
      ].join('\n')
    )
    expect(r.stdout).toBe('Done. Added system-diagram (3 files) to:\n  ./.claude/skills/system-diagram\n')
    // Still exactly the two requests, and no checksum line for a person to read.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([INDEX, ARCHIVE])
    expect(r.stderr).not.toContain('sha256')
  })

  it.each<[string, (io: FakeIo) => void, Record<string, string>, boolean, boolean, string]>([
    ['nothing seen: both folders', () => {}, {}, true, true, 'Claude Code or your other agent'],
    ['a .claude folder in the project', (io) => mkdirSync(join(io.cwd, '.claude')), {}, true, false, 'Claude Code'],
    ['a .claude folder at home', (io) => mkdirSync(join(io.homedir, '.claude')), {}, true, false, 'Claude Code'],
    ['CLAUDECODE set', () => {}, { CLAUDECODE: '1' }, true, false, 'Claude Code'],
    ['an .agents folder at home', (io) => mkdirSync(join(io.homedir, '.agents')), {}, false, true, 'Codex, Cursor or your other agent'],
    ['a .codex folder at home', (io) => mkdirSync(join(io.homedir, '.codex')), {}, false, true, 'Codex, Cursor or your other agent'],
    ['a .cursor folder at home', (io) => mkdirSync(join(io.homedir, '.cursor')), {}, false, true, 'Codex, Cursor or your other agent'],
    [
      'both kinds seen: both folders',
      (io) => {
        mkdirSync(join(io.homedir, '.claude'))
        mkdirSync(join(io.homedir, '.codex'))
      },
      {},
      true,
      true,
      'Claude Code or your other agent',
    ],
  ])('picks the agents from what it sees (%s), still with one Enter', async (_label, setUp, env, claude, agents, who) => {
    serve()
    const io = terminal([], env)
    setUp(io)
    const r = await add(io)
    expect(io.prompts).toEqual([GO])
    expect(existsSync(claudeDir(io.cwd))).toBe(claude)
    expect(existsSync(agentsDir(io.cwd))).toBe(agents)
    expect(r.stderr).toContain(`Next: start a new session in ${who}, in this folder.`)
  })

  it('c opens the two questions: every project, Claude Code only, then adds it without asking again', async () => {
    serve()
    const io = terminal(['c', '2', '1'])
    const here = `~${io.cwd.slice(io.homedir.length)}`
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([GO, SCOPE, 'Press Enter for 3, or type a number: '])
    expect(existsSync(claudeDir(io.homedir))).toBe(true)
    expect(existsSync(agentsDir(io.homedir))).toBe(false)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
    expect(r.stderr).toContain(`  1. This project only: ${here} (recommended)\n`)
    expect(r.stderr).toContain('  2. Every project: your home folder\n')
    expect(r.stderr).toContain('It goes to every project, for Claude Code:\n  ~/.claude/skills/system-diagram\n')
    expect(r.stdout).toBe('Done. Added system-diagram (3 files) to:\n  ~/.claude/skills/system-diagram\n')
    expect(r.stderr).toContain('Next: start a new session in Claude Code, in any folder.')
  })

  it('asks again after an answer it cannot read, at each kind of question', async () => {
    serve()
    const io = terminal(['what', 'c', 'seven', '', '2'])
    expect((await add(io)).code).toBe(0)
    expect(io.prompts).toEqual([GO, GO, SCOPE, SCOPE, 'Press Enter for 3, or type a number: '])
    const err = io.err.join('')
    expect(err).toContain('Press Enter, or type c.')
    expect(err).toContain('Type a number from 1 to 2, or press Enter.')
    expect(existsSync(agentsDir(io.cwd))).toBe(true)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it('does not ask this-project-or-every-project in the home folder', async () => {
    serve()
    const io = terminal(['c', ''])
    io.cwd = io.homedir
    expect((await add(io)).code).toBe(0)
    expect(io.prompts).toEqual([GO, 'Press Enter for 3, or type a number: '])
    expect(existsSync(claudeDir(io.homedir))).toBe(true)
  })

  it('shows the version when the index gives one', async () => {
    serve({ version: '0.1.1' })
    const io = terminal()
    await add(io)
    expect(io.err.join('')).toContain('This adds the system-diagram skill, by amdahl, version 0.1.1, to a folder your AI agent reads.\n')
  })

  it.each<[string, (string | null)[]]>([
    ['the one question', [null]],
    ['a "no" at the one question', ['n']],
    ['the where question', ['c', null]],
    ['the agents question', ['c', '', null]],
  ])('Ctrl+C at %s stops with nothing written', async (_label, answers) => {
    serve()
    const io = terminal(answers)
    const r = await add(io)
    expect(r.code).toBe(130)
    expect(r.stderr.endsWith('\nStopped. Nothing was written.\n')).toBe(true)
    expect(r.stdout).toBe('')
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('a different copy: Enter keeps it, y replaces it, with no second question', async () => {
    serve()
    const io = terminal([''], { CLAUDECODE: '1' })
    ownCopy(io)
    const kept = await add(io)
    expect(kept.code).toBe(0)
    expect(io.prompts).toEqual([KEEP])
    expect(kept.stderr).toContain(
      'A different copy of system-diagram is already at ./.claude/skills/system-diagram.\nReplacing it deletes that copy, with any changes you made to it.\n'
    )
    expect(kept.stderr).toContain('Kept your copy of system-diagram. Nothing was written.')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe('mine\n')

    io.prompts.length = 0
    io.answers.push('y')
    const replaced = await add(io)
    expect(replaced.code).toBe(0)
    expect(io.prompts).toEqual([KEEP])
    expect(replaced.stdout).toBe('Done. Added system-diagram (3 files) to:\n  ./.claude/skills/system-diagram\n')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('a different copy found after c still asks, and Enter still keeps it', async () => {
    serve()
    const io = terminal(['c', '', '1', ''])
    ownCopy(io)
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts.at(-1)).toBe('Press Enter to keep yours. Type y to replace it, or Ctrl+C to stop: ')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe('mine\n')
  })

  it('--force at a terminal replaces a different copy without the replace question', async () => {
    serve()
    const io = terminal([''], { CLAUDECODE: '1' })
    ownCopy(io)
    const r = await add(io, '--force')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([GO])
    expect(r.stderr).toContain('It will replace that copy (--force).')
    expect(readFileSync(join(claudeDir(io.cwd), 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('asks nothing when it is already up to date', async () => {
    serve()
    const io = terminal([''], { CLAUDECODE: '1' })
    await add(io)
    io.prompts.length = 0
    const r = await add(io)
    expect(io.prompts).toEqual([])
    expect(r.stdout).toBe('Already up to date: ./.claude/skills/system-diagram\n')
    expect(r.stderr).toContain('Next: start a new session in Claude Code, in this folder.')
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
