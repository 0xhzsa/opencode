// precheck.ts - deterministic safety net for the triage step.
//
// The triage model is cheap, and cheap models fail in two ways: they reason
// instead of answering, or they are rate-limited. Either way the coach would go
// silent on a textbook vulnerability. This module runs before the model and can
// only ESCALATE: it never suppresses a finding the model would have made.
//
// The rules are deliberately narrow. A false positive here forces an interrupt,
// so only patterns that are unambiguous in a diff belong.

import type { TriageResult } from "./triage.js";

const RE_SECRET =
  /(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/;

// A SQL keyword inside a string that is then concatenated or interpolated.
const RE_SQL_CONCAT = /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n]{0,160}(?:["'`]\s*\+|\$\{)/i;

// A password compared for equality against a stored credential. A confirmation
// field (`password === confirmPassword`) does not match.
const RE_PASSWORD_EQ =
  /(?:user|row|record|account|stored|db|found)\w*\.(?:password|passwd|pwd)\s*(?:===|==|!==|!=)|(?:password|passwd|pwd)\s*(?:===|==|!==|!=)\s*(?:user|row|record|account|stored|db|found)\b/i;

const RE_EVAL = /\beval\s*\(|\bnew\s+Function\s*\(/;
const RE_INNERHTML = /\.(?:inner|outer)HTML\s*=\s*[^\s"'`]/;

export function preCheck(diff: string): TriageResult | null {
  const d = String(diff ?? "");
  if (!d) return null;

  if (RE_SECRET.test(d)) {
    return {
      interrupt: true,
      uncertain: false,
      severity: "critical",
      category: "security",
      reason: "Pre-check: a credential literal is present in the diff.",
    };
  }

  if (RE_SQL_CONCAT.test(d)) {
    return {
      interrupt: true,
      uncertain: false,
      severity: "critical",
      category: "security",
      reason: "Pre-check: SQL is built by concatenating or interpolating values.",
    };
  }

  if (RE_PASSWORD_EQ.test(d)) {
    return {
      interrupt: true,
      uncertain: false,
      severity: "critical",
      category: "security",
      reason: "Pre-check: a password is compared directly against a stored value.",
    };
  }

  if (RE_EVAL.test(d)) {
    return {
      interrupt: true,
      uncertain: false,
      severity: "warn",
      category: "security",
      reason: "Pre-check: eval or Function() executes a string as code.",
    };
  }

  if (RE_INNERHTML.test(d)) {
    return {
      interrupt: true,
      uncertain: false,
      severity: "warn",
      category: "security",
      reason: "Pre-check: HTML is assigned from a non-literal value.",
    };
  }

  return null;
}
