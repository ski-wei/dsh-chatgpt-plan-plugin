import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const read = (name) => readFileSync(join(root, name), 'utf8')

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name)
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

test('manifest exports, bundle patch, and client section are complete', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, '@local/dsh-chatgpt-plan')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.private, true)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings-models', '@deepseek-ai/dsh-client-locale'])
  for (const path of ['.', './client', './icon']) {
    const target = pkg.exports[path]
    assert.equal(typeof target, 'string')
    assert.ok(statSync(join(root, target)).isFile(), `${target} exists`)
  }
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  const required = ['index.js', 'client.js', 'lib/', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md', 'LICENSE']
  assert.ok(statSync(join(root, 'package-lock.json')).isFile())
  for (const entry of required) assert.ok(pkg.files.includes(entry), `files includes ${entry}`)
  assert.equal(pkg.version, '0.2.0')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-llm'], '>=0.2.1-rc.2 <0.2.2')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-credentials'], '>=0.2.1-rc.2 <0.2.2')
})

test('bundle patch inserts exactly the unique provider id and no secrets', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id: openai-chatgpt-plan/u)
  assert.match(patch, /name: '@local\/dsh-chatgpt-plan'/u)
  assert.equal((patch.match(/id: openai-chatgpt-plan/gu) ?? []).length, 1)
  assert.equal(/token|secret|client_id|refresh/i.test(patch), false)
})

test('English and Chinese display metadata have the same keys', () => {
  const en = JSON.parse(read('locale/en.json'))
  const zh = JSON.parse(read('locale/zh.json'))
  const keys = (value) => Object.keys(value).sort()
  assert.deepEqual(keys(en), keys(zh))
  assert.deepEqual(keys(en.meta), keys(zh.meta))
  assert.ok(en.meta.title.length > 0)
  assert.ok(zh.meta.description.length > 0)
})

test('icon is a self-contained SVG within the 256 KiB limit', () => {
  const bytes = statSync(join(root, 'icon.svg')).size
  assert.ok(bytes > 0 && bytes <= 256 * 1024)
  const svg = read('icon.svg')
  assert.match(svg, /^<svg[\s>]/u)
  assert.equal(/<image|<script|href=/iu.test(svg), false)
})

test('all JavaScript files pass node --check', () => {
  const files = ['index.js', 'client.js', ...walk('lib').filter((file) => file.endsWith('.js'))]
  for (const file of files) {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
  }
})

test('runtime files contain no obvious credential literals', () => {
  const files = ['index.js', 'client.js', 'cordis.patch.yml', ...walk('lib').filter((file) => file.endsWith('.js')), 'locale/en.json', 'locale/zh.json']
  const text = files.map((file) => read(file)).join('\n')
  assert.equal(/\bsk-[A-Za-z0-9_-]{20,}/u.test(text), false)
  assert.equal(/\beyJ[A-Za-z0-9_-]{20,}\./u.test(text), false)
  assert.equal(/dynamic_agent_client/u.test(text), true)
})

test('client module registers the Models footer through the module loader', () => {
  const client = read('client.js')
  assert.match(client, /__ModuleLoader__\.load/u)
  assert.match(client, /settings\.models\.footer/u)
  assert.match(client, /openai-chatgpt-plan-account/u)
  assert.match(client, /ctx\.locale\.register/u)
})
