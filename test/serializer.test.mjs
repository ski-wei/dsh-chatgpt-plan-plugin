import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildResponsesRequest, REQUEST_FIELDS } from '../lib/serializer.js'

const capabilities = {
  known: true,
  additionalTools: true,
  reasoning: true,
  efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
}

function message(role, content, extra = {}) {
  return { role, content, id: `${role}-1`, source: { kind: role === 'assistant' ? 'model' : role === 'tool' ? 'tool' : 'user' }, ...extra }
}

test('request body uses the closed plan-route allow-list and developer role', () => {
  const { body, omitted } = buildResponsesRequest({
    messages: [message('user', [{ type: 'text', text: 'hello' }])],
    system: 'You are DSH.',
    maxTokens: 1000,
    temperature: 0.2,
    stop: ['x'],
  }, { modelId: 'gpt-5.4', capabilities })
  assert.equal(Object.keys(body).every((key) => REQUEST_FIELDS.includes(key)), true)
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.max_output_tokens, undefined)
  assert.equal(body.temperature, undefined)
  assert.equal(body.top_p, undefined)
  assert.equal(body.tools, undefined)
  assert.equal(body.previous_response_id, undefined)
  assert.equal(body.prompt_cache_retention, undefined)
  assert.deepEqual(omitted, ['maxTokens', 'temperature', 'stop'])
  assert.deepEqual(body.input[0], { role: 'developer', content: 'You are DSH.' })
  assert.deepEqual(body.input[1], { role: 'user', content: [{ type: 'input_text', text: 'hello' }] })
})

test('tools are declared once in additional_tools, not top-level tools', () => {
  const { body } = buildResponsesRequest({
    messages: [message('user', [{ type: 'text', text: 'read a file' }])],
    tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }, { modelId: 'gpt-5.4', capabilities })
  assert.equal(body.tools, undefined)
  assert.equal(body.input[0].type, 'additional_tools')
  assert.equal(body.input[0].role, 'developer')
  assert.deepEqual(body.input[0].tools, [{
    type: 'function',
    name: 'read_file',
    description: 'Read',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  }])
})

test('multi-turn history preserves tool call ids and raw arguments', () => {
  const args = '{"path":"a.txt","nested":{"x":1}}'
  const { body } = buildResponsesRequest({
    messages: [
      message('user', [{ type: 'text', text: 'go' }]),
      message('assistant', [
        { type: 'text', text: 'reading' },
        { type: 'tool-call', id: 'call_original|fc_item', name: 'read_file', arguments: args },
      ]),
      message('tool', [{ type: 'text', text: 'file body' }], { toolCallId: 'call_original|fc_item', source: { kind: 'tool', callId: 'call_original|fc_item' } }),
      message('user', [{ type: 'text', text: 'again' }]),
    ],
  }, { modelId: 'gpt-5.4', capabilities })
  const call = body.input.find((item) => item.type === 'function_call')
  const result = body.input.find((item) => item.type === 'function_call_output')
  assert.equal(call.call_id, 'call_original|fc_item')
  assert.equal(call.arguments, args)
  assert.equal(result.call_id, 'call_original|fc_item')
  assert.equal(result.output, 'file body')
})

test('unsupported content and unverified tools fail explicitly', () => {
  assert.throws(() => buildResponsesRequest({
    messages: [message('user', [{ type: 'image', attachment: {} }])],
  }, { modelId: 'gpt-5.4', capabilities }), (error) => error.code === 'UNSUPPORTED_CONTENT')
  assert.throws(() => buildResponsesRequest({
    messages: [message('user', [{ type: 'text', text: 'x' }])],
    tools: [{ name: 't', description: '', parameters: {} }],
  }, { modelId: 'mystery', capabilities: { known: false, additionalTools: false, reasoning: false, efforts: [] } }), (error) => error.code === 'UNSUPPORTED_CAPABILITY')
  assert.throws(() => buildResponsesRequest({
    messages: [message('user', [{ type: 'text', text: 'x' }])],
    reasoningEffort: 'extreme',
  }, { modelId: 'gpt-5.4', capabilities }), (error) => error.code === 'UNSUPPORTED_CONTROL')
})

test('reasoning effort is included only when allowed', () => {
  const { body } = buildResponsesRequest({
    messages: [message('user', [{ type: 'text', text: 'x' }])],
    reasoningEffort: 'high',
  }, { modelId: 'gpt-5.4', capabilities })
  assert.deepEqual(body.reasoning, { effort: 'high' })
})
