// src/commands/skills-guide.ts
//
// The guided `skills add`: what a person sees after pasting the command from
// a skill page into a terminal. It runs only when stdin and stdout are both a
// terminal and no flag already says where the skill goes (-g, --agents, -y);
// an agent, CI or a pipe never gets a question.
//
// It says what is about to happen and what was downloaded (nothing is
// written yet), asks only what it cannot work out, with the right answer
// already chosen so Enter is always correct, and ends with what to do next.
// The questions: this project or every project (skipped when the two are the
// same folder); which agents (skipped when only Claude Code, or only the
// others, are in use); replace a different copy already there (Enter keeps
// it). Ctrl+C at any question stops with nothing written.

import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import { PromptCancelled } from '../io'
import { planInstall, skillDirs, type FilePlan, type Payload, type Targets } from './skills-install'

/** What `skills add` downloaded and checked, shown before anything is written. */
export interface SkillSummary {
  name: string
  publisher: string
  description: string
  /** From the index entry or the SKILL.md front matter, when either gives one. */
  version?: string
  sha256: string
  /** The site's host, for example amdahl.ai. */
  host: string
}

/** What the guide settled: where to write, the plan, and whether replacing is allowed. */
export type GuideResult =
  | { kind: 'install'; targets: Targets; plan: FilePlan[]; force: boolean }
  | { kind: 'up-to-date'; targets: Targets; plan: FilePlan[] }
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

/** Which agents this computer shows signs of: Claude Code, and the agents that read `.agents/skills`. */
export function agentsInUse(ctx: Ctx): { claude: boolean; others: boolean } {
  const bases = [ctx.io.cwd, ctx.io.homedir]
  const seen = (dir: string) => bases.some((base) => existsSync(join(base, dir)))
  return {
    claude: seen('.claude') || Boolean(ctx.io.env.CLAUDECODE),
    others: seen('.agents') || seen('.codex') || seen('.cursor'),
  }
}

/** Who reads a skill folder, in words. */
export function agentLabel(targets: Pick<Targets, 'claude' | 'agents'>): string {
  if (targets.claude && targets.agents) return 'Claude Code, Codex, Cursor and other agents'
  return targets.claude ? 'Claude Code' : 'Codex, Cursor and other agents'
}

/** The first clause of a description, at most 100 characters. */
function firstClause(text: string): string {
  const clause = text.split(/[.:;](?:\s|$)/)[0]?.trim() ?? ''
  return clause.length > 100 ? `${clause.slice(0, 97).trimEnd()}...` : clause
}

/** A byte count in KB or MB. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Ask one numbered question. Enter takes the recommended option. */
async function choose(ctx: Ctx, question: string, options: { label: string; detail: string }[], recommended: number): Promise<number> {
  const lines = [question]
  options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${i === recommended ? ' (recommended)' : ''}`, `     ${o.detail}`))
  ctx.out.info(lines.join('\n'))
  for (;;) {
    const answer = (await ctx.io.prompt(`Press Enter for ${recommended + 1}, or type a number: `)).trim()
    if (answer === '') return recommended
    const n = Number(answer)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
    ctx.out.info(`Type a number from 1 to ${options.length}, or press Enter.`)
  }
}

/**
 * Walk a person through where the skill goes, then return the plan to write.
 * Writes nothing. Ctrl+C at any question throws a `cancelled` CliError.
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
  const files = payload.type === 'archive' ? payload.archive.files.map((f) => f.bytes.length) : [payload.body.length]
  const count = `${files.length} file${files.length === 1 ? '' : 's'}, ${size(files.reduce((a, b) => a + b, 0))}`
  const facts = [
    `This adds the ${skill.name} skill from ${skill.host} to a folder your AI agent reads.`,
    'Nothing is written until you say so.',
    '',
    `  Skill:     ${skill.name}, by ${skill.publisher}${skill.version ? `, version ${skill.version}` : ''}`,
  ]
  const what = firstClause(skill.description)
  if (what) facts.push(`  Does:      ${what}`)
  facts.push(`  Files:     ${count}`, `  Checksum:  sha256 ${skill.sha256.slice(0, 12)}, matches ${skill.host}`)
  // Ends with a blank line before the first question.
  out.info(`${facts.join('\n')}\n\n`)

  let base = io.homedir
  if (io.cwd !== io.homedir) {
    const here = io.cwd.startsWith(io.homedir + sep) ? `~${io.cwd.slice(io.homedir.length).split(sep).join('/')}` : io.cwd
    const scope = await choose(
      ctx,
      'Where should it go?',
      [
        { label: `This project only (${here})`, detail: 'Your agent uses it when you work in this folder.' },
        { label: 'Every project (your home folder)', detail: 'Your agent uses it in any folder on this computer.' },
      ],
      0
    )
    base = scope === 0 ? io.cwd : io.homedir
    out.info('')
  }

  const used = agentsInUse(ctx)
  let agents: Pick<Targets, 'claude' | 'agents'>
  if (used.claude !== used.others) {
    agents = { claude: used.claude, agents: used.others }
  } else {
    const pick = await choose(
      ctx,
      'Which AI agents should use it?',
      [
        { label: 'Claude Code', detail: 'Writes it to .claude/skills.' },
        { label: 'Codex, Cursor and other agents', detail: 'Writes it to .agents/skills.' },
        { label: 'Both', detail: 'Writes it to both folders. Right if you are not sure.' },
      ],
      2
    )
    agents = { claude: pick !== 1, agents: pick !== 0 }
    out.info('')
  }
  const targets: Targets = { base, ...agents }
  const plan = planInstall(skillDirs(targets, skill.name), payload)

  if (plan.every((p) => p.action === 'unchanged')) return { kind: 'up-to-date', targets, plan }
  const clashes = plan.filter((p) => p.action === 'replaced')
  if (clashes.length > 0) {
    out.info(
      [
        `A different copy of ${skill.name} is already at ${clashes.map((p) => shownPath(ctx, p.path)).join(' and ')}.`,
        'Replacing it deletes that copy, with any changes you made to it.',
      ].join('\n')
    )
    const answer = (await io.prompt('Type y to replace it, or press Enter to keep yours: ')).trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') return { kind: 'kept', targets, plan }
    return { kind: 'install', targets, plan, force: true }
  }

  out.info([`Ready to add ${skill.name} for ${agentLabel(targets)}:`, ...plan.map((p) => `  ${shownPath(ctx, p.path)}`)].join('\n'))
  const go = (await io.prompt('Press Enter to add it, or Ctrl+C to stop: ')).trim().toLowerCase()
  if (go === 'n' || go === 'no') throw new PromptCancelled()
  return { kind: 'install', targets, plan, force: false }
}

/** The one line on what to do next, for these targets. */
export function nextStep(ctx: Ctx, targets: Targets): string {
  const where = targets.base === ctx.io.homedir ? 'in any folder' : 'in this folder'
  const who = targets.claude && !targets.agents ? 'Claude Code' : targets.agents && !targets.claude ? 'Codex, Cursor or your other agent' : 'your agent'
  return `Next: start a new session in ${who}, ${where}. The skill loads by itself when a request matches what it does.`
}
