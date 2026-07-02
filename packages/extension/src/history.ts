// Sylo — snapshot & context file history.
//
// Stores the last 10 briefs and generated context files in VS Code
// globalState — never on a server.

import * as vscode from 'vscode'
import { ContextSnapshot } from './snapshot'
import { BriefResponse } from './apiClient'
import { WrittenContextFile } from './agentContext'

export interface HistoryEntry {
  id: string
  createdAt: number
  brief: BriefResponse | null
  snapshot: ContextSnapshot | null
  agentContext: WrittenContextFile | null
}

const STORAGE_KEY = 'sylo.history'
const MAX_ENTRIES = 10

export class SnapshotHistory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  addBrief(brief: BriefResponse, snapshot: ContextSnapshot): void {
    this.push({ id: genId(), createdAt: Date.now(), brief, snapshot, agentContext: null })
  }

  addAgentContext(agentContext: WrittenContextFile): void {
    const latest = this.getLatest()
    if (latest && latest.agentContext === null) {
      latest.agentContext = agentContext
      this.replaceLatest(latest)
    } else {
      this.push({ id: genId(), createdAt: Date.now(), brief: null, snapshot: null, agentContext })
    }
  }

  getAll(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(STORAGE_KEY, [])
  }

  getLatest(): HistoryEntry | null {
    return this.getAll()[0] ?? null
  }

  /** Most recent entry that has a brief. */
  getLatestBrief(): HistoryEntry | null {
    return this.getAll().find((e) => e.brief !== null) ?? null
  }

  /** Most recent entry that has a generated context file. */
  getLatestAgentContext(): HistoryEntry | null {
    return this.getAll().find((e) => e.agentContext !== null) ?? null
  }

  clear(): void {
    void this.context.globalState.update(STORAGE_KEY, [])
  }

  private push(entry: HistoryEntry): void {
    const all = this.getAll()
    all.unshift(entry)
    void this.context.globalState.update(STORAGE_KEY, all.slice(0, MAX_ENTRIES))
  }

  private replaceLatest(entry: HistoryEntry): void {
    const all = this.getAll()
    all[0] = entry
    void this.context.globalState.update(STORAGE_KEY, all)
  }
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
