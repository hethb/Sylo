// Sylo — minimal LLM client.
//
// The only place in the extension that touches the network. Talks to OpenAI or
// Anthropic using the developer's own API key. No telemetry, no third-party
// endpoints. Uses the global `fetch` available in the VS Code extension host
// (Node 18+), so there are no runtime dependencies.

export type Provider = 'openai' | 'anthropic'

export interface ChatRequest {
  provider: Provider
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  maxTokens: number
  temperature?: number
}

const REQUEST_TIMEOUT_MS = 30000

/**
 * Send a single system+user chat completion and return the assistant text.
 * Throws an Error with a human-readable message on any failure — never a raw
 * HTTP object.
 */
export async function chat(req: ChatRequest): Promise<string> {
  if (!req.apiKey) {
    throw new Error('API key not configured. Run "Sylo: Configure".')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    if (req.provider === 'anthropic') {
      return await callAnthropic(req, controller.signal)
    }
    return await callOpenAI(req, controller.signal)
  } catch (err) {
    throw new Error(humanizeError(err, req.provider))
  } finally {
    clearTimeout(timer)
  }
}

async function callOpenAI(req: ChatRequest, signal: AbortSignal): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.3,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt }
      ]
    })
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'OpenAI'))
  }

  const data = (await res.json()) as OpenAIResponse
  const content = data.choices?.[0]?.message?.content
  if (!content || content.trim().length === 0) {
    throw new Error('OpenAI returned an empty response.')
  }
  return content.trim()
}

async function callAnthropic(req: ChatRequest, signal: AbortSignal): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.3,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }]
    })
  })

  if (!res.ok) {
    throw new Error(await readApiError(res, 'Anthropic'))
  }

  const data = (await res.json()) as AnthropicResponse
  const content = data.content?.find((b) => b.type === 'text')?.text
  if (!content || content.trim().length === 0) {
    throw new Error('Anthropic returned an empty response.')
  }
  return content.trim()
}

/** Turn a non-2xx API response into a short, human-readable message. */
async function readApiError(res: Response, providerLabel: string): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as ApiErrorBody
    detail = body.error?.message ?? body.message ?? ''
  } catch {
    // Non-JSON error body — ignore, fall back to status text.
  }

  if (res.status === 401) {
    return `${providerLabel} rejected your API key (401). Check it with "Sylo: Configure".`
  }
  if (res.status === 429) {
    return `${providerLabel} rate limit or quota hit (429).${detail ? ` ${detail}` : ''}`
  }
  if (res.status === 404) {
    return `${providerLabel} could not find that model (404). Check the "sylo.model" setting.${
      detail ? ` ${detail}` : ''
    }`
  }
  if (res.status >= 500) {
    return `${providerLabel} had a server error (${res.status}). Try again in a moment.`
  }
  return `${providerLabel} request failed (${res.status})${detail ? `: ${detail}` : `: ${res.statusText}`}.`
}

function humanizeError(err: unknown, provider: Provider): string {
  const label = provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return `${label} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`
    }
    // Already-humanized messages (thrown above) pass straight through.
    if (err.message.startsWith(label) || err.message.startsWith('API key')) {
      return err.message
    }
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(err.message)) {
      return `Could not reach ${label}. Check your internet connection.`
    }
    return err.message
  }
  return `Unexpected error contacting ${label}.`
}

interface OpenAIResponse {
  choices?: { message?: { content?: string } }[]
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[]
}

interface ApiErrorBody {
  error?: { message?: string }
  message?: string
}
