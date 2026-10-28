/*
 * clipboard.ts - the universal fallback prompt source.
 *
 * Any app can put text on the clipboard, so this works where CDP and UI
 * Automation do not. It only keeps prose-looking text, and it never reads
 * more often than the configured interval.
 */

import { looksLikePrompt } from "../promptCapture";

export class ClipboardObserver {
  private timer: NodeJS.Timeout | undefined;
  private last = "";

  constructor(
    private read: () => PromiseLike<string>,
    private onPrompt: (text: string) => void,
    private intervalMs = 2000
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    try {
      const text = (await this.read()).trim();
      if (!text || text === this.last) return;
      if (!looksLikePrompt(text)) return;
      this.last = text;
      this.onPrompt(text);
    } catch {
      // clipboard can be unavailable; ignore
    }
  }
}
