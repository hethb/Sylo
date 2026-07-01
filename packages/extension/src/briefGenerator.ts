// Sylo — human re-entry brief generator.
//
// Turns a ContextSnapshot into a precise 3-sentence brief: what you were doing,
// the last decision, the next action. Sends the snapshot to the developer's own
// LLM provider and parses the reply.

import { chat, Provider } from './llm'
import { ContextSnapshot } from './snapshot'

export interface Brief {
  whatYouWereDoing: string
  lastDecision: string
  nextAction: string
  generatedAt: number
  snapshotTimestamp: number
  awayDurationFormatted: string
  model: string
}

const SYSTEM_PROMPT = `You are a developer's cognitive assistant. A developer has just returned to their code editor after being away. Your job is to give them a precise, specific 3-sentence re-entry brief that gets them back into flow immediately.

Rules:
- Sentence 1 (what they were doing): Name the specific task, file, and function/component if visible. Be concrete. Not "you were working on authentication" but "you were debugging the token refresh race condition in src/auth/middleware.ts, specifically the refreshTokenIfExpired function."
- Sentence 2 (last decision): What was the most recent meaningful action or decision visible in the code state? Reference line numbers, variable names, or error messages if present.
- Sentence 3 (next action): What is the single most obvious next concrete step based on the code state? This should be so specific that the developer can act on it immediately without thinking.

Do not add any preamble, greeting, or explanation. Output exactly 3 sentences separated by newlines. Nothing else.`

// Rough token budget guard. If the user prompt estimate exceeds this, we
// truncate the heaviest fields before sending.
const TOKEN_ESTIMATE_LIMIT = 3000
const CHARS_PER_TOKEN = 4

export async function generateBrief(
  snapshot: ContextSnapshot,
  apiKey: string,
  provider: Provider,
  model: string
): Promise<Brief> {
  const userPrompt = buildUserPrompt(snapshot)

  const text = await chat({
    provider,
    apiKey,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 400,
    temperature: 0.3
  })

  const [whatYouWereDoing, lastDecision, nextAction] = parseThreeSentences(text)

  return {
    whatYouWereDoing,
    lastDecision,
    nextAction,
    generatedAt: Date.now(),
    snapshotTimestamp: snapshot.timestamp,
    awayDurationFormatted: formatDuration(snapshot.awayDurationMs),
    model
  }
}

function buildUserPrompt(snapshot: ContextSnapshot): string {
  let surroundingCode = snapshot.activeFile?.surroundingCode ?? ''
  let gitDiff = snapshot.gitDiff ?? ''

  const compose = (): string => {
    const lines: string[] = []
    lines.push(`The developer was away for ${formatDuration(snapshot.awayDurationMs)}.`)
    lines.push('')
    lines.push('WORKSPACE')
    lines.push(`Name: ${snapshot.workspaceName}`)
    lines.push(`Branch: ${snapshot.gitBranch ?? 'unknown'}`)
    lines.push(`Last commit: ${snapshot.recentCommitMessage ?? 'none'}`)
    lines.push('')

    if (snapshot.activeFile) {
      const af = snapshot.activeFile
      lines.push(`ACTIVE FILE: ${af.path} (line ${af.cursorLine + 1}, col ${af.cursorColumn + 1})`)
      lines.push(`Language: ${af.languageId}`)
      lines.push(`Unsaved changes: ${af.isDirty ? 'yes' : 'no'}`)
      lines.push('')
      lines.push('CODE AROUND CURSOR:')
      lines.push(surroundingCode)
      lines.push('')
      if (af.selectionText) {
        lines.push('SELECTED CODE:')
        lines.push(af.selectionText)
        lines.push('')
      }
    } else {
      lines.push('ACTIVE FILE: none open')
      lines.push('')
    }

    if (gitDiff) {
      lines.push('ACTIVE FILE DIFF (uncommitted):')
      lines.push(gitDiff)
      lines.push('')
    }

    if (snapshot.diagnostics.length > 0) {
      lines.push(`ERRORS AND WARNINGS (${snapshot.diagnostics.length}):`)
      for (const d of snapshot.diagnostics) {
        const source = d.source ? `[${d.source}] ` : ''
        lines.push(`- ${d.severity} ${source}${d.message} (${d.file}:${d.line})`)
      }
      lines.push('')
    }

    if (snapshot.openFiles.length > 0) {
      lines.push(`OPEN FILES (${snapshot.openFiles.length}):`)
      for (const f of snapshot.openFiles) {
        lines.push(`- ${f.path}${f.isDirty ? ' (unsaved)' : ''}`)
      }
      lines.push('')
    }

    return lines.join('\n').trimEnd()
  }

  let prompt = compose()

  // Token guard: truncate the two heaviest fields and rebuild once.
  if (estimateTokens(prompt) > TOKEN_ESTIMATE_LIMIT) {
    surroundingCode = firstLines(surroundingCode, 30)
    gitDiff = firstLines(gitDiff, 40)
    prompt = compose()
  }

  return prompt
}

function parseThreeSentences(text: string): [string, string, string] {
  const parts = text
    .split('\n')
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length > 0)

  const first = parts[0] ?? text.trim()
  const second = parts[1] ?? ''
  const third = parts[2] ?? ''
  return [first, second, third]
}

function firstLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : lines.slice(0, max).join('\n')
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return 'a moment'
  }
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 1) {
    return 'less than a minute'
  }
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${hours}h ${minutes}m`
}
