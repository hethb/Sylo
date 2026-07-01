// Sylo — snapshot & context file history.
//
// Stores the last 10 snapshots along with their generated brief and agent
// context file. Persisted in VS Code globalState — never written to a server.

import * as vscode from 'vscode'
import { ContextSnapshot } from './snapshot'
import { Brief } from './briefGenerator'
import { AgentContextFile } from './agentContext'

export interface HistoryEntry {
  snapshot: ContextSnapshot
  brief: Brief | null
  briefError: string | null
  agentContext: AgentContextFile | null
  agentContextError: string | null
  id: string
}

const STORAGE_KEY = 'sylo.history'
const MAX_ENTRIES = 10

export class SnapshotHistory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Add an entry, or update the existing one with the same id in place.
   * Keeps only the most recent MAX_ENTRIES.
   */
  add(entry: HistoryEntry): void {
    const all = this.getAll()
    const existingIndex = all.findIndex((e) => e.id === entry.id)

    if (existingIndex !== -1) {
      all[existingIndex] = entry
    } else {
      all.unshift(entry)
    }

    const trimmed = all.slice(0, MAX_ENTRIES)
    void this.context.globalState.update(STORAGE_KEY, trimmed)
  }

  getAll(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(STORAGE_KEY, [])
  }

  getLatest(): HistoryEntry | null {
    return this.getAll()[0] ?? null
  }

  clear(): void {
    void this.context.globalState.update(STORAGE_KEY, [])
  }
}

/** Small collision-resistant id — avoids pulling in a nanoid dependency. */
export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
