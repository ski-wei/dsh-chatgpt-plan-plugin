/**
 * Acceptance-only probe: hold the current refresh token in memory, wait for the
 * plugin's sign-out to remove the local grant, then ask the official token
 * endpoint whether that refresh token was actually revoked. It prints only a
 * classification, never a token, code, URL, or provider body.
 *
 * Kept as historical acceptance evidence, not a plugin runtime module. It reads
 * the local DSH credential document, so run it only on a machine you own and
 * never attach its terminal output to a public issue.
 */
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const dshRoot = process.env.DSH_INSTALL_ROOT ?? resolve(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const YAML = require(join(dshRoot, 'node_modules', 'yaml', 'dist', 'index.js'))
const file = join(dshHome, '.credentials.yaml')
const read = () => YAML.parse(fs.readFileSync(file, 'utf8'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let account
let recordKey
for (let attempt = 0; attempt < 30 && account === undefined; attempt += 1) {
  try {
    const doc = read()
    for (const [key, rec] of Object.entries(doc.records ?? {})) {
      if (rec?.payload?.kind === 'chatgpt-plan-account' && rec.payload.planEnabled === true && rec.payload.refreshToken) {
        account = rec.payload
        recordKey = key
        break
      }
    }
  } catch {}
  if (account === undefined) await sleep(1000)
}
if (account === undefined) {
  console.log('PROBE_UNAVAILABLE no usable account')
  process.exit(0)
}
console.log(`PROBE_ARMED account=${account.id} record=${recordKey}`)
const deadline = Date.now() + 15 * 60 * 1000
while (Date.now() < deadline) {
  await sleep(2000)
  let present = true
  try {
    present = read().records?.[recordKey] !== undefined
  } catch {
    continue
  }
  if (present) continue
  console.log('LOCAL_GRANT_REMOVED')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: account.clientId,
    refresh_token: account.refreshToken,
    resource: 'https://api.openai.com/v1',
  })
  let response
  try {
    response = await fetch('https://auth.openai.com/api/accounts/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'deepseek-harness-chatgpt-plan/0.1.0' },
      body,
    })
  } catch {
    console.log('REVOKE_PROBE_NETWORK_ERROR')
    process.exit(0)
  }
  let code
  try { const parsed = JSON.parse(await response.text()); code = typeof parsed.error === 'string' ? parsed.error : parsed.error?.code } catch {}
  if (response.ok) {
    console.log('REMOTE_REVOKE_NOT_CONFIRMED refresh_succeeded')
  } else if (code === 'invalid_grant' || code === 'invalid_refresh_token') {
    console.log(`REMOTE_REVOKE_CONFIRMED ${code}`)
  } else {
    console.log(`REVOKE_PROBE_HTTP_${response.status} ${code ?? 'unknown'}`)
  }
  process.exit(0)
}
console.log('REVOKE_PROBE_TIMEOUT')
