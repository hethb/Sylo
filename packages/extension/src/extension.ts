// Sylo — extension entry point.
//
// Wires the focus watcher (human brief on return, optional agent context on
// leave), the sidebar panel, the two status bar items, and all commands.

import * as vscode from 'vscode'
import { captureSnapshot } from './snapshot'
import { FocusWatcher } from './focusWatcher'
import { generateBrief } from './briefGenerator'
import { generateAgentContext, writeAgentContext, AgentContextFile, AgentTarget } from './agentContext'
import { SnapshotHistory, HistoryEntry, genId } from './history'
import { SyloPanel } from './panel'
import { Provider } from './llm'

interface SyloConfig {
  apiKey: string
  provider: Provider
  model: string
  target: AgentTarget
}

function readConfig(): SyloConfig {
  const config = vscode.workspace.getConfiguration('sylo')
  return {
    apiKey: config.get<string>('apiKey') || '',
    provider: config.get<Provider>('provider') || 'openai',
    model: config.get<string>('model') || 'gpt-4o-mini',
    target: config.get<AgentTarget>('agentContextTarget') || 'generic'
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Sylo')
  const history = new SnapshotHistory(context)
  const panel = new SyloPanel(context, history)

  const briefStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  const agentStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  agentStatus.command = 'sylo.openAgentContext'
  briefStatus.command = 'sylo.showBrief'
  setBriefStatus(briefStatus, 'default')
  setAgentStatus(agentStatus, 'default')
  briefStatus.show()
  agentStatus.show()

  context.subscriptions.push(
    outputChannel,
    briefStatus,
    agentStatus,
    vscode.window.registerWebviewViewProvider('sylo.panel', panel)
  )

  // ---- Focus watcher: human brief on return, optional agent context on leave ----

  const watcher = new FocusWatcher(
    context,
    // onReturn — generate human brief
    async (snapshot) => {
      panel.setBriefState('generating', { awayDuration: snapshot.awayDurationMs })
      setBriefStatus(briefStatus, 'generating')

      const cfg = readConfig()
      if (!cfg.apiKey) {
        panel.setBriefState('error', { message: 'API key not configured. Run "Sylo: Configure".' })
        setBriefStatus(briefStatus, 'error')
        return
      }

      try {
        const brief = await generateBrief(snapshot, cfg.apiKey, cfg.provider, cfg.model)
        history.add({
          snapshot,
          brief,
          briefError: null,
          agentContext: null,
          agentContextError: null,
          id: genId()
        })
        panel.setBriefState('ready', { brief, snapshot })
        setBriefStatus(briefStatus, 'ready')

        if (vscode.workspace.getConfiguration('sylo').get<boolean>('autoShow')) {
          void vscode.window
            .showInformationMessage(
              `Sylo: Back after ${brief.awayDurationFormatted}. Brief ready.`,
              'Show brief',
              'Generate agent context'
            )
            .then((selection) => {
              if (selection === 'Show brief') {
                void vscode.commands.executeCommand('sylo.panel.focus')
              } else if (selection === 'Generate agent context') {
                void vscode.commands.executeCommand('sylo.generateAgentContext')
              }
            })
        }
      } catch (err) {
        const message = errMessage(err)
        outputChannel.appendLine(`Brief error: ${message}`)
        panel.setBriefState('error', { message })
        setBriefStatus(briefStatus, 'error')
      }
    },

    // onLeave — optionally auto-generate agent context file
    async (snapshot) => {
      if (!vscode.workspace.getConfiguration('sylo').get<boolean>('autoGenerateOnLeave')) {
        return
      }
      const cfg = readConfig()
      if (!cfg.apiKey) {
        return
      }
      outputChannel.appendLine('Auto-generating agent context on leave…')
      try {
        const file = await generateAgentContext(snapshot, cfg.apiKey, cfg.provider, cfg.model, cfg.target)
        const result = await writeAgentContext(file)
        outputChannel.appendLine(
          `Agent context ${result.wroteFile ? `written to ${result.file.path} ` : ''}(${result.file.tokenEstimate} tokens)`
        )
      } catch (err) {
        outputChannel.appendLine(`Auto agent context error: ${errMessage(err)}`)
      }
    }
  )

  watcher.start()
  context.subscriptions.push({ dispose: () => watcher.stop() })

  // ---- Shared: generate + persist an agent context file ----

  async function runAgentGeneration(options: { clipboardOnly: boolean }): Promise<void> {
    const cfg = readConfig()
    if (!cfg.apiKey) {
      vscode.window.showErrorMessage('Sylo: API key not configured. Run "Sylo: Configure".')
      panel.setAgentState('error', { message: 'API key not configured. Run "Sylo: Configure".' })
      return
    }

    panel.setAgentState('generating')
    setAgentStatus(agentStatus, 'generating')

    try {
      const snapshot = await captureSnapshot(context, 0)
      const file = await generateAgentContext(snapshot, cfg.apiKey, cfg.provider, cfg.model, cfg.target)

      let persisted: AgentContextFile
      let copied: boolean
      let wrote: boolean
      let warning: string | null

      if (options.clipboardOnly) {
        await vscode.env.clipboard.writeText(file.content)
        persisted = { ...file, path: '(clipboard only)' }
        copied = true
        wrote = false
        warning =
          file.tokenEstimate > 1500
            ? `Context is long (${file.tokenEstimate} tokens). Consider the 'copilot' target for shorter output.`
            : null
      } else {
        const result = await writeAgentContext(file)
        persisted = result.file
        copied = result.copiedToClipboard
        wrote = result.wroteFile
        warning = result.warning
        if (warning) {
          outputChannel.appendLine(warning)
        }
        if (wrote) {
          outputChannel.appendLine(`Agent context written to ${persisted.path} (${persisted.tokenEstimate} tokens)`)
        }
      }

      // Attach to the latest history entry, or create one.
      const latest = history.getLatest()
      if (latest) {
        latest.agentContext = persisted
        latest.agentContextError = null
        history.add(latest)
      } else {
        const entry: HistoryEntry = {
          snapshot,
          brief: null,
          briefError: null,
          agentContext: persisted,
          agentContextError: null,
          id: genId()
        }
        history.add(entry)
      }

      panel.setAgentState('ready', { agentContext: persisted, copied, wrote, warning })
      setAgentStatus(agentStatus, 'ready', persisted.tokenEstimate)

      const detail = wrote
        ? `Context file ready (${persisted.tokenEstimate} tokens). Copied to clipboard.`
        : `Context copied to clipboard (${persisted.tokenEstimate} tokens). Paste it into your agent.`
      if (wrote) {
        void vscode.window.showInformationMessage(`Sylo: ${detail}`, 'Open file').then((selection) => {
          if (selection === 'Open file') {
            void vscode.commands.executeCommand('sylo.openAgentContext')
          }
        })
      } else {
        void vscode.window.showInformationMessage(`Sylo: ${detail}`)
      }
    } catch (err) {
      const message = errMessage(err)
      outputChannel.appendLine(`Agent context error: ${message}`)
      panel.setAgentState('error', { message })
      setAgentStatus(agentStatus, 'error')
    }
  }

  // ---- Commands ----

  context.subscriptions.push(
    vscode.commands.registerCommand('sylo.generateAgentContext', () => runAgentGeneration({ clipboardOnly: false })),

    vscode.commands.registerCommand('sylo.generateAgentContextAndCopy', () =>
      runAgentGeneration({ clipboardOnly: true })
    ),

    vscode.commands.registerCommand('sylo.openAgentContext', async () => {
      const agentContextPath =
        vscode.workspace.getConfiguration('sylo').get<string>('agentContextPath') || 'SYLO_CONTEXT.md'
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('Sylo: No workspace folder open.')
        return
      }
      const filePath = vscode.Uri.joinPath(workspaceFolders[0].uri, agentContextPath)
      try {
        const doc = await vscode.workspace.openTextDocument(filePath)
        await vscode.window.showTextDocument(doc)
      } catch {
        vscode.window.showErrorMessage(
          `Sylo: No context file found at ${agentContextPath}. Generate one first with Cmd+Shift+Alt+S.`
        )
      }
    }),

    vscode.commands.registerCommand('sylo.showBrief', () => {
      const latest = history.getLatest()
      if (latest?.brief) {
        panel.setBriefState('ready', { brief: latest.brief, snapshot: latest.snapshot })
        void vscode.commands.executeCommand('sylo.panel.focus')
      } else {
        vscode.window.showInformationMessage('No brief yet. Leave VS Code for a few minutes and come back.')
      }
    }),

    vscode.commands.registerCommand('sylo.configure', async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI or Anthropic API key',
        password: true,
        placeHolder: 'sk-… or sk-ant-…'
      })
      if (apiKey) {
        await vscode.workspace
          .getConfiguration('sylo')
          .update('apiKey', apiKey, vscode.ConfigurationTarget.Global)
        vscode.window.showInformationMessage('Sylo: API key saved.')
      }
    }),

    vscode.commands.registerCommand('sylo.clearHistory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all Sylo snapshot history?',
        'Clear',
        'Cancel'
      )
      if (confirm === 'Clear') {
        history.clear()
        panel.setBriefState('waiting')
        panel.setAgentState('idle')
        setBriefStatus(briefStatus, 'default')
        setAgentStatus(agentStatus, 'default')
      }
    })
  )

  outputChannel.appendLine('Sylo activated.')
}

export function deactivate(): void {}

// ---- Status bar helpers ----

type BriefStatusKind = 'default' | 'away' | 'generating' | 'ready' | 'error'

function setBriefStatus(item: vscode.StatusBarItem, kind: BriefStatusKind, awayMinutes?: number): void {
  switch (kind) {
    case 'away':
      item.text = `$(clock) Away ${awayMinutes ?? 0}m…`
      item.tooltip = 'Sylo: you are away'
      break
    case 'generating':
      item.text = `$(loading~spin) Generating brief…`
      item.tooltip = 'Sylo: generating your re-entry brief'
      break
    case 'ready':
      item.text = `$(check) Brief ready`
      item.tooltip = 'Sylo: re-entry brief ready — click to view'
      break
    case 'error':
      item.text = `$(warning) Sylo: setup needed`
      item.tooltip = 'Sylo: configuration needed — click to fix'
      break
    case 'default':
    default:
      item.text = `$(eye) Sylo`
      item.tooltip = 'Sylo is watching for interruptions'
      break
  }
}

type AgentStatusKind = 'default' | 'generating' | 'ready' | 'error'

function setAgentStatus(item: vscode.StatusBarItem, kind: AgentStatusKind, tokens?: number): void {
  switch (kind) {
    case 'generating':
      item.text = `$(loading~spin) Writing context…`
      item.tooltip = 'Sylo: writing agent context file'
      break
    case 'ready':
      item.text = tokens != null ? `$(file-code) ${tokens} tokens` : `$(file-code) SYLO_CONTEXT.md ready`
      item.tooltip = 'Sylo: agent context file ready — click to open'
      break
    case 'error':
      item.text = `$(warning) Agent context`
      item.tooltip = 'Sylo: could not generate agent context'
      break
    case 'default':
    default:
      item.text = `$(robot) Agent context`
      item.tooltip = 'Sylo: generate an agent context file'
      break
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}
