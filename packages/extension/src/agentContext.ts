// Sylo — agent context file generator.
//
// The core feature. Turns a ContextSnapshot into a structured markdown handoff
// file (SYLO_CONTEXT.md) that an AI coding agent can read to understand the
// current task with zero manual explanation. Handles per-target formatting,
// writing the file, clipboard, and .gitignore hygiene.

import * as vscode from 'vscode'
import { chat, Provider } from './llm'
import { ContextSnapshot } from './snapshot'

export type AgentTarget = 'claude-code' | 'cursor' | 'copilot' | 'generic'

export interface AgentContextFile {
  content: string // the full markdown content
  path: string // where it was written (relative to workspace root; '(clipboard only)' when not written)
  generatedAt: number
  snapshotTimestamp: number
  tokenEstimate: number
}

const SYSTEM_PROMPT = `You are generating a context handoff file for an AI coding agent. A developer is about to start a new agent session and needs the agent to immediately understand their current task without any manual explanation.

Generate a structured markdown file that the developer will paste or feed directly to the agent. The file must be:
- Precise: reference exact file names, line numbers, function names, variable names, and error messages from the snapshot
- Actionable: the agent should be able to start working immediately after reading this, with no clarifying questions needed
- Concise: under 400 words. Agents have limited context windows. Every word must earn its place.
- Complete: cover what's being worked on, what's already been tried, what's broken, and what to do next

Do not include any preamble. Output only the markdown content. No code fences around the entire output.`

const CHARS_PER_TOKEN = 4
const LONG_FILE_TOKEN_WARNING = 1500
const ACTIVE_DIFF_PROMPT_LINES = 80
const EXISTING_CONTEXT_PROMPT_LINES = 20

export interface GenerateResult {
  file: AgentContextFile
  warning: string | null
  wroteFile: boolean
  copiedToClipboard: boolean
}

/**
 * Generate the agent context markdown (LLM call only). Side-effect-free — does
 * not write files or touch the clipboard. Use `writeAgentContext` to persist.
 */
export async function generateAgentContext(
  snapshot: ContextSnapshot,
  apiKey: string,
  provider: Provider,
  model: string,
  target: AgentTarget
): Promise<AgentContextFile> {
  const userPrompt = buildUserPrompt(snapshot, target)

  let content = await chat({
    provider,
    apiKey,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1200,
    temperature: 0.2
  })

  content = stripOuterCodeFence(content)
  content = applyTargetPostProcessing(content, target)

  return {
    content,
    path: '',
    generatedAt: Date.now(),
    snapshotTimestamp: snapshot.timestamp,
    tokenEstimate: estimateTokens(content)
  }
}

/**
 * Persist a generated context file per the `sylo.agentContextMode` setting:
 * write to disk, copy to clipboard, or both. Also manages .gitignore.
 * Returns the (path-populated) file plus what actually happened.
 */
export async function writeAgentContext(file: AgentContextFile): Promise<GenerateResult> {
  const config = vscode.workspace.getConfiguration('sylo')
  const mode = config.get<'file' | 'clipboard' | 'both'>('agentContextMode') ?? 'both'
  const agentContextPath = config.get<string>('agentContextPath') || 'SYLO_CONTEXT.md'

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]

  let wroteFile = false
  let copiedToClipboard = false
  let resolvedPath = '(clipboard only)'

  if ((mode === 'file' || mode === 'both') && workspaceFolder) {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, agentContextPath)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'))
    resolvedPath = agentContextPath
    wroteFile = true
    await ensureGitignored(workspaceFolder, agentContextPath)
  }

  if (mode === 'clipboard' || mode === 'both') {
    await vscode.env.clipboard.writeText(file.content)
    copiedToClipboard = true
  }

  const populated: AgentContextFile = { ...file, path: resolvedPath }

  const warning =
    file.tokenEstimate > LONG_FILE_TOKEN_WARNING
      ? `Context file is long (${file.tokenEstimate} tokens). Consider enabling the 'copilot' target format for shorter output.`
      : null

  return { file: populated, warning, wroteFile, copiedToClipboard }
}

function buildUserPrompt(snapshot: ContextSnapshot, target: AgentTarget): string {
  const lines: string[] = []
  lines.push('Generate an agent context handoff file from this workspace snapshot.')
  lines.push('')
  lines.push('TASK CONTEXT')
  lines.push(`Branch: ${snapshot.gitBranch ?? 'unknown'}`)
  lines.push(`Last commit: ${snapshot.recentCommitMessage ?? 'none'}`)
  lines.push('Recent commits:')
  if (snapshot.recentCommits.length > 0) {
    for (const c of snapshot.recentCommits) {
      lines.push(`- ${c}`)
    }
  } else {
    lines.push('- (none)')
  }
  lines.push('')

  const af = snapshot.activeFile
  if (af) {
    lines.push(`ACTIVE FILE: ${af.path} (line ${af.cursorLine + 1})`)
    lines.push(`Language: ${af.languageId}`)
    lines.push(`Unsaved changes: ${af.isDirty ? 'yes' : 'no'}`)
    lines.push('')

    if (af.fullContent !== null) {
      lines.push('FULL FILE CONTENT:')
      lines.push(af.fullContent)
    } else {
      const lineCount = af.surroundingCode.split('\n').length
      lines.push(`CURSOR CONTEXT (${lineCount} lines around cursor):`)
      lines.push(af.surroundingCode)
    }
    lines.push('')

    if (af.selectionText) {
      lines.push('SELECTED/HIGHLIGHTED CODE:')
      lines.push(af.selectionText)
      lines.push('')
    }
  } else {
    lines.push('ACTIVE FILE: none open')
    lines.push('')
  }

  lines.push('GIT CHANGES (summary):')
  lines.push(snapshot.gitDiffStat ?? 'no uncommitted changes')
  lines.push('')

  lines.push('ACTIVE FILE DIFF:')
  lines.push(
    snapshot.gitDiff ? firstLines(snapshot.gitDiff, ACTIVE_DIFF_PROMPT_LINES) : 'no changes to active file'
  )
  lines.push('')

  if (snapshot.gitDiffFull) {
    lines.push('FULL DIFF:')
    lines.push(snapshot.gitDiffFull)
    lines.push('')
  }

  lines.push(`OPEN FILES (${snapshot.openFiles.length}):`)
  for (const f of snapshot.openFiles) {
    lines.push(f.path)
  }
  lines.push('')

  lines.push(`ERRORS AND WARNINGS (${snapshot.diagnostics.length}):`)
  for (const d of snapshot.diagnostics) {
    const source = d.source ?? 'unknown'
    lines.push(`${d.severity} [${source}]: ${d.message} in ${d.file}:${d.line}`)
  }
  lines.push('')

  if (snapshot.existingAgentContext) {
    lines.push('PREVIOUS CONTEXT FILE (for reference):')
    lines.push(firstLines(snapshot.existingAgentContext, EXISTING_CONTEXT_PROMPT_LINES))
    lines.push('')
  }

  lines.push(`Target agent: ${target}`)
  lines.push('')
  lines.push(targetInstruction(snapshot, target))

  return lines.join('\n').trimEnd()
}

/**
 * Per-target formatting guidance appended to the user prompt so the model
 * shapes the output correctly. Structural guarantees are enforced again in
 * post-processing.
 */
function targetInstruction(snapshot: ContextSnapshot, target: AgentTarget): string {
  const singleOpenFile = snapshot.openFiles.length <= 1
  const workspaceName = snapshot.workspaceName
  const timestamp = new Date(snapshot.timestamp).toISOString()
  const branch = snapshot.gitBranch ?? 'unknown'

  const baseStructure = `Use this exact section structure, populated with specific details from the snapshot:

# Sylo Context — ${workspaceName}
> Generated ${timestamp} · Branch: ${branch}

## What's being worked on
[1-2 sentences: the specific task, naming the file and function/component]

## Current state
[Bullet list: what's working, what's broken, what's been tried]

## Key files
[List of the most relevant open files with one-line descriptions of their role]

## Errors to address
[List of current errors/warnings from diagnostics, each with file:line and message]

## Uncommitted changes
[Summary of what's been changed since last commit, from the git summary]

## Next action
[Single specific instruction for the agent: "Your first task is to..."]

## Do not touch
[Files or areas the agent should leave alone — inferred from open files that aren't the active file]`

  switch (target) {
    case 'claude-code':
      return `${baseStructure}

TARGET-SPECIFIC RULES (claude-code):
- Add a "## CLAUDE.md note" section at the very top (above the # heading is not allowed, so make it the first section after the title block) containing exactly: "This file was auto-generated by Sylo. You can ask Sylo to update it at any time by running \`sylo.generateAgentContext\`."
- Format the "Next action" as a direct imperative.
${singleOpenFile ? '- Omit the "Do not touch" section (there is only one open file).' : ''}`

    case 'cursor':
      return `${baseStructure}

TARGET-SPECIFIC RULES (cursor):
- Make line 1 exactly: <!-- @cursor-context -->
- Format errors in the "Errors to address" section as inline "TODO:" comments.
- Make the "Next action" section a numbered task list instead of prose.`

    case 'copilot':
      return `Keep the file SHORT — 200 words maximum. Copilot's chat context window is small.
Prioritize these two sections and drop the rest:

# Sylo Context — ${workspaceName}
> Branch: ${branch}

## What's being worked on
[1-2 sentences, naming the file and function]

## Next action
[Single specific instruction for the agent]

Do NOT include a "Do not touch" section.`

    case 'generic':
    default:
      return baseStructure
  }
}

/**
 * Deterministic structural guarantees, enforced regardless of what the model
 * returned, so downstream consumers can rely on them.
 */
function applyTargetPostProcessing(content: string, target: AgentTarget): string {
  let out = content.trim()

  if (target === 'cursor') {
    const header = '<!-- @cursor-context -->'
    if (!out.startsWith(header)) {
      out = `${header}\n${out}`
    }
  }

  return out
}

function stripOuterCodeFence(text: string): string {
  const trimmed = text.trim()
  // Only strip a fence that wraps the ENTIRE output (```...``` or ```markdown...```).
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  if (fenceMatch) {
    return fenceMatch[1].trim()
  }
  return trimmed
}

/**
 * Ensure the context file path is ignored by git — agent context files are
 * ephemeral. Exception: if the path is CLAUDE.md the developer has deliberately
 * chosen to commit it, so leave .gitignore alone.
 */
async function ensureGitignored(
  workspaceFolder: vscode.WorkspaceFolder,
  agentContextPath: string
): Promise<void> {
  if (agentContextPath.trim().toUpperCase() === 'CLAUDE.MD') {
    return
  }

  const gitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore')
  const entry = agentContextPath.trim()

  let current = ''
  try {
    const bytes = await vscode.workspace.fs.readFile(gitignoreUri)
    current = Buffer.from(bytes).toString('utf8')
  } catch {
    current = ''
  }

  const alreadyListed = current
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === entry || l === `/${entry}`)

  if (alreadyListed) {
    return
  }

  const needsNewline = current.length > 0 && !current.endsWith('\n')
  const addition = `${needsNewline ? '\n' : ''}${entry}\n`
  await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(current + addition, 'utf8'))
}

function firstLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : lines.slice(0, max).join('\n')
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}
