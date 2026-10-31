#!/usr/bin/env node
/**
 * Test-only links to the installed DSH `dsh-llm` / `dsh-credentials` packages.
 *
 * The bundle declares them as peer dependencies, so an installed profile
 * already supplies them. The offline tests import the real `LlmAdapter` and
 * `credentialKey`; these links make that possible from the project directory
 * without installing or modifying the global DSH tree.
 *
 * The install location differs between global npm prefix layouts, nvm layouts,
 * and packaged installs, so probe rather than assume one path. Set
 * `DSH_INSTALL_ROOT` to skip probing entirely.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packages = ['dsh-llm', 'dsh-credentials']

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
  } catch {
    return undefined
  }
}

function candidates() {
  const found = []
  if (process.env.DSH_INSTALL_ROOT) found.push(resolve(process.env.DSH_INSTALL_ROOT))
  // nvm / distro layout: <prefix>/bin/node -> <prefix>/lib/node_modules
  found.push(resolve(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  // Global npm prefix: npm root -g
  const npmRoot = run('npm', ['root', '-g'])
  if (npmRoot !== undefined && npmRoot.length > 0) found.push(join(npmRoot, '@deepseek-ai', 'dsh'))
  // The shell's own `dsh` shim: <package>/lib/bin.js
  const dshBin = run('which', ['dsh'])
  if (dshBin !== undefined && dshBin.length > 0) {
    try {
      found.push(dirname(dirname(realpathSync(dshBin))))
    } catch {
      // A broken shim is not a candidate.
    }
  }
  return [...new Set(found)]
}

function locateDsh() {
  for (const candidate of candidates()) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

const dshRoot = locateDsh()
if (dshRoot === undefined) {
  console.error(
    `DSH installation not found. Tried:\n${candidates().map((path) => `  - ${path}`).join('\n')}\n` +
      'Set DSH_INSTALL_ROOT to the directory containing the dsh package.json.',
  )
  process.exit(1)
}
const version = JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8')).version
console.log(`DSH ${version} at ${dshRoot}`)

const scopeDir = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(scopeDir, { recursive: true })
for (const name of packages) {
  const source = join(dshRoot, 'node_modules', '@deepseek-ai', name)
  const target = join(scopeDir, name)
  if (!existsSync(source)) {
    console.error(`missing installed package: ${source}`)
    process.exit(1)
  }
  if (existsSync(target)) {
    console.log(`kept ${name}`)
    continue
  }
  symlinkSync(source, target, 'dir')
  console.log(`linked ${name} -> ${source}`)
}
