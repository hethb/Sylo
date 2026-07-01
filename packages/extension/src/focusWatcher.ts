// Sylo — focus detection.
//
// Watches VS Code window focus. When the developer leaves (focus lost for more
// than a short debounce) it captures a snapshot and fires onLeave. When they
// return, it computes how long they were away and — if that clears the
// configured threshold — fires onReturn with the snapshot taken at departure.
//
// Each VS Code window has its own FocusWatcher instance, so multiple windows
// are tracked independently.

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
    private readonly context: vscode.ExtensionContext,
    private readonly onReturnCallback: (snapshot: ContextSnapshot) => void,
    private readonly onLeaveCallback: (snapshot: ContextSnapshot) => void
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
    // Focus may have returned during the debounce window.
    if (vscode.window.state.focused) {
      return
    }
    this.awayStartTime = Date.now()
    try {
      const snapshot = await captureSnapshot(this.context, 0)
      this.snapshotBeforeLeaving = snapshot
      this.onLeaveCallback(snapshot)
    } catch {
      // Capturing the leaving snapshot must never surface as an error to the user.
      this.snapshotBeforeLeaving = null
    }
  }

  private handleFocusGained(): void {
    // If we were still inside the debounce window, the developer never really left.
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

    const config = vscode.workspace.getConfiguration('sylo')
    const thresholdMinutes = config.get<number>('awayThresholdMinutes') ?? 5
    const thresholdMs = thresholdMinutes * 60 * 1000

    if (awayDurationMs < thresholdMs) {
      return
    }

    this.onReturnCallback({ ...snapshot, awayDurationMs })
  }

  private clearLeaveTimer(): void {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer)
      this.leaveTimer = null
    }
  }
}
