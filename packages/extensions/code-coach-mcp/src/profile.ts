// profile.ts — learner profile for Code Coach (MCP variant).
// Persistent, local, file-based. Each interaction appends one record per
// concept tag that fired. The read model is counts + a "mastered" set, used
// by the coach to stop re-teaching and to deepen on repetition.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProfileRecord {
  ts: number;
  finding: string;
  tags: string[];
}

export interface Snapshot {
  counts: Record<string, number>;
  mastered: string[];
}

const MASTERED_AT = 3;

export class Profile {
  private file: string;

  constructor(file: string) {
    this.file = file;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(this.file, "", "utf8");
    } catch {
      // best effort
    }
  }

  record(finding: string, tags: string[]): void {
    const rec: ProfileRecord = { ts: Date.now(), finding, tags };
    try {
      appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8");
    } catch {
      // append-only best effort
    }
  }

  snapshot(): Snapshot {
    const counts: Record<string, number> = {};
    try {
      const raw = readFileSync(this.file, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let rec: ProfileRecord;
        try {
          rec = JSON.parse(t);
        } catch {
          continue;
        }
        for (const tag of rec.tags) {
          counts[tag] = (counts[tag] ?? 0) + 1;
        }
      }
    } catch {
      return { counts: {}, mastered: [] };
    }
    const mastered = Object.entries(counts)
      .filter(([, n]) => n >= MASTERED_AT)
      .map(([k]) => k);
    return { counts, mastered };
  }

  // True when a finding whose tag list hits a mastered concept should deepen
  // its nudge rather than be a fresh lesson.
  shouldDeepen(tags: string[], counts: Record<string, number>): boolean {
    return tags.some((t) => (counts[t] ?? 0) >= MASTERED_AT);
  }

  // Depth level for a concept: 0 = beginner (analogy), 1 = intermediate
  // (principle + tradeoff), 2 = advanced (failure mode only).
  depthFor(tags: string[], counts: Record<string, number>): number {
    const max = tags.reduce((m, t) => Math.max(m, counts[t] ?? 0), 0);
    if (max >= MASTERED_AT) return 2;
    if (max >= 2) return 1;
    return 0;
  }

  // Clear the profile. Used by the reset-profile tool.
  reset(): void {
    try {
      writeFileSync(this.file, "", "utf8");
    } catch {
      // best effort
    }
  }

  static pathOf(dir: string): string {
    return join(dir, "profile.jsonl");
  }
}
