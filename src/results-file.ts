// src/results-file.ts
//
// The results file of `amdahl sequence --leads`, written after every step. Each
// write goes to a temp file in the same folder and is then renamed over the
// file, so a stop in the middle (Ctrl+C, a crash) never leaves half a file.
// The first write of a run that must not replace a file (no --force, no
// --resume) links the temp file to the name instead, which fails if the name
// appeared since the check.

import { linkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { usageError } from './errors'

/** Write `text` to `path` in one step. With `noReplace`, a file already there is refused (exit 2). */
export function writeResultsFile(path: string, text: string, noReplace: boolean): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  try {
    writeFileSync(temp, text)
    if (!noReplace) {
      renameSync(temp, path)
      return
    }
    try {
      linkSync(temp, path)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'EEXIST') throw usageError(`${path} already exists.`, 'Add --resume to pick up where it stopped, or --force to start again.')
      throw err
    }
    unlinkSync(temp)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // already gone
    }
    throw err
  }
}
