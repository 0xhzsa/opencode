/*
 * triage.ts - the deterministic part of Code Coach.
 *
 * Pure function. No model, no network, no editor dependency. Given the prompt
 * (or edit summary) and the diff about to land, it returns the findings worth
 * interrupting for, most severe first, capped at two. Silence is the default.
 *
 * Each finding carries its own teaching line (why) and its own fix, so the card
 * can render Explain why and Fix my prompt from the same object.
 */

export type Severity = "ignore" | "info" | "warn" | "critical";

export type Finding = {
  id: string;
  category: "security" | "correctness" | "maintainability";
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  tags: string[];
};

// A concept the learner has seen MASTERED_AT times should not be re-taught.
// Both the extension (via the profile) and the tests pass this list in; the
// engine drops those lessons automatically so silence stays the default.
export const MASTERED_AT = 3;

export type Decision =
  | { kind: "none" }
  | { kind: "nudge"; findings: Finding[] };

// Order matters: most severe first, capped at two in render. The numeric
// value is the severity rank (lower = more severe): 0 is critical, 9 is the
// least severe info note. Keep the keys in this map stable; adding a new
// finding type here is the only place it can change the render order.
const ORDER: Record<string, number> = {
  "sql-concat": 0,
  "shell-exec": 1,
  "secret-in-code": 2,
  "plaintext-password": 3,
  "xss": 4,
  "input-unvalidated": 5,
  "eval": 6,
  "no-try-catch": 7,
  "console-log": 8,
  "todo-leftover": 9,
};

function severityValue(s: Severity): number {
  return s === "critical" ? 3 : s === "warn" ? 2 : s === "info" ? 1 : 0;
}

// --- pattern helpers ------------------------------------------------------

const RE_SECRET_LITERAL =
  /((?:sk-[A-Za-z0-9_-]{1,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----))/;
const RE_PASSWORD_LITERAL = /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{6,}['"]/i;
const RE_SQL_CONCAT = /\b(query|execute|raw|sql)\s*\(|\$\{/i;
const RE_SQL_TAINT = /(req\b|req\.|request\.|user|input|search|q)\b/i;
// A request boundary that hands raw input past the validation gate: a req./request.
// access (req.query, req.body, ...) or an Express-style route/method call
// (route.get, app.post). Followed by the body/query/params/cookies field, it is
// the point where the shape of the data can change. A `.body` written in a
// test file, or a bare query string fragment, is not a request boundary and
// is not flagged.
const RE_REQUEST_BOUNDARY = /((?:req|request)\.(?:query|body|params|cookies)|(?:route|router|app|server)\.\w+\()/i;
const RE_INPUT_FIELD = /\.(body|query|params|cookies)\b/i;
const RE_SHELL_EXEC = /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/i;
const RE_INNERHTML = /\.innerHTML\s*=|\bouterHTML\s*=|dangerouslySetInnerHTML/i;
const RE_EVAL = /\beval\s*\(|\bFunction\s*\(/i;
const RE_CONSOLE = /\bconsole\.(log|info|debug|warn|error)\s*\(/i;
const RE_TODO = /\b(TODO|FIXME|XXX|HACK)\b/i;
const RE_PASSWORD_WORD = /\b(password|passwd|pwd|passphrase|credential|secret)\b/i;
const RE_HASH = /\b(bcrypt|argon2|scrypt|pbkdf2|hash|hashSync|createHash)\b/i;
const RE_RATE = /\b(rate[- ]?limit|throttle|lockout|attempts?\s+per|max[- ]?attempts|brute[- ]?force)/i;

// Words that mark a credential or authentication path: a login form, an API
// key check, a session creation -- anywhere secrets are at stake. Broader
// than the password words so the rate-limit finding fires on any of them,
// not only on password handling.
const RE_CREDENTIAL_PATH = /\b(login|sign?in|sign?up|logout|auth|api[_-]?key|password|passwd|pwd|token|credential|secret|session)\b/i;

// Words that mean "the input was already validated" so we do not flag a
// request boundary whose body/query/params were checked first.
const VALIDATION_KEYWORDS = /zod|yup|joi|ajv|schema|validate|allowlist|whitelist/i;

// A fallible call (fetch, .then, .json, a database write) sitting in a diff
// with no error handling that actually covers it. The check is local, not
// global: a .catch() chained onto the same promise silences the call, and a
// try/catch block that encloses the call silences it too. A try/catch on an
// unrelated statement, or a .catch() on a different promise elsewhere in the
// hunk, does NOT silence the finding.
const RE_FALLIBLE_CALL = /\b(fetch\s*\(|\.then\(|\.json\(|insertOne|insertMany|findOne|findById|save\s*\(|updateOne|deleteOne)/i;

// A line that opens a `try { ... }` block.
const isTryHead = (l: string): boolean => /^\s*try\s*\{/.test(l);

function hasFallibleCallWithoutTryCatch(diff: string): boolean {
  const lines = diff.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!RE_FALLIBLE_CALL.test(lines[i])) continue;
    if (isGuarded(i, lines)) continue;
    return true;
  }
  return false;
}

// Is the fallible call on `line` guarded? We walk back from the call line,
// tracking curly-brace depth so we can see whether a `try { ... }` block
// encloses it and has not closed by the call. A .catch() on the same
// promise, or a try/catch on another statement elsewhere in the hunk, does
// not silence the finding.
function isGuarded(callLine: number, lines: string[]): boolean {
  const line = lines[callLine];

  // Same-line guard: a .catch() chained onto the fallible call's promise, or
  // a try/catch pair that starts on this line before the call and still
  // encloses it. A try/catch on another statement, or a .catch() on a
  // different promise elsewhere in the hunk, does not silence the finding.
  const callPos = RE_FALLIBLE_CALL.exec(line)?.index ?? -1;
  const tryPos = line.search(/\btry\s*\{/);
  const catchPos = line.search(/\.catch\s*\(/);
  if (catchPos !== -1) {
    return true;
  }
  if (tryPos !== -1 && tryPos < callPos) {
    // The try block must enclose the call within the line: braces open at
    // the try's '{' and stay open past the call's position.
    let depth = 0;
    for (let k = tryPos; k < callPos; k++) {
      if (line[k] === "{") depth++;
      else if (line[k] === "}") depth--;
    }
    if (depth > 0) return true;
  }

  // Brace depth before each line.
  const open = (s: string) => (s.match(/{/g) ?? []).length;
  const close = (s: string) => (s.match(/}/g) ?? []).length;
  const d: number[] = [];
  let depth = 0;
  for (const l of lines) {
    d.push(depth);
    depth += open(l) - close(l);
  }
  const callDepth = d[callLine];

  for (let j = callLine - 1; j >= 0; j--) {
    if (!isTryHead(lines[j])) continue;
    if (d[j] >= callDepth) continue; // try opened at/under the call's depth
    const tryDepth = d[j];
    let closed = false;
    for (let k = j + 1; k < callLine; k++) {
      const after = d[k] + open(lines[k]) - close(lines[k]);
      if (after <= tryDepth) { closed = true; break; }
    }
    if (!closed) return true;
  }
  return false;
}

// --- findings -------------------------------------------------------------

function passwordFinding(): Finding {
  return {
    id: "plaintext-password",
    category: "security",
    severity: "warn",
    title: "Passwords would be compared in plaintext",
    why:
      "A hash is one-way: you store hash(password) with a per-user salt, and at login you hash what the user typed and compare in constant time. Even you can't recover the original from a hash.",
    fix:
      "Store bcrypt or argon2id with a per-user salt, compare with a constant-time function, and return generic errors so logins can't enumerate accounts.",
    tags: ["password-hashing"],
  };
}

function secretFinding(): Finding {
  return {
    id: "secret-in-code",
    category: "security",
    severity: "critical",
    title: "A secret is being committed",
    why:
      "Once a secret is in the diff it is in every clone, every backup, and every fork. Deleting the line does not delete it from history. It must never live in the repo.",
    fix:
      "Read it from an environment variable or a secret manager at runtime, and rotate the one that just landed.",
    tags: ["secrets"],
  };
}

function sqlFinding(): Finding {
  return {
    id: "sql-concat",
    category: "security",
    severity: "critical",
    title: "SQL built from input",
    why:
      "A query is code. When input is joined into the query string, the database can't tell your SQL from the input, so the input becomes code too.",
    fix:
      "Use parameterized queries or your ORM's query builder. Send the SQL and the values separately so the values are always treated as data.",
    tags: ["sql-injection"],
  };
}

function shellFinding(): Finding {
  return {
    id: "shell-exec",
    category: "security",
    severity: "critical",
    title: "Shell command built from input",
    why:
      "A shell interprets punctuation. If the input is pasted into the command string, the input can close your command and start another one.",
    fix:
      "Pass an argument array with shell disabled, and validate the input against an allowlist before it reaches exec.",
    tags: ["command-injection"],
  };
}

function xssFinding(): Finding {
  return {
    id: "xss",
    category: "security",
    severity: "warn",
    title: "User content rendered as HTML",
    why:
      "The browser cannot tell your markup from the user's markup once they are one string. A script tag in a comment then runs in every reader's browser.",
    fix:
      "Escape the output, or sanitize it with a library like DOMPurify before setting innerHTML.",
    tags: ["xss"],
  };
}

function unvalidatedFinding(): Finding {
  return {
    id: "input-unvalidated",
    category: "security",
    severity: "warn",
    title: "Input used without validation",
    why:
      "Every boundary is a place where the shape of the data can change. Validate at the boundary so the rest of the code can assume a known shape.",
    fix:
      "Validate against a schema (zod/yup) at the request boundary, and only pass the fields you expect downstream.",
    tags: ["input-validation"],
  };
}

function evalFinding(): Finding {
  return {
    id: "eval",
    category: "correctness",
    severity: "warn",
    title: "eval() runs untrusted text as code",
    why: "eval executes a string, so any input that reaches it is running as code in the process.",
    fix: "Replace eval with the parser you actually need — JSON.parse, a real templating engine, or explicit data fields.",
    tags: ["eval"],
  };
}

function tryCatchFinding(): Finding {
  return {
    id: "no-try-catch",
    category: "correctness",
    severity: "info",
    title: "A fallible call has no error handling",
    why: "Network, filesystem and database calls reject on failure. A swallowed or unhandled rejection leaves the session in a half-state that is expensive to debug.",
    fix: "Wrap the fallible call in try/catch (or .catch), and decide what the user actually sees on failure.",
    tags: ["error-handling"],
  };
}

function consoleFinding(): Finding {
  return {
    id: "console-log",
    category: "maintainability",
    severity: "info",
    title: "debug log left in the diff",
    why: "A stray console.log ships debug noise to the user's console and can leak sensitive values in production.",
    fix: "Remove it, or route it through your logger so it is off by default.",
    tags: ["debug-log"],
  };
}

function todoFinding(): Finding {
  return {
    id: "todo-leftover",
    category: "maintainability",
    severity: "info",
    title: "TODO left in the diff",
    why: "A TODO with no owner or deadline is technical debt that survives the PR.",
    fix: "Open an issue for it and remove the marker, or delete the line if it is dead.",
    tags: ["technical-debt"],
  };
}

// --- scorers --------------------------------------------------------------

export function score(prompt: string, diff: string, knownTags: string[] = []): Finding[] {
  const p = String(prompt ?? "");
  const d = String(diff ?? "");
  const found: Finding[] = [];
  if (!p && !d) {
    return found;
  }

  // Password handling is prompted, and the diff does not show hashing.
  if (RE_PASSWORD_WORD.test(p) && !RE_HASH.test(d)) {
    found.push(passwordFinding());
  }

  // Rate limiting on any credential or authentication path: a login form,
  // an API key check, a session creation -- anywhere secrets are at stake.
  // Broader than the password words so the finding is not locked to
  // password handling alone.
  if (RE_CREDENTIAL_PATH.test(p) && !RE_RATE.test(p) && !RE_RATE.test(d)) {
    if (!found.some((f) => f.id === "rate-limit")) {
      found.push({
        id: "rate-limit",
        category: "security",
        severity: "warn",
        title: "No rate limiting on the credential path",
        why:
          "A login without a limit lets a client try thousands of passwords a minute against one account. Per-IP and per-account limits with a short lockout turn that into a handful.",
        fix:
          "Rate-limit to 5 attempts per minute per IP and per account, and return generic errors.",
        tags: ["rate-limiting"],
      });
    }
  }

  if (RE_SECRET_LITERAL.test(d) || RE_PASSWORD_LITERAL.test(d)) {
    found.push(secretFinding());
  }

  if (RE_SQL_CONCAT.test(d) && RE_SQL_TAINT.test(d)) {
    found.push(sqlFinding());
  }

  if (RE_SHELL_EXEC.test(d)) {
    found.push(shellFinding());
  }

  if (RE_INNERHTML.test(d)) {
    found.push(xssFinding());
  }

  // Request boundary with an unvalidated input field: req./request. access or
  // an Express-style route/method call, and a body/query/params/cookies
  // field that reaches the rest of the code unchecked.
  if (RE_REQUEST_BOUNDARY.test(d) && RE_INPUT_FIELD.test(d) && !VALIDATION_KEYWORDS.test(d)) {
    found.push(unvalidatedFinding());
  }

  if (RE_EVAL.test(d)) {
    found.push(evalFinding());
  }

  if (hasFallibleCallWithoutTryCatch(d)) {
    found.push(tryCatchFinding());
  }

  if (RE_CONSOLE.test(d)) {
    found.push(consoleFinding());
  }

  if (RE_TODO.test(d)) {
    found.push(todoFinding());
  }

  // Drop duplicates, then order by severity *then* by the fixed order table so
  // the capped view always shows the most severe first.
  const seen = new Set<string>();
  const unique = found.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  unique.sort((a, b) => {
    const sa = ORDER[a.id] ?? 99;
    const sb = ORDER[b.id] ?? 99;
    return sa - sb;
  });

  // Don't teach something the profile already shows as mastered. The fix stays.
  return unique.filter((f) => f.tags.some((t) => !knownTags.includes(t)));
}

export function decide(prompt: string, diff: string, knownTags: string[] = []): Decision {
  const all = score(prompt, diff, knownTags);
  if (all.length === 0) {
    return { kind: "none" };
  }
  return { kind: "nudge", findings: all.slice(0, 2) };
}

