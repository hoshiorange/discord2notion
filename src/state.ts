/**
 * 録音状態管理（Phase 2 ではモック）。
 * 実際の録音処理は Phase 3 で実装するため、ここでは状態フラグと開始時刻のみ保持する。
 */

interface RecordingStatus {
  isRecording: boolean;
  startedAt: Date | null;
  durationMs: number | null;
}

class RecordingState {
  private isRecording = false;
  private startedAt: Date | null = null;

  start(): boolean {
    if (this.isRecording) return false;
    this.isRecording = true;
    this.startedAt = new Date();
    return true;
  }

  stop(): { wasRecording: boolean; durationMs: number | null } {
    if (!this.isRecording) {
      return { wasRecording: false, durationMs: null };
    }
    const durationMs = this.startedAt ? Date.now() - this.startedAt.getTime() : null;
    this.isRecording = false;
    this.startedAt = null;
    return { wasRecording: true, durationMs };
  }

  status(): RecordingStatus {
    return {
      isRecording: this.isRecording,
      startedAt: this.startedAt,
      durationMs: this.startedAt ? Date.now() - this.startedAt.getTime() : null,
    };
  }
}

export const recordingState = new RecordingState();
