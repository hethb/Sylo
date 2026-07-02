// Sylo API — wire types.
//
// This is the snapshot shape the VS Code extension sends. Keep in sync with
// packages/extension/src/snapshot.ts (deliberately duplicated so each package
// stands alone).

export interface ContextSnapshot {
  capturedAt: number
  workspaceName: string
  workspaceRoot: string

  activeFile: {
    relativePath: string
    languageId: string
    cursorLine: number
    cursorColumn: number
    surroundingCode: string // 60 lines around cursor, 30 above / 30 below
    fullContent: string | null // full file content if under 200 lines
    selectionText: string | null
    isDirty: boolean
  } | null

  openFiles: Array<{
    relativePath: string
    languageId: string
    isDirty: boolean
  }>

  git: {
    branch: string | null
    lastCommitMessage: string | null
    lastFiveCommits: string[]
    activeDiff: string | null // diff of active file only, max 100 lines
    diffStat: string | null // git diff HEAD --stat
  }

  diagnostics: Array<{
    file: string
    severity: 'error' | 'warning'
    message: string
    line: number
    source: string | null
  }>

  existingContextFile: string | null
}

/** Minimal structural check — enough to reject junk without being brittle. */
export function isValidSnapshot(value: unknown): value is ContextSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const s = value as Record<string, unknown>
  return (
    typeof s.workspaceName === 'string' &&
    s.workspaceName.length > 0 &&
    Array.isArray(s.openFiles) &&
    Array.isArray(s.diagnostics) &&
    typeof s.git === 'object' &&
    s.git !== null
  )
}
