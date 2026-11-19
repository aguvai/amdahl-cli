// src/commands/sequence.ts
//
// `amdahl sequence`: improve, or write, a sequence of 2 to 10 emails, each one
// written as a follow-up to the final emails before it. The console's Sequence
// tab does the same (see sequence-parse.ts for what is copied from it).
//
//   amdahl sequence <file|->         improve the emails in a text, markdown or CSV file
//   amdahl sequence --write "<goal>" write a new sequence, 2 to 6 emails, from a plan
//   amdahl sequence                  at a terminal: pick one of the two, then answer
//
// Every email is checked before the first request, so a typo costs nothing.
// The emails print one at a time as each comes back (the text on stdout, what
// Amdahl changed on stderr). A file is written only with `--csv`. An agent, CI,
// a pipe, `--json` or AMDAHL_NO_PROMPT=1 is never asked a question. `--json`
// prints one document: see jsonDocument in sequence-run.ts.

import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { amdahlCommand } from '../command-name'
import { resolveCredential, str, type Credential, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { DEFAULT_STEPS, GOAL_CHARS, MAX_RULES, MAX_STEPS, MIN_STEPS, STARTERS, parsePlan, stepLine, suggestPlan, type PlanStep } from '../sequence-plan'
import { MAX_EMAILS, emailProblem, emailsFromCsv, sequenceCsv, sequenceFileName, splitSequence, type SeqEmail } from '../sequence-parse'
import { atTerminal, canAsk } from '../terminal'
import { credentialOrSignIn, requestOptions } from './optimize'
import { failureLine, fieldLines, jsonDocument, runSequence, type Job } from './sequence-run'

const PASTE_PROMPT = 'Paste your emails, with a line of --- between them, then press Enter on an empty line:'
const IMPROVE = 'Improve emails I have'
const WRITE = 'Write a new sequence with Amdahl'
const OWN_GOAL = 'Type my own goal'

const USAGE = 'Usage: amdahl sequence <file> | -   or   amdahl sequence --write "<goal>"'

/** The emails in a file (text, markdown or CSV) or on stdin. */
async function readEmails(ctx: Ctx, file: string): Promise<SeqEmail[]> {
  const text = file === '-' ? await ctx.io.readStdin() : readTextFile(file)
  if (!text.trim()) throw usageError(`${file === '-' ? 'Stdin' : file} is empty.`)
  if (file !== '-' && /\.(csv|tsv)$/i.test(file)) {
    const read = emailsFromCsv(text)
    if (!read.ok) throw usageError(read.error)
    return read.emails
  }
  return splitSequence(text)
}

/** Refuse a sequence that cannot run, before anything is sent. */
function checkEmails(emails: SeqEmail[], has: string): void {
  if (emails.length < 2) throw usageError(`A sequence needs 2 emails or more. For one email: ${amdahlCommand('optimize <file>')}`)
  if (emails.length > MAX_EMAILS) throw usageError(`Amdahl improves up to ${MAX_EMAILS} emails. ${has} ${emails.length}.`)
  const problem = emailProblem(emails)
  if (problem) throw usageError(problem)
}

/** The goal, checked: not empty, at most 300 characters. */
function checkGoal(goal: string): string {
  const text = goal.trim()
  if (!text) throw usageError('Say what the sequence is for.', `Usage: ${amdahlCommand('sequence --write "<goal>"')}`)
  if (text.length > GOAL_CHARS) throw usageError(`The goal is ${text.length} characters. Amdahl takes up to ${GOAL_CHARS}.`)
  return text
}

/** An email count, 2 to 6. */
function checkCount(raw: string, flag: string): number {
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < MIN_STEPS || n > MAX_STEPS) throw usageError(`${flag} must be a whole number from ${MIN_STEPS} to ${MAX_STEPS}.`)
  return n
}

/** The plan: the `--plan` file when given (it sets the count), else the suggestion for the goal. */
function planFor(ctx: Ctx, goal: string, asked: number | undefined): PlanStep[] {
  const path = str(ctx.flags.plan)
  const flag = typeof ctx.flags.emails === 'string' ? checkCount(ctx.flags.emails, '--emails') : undefined
  if (path) {
    const steps = parsePlan(readTextFile(path), path)
    if (flag !== undefined && flag !== steps.length) throw usageError(`--emails ${flag} does not match the ${steps.length} emails in ${path}.`)
    return steps
  }
  return suggestPlan(goal, flag ?? asked ?? DEFAULT_STEPS)
}

/** The plan as the question's lines. */
function planText(steps: PlanStep[]): string {
  return [`The plan, ${steps.length} emails:`, ...steps.map((s, i) => `  ${i + 1}. ${stepLine(s)}`)].join('\n')
}

/** Print the plan and ask whether to write it. False when the answer is no. */
async function confirmPlan(ctx: Ctx, steps: PlanStep[]): Promise<boolean> {
  ctx.out.info(planText(steps))
  const answer = (await ctx.io.prompt(`Write these ${steps.length} emails? [Y/n]`)).trim()
  if (answer === '' || /^y/i.test(answer)) return true
  ctx.out.info(`Nothing was written. To change the plan, put one email per line in a file (Name: job) and run: ${amdahlCommand('sequence --write "<goal>" --plan plan.txt')}`)
  return false
}

/** The request options: email only, plus `--evidence`, `--on-unsupported` and the `--context` file. */
function requestBase(ctx: Ctx): Pick<Job, 'base' | 'fileContext'> {
  if (ctx.flags.channel !== undefined) throw usageError('--channel does not go with sequence: a sequence is email only.')
  const { context, ...rest } = requestOptions(ctx)
  const fileContext = (context as Record<string, unknown> | undefined) ?? null
  if (fileContext && 'prior_touches' in fileContext) throw usageError('--context cannot have prior_touches: Amdahl sends the emails before each one itself.')
  return { base: { channel: 'email', ...rest }, fileContext }
}

/** A sequence to write: the goal, the plan, and the blank emails. Null when the person said no. */
async function writeJob(ctx: Ctx, goal: string, asked: number | undefined, ask: boolean, fileContext: Job['fileContext']): Promise<Pick<Job, 'emails' | 'plan'> | null> {
  const checked = checkGoal(goal)
  const steps = planFor(ctx, checked, asked)
  const fileRules = Array.isArray(fileContext?.rules) ? fileContext.rules.length : 0
  if (fileRules + 2 > MAX_RULES) throw usageError(`--context has ${fileRules} rules. With the plan's 2, Amdahl takes at most ${MAX_RULES} for an email. Remove ${fileRules + 2 - MAX_RULES}.`)
  if (ask && !(await confirmPlan(ctx, steps))) return null
  return { emails: steps.map(() => ({ subject: '', body: '', sameThread: false })), plan: { goal: checked, steps } }
}

/** At a terminal with nothing given: the choice, then the paste or the goal. Null when nothing was pasted or the plan was declined. */
async function askJob(ctx: Ctx, fileContext: Job['fileContext']): Promise<Pick<Job, 'emails' | 'plan'> | null> {
  const { io, out } = ctx
  const pick = await io.select('What do you want to do?', [IMPROVE, WRITE], { initial: 0 })
  if (pick === 0) {
    const text = await io.readPaste(PASTE_PROMPT)
    if (!text.trim()) {
      out.info('Nothing pasted, so nothing was sent.')
      return null
    }
    const emails = splitSequence(text)
    checkEmails(emails, 'You pasted')
    return { emails, plan: null }
  }
  const start = await io.select('What is the sequence for?', [...STARTERS.map((s) => `${s.name}: ${s.line}`), OWN_GOAL], { initial: 0 })
  const goal = STARTERS[start]?.goal ?? (await io.prompt('What is the sequence for? Say it in a sentence or two:'))
  const answer = (await io.prompt(`How many emails, ${MIN_STEPS} to ${MAX_STEPS}? Enter for ${DEFAULT_STEPS}:`)).trim()
  return writeJob(ctx, goal, answer ? checkCount(answer, 'The number of emails') : undefined, true, fileContext)
}

/** Where `--csv` writes: the path given, else next to the file, else here. Null without `--csv`. */
function csvTarget(ctx: Ctx, file: string | null): string | null {
  const flag = ctx.flags.csv
  if (typeof flag !== 'string') return null
  if (flag) return flag
  return file && file !== '-' ? join(dirname(file), sequenceFileName(basename(file))) : join(ctx.io.cwd, sequenceFileName(null))
}

/** Refuse a file that exists, unless `--force`. Checked before anything is sent. */
function assertFree(path: string, force: boolean): void {
  if (!force && existsSync(path)) throw usageError(`${path} already exists.`, 'Move it, or add --force to replace it.')
}

/** Write the CSV; a file that appeared since the check is not replaced without `--force`. */
function writeCsv(path: string, text: string, force: boolean): void {
  try {
    writeFileSync(path, text, { flag: force ? 'w' : 'wx' })
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'EEXIST') throw usageError(`${path} already exists.`, 'Move it, or add --force to replace it.')
    throw err
  }
}

/** The line that says how to keep the emails, for a person at a terminal. */
function csvTip(file: string | null, writing: boolean): string {
  if (file && file !== '-') return `To save them as a CSV: ${amdahlCommand(`sequence ${file} --csv`)}`
  return writing ? 'To save them as a CSV: run the same command with --csv.' : `To save them as a CSV: ${amdahlCommand('sequence <file> --csv')}`
}

/** `amdahl sequence [<file>|-] [--write "<goal>"]`. */
export async function sequence(ctx: Ctx, args: string[]): Promise<number> {
  const { flags, out } = ctx
  const file = args[0]
  if (args.length > 1) throw usageError('Give one file of emails, or - for stdin.', USAGE)
  const writeFlag = typeof flags.write === 'string' ? flags.write : undefined
  if (file !== undefined && writeFlag !== undefined) throw usageError('Give the emails to improve, or --write "<goal>", not both.')
  if (writeFlag === undefined && (flags.emails !== undefined || flags.plan !== undefined)) throw usageError('--emails and --plan go with --write "<goal>".')
  if (flags.force === true && typeof flags.csv !== 'string') throw usageError('--force goes with --csv.')
  const bare = file === undefined && writeFlag === undefined
  // An agent, CI, a pipe and --json cannot be asked: they get the usage.
  if (bare && !(atTerminal(ctx) && !out.json)) throw usageError('Give a file of emails, or a goal to write them from.', USAGE)

  const request = requestBase(ctx)
  let credential: Credential | null = bare ? await credentialOrSignIn(ctx) : null
  let emails: SeqEmail[]
  let plan: Job['plan'] = null
  if (bare) {
    const asked = await askJob(ctx, request.fileContext)
    if (!asked) return EXIT.ok
    ;({ emails, plan } = asked)
  } else if (writeFlag !== undefined) {
    const written = await writeJob(ctx, writeFlag, undefined, canAsk(ctx), request.fileContext)
    if (!written) return EXIT.ok
    ;({ emails, plan } = written)
  } else {
    emails = await readEmails(ctx, file as string)
    checkEmails(emails, file === '-' ? 'The input has' : 'This file has')
  }

  const target = csvTarget(ctx, file ?? null)
  if (target) assertFree(target, flags.force === true)
  credential ??= await resolveCredential(ctx)

  const job: Job = { emails, plan, ...request }
  const outcome = await runSequence(ctx, credential, job)
  const { failed } = outcome
  if (!out.json) {
    const fields = fieldLines(outcome.fields, outcome.fields.kept)
    if (fields.length) out.info(fields.join('\n'))
    if (failed) out.info(`${failureLine(failed, emails.length, plan !== null)}${failed.hint ? `\n${failed.hint}` : ''}`)
  }
  let saved: string | null = null
  if (!failed && target) {
    writeCsv(target, sequenceCsv(outcome.done.map((d) => d.final)), flags.force === true)
    saved = target
    if (!out.json) out.result({}, `Saved: ${target}`)
  } else if (!failed && !out.json && atTerminal(ctx)) out.info(csvTip(file ?? null, plan !== null))
  if (out.json) out.result(jsonDocument(job, outcome, saved))
  return outcome.exit
}
