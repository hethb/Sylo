// Sylo API — hosted backend for the Sylo VS Code extension.
//
// The only place LLM API keys exist. The extension POSTs a workspace snapshot;
// this server calls Anthropic (our key, our cost) and returns the generated
// context file or re-entry brief. No user auth, no user identifiers — abuse is
// managed by per-IP rate limiting, an extension-version check, and a daily
// cost circuit breaker.

import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import { ContextSnapshot, isValidSnapshot } from './types'
import {
  AGENT_CONTEXT_SYSTEM_PROMPT,
  BRIEF_SYSTEM_PROMPT,
  buildAgentContextPrompt,
  buildBriefPrompt,
  formatContextFile,
  formatDuration
} from './prompts'
import { rateLimit, checkExtensionVersion, costGuard, recordUsage, getDailyCostUsd } from './guards'

const MODEL = 'claude-haiku-4-5' // fast and cheap — important for cost at scale
const PROMPT_TOKEN_BUDGET = 3500

const app = express()
const PORT = process.env.PORT || 3456

// Railway (and most PaaS) sit behind a proxy — needed for req.ip to be real.
app.set('trust proxy', true)

app.use(
  cors({
    origin: '*', // VS Code extensions don't have a traditional origin — allow all
    methods: ['POST', 'GET']
  })
)
app.use(express.json({ limit: '500kb' }))

const anthropic = new Anthropic() // reads ANTHROPIC_API_KEY from env

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' })
})

app.post('/generate', rateLimit, checkExtensionVersion, costGuard, (req, res) => {
  void generateHandler(req, res)
})
app.post('/brief', rateLimit, checkExtensionVersion, costGuard, (req, res) => {
  void briefHandler(req, res)
})

app.listen(PORT, () => {
  console.log(`Sylo API running on port ${PORT}`)
})

// ---- Handlers ----

async function generateHandler(req: express.Request, res: express.Response): Promise<void> {
  const snapshot = req.body as unknown

  if (!isValidSnapshot(snapshot)) {
    res.status(400).json({ error: 'Invalid snapshot payload' })
    return
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server configuration error' })
    return
  }

  logRequest(req, 'generate', snapshot.workspaceName)

  try {
    const userPrompt = buildAgentContextPrompt(snapshot)

    // Token budget check — rebuild truncated if too long
    const estimatedTokens = Math.round(userPrompt.length / 4)
    const finalPrompt =
      estimatedTokens > PROMPT_TOKEN_BUDGET
        ? buildAgentContextPrompt(snapshot, { truncated: true })
        : userPrompt

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: AGENT_CONTEXT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: finalPrompt }]
    })

    recordUsage(message.usage.input_tokens, message.usage.output_tokens)

    const rawContent = message.content.find((b) => b.type === 'text')?.text ?? ''
    const content = formatContextFile(rawContent, snapshot)

    res.json({
      content,
      tokenEstimate: Math.round(content.length / 4),
      model: MODEL,
      generatedAt: Date.now()
    })
  } catch (err) {
    handleLlmError(err, res, 'context file')
  }
}

async function briefHandler(req: express.Request, res: express.Response): Promise<void> {
  const body = req.body as { snapshot?: unknown; awayDurationMs?: unknown }
  const snapshot = body?.snapshot
  const awayDurationMs = typeof body?.awayDurationMs === 'number' ? body.awayDurationMs : 0

  if (!isValidSnapshot(snapshot)) {
    res.status(400).json({ error: 'Invalid payload' })
    return
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server configuration error' })
    return
  }

  logRequest(req, 'brief', snapshot.workspaceName)

  try {
    const userPrompt = buildBriefPrompt(snapshot, awayDurationMs)

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 250,
      system: BRIEF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })

    recordUsage(message.usage.input_tokens, message.usage.output_tokens)

    const text = message.content.find((b) => b.type === 'text')?.text ?? ''
    const sentences = text
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)

    res.json({
      whatYouWereDoing: sentences[0] || '',
      lastDecision: sentences[1] || '',
      nextAction: sentences[2] || '',
      awayDurationFormatted: formatDuration(awayDurationMs),
      generatedAt: Date.now()
    })
  } catch (err) {
    handleLlmError(err, res, 'brief')
  }
}

// ---- Helpers ----

function handleLlmError(err: unknown, res: express.Response, what: string): void {
  if (err instanceof Anthropic.RateLimitError) {
    console.error(`Anthropic rate limit hit while generating ${what}`)
    res.status(503).json({ error: 'Sylo is at capacity right now. Please try again in a minute.' })
    return
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`Anthropic API error (${err.status}) while generating ${what}:`, err.message)
    res.status(502).json({ error: `Failed to generate ${what}. Please try again.` })
    return
  }
  console.error(`Internal error while generating ${what}:`, err)
  res.status(500).json({ error: 'Internal server error. Please try again.' })
}

/** Log timestamp, IP, and workspace name only — never file contents. */
function logRequest(req: express.Request, route: string, workspaceName: string): void {
  console.log(
    `${new Date().toISOString()} ${route} ip=${req.ip} workspace=${workspaceName} dailyCost=$${getDailyCostUsd().toFixed(4)}`
  )
}
