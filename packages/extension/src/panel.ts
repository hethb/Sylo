// Sylo — sidebar webview panel.
//
// A two-tab panel: "Brief" (the human re-entry brief) and "Agent" (the agent
// context file). The extension pushes state into the webview via postMessage;
// the webview posts back button actions (which map to commands). Styling uses
// only VS Code theme CSS variables — no hardcoded colors, no UI framework.

import * as vscode from 'vscode'
import { SnapshotHistory } from './history'
import { Brief } from './briefGenerator'
import { ContextSnapshot } from './snapshot'
import { AgentContextFile, AgentTarget } from './agentContext'

type BriefState =
  | { kind: 'waiting' }
  | { kind: 'generating'; awayDuration: number }
  | { kind: 'ready'; brief: Brief; snapshot: ContextSnapshot }
  | { kind: 'error'; message: string }

type AgentState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; agentContext: AgentContextFile; warning?: string | null }
  | { kind: 'error'; message: string }

type BriefStateName = BriefState['kind']
type AgentStateName = AgentState['kind']

/** Messages sent from extension → webview. */
interface OutboundMessage {
  type: 'state'
  brief: SerializableBriefState
  agent: SerializableAgentState
  footer: { briefAt: string; agentAt: string }
  target: AgentTarget
}

interface SerializableBriefState {
  kind: BriefStateName
  awayDuration?: string
  brief?: Brief
  message?: string
}

interface SerializableAgentState {
  kind: AgentStateName
  tokenEstimate?: number
  path?: string
  branch?: string
  copied?: boolean
  wrote?: boolean
  preview?: string
  content?: string
  warning?: string | null
  message?: string
}

/** Messages sent from webview → extension. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'command'; command: string }
  | { type: 'setTarget'; target: AgentTarget }
  | { type: 'generateForTarget'; target: AgentTarget }

export class SyloPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null

  private briefState: BriefState = { kind: 'waiting' }
  private agentState: AgentState = { kind: 'idle' }

  private lastBriefAt: number | null = null
  private lastAgentAt: number | null = null

  private lastReady: { copied: boolean; wrote: boolean; warning: string | null } = {
    copied: false,
    wrote: false,
    warning: null
  }

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

    // Hydrate from history if we have something to show.
    const latest = this.history.getLatest()
    if (latest?.brief) {
      this.briefState = { kind: 'ready', brief: latest.brief, snapshot: latest.snapshot }
      this.lastBriefAt = latest.brief.generatedAt
    }
    if (latest?.agentContext) {
      this.agentState = { kind: 'ready', agentContext: latest.agentContext }
      this.lastAgentAt = latest.agentContext.generatedAt
    }

    this.postState()
  }

  // ---- Public state setters, called from extension.ts ----

  setBriefState(kind: 'waiting'): void
  setBriefState(kind: 'generating', payload: { awayDuration: number }): void
  setBriefState(kind: 'ready', payload: { brief: Brief; snapshot: ContextSnapshot }): void
  setBriefState(kind: 'error', payload: { message: string }): void
  setBriefState(kind: BriefStateName, payload?: unknown): void {
    switch (kind) {
      case 'waiting':
        this.briefState = { kind: 'waiting' }
        break
      case 'generating':
        this.briefState = { kind: 'generating', awayDuration: (payload as { awayDuration: number }).awayDuration }
        break
      case 'ready': {
        const p = payload as { brief: Brief; snapshot: ContextSnapshot }
        this.briefState = { kind: 'ready', brief: p.brief, snapshot: p.snapshot }
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
  setAgentState(
    kind: 'ready',
    payload: { agentContext: AgentContextFile; copied?: boolean; wrote?: boolean; warning?: string | null }
  ): void
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
        const p = payload as {
          agentContext: AgentContextFile
          copied?: boolean
          wrote?: boolean
          warning?: string | null
        }
        this.agentState = { kind: 'ready', agentContext: p.agentContext, warning: p.warning ?? null }
        this.lastAgentAt = p.agentContext.generatedAt
        this.lastReady = {
          copied: p.copied ?? false,
          wrote: p.wrote ?? false,
          warning: p.warning ?? null
        }
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
      case 'setTarget':
        void vscode.workspace
          .getConfiguration('sylo')
          .update('agentContextTarget', msg.target, vscode.ConfigurationTarget.Global)
          .then(() => this.postState())
        break
      case 'generateForTarget':
        void vscode.workspace
          .getConfiguration('sylo')
          .update('agentContextTarget', msg.target, vscode.ConfigurationTarget.Global)
          .then(() => vscode.commands.executeCommand('sylo.generateAgentContext'))
        break
    }
  }

  private currentTarget(): AgentTarget {
    return (
      vscode.workspace.getConfiguration('sylo').get<AgentTarget>('agentContextTarget') ?? 'generic'
    )
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
      },
      target: this.currentTarget()
    }
    void this.view.webview.postMessage(message)
  }

  private serializeBrief(): SerializableBriefState {
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

  private serializeAgent(): SerializableAgentState {
    switch (this.agentState.kind) {
      case 'generating':
        return { kind: 'generating' }
      case 'ready': {
        const ac = this.agentState.agentContext
        return {
          kind: 'ready',
          tokenEstimate: ac.tokenEstimate,
          path: ac.path,
          branch: extractBranch(ac.content),
          preview: previewOf(ac.content),
          content: ac.content,
          copied: this.lastReady.copied,
          wrote: this.lastReady.wrote,
          warning: this.agentState.warning ?? null
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
    padding: 0;
    margin: 0;
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background);
  }
  .tab {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    padding: 8px 10px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
    border-bottom: 2px solid transparent;
  }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .content { padding: 12px; }
  .panelpage { display: none; }
  .panelpage.active { display: block; }
  h2 { font-size: 1em; margin: 0 0 8px; }
  p { margin: 0 0 10px; line-height: 1.45; }
  .muted { color: var(--vscode-descriptionForeground); }
  .sentence { margin: 0 0 10px; line-height: 1.45; }
  .sentence .label {
    display: block;
    font-size: 0.82em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 2px;
  }
  button.action {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 10px;
    margin: 4px 4px 0 0;
    border-radius: 3px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
  }
  button.action:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 3px 6px;
    border-radius: 3px;
  }
  .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  pre {
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.86em;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
  }
  .meta { font-size: 0.86em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, inherit)); }
  .warn {
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-editorWarning-foreground));
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    padding: 6px 8px;
    border-radius: 3px;
    margin: 8px 0;
    font-size: 0.86em;
  }
  .error-box {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    padding: 8px;
    border-radius: 3px;
    margin: 8px 0;
    font-size: 0.9em;
  }
  .pulse { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
  .icon { font-size: 1.6em; margin-bottom: 6px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
  footer {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 6px 12px;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    position: sticky;
    bottom: 0;
    background: var(--vscode-sideBar-background);
  }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" id="tab-brief" data-tab="brief">Brief</button>
    <button class="tab" id="tab-agent" data-tab="agent">Agent</button>
  </div>

  <div class="content">
    <div class="panelpage active" id="page-brief"></div>
    <div class="panelpage" id="page-agent"></div>
  </div>

  <footer id="footer">Brief: none yet &nbsp;·&nbsp; Agent: none yet</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let activeTab = 'brief';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cmd(command) { vscode.postMessage({ type: 'command', command: command }); }

  function selectTab(tab) {
    activeTab = tab;
    document.getElementById('tab-brief').classList.toggle('active', tab === 'brief');
    document.getElementById('tab-agent').classList.toggle('active', tab === 'agent');
    document.getElementById('page-brief').classList.toggle('active', tab === 'brief');
    document.getElementById('page-agent').classList.toggle('active', tab === 'agent');
  }

  document.getElementById('tab-brief').addEventListener('click', () => selectTab('brief'));
  document.getElementById('tab-agent').addEventListener('click', () => selectTab('agent'));

  function renderBrief(b) {
    if (b.kind === 'waiting') {
      return '<div class="icon">👁️</div><p class="muted">Sylo is watching for interruptions…</p>' +
        '<p class="muted">Leave VS Code for a few minutes and come back to see your re-entry brief.</p>';
    }
    if (b.kind === 'generating') {
      return '<div class="icon pulse">✳️</div><p>Generating your re-entry brief…</p>' +
        '<p class="muted">Away for ' + esc(b.awayDuration) + '</p>';
    }
    if (b.kind === 'error') {
      return '<div class="icon">⚠️</div><div class="error-box">' + esc(b.message) + '</div>' +
        '<button class="action" onclick="cmd(\\'sylo.configure\\')">Configure →</button>';
    }
    if (b.kind === 'ready' && b.brief) {
      const br = b.brief;
      return '<p class="muted">Back after ' + esc(br.awayDurationFormatted) + '</p>' +
        '<div class="sentence"><span class="label">What you were doing</span>' + esc(br.whatYouWereDoing) + '</div>' +
        '<div class="sentence"><span class="label">Last decision</span>' + esc(br.lastDecision) + '</div>' +
        '<div class="sentence"><span class="label">Next action</span>' + esc(br.nextAction) + '</div>' +
        '<div class="row">' +
          '<button class="action" onclick="cmd(\\'sylo.showBrief\\')">✓ Got it</button>' +
          '<button class="action secondary" onclick="cmd(\\'sylo.showBrief\\')">View snapshot</button>' +
          '<button class="action secondary" id="brief-regen">Regenerate</button>' +
        '</div>' +
        '<p class="muted" style="margin-top:8px;font-size:0.82em;">Model: ' + esc(br.model) + '</p>';
    }
    return '';
  }

  function renderAgent(a, target) {
    const targetOptions = ['claude-code','cursor','copilot','generic'].map(function(t){
      return '<option value="' + t + '"' + (t === target ? ' selected' : '') + '>' + labelFor(t) + '</option>';
    }).join('');

    if (a.kind === 'idle') {
      return '<div class="icon">🤖</div><h2>Ready to brief your agent</h2>' +
        '<p class="muted">Press Cmd+Shift+Alt+S or run "Sylo: Generate agent context file" to capture current workspace state and write your context file.</p>' +
        '<div class="row"><span class="muted">Target agent:</span>' +
        '<select id="agent-target">' + targetOptions + '</select></div>' +
        '<button class="action" id="agent-generate">Generate now →</button>';
    }
    if (a.kind === 'generating') {
      return '<div class="icon pulse">🤖</div><p>Writing context for ' + esc(labelFor(target)) + '…</p>' +
        '<p class="muted">Capturing workspace state</p>';
    }
    if (a.kind === 'error') {
      return '<div class="icon">⚠️</div><h2>Could not generate context file</h2>' +
        '<div class="error-box">' + esc(a.message) + '</div>' +
        '<button class="action" onclick="cmd(\\'sylo.configure\\')">Configure API key →</button>';
    }
    if (a.kind === 'ready') {
      const statusLines = [];
      if (a.wrote) statusLines.push(esc(a.path) + ' written · ' + esc(a.tokenEstimate) + ' tokens');
      else statusLines.push(esc(a.tokenEstimate) + ' tokens');
      if (a.copied) statusLines.push('<span class="ok">Copied to clipboard ✓</span>');
      if (a.branch) statusLines.push('Branch: ' + esc(a.branch));

      const warnHtml = a.warning ? '<div class="warn">' + esc(a.warning) + '</div>' : '';

      return '<h2>Context file ready</h2>' +
        '<div class="meta">' + statusLines.join('<br/>') + '</div>' +
        warnHtml +
        '<hr class="divider"/><div class="muted" style="font-size:0.8em;letter-spacing:0.04em;">PREVIEW</div>' +
        '<pre id="agent-preview">' + esc(a.preview) + '</pre>' +
        '<button class="action secondary" id="agent-showfull">Show full file</button>' +
        '<hr class="divider"/>' +
        '<div class="row">' +
          '<button class="action" onclick="cmd(\\'sylo.openAgentContext\\')">Open file</button>' +
          '<button class="action secondary" id="agent-copyagain">Copy again</button>' +
          '<button class="action secondary" id="agent-regen">Regenerate</button>' +
        '</div>' +
        '<div class="row"><span class="muted">Open for different agent:</span>' +
        '<select id="agent-retarget">' + targetOptions + '</select></div>' +
        '<p class="muted" style="margin-top:8px;font-size:0.82em;">Paste it into your agent to start with full context.</p>';
    }
    return '';
  }

  function labelFor(t) {
    if (t === 'claude-code') return 'Claude Code';
    if (t === 'cursor') return 'Cursor';
    if (t === 'copilot') return 'Copilot';
    return 'Generic';
  }

  let lastAgent = null;

  function wireAgentEvents() {
    const target = document.getElementById('agent-target');
    if (target) target.addEventListener('change', function(e){
      vscode.postMessage({ type: 'setTarget', target: e.target.value });
    });
    const gen = document.getElementById('agent-generate');
    if (gen) gen.addEventListener('click', function(){ cmd('sylo.generateAgentContext'); });
    const copyAgain = document.getElementById('agent-copyagain');
    if (copyAgain) copyAgain.addEventListener('click', function(){ cmd('sylo.generateAgentContext'); });
    const regen = document.getElementById('agent-regen');
    if (regen) regen.addEventListener('click', function(){ cmd('sylo.generateAgentContext'); });
    const retarget = document.getElementById('agent-retarget');
    if (retarget) retarget.addEventListener('change', function(e){
      vscode.postMessage({ type: 'generateForTarget', target: e.target.value });
    });
    const showFull = document.getElementById('agent-showfull');
    if (showFull && lastAgent && lastAgent.content) showFull.addEventListener('click', function(){
      document.getElementById('agent-preview').textContent = lastAgent.content;
      showFull.classList.add('hidden');
    });
    const briefRegen = document.getElementById('brief-regen');
    if (briefRegen) briefRegen.addEventListener('click', function(){ cmd('sylo.showBrief'); });
  }

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type !== 'state') return;
    lastAgent = msg.agent && msg.agent.kind === 'ready' ? msg.agent : null;
    document.getElementById('page-brief').innerHTML = renderBrief(msg.brief);
    document.getElementById('page-agent').innerHTML = renderAgent(msg.agent, msg.target);
    document.getElementById('footer').innerHTML =
      'Brief: ' + esc(msg.footer.briefAt) + ' &nbsp;·&nbsp; Agent: ' + esc(msg.footer.agentAt);
    wireAgentEvents();
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

function extractBranch(content: string): string {
  const match = content.match(/Branch:\s*([^\n·]+)/)
  return match ? match[1].trim() : ''
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let text = ''
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
