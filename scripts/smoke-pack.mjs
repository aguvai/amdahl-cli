#!/usr/bin/env node
// scripts/smoke-pack.mjs
//
// Prove the packed tarball is self-contained: build, `pnpm pack`, install the
// tarball into a throwaway npm prefix with no network, and run
// `amdahl --version` from the installed bin. Then pack the short-name package
// (packages/amdahl), install it the way `npx amdahl` does (a project whose
// only dependency is `amdahl`, with @amdahl/cli taken from the tarball just
// packed), and run `amdahl --help` and `--version` through it: through
// `npm exec` and through its own bin. Exits non-zero on any failure.
//
//   node scripts/smoke-pack.mjs
//   pnpm smoke:pack

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'amdahl-cli-smoke-'))
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts })

try {
  run('pnpm', ['build'], { cwd: pkgDir })
  run('pnpm', ['pack', '--pack-destination', work], { cwd: pkgDir })
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'))
  if (tgz !== `amdahl-cli-${version}.tgz`) throw new Error(`unexpected tarball name: ${tgz}`)

  const prefix = join(work, 'prefix')
  run('npm', ['install', '-g', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', join(work, tgz)])
  const bin = process.platform === 'win32' ? join(prefix, 'amdahl.cmd') : join(prefix, 'bin', 'amdahl')
  const out = run(bin, ['--version']).trim()
  if (out !== version) throw new Error(`amdahl --version printed "${out}", expected "${version}"`)
  console.log(`ok: ${tgz} installs and runs (amdahl --version = ${out})`)

  const shortDir = join(pkgDir, 'packages', 'amdahl')
  run('npm', ['pack', '--pack-destination', work], { cwd: shortDir })
  const shortTgz = `amdahl-${version}.tgz`
  const files = run('tar', ['-tzf', join(work, shortTgz)]).trim().split('\n').sort()
  const wantFiles = ['package/LICENSE', 'package/README.md', 'package/amdahl.js', 'package/package.json']
  if (files.join() !== wantFiles.join()) throw new Error(`${shortTgz} holds ${files.join(', ')}`)

  const project = join(work, 'project')
  mkdirSync(project)
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'smoke',
      private: true,
      dependencies: { amdahl: `file:../${shortTgz}` },
      overrides: { '@amdahl/cli': `file:../${tgz}` },
    })
  )
  run('npm', ['install', '--offline', '--no-audit', '--no-fund'], { cwd: project })
  const exec = (args) => run('npm', ['exec', '--offline', '--', 'amdahl', ...args], { cwd: project })
  const shim = (args) => run(process.execPath, [join(project, 'node_modules', 'amdahl', 'amdahl.js'), ...args], { cwd: project })
  for (const [how, go] of [['npm exec amdahl', exec], ['the amdahl package bin', shim]]) {
    const help = go(['--help'])
    if (!help.startsWith('Usage: amdahl <command>') || !help.includes('skills add <publisher>/<skill>')) {
      throw new Error(`${how} --help printed:\n${help}`)
    }
    const v = go(['--version']).trim()
    if (v !== version) throw new Error(`${how} --version printed "${v}", expected "${version}"`)
  }
  console.log(`ok: ${shortTgz} runs @amdahl/cli ${version} (npx amdahl --help, --version)`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
