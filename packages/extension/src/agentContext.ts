// Sylo — context file persistence.
//
// The LLM call now lives on the Sylo API server; this module handles the local
// side: writing the context file, copying to clipboard, and .gitignore hygiene.

import * as vscode from 'vscode'

export interface WrittenContextFile {
  content: string
  filePath: string // relative to workspace root
  tokenEstimate: number
  generatedAt: number
}

/**
 * Write the generated context file to the configured path, copy it to the
 * clipboard, and make sure it's gitignored (unless the path is CLAUDE.md).
 */
export async function writeContextFile(
  content: string,
  tokenEstimate: number,
  generatedAt: number
): Promise<WrittenContextFile> {
  const config = vscode.workspace.getConfiguration('sylo')
  const agentContextPath = config.get<string>('agentContextPath') || 'SYLO_CONTEXT.md'

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  if (!workspaceFolder) {
    throw new Error('No workspace open')
  }

  const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, agentContextPath)
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'))

  await vscode.env.clipboard.writeText(content)

  await ensureGitignored(workspaceFolder, agentContextPath)

  return { content, filePath: agentContextPath, tokenEstimate, generatedAt }
}

/**
 * Append the context file path to .gitignore if it isn't already listed.
 * Exception: CLAUDE.md — choosing that path means the developer wants the file
 * committed, so leave .gitignore alone.
 */
export async function ensureGitignored(
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
    current = Buffer.from(await vscode.workspace.fs.readFile(gitignoreUri)).toString('utf8')
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
  await vscode.workspace.fs.writeFile(
    gitignoreUri,
    Buffer.from(`${current}${needsNewline ? '\n' : ''}${entry}\n`, 'utf8')
  )
}
