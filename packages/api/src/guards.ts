// Sylo API — abuse prevention: per-IP rate limiting, extension-version check,
// and a daily cost circuit breaker.

import express from 'express'

// ---- Rate limiting: 20 requests / minute / IP, in-memory ----

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

const WINDOW_MS = 60 * 1000
const LIMIT_PER_WINDOW = 20

export function rateLimit(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()

  const entry = rateLimitMap.get(ip)

  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    next()
    return
  }

  if (entry.count >= LIMIT_PER_WINDOW) {
    res.status(429).json({
      error: 'Rate limit exceeded. Please wait a moment before generating another context file.',
      retryAfterMs: entry.resetAt - now
    })
    return
  }

  entry.count++
  next()
}

// Periodically sweep expired entries so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (entry.resetAt < now) {
      rateLimitMap.delete(ip)
    }
  }
}, 10 * 60 * 1000).unref()

// ---- Extension version check ----

// Known-good extension versions. Extend via KNOWN_EXTENSION_VERSIONS env var
// (comma-separated) without redeploying code changes.
const KNOWN_VERSIONS = new Set(
  (process.env.KNOWN_EXTENSION_VERSIONS ?? '0.1.0').split(',').map((v) => v.trim())
)

export function checkExtensionVersion(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const version = req.header('Sylo-Extension-Version')
  if (!version || !KNOWN_VERSIONS.has(version)) {
    res.status(403).json({
      error: 'Unrecognized Sylo extension version. Please update the Sylo extension.'
    })
    return
  }
  next()
}

// ---- Daily cost circuit breaker ----

// claude-haiku-4-5 pricing (per million tokens)
const INPUT_COST_PER_MTOK = 1.0
const OUTPUT_COST_PER_MTOK = 5.0

const MAX_DAILY_COST_USD = Number(process.env.MAX_DAILY_COST_USD ?? '25')

let costDay = currentDay()
let dailyCostUsd = 0

function currentDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function rollDayIfNeeded(): void {
  const day = currentDay()
  if (day !== costDay) {
    costDay = day
    dailyCostUsd = 0
  }
}

export function recordUsage(inputTokens: number, outputTokens: number): number {
  rollDayIfNeeded()
  const cost =
    (inputTokens / 1_000_000) * INPUT_COST_PER_MTOK +
    (outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK
  dailyCostUsd += cost
  return dailyCostUsd
}

export function costGuard(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  rollDayIfNeeded()
  if (dailyCostUsd >= MAX_DAILY_COST_USD) {
    res.status(503).json({
      error:
        "Sylo's free tier has hit its daily limit. Service resets at midnight UTC — please try again then."
    })
    return
  }
  next()
}

export function getDailyCostUsd(): number {
  rollDayIfNeeded()
  return dailyCostUsd
}
