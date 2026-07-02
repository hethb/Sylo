// Sylo — sidebar webview panel.
//
// Two tabs: "Agent" (context file) and "Brief" (re-entry brief). No setup or
// API key UI anywhere — errors mean the Sylo server is temporarily
// unavailable, and the recovery action is always "Try again". A persistent
// privacy footer explains exactly what leaves the machine.

import * as vscode from 'vscode'
import { SnapshotHistory } from './history'
import { BriefResponse } from './apiClient'
import { WrittenContextFile } from './agentContext'

const PRIVACY_URL = 'https://github.com/hethb/Sylo#privacy'

type BriefState =
  | { kind: 'waiting' }
  | { kind: 'generating'; awayDuration: number }
  | { kind: 'ready'; brief: BriefResponse }
  | { kind: 'error'; message: string }

type AgentState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; agentContext: WrittenContextFile }
  | { kind: 'error'; message: string }

type BriefStateName = BriefState['kind']
type AgentStateName = AgentState['kind']

interface OutboundMessage {
  type: 'state'
  brief: {
    kind: BriefStateName
    awayDuration?: string
    brief?: BriefResponse
    message?: string
  }
  agent: {
    kind: AgentStateName
    filePath?: string
    tokenEstimate?: number
    preview?: string
    content?: string
    message?: string
  }
  footer: { briefAt: string; agentAt: string }
}

type InboundMessage =
  | { type: 'ready' }
  | { type: 'command'; command: string }
  | { type: 'copyAgain' }

export class SyloPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null

  private briefState: BriefState = { kind: 'waiting' }
  private agentState: AgentState = { kind: 'idle' }
  private lastBriefAt: number | null = null
  private lastAgentAt: number | null = null

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly history: SnapshotHistory
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = this.getHtml(webviewView.webview)

    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => {
      this.handleMessage(msg)
    })

    // Hydrate from history.
    const latestBrief = this.history.getLatestBrief()
    if (latestBrief?.brief) {
      this.briefState = { kind: 'ready', brief: latestBrief.brief }
      this.lastBriefAt = latestBrief.brief.generatedAt
    }
    const latestContext = this.history.getLatestAgentContext()
    if (latestContext?.agentContext) {
      this.agentState = { kind: 'ready', agentContext: latestContext.agentContext }
      this.lastAgentAt = latestContext.agentContext.generatedAt
    }

    this.postState()
  }

  // ---- State setters ----

  setBriefState(kind: 'waiting'): void
  setBriefState(kind: 'generating', payload: { awayDuration: number }): void
  setBriefState(kind: 'ready', payload: { brief: BriefResponse }): void
  setBriefState(kind: 'error', payload: { message: string }): void
  setBriefState(kind: BriefStateName, payload?: unknown): void {
    switch (kind) {
      case 'waiting':
        this.briefState = { kind: 'waiting' }
        break
      case 'generating':
        this.briefState = {
          kind: 'generating',
          awayDuration: (payload as { awayDuration: number }).awayDuration
        }
        break
      case 'ready': {
        const p = payload as { brief: BriefResponse }
        this.briefState = { kind: 'ready', brief: p.brief }
        this.lastBriefAt = p.brief.generatedAt
        break
      }
      case 'error':
        this.briefState = { kind: 'error', message: (payload as { message: string }).message }
        break
    }
    this.postState()
  }

  setAgentState(kind: 'idle'): void
  setAgentState(kind: 'generating'): void
  setAgentState(kind: 'ready', payload: { agentContext: WrittenContextFile }): void
  setAgentState(kind: 'error', payload: { message: string }): void
  setAgentState(kind: AgentStateName, payload?: unknown): void {
    switch (kind) {
      case 'idle':
        this.agentState = { kind: 'idle' }
        break
      case 'generating':
        this.agentState = { kind: 'generating' }
        break
      case 'ready': {
        const p = payload as { agentContext: WrittenContextFile }
        this.agentState = { kind: 'ready', agentContext: p.agentContext }
        this.lastAgentAt = p.agentContext.generatedAt
        break
      }
      case 'error':
        this.agentState = { kind: 'error', message: (payload as { message: string }).message }
        break
    }
    this.postState()
  }

  // ---- Internals ----

  private handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case 'ready':
        this.postState()
        break
      case 'command':
        void vscode.commands.executeCommand(msg.command)
        break
      case 'copyAgain': {
        const latest = this.history.getLatestAgentContext()
        if (latest?.agentContext) {
          void vscode.env.clipboard.writeText(latest.agentContext.content).then(() => {
            void vscode.window.showInformationMessage('Sylo: Context copied to clipboard.')
          })
        }
        break
      }
    }
  }

  private postState(): void {
    if (!this.view) {
      return
    }
    const message: OutboundMessage = {
      type: 'state',
      brief: this.serializeBrief(),
      agent: this.serializeAgent(),
      footer: {
        briefAt: this.lastBriefAt ? new Date(this.lastBriefAt).toLocaleTimeString() : 'none yet',
        agentAt: this.lastAgentAt ? new Date(this.lastAgentAt).toLocaleTimeString() : 'none yet'
      }
    }
    void this.view.webview.postMessage(message)
  }

  private serializeBrief(): OutboundMessage['brief'] {
    switch (this.briefState.kind) {
      case 'generating':
        return { kind: 'generating', awayDuration: formatMinutes(this.briefState.awayDuration) }
      case 'ready':
        return { kind: 'ready', brief: this.briefState.brief }
      case 'error':
        return { kind: 'error', message: this.briefState.message }
      case 'waiting':
      default:
        return { kind: 'waiting' }
    }
  }

  private serializeAgent(): OutboundMessage['agent'] {
    switch (this.agentState.kind) {
      case 'generating':
        return { kind: 'generating' }
      case 'ready': {
        const ac = this.agentState.agentContext
        return {
          kind: 'ready',
          filePath: ac.filePath,
          tokenEstimate: ac.tokenEstimate,
          preview: previewOf(ac.content),
          content: ac.content
        }
      }
      case 'error':
        return { kind: 'error', message: this.agentState.message }
      case 'idle':
      default:
        return { kind: 'idle' }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce()
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ')

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0; margin: 0;
    display: flex; flex-direction: column; min-height: 100vh;
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    position: sticky; top: 0;
    background: var(--vscode-sideBar-background);
  }
  .tab {
    flex: 1; background: transparent; border: none;
    color: var(--vscode-descriptionForeground);
    padding: 8px 10px; cursor: pointer;
    font-size: var(--vscode-font-size);
    border-bottom: 2px solid transparent;
  }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .content { padding: 12px; flex: 1; }
  .panelpage { display: none; }
  .panelpage.active { display: block; }
  h2 { font-size: 1em; margin: 0 0 8px; }
  p { margin: 0 0 10px; line-height: 1.45; }
  .muted { color: var(--vscode-descriptionForeground); }
  .center { text-align: center; }
  .sentence { margin: 0 0 10px; line-height: 1.45; }
  .sentence .label {
    display: block; font-size: 0.82em; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 2px;
  }
  button.action {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 10px; margin: 4px 4px 0 0;
    border-radius: 3px; cursor: pointer;
    font-size: var(--vscode-font-size);
  }
  button.action:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  kbd {
    background: var(--vscode-keybindingLabel-background);
    color: var(--vscode-keybindingLabel-foreground);
    border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-panel-border));
    border-radius: 3px; padding: 1px 5px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
  }
  pre {
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; padding: 8px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.86em; white-space: pre-wrap; word-break: break-word;
    max-height: 260px; overflow-y: auto;
  }
  .meta { font-size: 0.86em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, inherit)); }
  .error-box {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    padding: 8px; border-radius: 3px; margin: 8px 0; font-size: 0.9em;
  }
  .pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
  .icon { font-size: 1.6em; margin-bottom: 6px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
  .hidden { display: none; }
  .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  .timestamps {
    padding: 4px 12px; font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
  }
  footer.privacy {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 8px 12px; font-size: 0.78em; line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBar-background);
    position: sticky; bottom: 0;
  }
  footer.privacy a { color: var(--vscode-textLink-foreground); text-decoration: none; }
</style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" id="tab-agent" data-tab="agent">Agent</button>
    <button class="tab" id="tab-brief" data-tab="brief">Brief</button>
  </div>

  <div class="content">
    <div class="panelpage active" id="page-agent"></div>
    <div class="panelpage" id="page-brief"></div>
  </div>

  <div class="timestamps" id="timestamps">Brief: none yet &nbsp;·&nbsp; Agent: none yet</div>

  <footer class="privacy">
    Sylo sends your open file names, git diff, and error messages to generate context.
    Secrets are redacted automatically.
    <a href="${PRIVACY_URL}">Privacy policy ↗</a>
  </footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const isMac = navigator.userAgent.includes('Mac');
  const SHORTCUT = isMac ? 'Cmd+Shift+Alt+S' : 'Ctrl+Shift+Alt+S';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cmd(command) { vscode.postMessage({ type: 'command', command: command }); }

  function selectTab(tab) {
    for (const t of ['agent', 'brief']) {
      document.getElementById('tab-' + t).classList.toggle('active', t === tab);
      document.getElementById('page-' + t).classList.toggle('active', t === tab);
    }
  }
  document.getElementById('tab-agent').addEventListener('click', () => selectTab('agent'));
  document.getElementById('tab-brief').addEventListener('click', () => selectTab('brief'));

  function renderBrief(b) {
    if (b.kind === 'waiting') {
      return '<div class="icon center">👁️</div>' +
        '<p class="muted center">Sylo is watching for interruptions.</p>' +
        '<p class="muted center">Leave VS Code for a few minutes and come back to see your re-entry brief. No setup required.</p>';
    }
    if (b.kind === 'generating') {
      return '<div class="icon center pulse">✳️</div><p class="center">Generating your re-entry brief…</p>' +
        '<p class="muted center">Away for ' + esc(b.awayDuration) + '</p>';
    }
    if (b.kind === 'error') {
      return '<div class="icon center">⚠️</div><h2 class="center">Could not generate brief</h2>' +
        '<div class="error-box">' + esc(b.message) + '</div>' +
        '<p class="muted">Sylo will try again the next time you return.</p>';
    }
    if (b.kind === 'ready' && b.brief) {
      const br = b.brief;
      return '<p class="muted">Back after ' + esc(br.awayDurationFormatted) + '</p>' +
        '<div class="sentence"><span class="label">What you were doing</span>' + esc(br.whatYouWereDoing) + '</div>' +
        '<div class="sentence"><span class="label">Last decision</span>' + esc(br.lastDecision) + '</div>' +
        '<div class="sentence"><span class="label">Next action</span>' + esc(br.nextAction) + '</div>' +
        '<div class="row">' +
          '<button class="action" id="brief-gotit">✓ Got it</button>' +
          '<button class="action secondary" id="brief-toagent">Generate agent context</button>' +
        '</div>';
    }
    return '';
  }

  function renderAgent(a) {
    if (a.kind === 'idle') {
      return '<div class="icon center">🤖</div>' +
        '<h2 class="center">Press <kbd>' + SHORTCUT + '</kbd></h2>' +
        '<p class="muted center">Sylo captures your workspace and writes a context file your agent can read immediately — no setup required.</p>' +
        '<div class="center"><button class="action" id="agent-generate">Generate context →</button></div>';
    }
    if (a.kind === 'generating') {
      return '<div class="icon center pulse">🤖</div><p class="center">Generating context…</p>' +
        '<p class="muted center">Capturing workspace state</p>';
    }
    if (a.kind === 'error') {
      return '<div class="icon center">⚠️</div><h2 class="center">Could not generate context</h2>' +
        '<div class="error-box">' + esc(a.message) + '</div>' +
        '<div class="center"><button class="action" id="agent-retry">Try again</button></div>';
    }
    if (a.kind === 'ready') {
      return '<h2>Context file ready</h2>' +
        '<div class="meta">' + esc(a.filePath) + ' written · ' + esc(a.tokenEstimate) + ' tokens<br/>' +
        '<span class="ok">Copied to clipboard ✓</span></div>' +
        '<hr class="divider"/><div class="muted" style="font-size:0.8em;letter-spacing:0.04em;">PREVIEW</div>' +
        '<pre id="agent-preview">' + esc(a.preview) + '</pre>' +
        '<button class="action secondary" id="agent-showfull">Show full file</button>' +
        '<hr class="divider"/>' +
        '<div class="row">' +
          '<button class="action" id="agent-open">Open file</button>' +
          '<button class="action secondary" id="agent-copyagain">Copy again</button>' +
          '<button class="action secondary" id="agent-regen">Regenerate</button>' +
        '</div>' +
        '<p class="muted" style="margin-top:8px;font-size:0.82em;">Paste it into Claude Code, Cursor, or any agent to start with full context.</p>';
    }
    return '';
  }

  let lastAgent = null;

  function wireEvents() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('agent-generate', () => cmd('sylo.generateAgentContext'));
    on('agent-retry', () => cmd('sylo.generateAgentContext'));
    on('agent-regen', () => cmd('sylo.generateAgentContext'));
    on('agent-open', () => cmd('sylo.openContextFile'));
    on('agent-copyagain', () => vscode.postMessage({ type: 'copyAgain' }));
    on('brief-gotit', () => cmd('sylo.showBrief'));
    on('brief-toagent', () => { selectTab('agent'); cmd('sylo.generateAgentContext'); });
    const showFull = document.getElementById('agent-showfull');
    if (showFull && lastAgent && lastAgent.content) showFull.addEventListener('click', function(){
      document.getElementById('agent-preview').textContent = lastAgent.content;
      showFull.classList.add('hidden');
    });
  }

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type !== 'state') return;
    lastAgent = msg.agent && msg.agent.kind === 'ready' ? msg.agent : null;
    document.getElementById('page-brief').innerHTML = renderBrief(msg.brief);
    document.getElementById('page-agent').innerHTML = renderAgent(msg.agent);
    document.getElementById('timestamps').innerHTML =
      'Brief: ' + esc(msg.footer.briefAt) + ' &nbsp;·&nbsp; Agent: ' + esc(msg.footer.agentAt);
    wireEvents();
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`
  }
}

function formatMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

function previewOf(content: string): string {
  const lines = content.split('\n')
  if (lines.length <= 14) {
    return content
  }
  return lines.slice(0, 14).join('\n') + '\n…'
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let text = ''
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
