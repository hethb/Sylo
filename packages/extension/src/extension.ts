// Sylo — extension entry point.
//
// Zero-friction: no API key, no configuration gate. All LLM calls go through
// the hosted Sylo API (or a self-hosted instance via sylo.apiBaseUrl).

import * as vscode from 'vscode'
import { captureSnapshot } from './snapshot'
import { FocusWatcher } from './focusWatcher'
import { SyloApiClient, SyloRateLimitError } from './apiClient'
import { writeContextFile } from './agentContext'
import { SnapshotHistory } from './history'
import { SyloPanel } from './panel'

const DEFAULT_API_BASE_URL = 'https://api.sylo.dev'

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Sylo')
  const history = new SnapshotHistory(context)
  const panel = new SyloPanel(context, history)

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider('sylo.panel', panel)
  )

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.text = '$(robot) Sylo'
  statusBar.tooltip = 'Generate agent context file (Cmd+Shift+Alt+S)'
  statusBar.command = 'sylo.generateAgentContext'
  statusBar.show()
  context.subscriptions.push(statusBar)

  function resetStatusBar(): void {
    statusBar.text = '$(robot) Sylo'
    statusBar.tooltip = 'Generate agent context file (Cmd+Shift+Alt+S)'
  }

  function getClient(): SyloApiClient {
    const baseUrl =
      vscode.workspace.getConfiguration('sylo').get<string>('apiBaseUrl') || DEFAULT_API_BASE_URL
    return new SyloApiClient(baseUrl)
  }

  // ---- First-run welcome: one notification, zero input required ----

  if (!context.globalState.get<boolean>('hasSeenWelcome')) {
    void context.globalState.update('hasSeenWelcome', true)
    void vscode.window.showInformationMessage(
      'Welcome to Sylo — no setup required. Press Cmd+Shift+Alt+S at any time to generate a context file for your agent.'
    )
  }

  // ---- Core command: generate agent context (no setup gate) ----

  let generating = false

  context.subscriptions.push(
    vscode.commands.registerCommand('sylo.generateAgentContext', async () => {
      if (generating) {
        return
      }
      generating = true
      statusBar.text = '$(loading~spin) Generating context…'
      panel.setAgentState('generating')

      try {
        if (!vscode.workspace.workspaceFolders?.length) {
          throw new Error('No workspace open. Open a folder first, then press Cmd+Shift+Alt+S.')
        }

        const { snapshot, redactedLineCount } = await captureSnapshot()
        if (redactedLineCount > 0) {
          output.appendLine(`Redacted ${redactedLineCount} secret-looking line(s) before sending.`)
        }

        const result = await getClient().generateContext(snapshot)
        const written = await writeContextFile(result.content, result.tokenEstimate, result.generatedAt)

        history.addAgentContext(written)
        panel.setAgentState('ready', { agentContext: written })
        statusBar.text = `$(file-code) Context ready · ${written.tokenEstimate} tokens`
        output.appendLine(`Context written to ${written.filePath} (${written.tokenEstimate} tokens)`)

        void vscode.window
          .showInformationMessage(
            `Sylo: Context file ready (${written.tokenEstimate} tokens) — copied to clipboard.`,
            'Open file'
          )
          .then((sel) => {
            if (sel === 'Open file') {
              void vscode.commands.executeCommand('sylo.openContextFile')
            }
          })
      } catch (err) {
        const msg =
          err instanceof SyloRateLimitError
            ? `Too many requests. Please wait ${Math.ceil(err.retryAfterMs / 1000)} seconds.`
            : err instanceof Error
              ? err.message
              : 'Something went wrong. Please try again.'

        output.appendLine(`Error: ${msg}`)
        statusBar.text = '$(warning) Sylo: try again'
        panel.setAgentState('error', { message: msg })
        void vscode.window.showErrorMessage(`Sylo: ${msg}`)
      } finally {
        generating = false
        setTimeout(resetStatusBar, 15000)
      }
    }),

    // ---- Open context file ----

    vscode.commands.registerCommand('sylo.openContextFile', async () => {
      const agentContextPath =
        vscode.workspace.getConfiguration('sylo').get<string>('agentContextPath') || 'SYLO_CONTEXT.md'
      const folders = vscode.workspace.workspaceFolders
      if (!folders) {
        return
      }
      const uri = vscode.Uri.joinPath(folders[0].uri, agentContextPath)
      try {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri))
      } catch {
        void vscode.window.showErrorMessage(
          'Sylo: No context file found. Press Cmd+Shift+Alt+S to generate one.'
        )
      }
    }),

    // ---- Show brief ----

    vscode.commands.registerCommand('sylo.showBrief', () => {
      const latest = history.getLatestBrief()
      if (latest?.brief) {
        panel.setBriefState('ready', { brief: latest.brief })
        void vscode.commands.executeCommand('sylo.panel.focus')
      } else {
        void vscode.window.showInformationMessage(
          'No brief yet. Leave VS Code for a few minutes and come back.'
        )
      }
    }),

    // ---- Clear history ----

    vscode.commands.registerCommand('sylo.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage('Clear all Sylo history?', 'Clear', 'Cancel')
      if (confirm === 'Clear') {
        history.clear()
        panel.setBriefState('waiting')
        panel.setAgentState('idle')
        resetStatusBar()
      }
    })
  )

  // ---- Focus watcher: re-entry brief on return, also zero friction ----

  const watcher = new FocusWatcher(async (snapshot, awayDurationMs) => {
    panel.setBriefState('generating', { awayDuration: awayDurationMs })
    try {
      const brief = await getClient().generateBrief(snapshot, awayDurationMs)
      history.addBrief(brief, snapshot)
      panel.setBriefState('ready', { brief })

      if (vscode.workspace.getConfiguration('sylo').get<boolean>('autoShow')) {
        void vscode.window
          .showInformationMessage(
            `Sylo: Back after ${brief.awayDurationFormatted}.`,
            'Show brief',
            'Generate agent context'
          )
          .then((sel) => {
            if (sel === 'Show brief') {
              void vscode.commands.executeCommand('sylo.panel.focus')
            }
            if (sel === 'Generate agent context') {
              void vscode.commands.executeCommand('sylo.generateAgentContext')
            }
          })
      }
    } catch (err) {
      output.appendLine(`Brief error: ${err instanceof Error ? err.message : String(err)}`)
      panel.setBriefState('error', { message: 'Could not generate brief. Will try again next time.' })
    }
  })

  watcher.start()
  context.subscriptions.push({ dispose: () => watcher.stop() })

  output.appendLine('Sylo activated. Press Cmd+Shift+Alt+S to generate a context file.')
}

export function deactivate(): void {}
