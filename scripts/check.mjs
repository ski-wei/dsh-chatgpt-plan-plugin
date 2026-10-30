#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const required = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
  'lib/accounts.js',
  'lib/adapter.js',
  'lib/catalog.js',
  'lib/config.js',
  'lib/constants.js',
  'lib/coordinator.js',
  'lib/errors.js',
  'lib/host-id.js',
  'lib/id-token.js',
  'lib/oauth.js',
  'lib/pkce.js',
  'lib/serializer.js',
  'lib/sse.js',
  'lib/util.js',
  'lib/web-routes.js',
]

let stdout
try {
  stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(root, '.npm-cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  console.error('npm pack --dry-run failed')
  console.error(error.stderr?.toString?.() ?? error.message)
  process.exit(1)
}

let parsed
try {
  parsed = JSON.parse(stdout)
} catch {
  console.error('npm pack did not return JSON')
  console.error(stdout)
  process.exit(1)
}
const pack = Array.isArray(parsed) ? parsed[0] : parsed
const files = (pack.files ?? []).map((file) => file.path)
const missing = required.filter((file) => !files.includes(file))
if (missing.length > 0) {
  console.error(`packed bundle is missing: ${missing.join(', ')}`)
  process.exit(1)
}
const runtime = files.filter((file) => file.startsWith('lib/') && file.endsWith('.js'))
for (const file of runtime) {
  if (statSync(join(root, file)).size === 0) {
    console.error(`runtime file is empty: ${file}`)
    process.exit(1)
  }
}
const forbidden = files.filter((file) => file.startsWith('node_modules/') || file.startsWith('.inspect-codex/') || file.startsWith('.npm-cache/'))
if (forbidden.length > 0) {
  console.error(`packed bundle contains non-runtime files: ${forbidden.join(', ')}`)
  process.exit(1)
}

const totalBytes = files.reduce((sum, file) => sum + statSync(join(root, file)).size, 0)
console.log(JSON.stringify({
  ok: true,
  package: pack.name,
  version: pack.version,
  fileCount: files.length,
  totalBytes,
  files,
}, null, 2))
