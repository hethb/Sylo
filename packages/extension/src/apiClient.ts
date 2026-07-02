// Sylo — API client.
//
// The only networked module in the extension. Talks exclusively to the hosted
// Sylo API (or a self-hosted instance via sylo.apiBaseUrl). No LLM keys, no
// user identifiers — the request body is the redacted workspace snapshot.

import * as vscode from 'vscode'
import { ContextSnapshot } from './snapshot'

export const EXTENSION_VERSION = '0.1.0'
const REQUEST_TIMEOUT_MS = 15000

export interface GenerateResponse {
  content: string
  tokenEstimate: number
  generatedAt: number
}

export interface BriefResponse {
  whatYouWereDoing: string
  lastDecision: string
  nextAction: string
  awayDurationFormatted: string
  generatedAt: number
}

export class SyloApiClient {
  constructor(private readonly baseUrl: string) {}

  async generateContext(snapshot: ContextSnapshot): Promise<GenerateResponse> {
    const response = await this.post('/generate', JSON.stringify(snapshot), {
      'Sylo-VS-Code-Version': vscode.version
    })
    return (await response.json()) as GenerateResponse
  }

  async generateBrief(snapshot: ContextSnapshot, awayDurationMs: number): Promise<BriefResponse> {
    const response = await this.post('/brief', JSON.stringify({ snapshot, awayDurationMs }))
    return (await response.json()) as BriefResponse
  }

  private async post(
    route: string,
    body: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sylo-Extension-Version': EXTENSION_VERSION,
          ...extraHeaders
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (response.status === 429) {
      const data = (await safeJson(response)) as { error?: string; retryAfterMs?: number }
      throw new SyloRateLimitError(
        data.error ?? 'Too many requests. Please wait a moment.',
        data.retryAfterMs ?? 30000
      )
    }

    if (!response.ok) {
      const data = (await safeJson(response)) as { error?: string }
      throw new SyloApiError(data.error || `Sylo server returned ${response.status}. Please try again.`)
    }

    return response
  }
}

export class SyloApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyloApiError'
  }
}

export class SyloRateLimitError extends SyloApiError {
  constructor(
    message: string,
    public readonly retryAfterMs: number
  ) {
    super(message)
    this.name = 'SyloRateLimitError'
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

function toNetworkError(err: unknown): SyloApiError {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new SyloApiError('The Sylo server took too long to respond. Please try again.')
  }
  return new SyloApiError('Could not reach the Sylo server. Check your internet connection and try again.')
}
