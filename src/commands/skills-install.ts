// src/commands/skills-install.ts
//
// Where `skills add` puts a skill, and how it writes it there. The caller
// picks the targets (from flags, or the guided questions), plans the install
// (each target is new, identical, or a different skill to replace), refuses
// a replacement it was not allowed, and only then writes.
//
// A folder skill (one unpacked from an archive) installs all or nothing:
// each target is unpacked into a hidden temp folder next to it, and only
// when every one is complete are they renamed into place. A failure at any
// step removes the temp folders, puts back any folder it had moved aside,
// and removes the parent folders it created: nothing is left. A SKILL.md-only
// skill writes the one file in each target, through a temp file renamed over
// it. Either kind refuses a target with a link anywhere under the install
// root, even with --force.

import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError, EXIT } from '../errors'
import type { Io } from '../io'
import type { SkillArchive } from '../tar-gz'

/** What `skills add` did to one file or folder. */
export interface FilePlan {
  path: string
  action: 'wrote' | 'replaced' | 'unchanged'
}

/** Where a skill goes: under `base`, for Claude Code (`.claude/skills`), the other agents (`.agents/skills`), or both. */
export interface Targets {
  /** The project folder, or the home folder for every project. */
  base: string
  claude: boolean
  agents: boolean
}

/** What was downloaded and checked: one SKILL.md, or a whole folder. */
export type Payload = { type: 'skill-md'; body: Buffer } | { type: 'archive'; archive: SkillArchive }

/** The skill folders for these targets: `.claude/skills/<name>` and/or `.agents/skills/<name>`. */
export function skillDirs(targets: Targets, name: string): string[] {
  const dirs: string[] = []
  if (targets.claude) dirs.push(join(targets.base, '.claude', 'skills', name))
  if (targets.agents) dirs.push(join(targets.base, '.agents', 'skills', name))
  return dirs
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Why a file operation failed, in plain words where the cause is a common one. */
function plainReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') return 'you do not have permission to write there'
  if (code === 'ENOSPC') return 'the disk is full'
  if (code === 'EROFS') return 'that disk is read-only'
  if (code === 'ENOTDIR' || code === 'EEXIST') return 'a file is in the way'
  return message(err)
}

const leftBehind = (written: string[]) => (written.length > 0 ? `It wrote ${written.join(' and ')} first.` : 'Nothing was written.')

/** The error for a failed write, saying what was left behind and the one thing to do. */
export function writeFailure(path: string, err: unknown, written: string[] = []): CliError {
  const code = (err as NodeJS.ErrnoException).code
  const left = leftBehind(written)
  const fix = code === 'EACCES' || code === 'EPERM' ? ' Run the command from a folder you can write to.' : ''
  return new CliError('write_failed', `Could not write ${path}: ${plainReason(err)}`, EXIT.general, `${left}${fix}`)
}

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
    throw writeFailure(dir, err)
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
    throw writeFailure(dir, err)
  }
}

/**
 * Refuse a skill folder, or its SKILL.md, reached through a link, or a
 * SKILL.md that is not a plain file: the write would land wherever the link
 * points, outside the install root. Checks each part under the root that
 * `skillDirs` builds (`.claude` or `.agents`, `skills`, the skill folder) and,
 * when given, the file itself. `--force` does not override it.
 */
function refuseLinks(dir: string, file?: string, written: string[] = []): void {
  const path = file ?? dir
  for (const part of [dirname(dirname(dir)), dirname(dir), dir, ...(file ? [file] : [])]) {
    let stat
    try {
      stat = lstatSync(part)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw writeFailure(path, err, written)
    }
    const why = stat.isSymbolicLink() ? 'is a link' : part === file && !stat.isFile() ? 'is not a file' : ''
    if (why) {
      throw new CliError(
        'link_in_the_way',
        `Could not write ${path}: ${part} ${why}.`,
        EXIT.general,
        `${leftBehind(written)} Remove it, or install somewhere else.`
      )
    }
  }
}

/** What installing `payload` into each skill folder would do. */
export function planInstall(dirs: string[], payload: Payload): FilePlan[] {
  return dirs.map((dir) => {
    if (payload.type === 'archive') {
      refuseLinks(dir)
      const same = sameFolder(dir, payload.archive)
      return { path: dir, action: same === null ? 'wrote' : same ? 'unchanged' : 'replaced' }
    }
    const path = join(dir, 'SKILL.md')
    refuseLinks(dir, path)
    let current: Buffer | null
    try {
      current = lstatSync(path, { throwIfNoEntry: false }) ? readFileSync(path) : null
    } catch (err) {
      throw writeFailure(path, err)
    }
    return { path, action: current === null ? 'wrote' : current.equals(payload.body) ? 'unchanged' : 'replaced' }
  })
}

/** Refuse to replace a different skill of the same name unless `force`. */
export function refuseClashes(plan: FilePlan[], name: string, force: boolean): void {
  const clashes = plan.filter((p) => p.action === 'replaced').map((p) => p.path)
  if (clashes.length > 0 && !force) {
    throw new CliError(
      'skill_exists',
      `A different ${name} skill is already at ${clashes.join(' and ')}.`,
      EXIT.general,
      'Nothing was written. Run again with --force to replace it.'
    )
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
  // Again: in the guided flow, time has passed since the plan. And once more
  // after mkdir, which follows a link it finds on the way.
  refuseLinks(target)
  s.createdParent = mkdirSync(dirname(target), { recursive: true }) ?? undefined
  refuseLinks(target)
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

/** Install the archive into every planned folder, all or nothing. */
function writeFolders(plan: FilePlan[], name: string, archive: SkillArchive): void {
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
    if (err instanceof CliError) throw err
    throw writeFailure(current, err)
  }
  for (const s of staged) if (s.backup) rmSync(s.backup, { recursive: true, force: true })
}

/**
 * Write the SKILL.md into every planned path that differs: into a new temp
 * file in the same folder, renamed over the old one. A rename replaces what
 * is at the path instead of following it.
 */
function writeFiles(plan: FilePlan[], body: Buffer): void {
  const written: string[] = []
  for (const p of plan) {
    if (p.action === 'unchanged') continue
    // Again: in the guided flow, time has passed since the plan.
    refuseLinks(dirname(p.path), p.path, written)
    const temp = join(dirname(p.path), `.SKILL.md.amdahl-tmp-${randomBytes(6).toString('hex')}`)
    try {
      mkdirSync(dirname(p.path), { recursive: true })
      refuseLinks(dirname(p.path), p.path, written)
      writeFileSync(temp, body, { flag: 'wx', mode: 0o644 })
      renameSync(temp, p.path)
    } catch (err) {
      rmSync(temp, { force: true })
      if (err instanceof CliError) throw err
      throw writeFailure(p.path, err, written)
    }
    written.push(p.path)
  }
}

/** Carry out a plan (check it with refuseClashes first). Ctrl+C waits until the files are written. */
export function writeInstall(io: Io, plan: FilePlan[], name: string, payload: Payload): void {
  io.uninterruptible(() => (payload.type === 'archive' ? writeFolders(plan, name, payload.archive) : writeFiles(plan, payload.body)))
}
