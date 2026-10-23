// src/commands/skills-guide.ts
//
// The guided `skills add`: what a person sees after pasting the command from
// a skill page into a terminal. It runs only when stdin and stdout are both a
// terminal and no flag already says where the skill goes (-g, --agents, -y);
// an agent, CI or a pipe never gets a question.
//
// One question. It names the skill and the agents it sees in use, then asks
// where: this project (Enter) or every project on this computer. The answer
// is the go-ahead; there is no second confirm. It is not asked in the home
// folder, where the two are the same. The agents are never asked: they come
// from what is in use (both folders when it sees both kinds, or neither), and
// -g / --agents change them. When a different copy is already there, Enter
// keeps it and `y` replaces it; --force replaces it without asking. Ctrl+C
// stops with nothing written.

import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import { PromptCancelled } from '../io'
import { planInstall, skillDirs, type FilePlan, type Payload, type Targets } from './skills-install'

/** What `skills add` downloaded and checked, shown before anything is written. */
export interface SkillSummary {
  name: string
  publisher: string
  /** From the index entry or the SKILL.md front matter, when either gives one. */
  version?: string
}

/** What the guide settled: where to write and the plan, or that the person kept their own copy. An unchanged folder in the plan is skipped by the write. */
export type GuideResult =
  | { kind: 'install'; targets: Targets; plan: FilePlan[]; force: boolean }
  | { kind: 'kept'; targets: Targets; plan: FilePlan[] }

/** True when `skills add` should guide: a person at a terminal, and no flag already says where. */
export function shouldGuide(ctx: Ctx): boolean {
  const f = ctx.flags
  return !ctx.nonInteractive && ctx.io.stdoutIsTTY && !ctx.out.json && f.global !== true && f.agents !== true && f.yes !== true
}

/** A path as the person would type it: `./...` under this folder, `~/...` under home. */
export function shownPath(ctx: Ctx, path: string): string {
  const under = (base: string) => {
    const rel = relative(base, path)
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)) ? rel : null
  }
  const inCwd = under(ctx.io.cwd)
  if (inCwd !== null) return inCwd ? `./${inCwd.split(sep).join('/')}` : '.'
  const inHome = under(ctx.io.homedir)
  if (inHome !== null) return inHome ? `~/${inHome.split(sep).join('/')}` : '~'
  return path
}

/**
 * The agents this computer shows signs of, by name, and the folders that
 * serves: Claude Code (`.claude` here or at home, or CLAUDECODE) reads
 * `.claude/skills`; Codex (`.codex`), Cursor (`.cursor`, or CURSOR_AGENT) and
 * other agents (`.agents`) read `.agents/skills`. With no sign of either kind,
 * or of both, it serves both folders.
 */
export function agentsInUse(ctx: Ctx): { claude: boolean; agents: boolean; names: string[] } {
  const bases = [ctx.io.cwd, ctx.io.homedir]
  const seen = (dir: string) => bases.some((base) => existsSync(join(base, dir)))
  const claude = seen('.claude') || Boolean(ctx.io.env.CLAUDECODE)
  const codex = seen('.codex')
  const cursor = seen('.cursor') || Boolean(ctx.io.env.CURSOR_AGENT)
  const others = codex || cursor || seen('.agents')
  if (!claude && !others) return { claude: true, agents: true, names: ['Claude Code', 'Codex', 'Cursor'] }
  const names: string[] = []
  if (claude) names.push('Claude Code')
  if (codex) names.push('Codex')
  if (cursor) names.push('Cursor')
  if (others && !codex && !cursor) names.push('other agents')
  return { claude, agents: others, names }
}

/**
 * The agent that is running this command, from what it documents setting in
 * the shell it runs commands in: Claude Code sets CLAUDECODE, Cursor sets
 * CURSOR_AGENT. Codex documents no such variable, so it is never named here.
 */
export function runningAgent(ctx: Ctx): 'claude' | 'cursor' | null {
  if (ctx.io.env.CLAUDECODE) return 'claude'
  if (ctx.io.env.CURSOR_AGENT) return 'cursor'
  return null
}

/** Names joined for a sentence: "A", "A and B", "A, B and C" (or "or"). */
export function joinNames(names: string[], word: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`
}

/** A slug as a name a person reads: `system-diagram` is "System diagram". */
function readable(slug: string): string {
  const words = slug.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Ask until the answer is one of `allowed` ('' is Enter). `n` or `no` stops, as Ctrl+C does. */
async function key(ctx: Ctx, question: string, allowed: string[], retry: string): Promise<string> {
  for (;;) {
    const answer = (await ctx.io.prompt(question)).trim().toLowerCase()
    if (answer === 'n' || answer === 'no') throw new PromptCancelled()
    if (allowed.includes(answer)) return answer
    if (answer === 'yes' && allowed.includes('y')) return 'y'
    ctx.out.info(retry)
  }
}

/**
 * Ask where the skill goes, then return the plan to write. Writes nothing.
 * Ctrl+C at the question throws a `cancelled` CliError.
 */
export async function guide(ctx: Ctx, skill: SkillSummary, payload: Payload): Promise<GuideResult> {
  try {
    return await ask(ctx, skill, payload)
  } catch (err) {
    if (err instanceof PromptCancelled) throw new CliError('cancelled', 'Stopped. Nothing was written.', EXIT.cancelled)
    throw err
  }
}

async function ask(ctx: Ctx, skill: SkillSummary, payload: Payload): Promise<GuideResult> {
  const { io, out } = ctx
  const used = agentsInUse(ctx)
  const count = payload.type === 'archive' ? payload.archive.files.length : 1
  const version = skill.version ? `${skill.version.startsWith('v') ? '' : 'v'}${skill.version}, ` : ''
  out.info(`${readable(skill.name)}, by ${readable(skill.publisher)} (${version}${count} file${count === 1 ? '' : 's'}), for ${joinNames(used.names)}.`)

  let base = io.homedir
  if (io.cwd !== io.homedir) {
    const here = io.cwd.startsWith(io.homedir + sep) ? `~${io.cwd.slice(io.homedir.length).split(sep).join('/')}` : io.cwd
    out.info(['Install it in:', `  1. This project (${here})`, '  2. Every project on this computer'].join('\n'))
    const answer = await key(ctx, 'Press Enter for 1, or type 2: ', ['', '1', '2'], 'Press Enter for 1, or type 2.')
    base = answer === '2' ? io.homedir : io.cwd
  }

  const targets: Targets = { base, claude: used.claude, agents: used.agents }
  const plan = planInstall(skillDirs(targets, skill.name), payload)
  const clashes = plan.filter((p) => p.action === 'replaced')
  if (clashes.length === 0 || ctx.flags.force === true) return { kind: 'install', targets, plan, force: true }

  out.info(
    [
      '',
      `A different copy of ${skill.name} is already at ${joinNames(clashes.map((p) => shownPath(ctx, p.path)))}.`,
      'Replacing it deletes that copy, with any changes you made to it.',
    ].join('\n')
  )
  const answer = await key(ctx, 'Press Enter to keep yours, or type y to replace it: ', ['', 'y'], 'Press Enter to keep yours, or type y.')
  return answer === 'y' ? { kind: 'install', targets, plan, force: true } : { kind: 'kept', targets, plan }
}

/** The folders a plan touches, as the person would type them: `./.claude/skills`, not the skill folder. */
export function skillsFolders(ctx: Ctx, plan: FilePlan[]): string {
  return joinNames(plan.map((p) => shownPath(ctx, dirname(p.path.endsWith('SKILL.md') ? dirname(p.path) : p.path))))
}

/** The one line on what to do next: open a chat in the agents `seen` (read before anything was written). */
export function nextStep(ctx: Ctx, targets: Targets, seen: string[]): string {
  const where = targets.base === ctx.io.homedir ? 'in any folder' : 'in this folder'
  const names = seen.map((n) => (n === 'other agents' ? 'other agent' : n))
  return `Open a new ${joinNames(names, 'or')} chat ${where} to use it.`
}
