// Sylo — context snapshot engine.
//
// Captures the developer's full working context. This is the shared data layer
// used by both the human re-entry brief generator and the agent context file
// generator. It reads only editor metadata, cursor position, git diff, and
// diagnostics — nothing is ever sent anywhere from here.

import * as vscode from 'vscode'
import { exec } from 'child_process'
import * as path from 'path'

export interface ContextSnapshot {
  timestamp: number
  workspaceName: string
  workspaceRoot: string
  openFiles: OpenFileSnapshot[]
  activeFile: ActiveFileSnapshot | null
  gitDiff: string | null
  gitDiffFull: string | null // full diff, only populated when includeFullDiff=true
  gitDiffStat: string | null // summary of changed files
  gitBranch: string | null
  recentCommitMessage: string | null
  recentCommits: string[] // last 5 commit messages
  terminalOutput: string | null
  diagnostics: DiagnosticSnapshot[]
  awayDurationMs: number
  existingAgentContext: string | null // current contents of SYLO_CONTEXT.md if it exists
}

export interface OpenFileSnapshot {
  path: string // relative to workspace root
  languageId: string
  isDirty: boolean
}

export interface ActiveFileSnapshot {
  path: string
  languageId: string
  cursorLine: number
  cursorColumn: number
  surroundingCode: string
  selectionText: string | null
  isDirty: boolean
  fullContent: string | null // full file content for small files (<200 lines)
}

export interface DiagnosticSnapshot {
  file: string
  severity: 'error' | 'warning'
  message: string
  line: number
  source: string | null // e.g. "eslint", "typescript"
}

const GIT_TIMEOUT_MS = 5000
const SMALL_FILE_LINE_LIMIT = 200
const ACTIVE_DIFF_MAX_LINES = 100
const FULL_DIFF_MAX_LINES = 300
const MAX_DIAGNOSTICS = 15

/**
 * Capture a complete snapshot of the current workspace state.
 *
 * Never throws for missing git / no workspace — degrades gracefully to null
 * fields so the brief and agent-context generators can still run.
 */
export async function captureSnapshot(
  _context: vscode.ExtensionContext,
  awayDurationMs: number
): Promise<ContextSnapshot> {
  const config = vscode.workspace.getConfiguration('sylo')
  const maxContextLines = config.get<number>('maxContextLines') ?? 50
  const includeFullDiff = config.get<boolean>('includeFullDiff') ?? false
  const agentContextPath = config.get<string>('agentContextPath') || 'SYLO_CONTEXT.md'

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? ''
  const workspaceName = workspaceFolder?.name ?? vscode.workspace.name ?? 'workspace'

  const activeFile = await captureActiveFile(workspaceRoot, maxContextLines)
  const openFiles = captureOpenFiles(workspaceRoot)
  const diagnostics = captureDiagnostics(workspaceRoot)

  const git = await captureGit(workspaceRoot, activeFile?.path ?? null, includeFullDiff)
  const existingAgentContext = await readExistingAgentContext(workspaceFolder, agentContextPath)

  return {
    timestamp: Date.now(),
    workspaceName,
    workspaceRoot,
    openFiles,
    activeFile,
    gitDiff: git.gitDiff,
    gitDiffFull: git.gitDiffFull,
    gitDiffStat: git.gitDiffStat,
    gitBranch: git.gitBranch,
    recentCommitMessage: git.recentCommitMessage,
    recentCommits: git.recentCommits,
    terminalOutput: null,
    diagnostics,
    awayDurationMs,
    existingAgentContext
  }
}

/** Path of `uri` relative to the workspace root, using forward slashes. */
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

async function captureActiveFile(
  workspaceRoot: string,
  maxContextLines: number
): Promise<ActiveFileSnapshot | null> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return null
  }

  const doc = editor.document
  if (doc.uri.scheme !== 'file') {
    return null
  }

  const cursor = editor.selection.active
  const cursorLine = cursor.line
  const cursorColumn = cursor.character

  // maxContextLines of code centered on the cursor.
  const half = Math.floor(maxContextLines / 2)
  const startLine = Math.max(0, cursorLine - half)
  const endLine = Math.min(doc.lineCount - 1, cursorLine + half)
  const surroundingRange = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)
  const surroundingCode = doc.getText(surroundingRange)

  const selectionText = editor.selection.isEmpty ? null : doc.getText(editor.selection)

  const fullContent = doc.lineCount < SMALL_FILE_LINE_LIMIT ? doc.getText() : null

  return {
    path: toRelative(workspaceRoot, doc.uri),
    languageId: doc.languageId,
    cursorLine,
    cursorColumn,
    surroundingCode,
    selectionText,
    isDirty: doc.isDirty,
    fullContent
  }
}

function captureOpenFiles(workspaceRoot: string): OpenFileSnapshot[] {
  const files: OpenFileSnapshot[] = []
  const seen = new Set<string>()

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (!(input instanceof vscode.TabInputText)) {
        continue
      }
      if (input.uri.scheme !== 'file') {
        continue
      }
      const rel = toRelative(workspaceRoot, input.uri)
      if (seen.has(rel)) {
        continue
      }
      seen.add(rel)

      // Language + dirty state come from the open document if VS Code has it loaded.
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === input.uri.toString())
      files.push({
        path: rel,
        languageId: doc?.languageId ?? languageIdFromPath(rel),
        isDirty: doc?.isDirty ?? tab.isDirty
      })
    }
  }

  return files
}

function languageIdFromPath(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase()
  return ext || 'plaintext'
}

function captureDiagnostics(workspaceRoot: string): DiagnosticSnapshot[] {
  const all = vscode.languages.getDiagnostics()
  const collected: DiagnosticSnapshot[] = []

  for (const [uri, diags] of all) {
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

  // Errors before warnings, then limit to the most severe 15.
  collected.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  return collected.slice(0, MAX_DIAGNOSTICS)
}

function severityRank(severity: 'error' | 'warning'): number {
  return severity === 'error' ? 0 : 1
}

interface GitInfo {
  gitDiff: string | null
  gitDiffFull: string | null
  gitDiffStat: string | null
  gitBranch: string | null
  recentCommitMessage: string | null
  recentCommits: string[]
}

async function captureGit(
  workspaceRoot: string,
  activeFileRel: string | null,
  includeFullDiff: boolean
): Promise<GitInfo> {
  const empty: GitInfo = {
    gitDiff: null,
    gitDiffFull: null,
    gitDiffStat: null,
    gitBranch: null,
    recentCommitMessage: null,
    recentCommits: []
  }

  if (!workspaceRoot) {
    return empty
  }

  const gitDiffStat = await runGit(workspaceRoot, ['diff', 'HEAD', '--stat'])

  let gitDiff: string | null = null
  if (activeFileRel) {
    const raw = await runGit(workspaceRoot, ['diff', 'HEAD', '--', activeFileRel])
    gitDiff = truncateLines(raw, ACTIVE_DIFF_MAX_LINES)
  }

  let gitDiffFull: string | null = null
  if (includeFullDiff) {
    const raw = await runGit(workspaceRoot, ['diff', 'HEAD'])
    gitDiffFull = truncateLines(raw, FULL_DIFF_MAX_LINES)
  }

  const gitBranch = await runGit(workspaceRoot, ['branch', '--show-current'])
  const recentCommitMessage = await runGit(workspaceRoot, ['log', '-1', '--pretty=%s'])
  const recentCommitsRaw = await runGit(workspaceRoot, ['log', '-5', '--pretty=%s'])

  const recentCommits = recentCommitsRaw
    ? recentCommitsRaw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    : []

  return {
    gitDiff: emptyToNull(gitDiff),
    gitDiffFull: emptyToNull(gitDiffFull),
    gitDiffStat: emptyToNull(gitDiffStat),
    gitBranch: emptyToNull(gitBranch),
    recentCommitMessage: emptyToNull(recentCommitMessage),
    recentCommits
  }
}

/**
 * Run a git command in the workspace root with a hard 5-second timeout.
 * Returns the trimmed stdout, or null if git is unavailable / errors / times out.
 * Never throws.
 */
function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // Build a shell-safe command. Arguments are quoted to survive spaces/special chars.
    const command = ['git', ...args.map(shellQuote)].join(' ')
    exec(
      command,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        resolve(stdout.trimEnd())
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
  const kept = lines.slice(0, maxLines).join('\n')
  const omitted = lines.length - maxLines
  return `${kept}\n… (${omitted} more line${omitted === 1 ? '' : 's'} truncated)`
}

function emptyToNull(value: string | null): string | null {
  if (value === null) {
    return null
  }
  return value.trim().length === 0 ? null : value
}

async function readExistingAgentContext(
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  agentContextPath: string
): Promise<string | null> {
  if (!workspaceFolder) {
    return null
  }
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, agentContextPath)
  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return null
  }
}
