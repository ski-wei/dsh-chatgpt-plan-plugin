import { createHash, randomBytes } from 'node:crypto'
import { base64url } from './util.js'

/** Create the per-attempt PKCE material. Never reused across attempts. */
export function createPkce(verifierBytes = 48) {
  const verifier = randomBytes(verifierBytes).toString('base64url')
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}
