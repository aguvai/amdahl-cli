// src/tar-gz.ts
//
// Our own reader for a folder skill's archive: a gzip'd ustar tar, read in
// memory, never handed to a shell `tar`. It checks the gzip frame itself
// (one member, its CRC-32 and length), then reads every tar header and
// refuses, before anything is written, an archive that could put a file
// anywhere but inside the skill's folder or that is not plain files and
// folders:
//
//   - a path that is absolute, holds `..`, `.` or an empty segment, a
//     backslash or a control character, or that two entries share (also
//     when only their case differs: one would overwrite the other on macOS
//     and Windows);
//   - any entry type but a file or a folder (links, devices, fifos, pax and
//     GNU long-name headers);
//   - a file mode other than 0644 or 0755;
//   - more than MAX_ARCHIVE_FILES files, or more than MAX_UNPACKED_BYTES of
//     file contents;
//   - a header whose checksum is wrong, a body cut short, or no end marker.
//
// amdahl.ai writes these archives (stored deflate blocks, ustar headers, an
// explicit entry for each folder, files at the root); this reads any gzip
// and ustar tar that keeps to the rules above.

import { inflateRawSync } from 'node:zlib'

/** The most files a folder skill may hold: amdahl.ai's own limit. */
export const MAX_ARCHIVE_FILES = 200

/** The most bytes of file contents a folder skill may hold: amdahl.ai's own limit (4 MB). */
export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024

/**
 * The most bytes the tar itself may inflate to: the file contents plus room
 * for headers, padding and folders. It bounds memory before any header is read.
 */
const MAX_TAR_BYTES = MAX_UNPACKED_BYTES + 1024 * 1024

const BLOCK = 512
const FILE_MODES = new Set([0o644, 0o755])
// Every C0 control character and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** One file in the archive. */
export interface ArchiveFile {
  /** Its path inside the skill folder: segments joined by `/`. */
  path: string
  bytes: Buffer
  /** 0o644 or 0o755. */
  mode: number
}

/** What an archive holds once it has passed every check. */
export interface SkillArchive {
  files: ArchiveFile[]
  /** Every folder, listed or implied by a file's path, parents first. */
  dirs: string[]
}

/** Why an archive was refused. `tooLarge` marks the size and count limits. */
export class ArchiveError extends Error {
  readonly tooLarge: boolean

  constructor(message: string, tooLarge = false) {
    super(message)
    this.name = 'ArchiveError'
    this.tooLarge = tooLarge
  }
}

let crcTable: Uint32Array | null = null

/** gzip's CRC-32 (reversed polynomial 0xEDB88320), from our own table. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ (data[i] as number)) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Inflate one gzip member and check its trailer: the CRC-32 and the length
 * of the inflated bytes must match, and nothing may follow it.
 */
export function gunzipChecked(gz: Buffer): Buffer {
  if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw new ArchiveError('it is not gzip')
  if (gz[2] !== 8) throw new ArchiveError('its gzip method is not deflate')
  const flags = gz[3] as number
  if (flags & 0xe0) throw new ArchiveError('its gzip header sets reserved flags')
  let at = 10
  if (flags & 0x04) at += 2 + gz.readUInt16LE(Math.min(at, gz.length - 2)) // FEXTRA
  for (const flag of [0x08, 0x10]) {
    // FNAME, FCOMMENT: NUL-terminated.
    if (!(flags & flag)) continue
    const end = gz.indexOf(0, at)
    if (end < 0) throw new ArchiveError('its gzip header is cut short')
    at = end + 1
  }
  if (flags & 0x02) at += 2 // FHCRC
  if (at > gz.length - 8) throw new ArchiveError('its gzip header is cut short')

  let tar: Buffer
  let used: number
  try {
    const out = inflateRawSync(gz.subarray(at), { info: true, maxOutputLength: MAX_TAR_BYTES }) as unknown as {
      buffer: Buffer
      engine: { bytesWritten: number }
    }
    tar = out.buffer
    used = out.engine.bytesWritten
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveError(`it unpacks to more than ${MAX_TAR_BYTES / 1024 / 1024} MB`, true)
    }
    throw new ArchiveError(`its gzip data is broken (${err instanceof Error ? err.message : String(err)})`)
  }
  const trailer = at + used
  if (gz.length - trailer < 8) throw new ArchiveError('its gzip trailer is cut short')
  if (gz.length - trailer > 8) throw new ArchiveError('it has bytes after its gzip trailer')
  if (gz.readUInt32LE(trailer) !== crc32(tar)) throw new ArchiveError('its gzip CRC-32 does not match its contents')
  if (gz.readUInt32LE(trailer + 4) !== tar.length % 2 ** 32) throw new ArchiveError('its gzip length does not match its contents')
  return tar
}

/** A NUL-terminated header field as UTF-8. */
function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length)
  const end = raw.indexOf(0)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? raw : raw.subarray(0, end))
  } catch {
    throw new ArchiveError('it has a path that is not UTF-8')
  }
}

/** An octal number field (NUL or space terminated); null when it is not one. */
function octal(header: Buffer, start: number, length: number): number | null {
  const text = header.toString('latin1', start, start + length).replace(/[\0 ]+$/, '').replace(/^ +/, '')
  return /^[0-7]{1,12}$/.test(text) ? parseInt(text, 8) : null
}

/** Refuse a path that could leave the skill folder or confuse a file system. */
function checkPath(path: string): void {
  const shown = JSON.stringify(path)
  if (path === '') throw new ArchiveError('it has an entry with an empty path')
  if (path.startsWith('/')) throw new ArchiveError(`it has an absolute path, ${shown}`)
  if (path.includes('\\')) throw new ArchiveError(`it has a path with a backslash, ${shown}`)
  if (CONTROL_RE.test(path)) throw new ArchiveError(`it has a path with a control character, ${shown}`)
  for (const segment of path.split('/')) {
    if (segment === '') throw new ArchiveError(`it has a path with an empty segment, ${shown}`)
    if (segment === '..' || segment === '.') throw new ArchiveError(`it has a path with "${segment}" in it, ${shown}`)
  }
}

const TYPE_NAMES: Record<string, string> = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a fifo',
  '7': 'a contiguous file',
  x: 'a pax header',
  g: 'a pax global header',
  L: 'a GNU long name',
  K: 'a GNU long link name',
}

/** Read the tar and return its files and folders, or throw an ArchiveError. */
export function readTar(tar: Buffer): SkillArchive {
  if (tar.length % BLOCK !== 0) throw new ArchiveError('its tar is not a whole number of 512-byte blocks')
  const files: ArchiveFile[] = []
  const dirs: string[] = []
  // Lower-cased path -> what it is; implied folders included.
  const seen = new Map<string, 'file' | 'dir' | 'implied'>()
  let unpacked = 0
  let at = 0
  for (;;) {
    if (at >= tar.length) throw new ArchiveError('its tar has no end marker')
    const header = tar.subarray(at, at + BLOCK)
    if (header.every((b) => b === 0)) {
      if (!tar.subarray(at).every((b) => b === 0)) throw new ArchiveError('it has data after its tar end marker')
      break
    }
    let sum = 0
    for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number)
    if (octal(header, 148, 8) !== sum) throw new ArchiveError('it has a tar header with a wrong checksum')
    if (header.toString('latin1', 257, 263) !== 'ustar\0' || header.toString('latin1', 263, 265) !== '00') {
      throw new ArchiveError('its tar is not ustar')
    }
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    let path = prefix ? `${prefix}/${name}` : name
    const type = String.fromCharCode(header[156] as number)
    const size = octal(header, 124, 12)
    const mode = octal(header, 100, 8)
    if (size === null || mode === null) throw new ArchiveError(`it has a tar header for ${JSON.stringify(path)} with a bad size or mode`)

    const isDir = type === '5'
    if (!isDir && type !== '0' && type !== '\0') {
      const what = TYPE_NAMES[type] ?? `an entry of type ${JSON.stringify(type)}`
      throw new ArchiveError(`${JSON.stringify(path)} is ${what}; a skill archive holds only files and folders`)
    }
    if (isDir && path.endsWith('/')) path = path.slice(0, -1)
    checkPath(path)

    const key = path.toLowerCase()
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/')
      const kind = seen.get(parent)
      if (kind === 'file') throw new ArchiveError(`it puts ${JSON.stringify(path)} inside a file`)
      if (!kind) seen.set(parent, 'implied')
    }
    const before = seen.get(key)
    if (before === 'file' || before === 'dir' || (before === 'implied' && !isDir)) {
      throw new ArchiveError(`it lists ${JSON.stringify(path)} twice`)
    }

    const start = at + BLOCK
    if (isDir) {
      if (size !== 0) throw new ArchiveError(`its folder ${JSON.stringify(path)} has a size`)
      seen.set(key, 'dir')
      dirs.push(path)
    } else {
      if (!FILE_MODES.has(mode & 0o7777)) {
        throw new ArchiveError(`${JSON.stringify(path)} has mode ${(mode & 0o7777).toString(8).padStart(4, '0')}; a file must be 0644 or 0755`)
      }
      if (files.length + 1 > MAX_ARCHIVE_FILES) throw new ArchiveError(`it has more than ${MAX_ARCHIVE_FILES} files`, true)
      unpacked += size
      if (unpacked > MAX_UNPACKED_BYTES) throw new ArchiveError(`its files come to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`, true)
      if (start + size > tar.length) throw new ArchiveError(`its tar is cut short inside ${JSON.stringify(path)}`)
      seen.set(key, 'file')
      files.push({ path, bytes: Buffer.from(tar.subarray(start, start + size)), mode: mode & 0o7777 })
    }
    at = start + Math.ceil(size / BLOCK) * BLOCK
  }

  // Every folder, explicit or implied, in the case the archive gave it, parents first.
  const allDirs = new Map<string, string>()
  const addDirsOf = (path: string, self: boolean) => {
    const parts = path.split('/')
    for (let i = 1; i <= parts.length - (self ? 0 : 1); i += 1) {
      const dir = parts.slice(0, i).join('/')
      if (!allDirs.has(dir.toLowerCase())) allDirs.set(dir.toLowerCase(), dir)
    }
  }
  for (const dir of dirs) addDirsOf(dir, true)
  for (const f of files) addDirsOf(f.path, false)
  return { files, dirs: [...allDirs.values()].sort((a, b) => a.split('/').length - b.split('/').length) }
}

/** gunzipChecked, then readTar. */
export function readSkillArchive(gz: Buffer): SkillArchive {
  return readTar(gunzipChecked(gz))
}
