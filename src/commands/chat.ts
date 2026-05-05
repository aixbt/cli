import type { Command } from 'commander'
import { getClientOptions } from '../lib/auth.js'
import { postRaw } from '../lib/api-client.js'
import * as output from '../lib/output.js'
import { ApiError } from '../lib/errors.js'

interface AgentResponse {
  status: number
  error: string
  data: { text: string }
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat [message]')
    .description('Chat with the AIXBT agent (requires Pro/Holder)')
    .option('--messages <json>', 'Full conversation history as JSON array of {role, content}')
    .action(async (message: string | undefined, _opts: unknown, cmd: Command) => {
      await handleChat(message, cmd)
    })
}

function parseMessages(message: string | undefined, cmd: Command): ChatMessage[] {
  const opts = cmd.optsWithGlobals()
  const messagesJson = opts.messages as string | undefined

  if (messagesJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(messagesJson)
    } catch {
      throw new ApiError(0, 'Invalid JSON in --messages. Expected array of {role, content}.', 'INVALID_INPUT')
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new ApiError(0, '--messages must be a non-empty JSON array.', 'INVALID_INPUT')
    }

    for (const msg of parsed) {
      if (!msg.role || !msg.content) {
        throw new ApiError(0, 'Each message must have "role" and "content" fields.', 'INVALID_INPUT')
      }
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        throw new ApiError(0, `Invalid role "${msg.role}". Must be "user" or "assistant".`, 'INVALID_INPUT')
      }
    }

    return parsed as ChatMessage[]
  }

  if (!message) {
    throw new ApiError(0, 'Provide a message or use --messages. Run: aixbt chat "your question"', 'INVALID_INPUT')
  }

  return [{ role: 'user', content: message }]
}

async function handleChat(message: string | undefined, cmd: Command): Promise<void> {
  const { clientOpts, outputFormat } = getClientOptions(cmd)

  const messages = parseMessages(message, cmd)

  const result = await output.withSpinner(
    'Thinking...',
    outputFormat,
    async () => {
      try {
        return await postRaw<AgentResponse>('/v2/agents/indigo', { messages }, clientOpts)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'INVALID_API_KEY_SCOPE') {
          throw new ApiError(403, 'Chat requires Pro tier or above. Upgrade at aixbt.tech', 'UPGRADE_REQUIRED')
        }
        throw err
      }
    },
    'Chat request failed',
    { silent: true },
  )

  if (result.status === 404 || !result.data?.text) {
    if (output.isStructuredFormat(outputFormat)) {
      output.outputStructured({ data: { text: null, message: 'No information found for your query.' } }, outputFormat)
    } else {
      output.dim('No information found for your query. Try rephrasing or being more specific.')
    }
    return
  }

  if (output.isStructuredFormat(outputFormat)) {
    output.outputStructured({ data: { text: result.data.text, messages } }, outputFormat)
    return
  }

  console.log(result.data.text)
}
