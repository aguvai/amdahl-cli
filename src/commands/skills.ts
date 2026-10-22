// src/commands/skills.ts
//
// `amdahl skills add <publisher>/<skill> [-g] [--agents] [--force] [--site <origin>]`:
// install one skill from the library at amdahl.ai/skills. Reads the skill's
// one-entry index (Agent Skills Discovery v0.2.0) at
// `<site>/skills/<publisher>/<skill>/.well-known/agent-skills/index.json`,
// fetches the SKILL.md the entry names, and refuses it unless its sha256
// matches the entry's digest and its front matter parses as YAML with a string
// `name` (the index's) and `description`. Needs no sign-in. Makes exactly
// these two requests, both to the site, and follows no redirect: no telemetry,
// no other host. Each request has a deadline and a size cap. Writes `./.claude/skills/<name>/SKILL.md` (`-g`: under the
// home folder; `--agents`: `.agents/skills` too), never replaces a different
// file of the same name without `--force`, and writes nothing on a refusal.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { str, type Ctx } from '../context'
import { CliError, EXIT, exitForHttp, usageError } from '../errors'

/** Where the skills library is published. */
export const DEFAULT_SKILLS_SITE = 'https://amdahl.ai'

/** The only hosts `--site` may name over plain http. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A publisher slug as amdahl.ai allows it: 1-40 characters, never `--`. */
const PUBLISHER_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** A skill name as the Agent Skills spec and amdahl.ai allow it: 1-64 characters, single hyphens. */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/

/** The most `skills add` reads of an index: far more than one entry needs. */
export const MAX_INDEX_BYTES = 256 * 1024

/** The most it reads of a SKILL.md: amdahl.ai refuses a bigger one (its SKILL_MAX_BYTES). */
export const MAX_SKILL_BYTES = 64 * 1024

const DIGEST_RE = /^sha256:([0-9a-f]{64})$/i
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const USAGE = 'Usage: amdahl skills add <publisher>/<skill> [-g] [--agents] [--force] [--site <origin>]'

/** One skill in the library. */
export interface SkillRef {
  publisher: string
  skill: string
}

/** What `skills add` did to one file. */
interface FilePlan {
  path: string
  action: 'wrote' | 'replaced' | 'unchanged'
}

/**
 * Validate `--site` and return its origin: https, or http for localhost only,
 * with no path, query or credentials.
 */
export function normaliseSite(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw usageError(`Not a valid --site origin: ${raw}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw usageError(`--site must be https (http only for localhost): ${raw}`)
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw usageError(`--site takes an origin only, like ${DEFAULT_SKILLS_SITE}: ${raw}`)
  }
  return url.origin
}

/**
 * Read `<publisher>/<skill>`, or the skill's page or `.md` URL on the site.
 *
 * @throws a usage CliError for anything else, including a URL on another site.
 */
export function parseSkillRef(raw: string, site: string): SkillRef {
  let path = raw
  if (/^https?:\/\//i.test(raw)) {
    let url: URL | null = null
    try {
      url = new URL(raw)
    } catch {
      // Reported below as not a skill.
    }
    if (url && url.origin !== site) {
      throw usageError(`${raw} is not on ${site}.`, 'Pass --site <origin> to install from another site.')
    }
    const m = url ? /^\/skills\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname) : null
    path = m ? `${m[1]}/${m[2]}` : ''
  }
  const [publisher = '', skill = '', ...rest] = path.replace(/\.md$/, '').split('/')
  if (rest.length > 0 || !PUBLISHER_RE.test(publisher) || publisher.includes('--') || !SKILL_NAME_RE.test(skill)) {
    throw usageError(`Not a skill: ${raw}`, `Name it as <publisher>/<skill>, or paste its link from ${site}/skills.`)
  }
  return { publisher, skill }
}

/**
 * GET one URL, following no redirect, and return the body's bytes. Gives up
 * after `io.fetchTimeoutMs`, headers and body together, and refuses a body
 * over `maxBytes`: by its Content-Length when it sends one, else as it reads.
 */
async function get(ctx: Ctx, url: string, what: string, site: string, maxBytes: number): Promise<Buffer> {
  const timeoutMs = ctx.io.fetchTimeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  // Rejects when the time is up, so a stalled body is cut off too, whatever
  // fetch does with the signal once the headers are in.
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  timedOut.catch(() => {})
  const unreachable = (err: unknown) => {
    if (signal.aborted) {
      return new CliError('network_error', `No answer from ${url} within ${timeoutMs / 1000} seconds.`, EXIT.network)
    }
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
    return new CliError('network_error', `Could not reach ${site}: ${err instanceof Error ? err.message : String(err)}${cause}`, EXIT.network)
  }
  const tooLarge = () =>
    new CliError('too_large', `${url} is over ${maxBytes / 1024} KB, the most skills add reads for a ${what}.`, EXIT.general, 'Nothing was written.')

  let res: Response
  try {
    res = await Promise.race([fetch(url, { redirect: 'manual', signal }), timedOut])
  } catch (err) {
    throw unreachable(err)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    if (res.status >= 300 && res.status < 400) {
      throw new CliError('skill_redirect', `${url} answered with a redirect, and skills add follows none.`, EXIT.general)
    }
    if (res.status === 404) {
      throw new CliError('skill_not_found', `No ${what} at ${url}.`, EXIT.general, `Check the publisher and skill name at ${site}/skills.`)
    }
    throw new CliError(`http_${res.status}`, `${url} answered HTTP ${res.status}.`, exitForHttp(res.status))
  }
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (reader) {
      const { done, value } = await Promise.race([reader.read(), timedOut])
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw tooLarge()
      chunks.push(value)
    }
  } catch (err) {
    await reader?.cancel().catch(() => {})
    throw err instanceof CliError ? err : unreachable(err)
  }
  return Buffer.concat(chunks)
}

/**
 * Find the skill's entry in its index and return the file URL (on the site)
 * and the sha256 hex the file must match.
 */
export function readIndex(body: Buffer, indexUrl: string, ref: SkillRef, site: string): { url: string; sha256: string } {
  const bad = (why: string) => new CliError('invalid_index', `The index at ${indexUrl} ${why}.`, EXIT.general)
  let index: unknown
  try {
    index = JSON.parse(body.toString('utf8'))
  } catch {
    throw bad('is not JSON')
  }
  const skills = index && typeof index === 'object' ? (index as { skills?: unknown }).skills : undefined
  if (!Array.isArray(skills)) throw bad('has no skills list')
  const entry = skills.find((s) => s && typeof s === 'object' && (s as { name?: unknown }).name === ref.skill) as
    | Record<string, unknown>
    | undefined
  if (!entry) throw bad(`does not list ${ref.skill}`)
  if (entry.type !== 'skill-md') throw bad(`lists ${ref.skill} as a type other than skill-md`)
  const digest = typeof entry.digest === 'string' ? DIGEST_RE.exec(entry.digest) : null
  if (!digest?.[1]) throw bad(`gives ${ref.skill} no sha256 digest`)
  let url: URL | null = null
  try {
    url = typeof entry.url === 'string' ? new URL(entry.url, indexUrl) : null
  } catch {
    url = null
  }
  if (!url) throw bad(`gives ${ref.skill} no file URL`)
  if (url.origin !== site) throw bad(`points ${ref.skill} at ${url.origin}, not ${site}`)
  return { url: url.href, sha256: digest[1].toLowerCase() }
}

/**
 * Refuse the downloaded file unless it is exactly what the index promised
 * and a SKILL.md for `ref.skill`: UTF-8, YAML front matter, a string `name`
 * equal to the index's and a non-empty string `description`.
 */
export function checkSkill(body: Buffer, fileUrl: string, sha256: string, ref: SkillRef): void {
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== sha256) {
    throw new CliError(
      'digest_mismatch',
      `${fileUrl} does not match its index: its sha256 is ${actual}, the index says ${sha256}.`,
      EXIT.general,
      'Nothing was written. Try again; if it repeats, report it.'
    )
  }
  const bad = (why: string) => new CliError('invalid_skill', `${fileUrl} is not a valid skill: ${why}.`, EXIT.general)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw bad('it is not UTF-8 text')
  }
  const fm = FRONT_MATTER_RE.exec(text)
  if (!fm) throw bad('it has no front matter')
  const doc = parseDocument(fm[1] ?? '', { uniqueKeys: true })
  const yamlError = doc.errors[0]
  if (yamlError) {
    // +1 for the opening `---` line, so the number is the file's own line.
    const line = yamlError.linePos ? `line ${yamlError.linePos[0].line + 1}: ` : ''
    throw bad(`its front matter is not valid YAML (${line}${yamlError.message.split(' at line')[0]})`)
  }
  let meta: unknown
  try {
    meta = doc.toJS()
  } catch (err) {
    throw bad(`its front matter could not be read (${err instanceof Error ? err.message : String(err)})`)
  }
  const { name, description } = (meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}) as Record<string, unknown>
  if (typeof name !== 'string') throw bad('its front matter has no string name')
  if (typeof description !== 'string' || description.trim() === '') throw bad('its front matter has no string description')
  if (name !== ref.skill) throw bad(`its front matter names it "${name}", but the index lists ${ref.skill}`)
}

/** Every file `skills add` writes for this skill. */
function targetPaths(ctx: Ctx, name: string): string[] {
  const base = ctx.flags.global === true ? ctx.io.homedir : ctx.io.cwd
  const dirs = [join(base, '.claude', 'skills')]
  if (ctx.flags.agents === true) dirs.push(join(base, '.agents', 'skills'))
  return dirs.map((dir) => join(dir, name, 'SKILL.md'))
}

/** Compare each target with the new bytes, then write the ones that differ. */
function writeSkill(ctx: Ctx, name: string, body: Buffer): FilePlan[] {
  const plan: FilePlan[] = targetPaths(ctx, name).map((path) => {
    let current: Buffer | null
    try {
      current = existsSync(path) ? readFileSync(path) : null
    } catch (err) {
      throw new CliError('write_failed', `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, EXIT.general, 'Nothing was written.')
    }
    return { path, action: current === null ? 'wrote' : current.equals(body) ? 'unchanged' : 'replaced' }
  })
  const clashes = plan.filter((p) => p.action === 'replaced').map((p) => p.path)
  if (clashes.length > 0 && ctx.flags.force !== true) {
    throw new CliError(
      'skill_exists',
      `A different ${name} skill is already at ${clashes.join(' and ')}.`,
      EXIT.general,
      'Nothing was written. Run again with --force to replace it.'
    )
  }
  const written: string[] = []
  for (const p of plan) {
    if (p.action === 'unchanged') continue
    try {
      mkdirSync(dirname(p.path), { recursive: true })
      writeFileSync(p.path, body)
    } catch (err) {
      throw new CliError(
        'write_failed',
        `Could not write ${p.path}: ${err instanceof Error ? err.message : String(err)}`,
        EXIT.general,
        written.length > 0 ? `It wrote ${written.join(' and ')} first.` : 'Nothing was written.'
      )
    }
    written.push(p.path)
  }
  return plan
}

/** `amdahl skills add <publisher>/<skill>`. */
export async function skillsAdd(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0]) throw usageError(USAGE)
  const siteFlag = str(ctx.flags.site)
  const site = siteFlag ? normaliseSite(siteFlag) : DEFAULT_SKILLS_SITE
  const ref = parseSkillRef(args[0], site)

  const indexUrl = `${site}/skills/${ref.publisher}/${ref.skill}/.well-known/agent-skills/index.json`
  const { url, sha256 } = readIndex(await get(ctx, indexUrl, 'skill index', site, MAX_INDEX_BYTES), indexUrl, ref, site)
  const body = await get(ctx, url, 'SKILL.md', site, MAX_SKILL_BYTES)
  checkSkill(body, url, sha256, ref)

  const files = writeSkill(ctx, ref.skill, body)
  const human = files
    .map((f) => (f.action === 'unchanged' ? `Already up to date: ${f.path}` : `${f.action === 'wrote' ? 'Wrote' : 'Replaced'} ${f.path}`))
    .join('\n')
  ctx.out.result({ ok: true, publisher: ref.publisher, skill: ref.skill, url, digest: `sha256:${sha256}`, files }, human)
  return EXIT.ok
}
