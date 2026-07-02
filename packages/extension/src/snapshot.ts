// Sylo — context snapshot engine.
//
// Captures the developer's working context, entirely locally. Before the
// snapshot leaves the extension (to the Sylo API), all code-bearing text
// fields are passed through redactSecrets() so lines that look like secret
// assignments never leave the machine.

import * as vscode from 'vscode'
import { exec } from 'child_process'
import * as path from 'path'

export interface ContextSnapshot {
  capturedAt: number
  workspaceName: string
  workspaceRoot: string

  activeFile: ActiveFileSnapshot | null
  openFiles: OpenFileSnapshot[]

  git: {
    branch: string | null
    lastCommitMessage: string | null
    lastFiveCommits: string[]
    activeDiff: string | null // diff of active file only, max 100 lines
    diffStat: string | null // git diff HEAD --stat
  }

  diagnostics: DiagnosticSnapshot[]

  existingContextFile: string | null
}

export interface ActiveFileSnapshot {
  relativePath: string
  languageId: string
  cursorLine: number
  cursorColumn: number
  surroundingCode: string // 60 lines around cursor, 30 above / 30 below
  fullContent: string | null // full file content if under 200 lines
  selectionText: string | null
  isDirty: boolean
}

export interface OpenFileSnapshot {
  relativePath: string
  languageId: string
  isDirty: boolean
}

export interface DiagnosticSnapshot {
  file: string
  severity: 'error' | 'warning'
  message: string
  line: number
  source: string | null
}

const GIT_TIMEOUT_MS = 5000
const SURROUNDING_LINES_EACH_SIDE = 30
const SMALL_FILE_LINE_LIMIT = 200
const ACTIVE_DIFF_MAX_LINES = 100
const MAX_DIAGNOSTICS = 15

export interface CaptureResult {
  snapshot: ContextSnapshot
  redactedLineCount: number
}

/**
 * Capture a snapshot of the current workspace state, with secrets redacted.
 * Never throws — degrades to null fields when git / editor state is missing.
 */
export async function captureSnapshot(): Promise<CaptureResult> {
  const config = vscode.workspace.getConfiguration('sylo')
  const agentContextPath = config.get<string>('agentContextPath') || 'SYLO_CONTEXT.md'

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? ''
  const workspaceName = workspaceFolder?.name ?? vscode.workspace.name ?? 'workspace'

  const activeFile = captureActiveFile(workspaceRoot)
  const openFiles = captureOpenFiles(workspaceRoot)
  const diagnostics = captureDiagnostics(workspaceRoot)
  const git = await captureGit(workspaceRoot, activeFile?.relativePath ?? null)
  const existingContextFile = await readExistingContextFile(workspaceFolder, agentContextPath)

  const redaction = new RedactionCounter()

  const snapshot: ContextSnapshot = {
    capturedAt: Date.now(),
    workspaceName,
    workspaceRoot,
    activeFile: activeFile
      ? {
          ...activeFile,
          surroundingCode: redaction.redact(activeFile.surroundingCode),
          fullContent: activeFile.fullContent === null ? null : redaction.redact(activeFile.fullContent),
          selectionText:
            activeFile.selectionText === null ? null : redaction.redact(activeFile.selectionText)
        }
      : null,
    openFiles,
    git: {
      ...git,
      activeDiff: git.activeDiff === null ? null : redaction.redact(git.activeDiff)
    },
    diagnostics,
    existingContextFile: existingContextFile === null ? null : redaction.redact(existingContextFile)
  }

  return { snapshot, redactedLineCount: redaction.count }
}

// ---- Secret redaction ----

const SECRET_LINE_PATTERN = /\b(API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|ACCESS_KEY)\s*[=:]/i

/**
 * Replace any line that looks like a secret assignment with a placeholder.
 * Runs client-side, before the snapshot leaves the extension.
 */
export function redactSecrets(text: string): string {
  return text
    .split('\n')
    .map((line) => (SECRET_LINE_PATTERN.test(line) ? '[redacted by Sylo]' : line))
    .join('\n')
}

/** redactSecrets + a running count of redacted lines for output-channel logging. */
class RedactionCounter {
  count = 0

  redact(text: string): string {
    return text
      .split('\n')
      .map((line) => {
        if (SECRET_LINE_PATTERN.test(line)) {
          this.count++
          return '[redacted by Sylo]'
        }
        return line
      })
      .join('\n')
  }
}

// ---- Capture helpers ----

function toRelative(workspaceRoot: string, uri: vscode.Uri): string {
  if (uri.scheme !== 'file') {
    return uri.toString()
  }
  if (!workspaceRoot) {
    return uri.fsPath
  }
  const rel = path.relative(workspaceRoot, uri.fsPath)
  return rel.split(path.sep).join('/')
}

function captureActiveFile(workspaceRoot: string): ActiveFileSnapshot | null {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== 'file') {
    return null
  }

  const doc = editor.document
  const cursor = editor.selection.active

  const startLine = Math.max(0, cursor.line - SURROUNDING_LINES_EACH_SIDE)
  const endLine = Math.min(doc.lineCount - 1, cursor.line + SURROUNDING_LINES_EACH_SIDE)
  const surroundingRange = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)

  return {
    relativePath: toRelative(workspaceRoot, doc.uri),
    languageId: doc.languageId,
    cursorLine: cursor.line + 1, // 1-based for humans and agents
    cursorColumn: cursor.character + 1,
    surroundingCode: doc.getText(surroundingRange),
    fullContent: doc.lineCount < SMALL_FILE_LINE_LIMIT ? doc.getText() : null,
    selectionText: editor.selection.isEmpty ? null : doc.getText(editor.selection),
    isDirty: doc.isDirty
  }
}

function captureOpenFiles(workspaceRoot: string): OpenFileSnapshot[] {
  const files: OpenFileSnapshot[] = []
  const seen = new Set<string>()

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== 'file') {
        continue
      }
      const rel = toRelative(workspaceRoot, input.uri)
      if (seen.has(rel)) {
        continue
      }
      seen.add(rel)

      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === input.uri.toString())
      files.push({
        relativePath: rel,
        languageId: doc?.languageId ?? path.extname(rel).replace('.', '') || 'plaintext',
        isDirty: doc?.isDirty ?? tab.isDirty
      })
    }
  }

  return files
}

function captureDiagnostics(workspaceRoot: string): DiagnosticSnapshot[] {
  const collected: DiagnosticSnapshot[] = []

  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') {
      continue
    }
    const rel = toRelative(workspaceRoot, uri)
    for (const d of diags) {
      if (
        d.severity !== vscode.DiagnosticSeverity.Error &&
        d.severity !== vscode.DiagnosticSeverity.Warning
      ) {
        continue
      }
      collected.push({
        file: rel,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        message: d.message,
        line: d.range.start.line + 1,
        source: d.source ?? null
      })
    }
  }

  // Errors first, then cap at the 15 most severe.
  collected.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return collected.slice(0, MAX_DIAGNOSTICS)
}

async function captureGit(
  workspaceRoot: string,
  activeFileRel: string | null
): Promise<ContextSnapshot['git']> {
  const empty: ContextSnapshot['git'] = {
    branch: null,
    lastCommitMessage: null,
    lastFiveCommits: [],
    activeDiff: null,
    diffStat: null
  }

  if (!workspaceRoot) {
    return empty
  }

  const [diffStat, branch, lastCommitMessage, lastFiveRaw] = await Promise.all([
    runGit(workspaceRoot, ['diff', 'HEAD', '--stat']),
    runGit(workspaceRoot, ['branch', '--show-current']),
    runGit(workspaceRoot, ['log', '-1', '--pretty=%s']),
    runGit(workspaceRoot, ['log', '-5', '--pretty=%s'])
  ])

  let activeDiff: string | null = null
  if (activeFileRel) {
    const raw = await runGit(workspaceRoot, ['diff', 'HEAD', '--', activeFileRel])
    activeDiff = truncateLines(raw, ACTIVE_DIFF_MAX_LINES)
  }

  return {
    branch: emptyToNull(branch),
    lastCommitMessage: emptyToNull(lastCommitMessage),
    lastFiveCommits: lastFiveRaw
      ? lastFiveRaw
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      : [],
    activeDiff: emptyToNull(activeDiff),
    diffStat: emptyToNull(diffStat)
  }
}

/** Run a git command with a hard 5s timeout. Returns null on any failure. */
function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const command = ['git', ...args.map(shellQuote)].join(' ')
    exec(
      command,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        resolve(err ? null : stdout.trimEnd())
      }
    )
  })
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./=-]+$/.test(arg)) {
    return arg
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function truncateLines(text: string | null, maxLines: number): string | null {
  if (!text) {
    return text
  }
  const lines = text.split('\n')
  if (lines.length <= maxLines) {
    return text
  }
  return lines.slice(0, maxLines).join('\n')
}

function emptyToNull(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value
}

async function readExistingContextFile(
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  agentContextPath: string
): Promise<string | null> {
  if (!workspaceFolder) {
    return null
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(workspaceFolder.uri, agentContextPath)
    )
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return null
  }
}
