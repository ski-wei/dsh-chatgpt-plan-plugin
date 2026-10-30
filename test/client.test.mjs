import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

test('client factory registers locale dictionaries and the Models footer panel', () => {
  let loaded
  const window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  const code = readFileSync(join(root, 'client.js'), 'utf8')
  new Function('window', code)(window)
  assert.equal(loaded.id, '@local/dsh-chatgpt-plan')

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
  }
  const effects = []
  const registrations = []
  const localeRegistrations = []
  const ctx = {
    effect(callback) {
      const cleanup = callback()
      effects.push(cleanup)
      return cleanup
    },
    locale: {
      register(ns, locale, dict) {
        localeRegistrations.push({ ns, locale, dict })
        return () => {}
      },
      bind(ns) {
        return (key) => `${ns}:${key}`
      },
      getSnapshot() {
        return { active: 'en' }
      },
    },
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'settings.models.footer')
        callback()
        return () => {}
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  const factory = loaded.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  factory.apply(ctx)
  assert.deepEqual(localeRegistrations.map((entry) => entry.locale), ['en', 'zh'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.models.footer')
  assert.equal(registrations[0].options.id, 'openai-chatgpt-plan-account')
  assert.equal(registrations[0].options.order, 10)
  const rendered = registrations[0].Component()
  assert.equal(rendered.type, 'section')
  assert.equal(effects.length, 3)
  for (const cleanup of effects) cleanup()
})
