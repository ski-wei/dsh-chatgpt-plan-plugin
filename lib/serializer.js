import { ChatGptPlanError } from './errors.js'

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function unsupportedContent(role, type) {
  throw new ChatGptPlanError(
    `The ChatGPT-plan route cannot serialize a ${String(type)} block in a ${role} message`,
    'UNSUPPORTED_CONTENT',
  )
}

function toolSchemaOf(tool) {
  if (tool === null || typeof tool !== 'object') {
    throw new ChatGptPlanError('A tool declaration is not an object', 'INVALID_REQUEST')
  }
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new ChatGptPlanError('A tool declaration has no name', 'INVALID_REQUEST')
  }
  const parameters =
    tool.parameters !== null && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
      ? tool.parameters
      : { type: 'object', properties: {} }
  return {
    type: 'function',
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters,
  }
}

function appendMessage(input, message) {
  const role = message?.role
  if (role === 'system' || role === 'developer') {
    const text = textOf(message.content)
    if (text.length > 0) input.push({ role: 'developer', content: text })
    return
  }
  if (role === 'user') {
    const content = []
    if (typeof message.content === 'string') {
      if (message.content.length > 0) content.push({ type: 'input_text', text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.length > 0) {
            content.push({ type: 'input_text', text: block.text })
          }
        } else if (block.type === 'image' || block.type === 'file') {
          unsupportedContent('user', block.type)
        } else {
          unsupportedContent('user', block.type)
        }
      }
    }
    if (content.length > 0) input.push({ role: 'user', content })
    return
  }
  if (role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
          })
        }
      } else if (block.type === 'tool-call') {
        if (typeof block.id !== 'string' || block.id.length === 0) {
          throw new ChatGptPlanError('A tool call has no call id', 'INVALID_REQUEST')
        }
        if (typeof block.name !== 'string' || block.name.length === 0) {
          throw new ChatGptPlanError('A tool call has no name', 'INVALID_REQUEST')
        }
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
        })
      } else if (block.type === 'reasoning') {
        // Reasoning replay is not sent: the plan route accepts a fresh full
        // input, and retaining no encrypted reasoning keeps this adapter from
        // pretending to replay opaque provider state it does not own.
      } else if (block.type === 'image' || block.type === 'file') {
        unsupportedContent('assistant', block.type)
      } else if (block.type !== 'tool-addition' && block.type !== 'tool-removal') {
        unsupportedContent('assistant', block.type)
      }
    }
    return
  }
  if (role === 'tool') {
    const callId = message.toolCallId ?? message.source?.callId
    if (typeof callId !== 'string' || callId.length === 0) {
      throw new ChatGptPlanError('A tool result has no call id', 'INVALID_REQUEST')
    }
    const content = Array.isArray(message.content) ? message.content : []
    const parts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (typeof block.text === 'string') parts.push(block.text)
      } else {
        unsupportedContent('tool', block.type)
      }
    }
    input.push({
      type: 'function_call_output',
      call_id: callId,
      output: parts.length === 0 ? '(no tool output)' : parts.join('\n'),
    })
    return
  }
  throw new ChatGptPlanError(`Unknown message role "${String(role)}"`, 'INVALID_REQUEST')
}

/**
 * Build the only request shape this route may send.
 *
 * The allow-list is explicit and closed. In particular there is no top-level
 * `tools`, `max_output_tokens`, `temperature`, `top_p`, `stop`, cache field,
 * `previous_response_id`, service tier, or metadata. Tools are declared once
 * in an `additional_tools` input item, which is the shape the plan route
 * documents for open-source clients.
 */
export function buildResponsesRequest(options, context) {
  const capabilities = context.capabilities
  const tools = Array.isArray(options.tools) ? options.tools : []
  if (tools.length > 0 && capabilities?.additionalTools !== true) {
    throw new ChatGptPlanError(
      'This model has no verified additional_tools capability; refusing to send tools on the plan route',
      'UNSUPPORTED_CAPABILITY',
    )
  }
  const omitted = []
  if (options.maxTokens !== undefined) omitted.push('maxTokens')
  if (options.temperature !== undefined) omitted.push('temperature')
  if (options.stop !== undefined) omitted.push('stop')

  let reasoning
  if (options.reasoningEffort !== undefined) {
    if (capabilities?.reasoning !== true) {
      throw new ChatGptPlanError('This model does not accept a reasoning effort on the plan route', 'UNSUPPORTED_CONTROL')
    }
    const allowed = new Set((capabilities.efforts ?? []).map((effort) => effort.id))
    if (!allowed.has(String(options.reasoningEffort))) {
      throw new ChatGptPlanError(`Unsupported reasoning effort "${options.reasoningEffort}"`, 'UNSUPPORTED_CONTROL')
    }
    reasoning = { effort: String(options.reasoningEffort) }
  }

  const input = []
  if (tools.length > 0) {
    input.push({
      type: 'additional_tools',
      role: 'developer',
      tools: tools.map(toolSchemaOf),
    })
  }
  if (typeof options.system === 'string' && options.system.length > 0) {
    input.push({ role: 'developer', content: options.system })
  }
  for (const message of options.messages ?? []) appendMessage(input, message)
  if (input.length === 0) {
    throw new ChatGptPlanError('The request has no model-visible input', 'INVALID_REQUEST')
  }

  const body = {
    model: context.modelId,
    input,
    stream: true,
    store: false,
    ...(reasoning === undefined ? {} : { reasoning }),
  }
  return { body, omitted }
}

/** Allowed top-level keys; exported so tests can pin the whitelist. */
export const REQUEST_FIELDS = Object.freeze(['model', 'input', 'stream', 'store', 'reasoning'])
