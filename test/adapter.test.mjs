import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatGptPlanAdapter } from '../lib/adapter.js'
import { collect, fakeLogger, jsonResponse, makeFetch, sseResponse } from './helpers.mjs'

const capabilities = { known: true, additionalTools: true, reasoning: true, efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], contextWindow: 272000, maxTokens: 128000 }

function setup({ fetchImpl, account = { id: 'acct-a', planEnabled: true, reauthRequired: false }, token = 'access-token', config = {} } = {}) {
  const accountState = { current: account }
  const accounts = {
    getActiveAccount: async () => accountState.current,
    resolveAccessToken: async () => token,
    refreshAccount: async () => accountState.current,
    markReauth: async (id, reason) => {
      accountState.current = { ...accountState.current, reauthRequired: true, lastError: reason }
    },
  }
  const catalog = {
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
    capabilitiesFor: () => capabilities,
    listModels: async () => [],
  }
  const adapter = new ChatGptPlanAdapter({
    accounts,
    catalog,
    config: { requestTimeoutMs: 2000, streamIdleTimeoutMs: 2000, displayName: 'ChatGPT Plan', ...config },
    fetchImpl,
    logger: fakeLogger(),
  })
  return { adapter, accounts, catalog, accountState }
}

function textStream() {
  return sseResponse([
    { type: 'response.created', response: { id: 'resp-1' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', output_index: 0, delta: 'lo' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-1', content: [{ type: 'output_text', text: 'Hello' }] } },
    { type: 'response.completed', response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } },
  ], { splitAt: [1, 7, 80, 150, 260] })
}

test('text stream emits block, deltas, usage, and exactly one stop finish', async () => {
  const fetch = makeFetch([[/\/responses$/u, async () => textStream()]])
  const { adapter } = setup({ fetchImpl: fetch })
  const chunks = await collect(adapter.stream({ provider: 'openai-chatgpt-plan', model: 'gpt-5.4', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
  const finishes = chunks.filter((chunk) => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.deepEqual(finishes[0].reason, { kind: 'stop' })
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text), ['Hel', 'lo'])
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'block-end').block, { type: 'text', text: 'Hello' })
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage').usage, { inputTokens: 10, outputTokens: 3, totalTokens: 15, cacheReadTokens: 2, reasoningTokens: 1 })
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(fetch.calls[0].options.headers['user-agent'].startsWith('deepseek-harness/'), true)
  assert.equal(fetch.calls[0].options.headers.authorization, 'Bearer access-token')
  const body = JSON.parse(fetch.calls[0].options.body)
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.input[0].role, 'user')
})

test('tool call fragments preserve raw arguments and call id, then finish as tool-calls', async () => {
  const args = '{"path":"a.txt","nested":{"x":1}}'
  const split = Math.floor(args.length / 2)
  const response = sseResponse([
    { type: 'response.created', response: { id: 'resp-tool' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc-1', call_id: 'call_abc', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(0, split) },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(split) },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: args },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc-1', call_id: 'call_abc', name: 'read_file', arguments: args } },
    { type: 'response.completed', response: { id: 'resp-tool', status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
  ], { splitAt: [3, 40, 100, 170] })
  const fetch = makeFetch([[/\/responses$/u, async () => response]])
  const { adapter } = setup({ fetchImpl: fetch })
  const chunks = await collect(adapter.stream({
    provider: 'openai-chatgpt-plan',
    model: 'gpt-5.4',
    messages: [{
      role: 'assistant',
      id: 'a-1',
      source: { kind: 'model', provider: 'openai-chatgpt-plan', model: 'gpt-5.4' },
      content: [{ type: 'tool-call', id: 'prior-call', name: 'lookup', arguments: '{"q":"x"}' }, { type: 'text', text: 'done' }],
    }],
  }))
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(deltas[0].id, 'call_abc')
  assert.equal(deltas.every((chunk) => chunk.id === 'call_abc'), true)
  assert.equal(deltas.map((chunk) => chunk.argumentsDelta).join(''), args)
  const block = chunks.find((chunk) => chunk.type === 'block-end').block
  assert.deepEqual(block, { type: 'tool-call', id: 'call_abc', name: 'read_file', arguments: args })
  assert.deepEqual(chunks.find((chunk) => chunk.type === 'finish').reason, { kind: 'tool-calls' })
  const sent = JSON.parse(fetch.calls[0].options.body)
  assert.equal(sent.input.some((item) => item.type === 'function_call' && item.call_id === 'prior-call' && item.arguments === '{"q":"x"}'), true)
})

test('multi-turn tool results are sent back with the original call id and raw text', async () => {
  const fetch = makeFetch([[/\/responses$/u, async () => textStream()]])
  const { adapter } = setup({ fetchImpl: fetch })
  await collect(adapter.stream({
    provider: 'openai-chatgpt-plan',
    model: 'gpt-5.4',
    messages: [
      { role: 'assistant', id: 'a-1', source: { kind: 'model', provider: 'openai-chatgpt-plan', model: 'gpt-5.4' }, content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }] },
      { role: 'tool', id: 't-1', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', content: [{ type: 'text', text: 'body' }] },
      { role: 'user', id: 'u-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] },
    ],
  }))
  const body = JSON.parse(fetch.calls[0].options.body)
  const output = body.input.find((item) => item.type === 'function_call_output')
  assert.deepEqual(output, { type: 'function_call_output', call_id: 'call_1', output: 'body' })
})

test('unsupported controls are omitted and recorded in the warning', async () => {
  const fetch = makeFetch([[/\/responses$/u, async () => textStream()]])
  const { adapter } = setup({ fetchImpl: fetch })
  await collect(adapter.stream({
    provider: 'openai-chatgpt-plan',
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 99,
    temperature: 0.1,
    stop: ['END'],
  }))
  const body = JSON.parse(fetch.calls[0].options.body)
  assert.equal(body.max_output_tokens, undefined)
  assert.equal(body.temperature, undefined)
  assert.equal(body.stop, undefined)
  assert.equal(adapter.providerRetryPolicy('x').retryableCodes.includes('RATE_LIMIT'), true)
})

test('quota, auth, and malformed streams become one terminal error finish', async () => {
  const quotaFetch = makeFetch([[/\/responses$/u, async () => jsonResponse({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }, { status: 429 })]])
  const quota = setup({ fetchImpl: quotaFetch })
  const quotaChunks = await collect(quota.adapter.stream({ provider: 'openai-chatgpt-plan', model: 'gpt-5.4', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
  assert.equal(quotaChunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.equal(quotaChunks.at(-1).reason.kind, 'error')
  assert.equal(quotaChunks.at(-1).reason.failure.code, 'QUOTA')

  const malformed = sseResponse(['data: not-json\n\n'])
  const malformedFetch = makeFetch([[/\/responses$/u, async () => malformed]])
  const bad = setup({ fetchImpl: malformedFetch })
  const badChunks = await collect(bad.adapter.stream({ provider: 'openai-chatgpt-plan', model: 'gpt-5.4', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
  assert.equal(badChunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.equal(badChunks.at(-1).reason.failure.code, 'MALFORMED_RESPONSE')
})

test('a fetch transport failure becomes a retryable TRANSPORT terminal', async () => {
  const fetch = makeFetch([[/\/responses$/u, async () => { throw new TypeError('network down') }]])
  const { adapter } = setup({ fetchImpl: fetch })
  const chunks = await collect(adapter.stream({ provider: 'openai-chatgpt-plan', model: 'gpt-5.4', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.equal(chunks.at(-1).reason.failure.code, 'TRANSPORT')
})

test('a terminal response.failed keeps its official usage-limit code as QUOTA', async () => {
  const failed = sseResponse([
    { type: 'response.created', response: { id: 'resp-failed' } },
    { type: 'response.failed', response: { id: 'resp-failed', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
  ])
  const fetch = makeFetch([[/\/responses$/u, async () => failed]])
  const { adapter } = setup({ fetchImpl: fetch })
  const chunks = await collect(adapter.stream({ provider: 'openai-chatgpt-plan', model: 'gpt-5.4', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.equal(chunks.at(-1).reason.failure.code, 'QUOTA')
})

test('an aborted caller gets exactly one aborted finish and no second terminal', async () => {
  const controller = new AbortController()
  const fetch = makeFetch([[/\/responses$/u, async () => textStream()]])
  const { adapter } = setup({ fetchImpl: fetch })
  controller.abort()
  const chunks = await collect(adapter.stream({
    provider: 'openai-chatgpt-plan',
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    signal: controller.signal,
  }))
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.equal(chunks[0].reason.kind, 'aborted')
  assert.equal(fetch.calls.length, 0)
})

test('an idle stream times out with a TIMEOUT terminal rather than an abort', async () => {
  const never = new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const fetch = makeFetch([[/\/responses$/u, async () => never]])
  const { adapter } = setup({ fetchImpl: fetch, config: { streamIdleTimeoutMs: 20 } })
  const chunks = await collect(adapter.stream({ provider: 'openai-chatgpt-plan', model: 'gpt-5.4', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT')
})

test('SSE split inside a frame still produces complete ordered blocks', async () => {
  const body = sseResponse([
    { type: 'response.output_text.delta', output_index: 0, delta: 'A' },
    { type: 'response.output_text.delta', output_index: 0, delta: 'B' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
  ], { splitAt: [2, 5, 9, 17, 29] })
  const fetch = makeFetch([[/\/responses$/u, async () => body]])
  const { adapter } = setup({ fetchImpl: fetch })
  const chunks = await collect(adapter.stream({ provider: 'openai-chatgpt-plan', model: 'gpt-5.4', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
  assert.equal(chunks.filter((chunk) => chunk.type === 'block-start').length, 1)
  assert.deepEqual(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text), ['A', 'B'])
  assert.equal(chunks.find((chunk) => chunk.type === 'block-end').block.text, 'AB')
  assert.equal(chunks.at(-1).type, 'finish')
})
