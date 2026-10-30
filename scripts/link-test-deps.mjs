#!/usr/bin/env node
/**
 * Test-only links to the installed DSH 0.2.1-rc.2 packages.
 *
 * The bundle declares them as peer dependencies, so an installed profile
 * already supplies them. The offline tests import the real `LlmAdapter` and
 * `credentialKey`; these links make that possible from the project directory
 * without installing or modifying the global DSH tree.
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dshRoot =
  process.env.DSH_INSTALL_ROOT ??
  resolve(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
const packages = ['dsh-llm', 'dsh-credentials']

if (!existsSync(join(dshRoot, 'package.json'))) {
  console.error(`DSH installation not found at ${dshRoot}; set DSH_INSTALL_ROOT.`)
  process.exit(1)
}
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
