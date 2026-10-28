/*
 * hub.ts - one funnel for every observation.
 *
 * Adapters (save diff, terminal, clipboard, browser CDP, Windows UIA) all
 * produce the same shape. The hub drops noise before it reaches the model:
 * short text, huge pastes, and the same prompt from the same source inside a
 * dedupe window.
 */

export interface Observation {
  prompt: string;
  diff: string;
  source: string;
  app?: string;
  title?: string;
  context?: string;
  ts: number;
}

export type ObservationInput = Omit<Observation, "ts"> & { ts?: number };

export interface HubOptions {
  dedupeMs?: number;
  minChars?: number;
  maxChars?: number;
}

export class ObserverHub {
  private seen = new Map<string, number>();

  constructor(
    private emit: (observation: Observation) => void,
    private opts: HubOptions = {}
  ) {}

  push(input: ObservationInput): boolean {
    const prompt = input.prompt.trim();
    if (prompt.length < (this.opts.minChars ?? 8)) return false;
    if (prompt.length > (this.opts.maxChars ?? 8000)) return false;

    const key = `${input.source}|${input.app ?? ""}|${prompt}`;
    const now = Date.now();
    const last = this.seen.get(key);
    if (last !== undefined && now - last < (this.opts.dedupeMs ?? 30_000)) return false;

    this.seen.set(key, now);
    if (this.seen.size > 200) {
      const cutoff = now - (this.opts.dedupeMs ?? 30_000);
      for (const [k, ts] of this.seen) {
        if (ts < cutoff) this.seen.delete(k);
      }
    }

    this.emit({ ...input, prompt, ts: input.ts ?? now });
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}
