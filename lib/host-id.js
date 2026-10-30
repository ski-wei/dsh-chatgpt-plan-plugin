import { randomUUID } from 'node:crypto'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** A host id is the stable public installation name sent as ext_agent_host_id. */
export function createHostId() {
  return `urn:uuid:${randomUUID()}`
}

export function isHostId(value) {
  if (typeof value !== 'string' || !value.startsWith('urn:uuid:')) return false
  return UUID_V4.test(value.slice('urn:uuid:'.length))
}
