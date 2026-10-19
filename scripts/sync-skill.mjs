#!/usr/bin/env node
// scripts/sync-skill.mjs
//
// Refresh the bundled capability map, skill/SKILL.md, from the published copy.
// Refuses anything that is not a SKILL.md with `name: amdahl` frontmatter (an
// HTML error page, for example) and leaves the bundled file alone. On a change
// it adds the outgoing file's sha256 to skill/shipped.json, so `amdahl install`
// upgrades that copy on users' machines instead of keeping it as an edit.
//
//   node scripts/sync-skill.mjs
//   pnpm sync:skill

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ = 'https://docs.amdahl.ai/skills/amdahl/SKILL.md'
const dir = join(resolve(fileURLToPath(new URL('..', import.meta.url))), 'skill')
const path = join(dir, 'SKILL.md')
const shippedPath = join(dir, 'shipped.json')

const res = await fetch(URL_)
if (!res.ok) {
  console.error(`GET ${URL_} returned ${res.status}; skill/SKILL.md unchanged.`)
  process.exit(1)
}
const text = await res.text()
if (!/^---\nname: amdahl\ndescription: .+\n---\n/.test(text)) {
  console.error(`${URL_} is not the amdahl SKILL.md (no frontmatter); skill/SKILL.md unchanged.`)
  process.exit(1)
}
const current = readFileSync(path, 'utf8')
if (current === text) {
  console.log('skill/SKILL.md is already up to date.')
} else {
  const shipped = JSON.parse(readFileSync(shippedPath, 'utf8'))
  const hash = createHash('sha256').update(current).digest('hex')
  if (!shipped.includes(hash)) writeFileSync(shippedPath, `${JSON.stringify([...shipped, hash], null, 2)}\n`)
  writeFileSync(path, text)
  console.log('Updated skill/SKILL.md and skill/shipped.json. Review the diff and commit both.')
}
