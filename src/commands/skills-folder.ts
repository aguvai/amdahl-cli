// src/commands/skills-folder.ts
//
// Where `skills add` puts a skill, and how it installs a folder skill (one
// unpacked from an archive) all or nothing. Every target folder is compared
// with the archive first; a different folder stops the install unless
// `--force`. Then each target is unpacked into a hidden temp folder next to
// it, and only when every one is complete are they renamed into place. A
// failure at any step removes the temp folders, puts back any folder it had
// moved aside, and removes the parent folders it created: nothing is left.

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import type { SkillArchive } from '../tar-gz'

/** What `skills add` did to one file or folder. */
export interface FilePlan {
  path: string
  action: 'wrote' | 'replaced' | 'unchanged'
}

/** The skill folders `skills add` writes: `.claude/skills/<name>`, and `.agents/skills/<name>` with `--agents`. */
export function skillDirs(ctx: Ctx, name: string): string[] {
  const base = ctx.flags.global === true ? ctx.io.homedir : ctx.io.cwd
  const dirs = [join(base, '.claude', 'skills', name)]
  if (ctx.flags.agents === true) dirs.push(join(base, '.agents', 'skills', name))
  return dirs
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * True when `dir` holds exactly the archive's folders and files, with the
 * same bytes and the same executable bit; false for anything else there
 * (a file, a link, other contents); null when nothing is there.
 */
export function sameFolder(dir: string, archive: SkillArchive): boolean | null {
  let top
  try {
    top = lstatSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new CliError('write_failed', `Could not read ${dir}: ${message(err)}`, EXIT.general, 'Nothing was written.')
  }
  if (!top.isDirectory()) return false
  const want = new Map(archive.files.map((f) => [f.path, f]))
  const wantDirs = new Set(archive.dirs)
  let found = 0
  const walk = (rel: string): boolean => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (++found > want.size + wantDirs.size) return false
      if (entry.isDirectory()) {
        if (!wantDirs.has(path) || !walk(path)) return false
      } else if (entry.isFile()) {
        const file = want.get(path)
        if (!file) return false
        const full = join(dir, path)
        if (process.platform !== 'win32' && (lstatSync(full).mode & 0o111 ? 0o755 : 0o644) !== file.mode) return false
        if (!readFileSync(full).equals(file.bytes)) return false
      } else {
        return false
      }
    }
    return true
  }
  try {
    return walk('') && found === want.size + wantDirs.size
  } catch (err) {
    throw new CliError('write_failed', `Could not read ${dir}: ${message(err)}`, EXIT.general, 'Nothing was written.')
  }
}

/** One target on its way into place. */
interface Staged {
  target: string
  temp: string
  /** Where the old folder was moved, once it has been. */
  backup?: string
  /** The first parent folder this run created, to remove on a failure. */
  createdParent?: string
  swapped?: boolean
}

/** Unpack the archive into a new hidden temp folder next to `target`. */
function stage(target: string, name: string, archive: SkillArchive, staged: Staged[]): void {
  const s: Staged = { target, temp: '' }
  staged.push(s)
  s.createdParent = mkdirSync(dirname(target), { recursive: true }) ?? undefined
  s.temp = mkdtempSync(join(dirname(target), `.${name}.amdahl-tmp-`))
  // mkdtemp makes it 0700; the skill folder is 0755, like every folder in the archive.
  chmodSync(s.temp, 0o755)
  for (const dir of archive.dirs) mkdirSync(join(s.temp, dir))
  for (const file of archive.files) writeFileSync(join(s.temp, file.path), file.bytes, { flag: 'wx', mode: file.mode })
}

/** Undo every step taken so far, newest first. Best effort: a failure here is already being reported. */
function rollBack(staged: Staged[]): void {
  for (const s of [...staged].reverse()) {
    try {
      if (s.swapped) {
        rmSync(s.target, { recursive: true, force: true })
        if (s.backup) renameSync(s.backup, s.target)
      } else if (s.backup) {
        renameSync(s.backup, s.target)
      }
    } catch {
      // Keep going: put back what can be put back.
    }
    if (s.temp) rmSync(s.temp, { recursive: true, force: true })
    if (s.createdParent) rmSync(s.createdParent, { recursive: true, force: true })
  }
}

/**
 * Install the archive as the skill folder `name` in every target, all or
 * nothing. Refuses a different folder already there unless `--force`, and
 * leaves an identical one as it is.
 */
export function writeSkillFolder(ctx: Ctx, name: string, archive: SkillArchive): FilePlan[] {
  const plan: FilePlan[] = skillDirs(ctx, name).map((path) => {
    const same = sameFolder(path, archive)
    return { path, action: same === null ? 'wrote' : same ? 'unchanged' : 'replaced' }
  })
  const clashes = plan.filter((p) => p.action === 'replaced').map((p) => p.path)
  if (clashes.length > 0 && ctx.flags.force !== true) {
    throw new CliError(
      'skill_exists',
      `A different ${name} skill is already at ${clashes.join(' and ')}.`,
      EXIT.general,
      'Nothing was written. Run again with --force to replace that folder.'
    )
  }

  const staged: Staged[] = []
  let current = ''
  try {
    for (const p of plan) {
      if (p.action === 'unchanged') continue
      current = p.path
      stage(p.path, name, archive, staged)
    }
    for (const s of staged) {
      current = s.target
      if (plan.find((p) => p.path === s.target)?.action === 'replaced') {
        s.backup = `${s.temp}.old`
        renameSync(s.target, s.backup)
      }
      renameSync(s.temp, s.target)
      s.swapped = true
    }
  } catch (err) {
    rollBack(staged)
    throw new CliError('write_failed', `Could not write ${current}: ${message(err)}`, EXIT.general, 'Nothing was written.')
  }
  for (const s of staged) if (s.backup) rmSync(s.backup, { recursive: true, force: true })
  return plan
}
