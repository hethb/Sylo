// Sylo — focus detection.
//
// Watches window focus. When the developer leaves for longer than the
// configured threshold and comes back, fires onReturn with the snapshot taken
// at departure plus how long they were away.

import * as vscode from 'vscode'
import { captureSnapshot, ContextSnapshot } from './snapshot'

const LEAVE_DEBOUNCE_MS = 3000

export class FocusWatcher {
  private awayStartTime: number | null = null
  private snapshotBeforeLeaving: ContextSnapshot | null = null
  private leaveTimer: ReturnType<typeof setTimeout> | null = null
  private disposable: vscode.Disposable | null = null
  private started = false

  constructor(
    private readonly onReturn: (snapshot: ContextSnapshot, awayDurationMs: number) => void
  ) {}

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.disposable = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        this.handleFocusGained()
      } else {
        this.handleFocusLost()
      }
    })
  }

  stop(): void {
    this.started = false
    this.clearLeaveTimer()
    this.disposable?.dispose()
    this.disposable = null
    this.awayStartTime = null
    this.snapshotBeforeLeaving = null
  }

  private handleFocusLost(): void {
    // Debounce: a quick alt-tab that comes right back should not count as leaving.
    if (this.leaveTimer || this.awayStartTime !== null) {
      return
    }
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null
      void this.commitLeave()
    }, LEAVE_DEBOUNCE_MS)
  }

  private async commitLeave(): Promise<void> {
    if (vscode.window.state.focused) {
      return
    }
    this.awayStartTime = Date.now()
    try {
      const { snapshot } = await captureSnapshot()
      this.snapshotBeforeLeaving = snapshot
    } catch {
      this.snapshotBeforeLeaving = null
    }
  }

  private handleFocusGained(): void {
    this.clearLeaveTimer()

    if (this.awayStartTime === null) {
      return
    }

    const awayDurationMs = Date.now() - this.awayStartTime
    const snapshot = this.snapshotBeforeLeaving

    this.awayStartTime = null
    this.snapshotBeforeLeaving = null

    if (!snapshot) {
      return
    }

    const thresholdMinutes =
      vscode.workspace.getConfiguration('sylo').get<number>('awayThresholdMinutes') ?? 5

    if (awayDurationMs < thresholdMinutes * 60 * 1000) {
      return
    }

    this.onReturn(snapshot, awayDurationMs)
  }

  private clearLeaveTimer(): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer)
      this.leaveTimer = null
    }
  }
}
