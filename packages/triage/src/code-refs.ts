// Deterministic code-reference checks against a CodeSource.
//
// For every file/symbol the report cites, we confirm it exists at the claimed version. A symbol that
// is missing but within edit distance 2 of a real definition is treated as a typo (a note, routed to
// NEEDS_HUMAN), not fabrication. A symbol missing with no near match is hard evidence of slop.

import type { CodeLocation, CodeSource, Finding } from "@goodfaith/core";

export interface CodeRefResult {
  findings: Finding[];
  /** The primary cited symbol/file is missing at the version with no near match. */
  hardFailure: boolean;
  /** At least one cited symbol was a near match (typo) rather than an exact hit. */
  nearMatchOnly: boolean;
  /** Normalised key of the primary component, for duplicate comparison. */
  primaryComponent?: string;
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "typeof", "await", "const", "let", "var"]);

/** Levenshtein distance with an early cap (returns cap+1 once exceeded). */
export function editDistance(a: string, b: string, cap = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = curr;
  }
  return prev[b.length] ?? cap + 1;
}

const symbolCache = new Map<string, string[]>();

/** All top-level and method definition names in the source at `ref` (a generous superset). */
export async function definedSymbols(code: CodeSource, ref: string): Promise<string[]> {
  const key = `${code.id}@${ref}`;
  const cached = symbolCache.get(key);
  if (cached) return cached;
  const names = new Set<string>();
  const files = await code.listFiles(ref);
  const sourceRe = /\.(ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|hpp|py|go|rb|rs|java|php)$/i;
  for (const file of files) {
    if (!sourceRe.test(file)) continue;
    const content = (await code.readFile(file, ref)) ?? "";
    capture(content, /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, names);
    capture(content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, names);
    capture(content, /\b(?:class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g, names);
    capture(content, /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::[^;{]+)?\{/gm, names);
    capture(content, /\bdef\s+([A-Za-z_$][\w$]*)/g, names); // python/ruby
  }
  const list = [...names].filter((n) => !KEYWORDS.has(n));
  symbolCache.set(key, list);
  return list;
}

function capture(content: string, re: RegExp, into: Set<string>): void {
  for (const m of content.matchAll(re)) if (m[1]) into.add(m[1]);
}

/** Does `content` contain a *definition* of `name` (TS/JS, C/C++, Python/Ruby, or a #define)? */
export function definesSymbol(content: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    `\\b(?:async\\s+)?function\\s+${n}\\b`,
    `\\b(?:const|let|var)\\s+${n}\\s*=`,
    `\\b(?:class|interface|type|enum|namespace|struct)\\s+${n}\\b`,
    `\\b(?:def|func|fn|sub)\\s+${n}\\b`,
    `#\\s*define\\s+${n}\\b`,
    // method / C-function definition: optional return type / modifiers, then name(...) then { (same or next line).
    `(?:^|\\n)[ \\t]*(?:[A-Za-z_][\\w*&<>:\\] \\t]*?[ \\t*&]+)?${n}\\s*\\([^;]*\\)[\\s\\n]*\\{`,
    `(?:^|\\n)[ \\t]*(?:public|private|protected|static|readonly|override|async|get|set|[ \\t])*${n}\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?::[^;{]+)?\\{`,
  ];
  return patterns.some((p) => new RegExp(p).test(content));
}

/** Candidate identifier names in a file (definitions and call sites), for typo suggestions. */
export function fileSymbols(content: string): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(/g)) if (m[1] && !KEYWORDS.has(m[1])) names.add(m[1]);
  return [...names];
}

export function primaryComponentKey(components: CodeLocation[]): string | undefined {
  const c = components.find((x) => x.path || x.symbol);
  if (!c) return undefined;
  return (c.path || c.symbol || "").trim().toLowerCase();
}

export async function checkCodeRefs(components: CodeLocation[], ref: string, code: CodeSource): Promise<CodeRefResult> {
  const findings: Finding[] = [];
  let hardFailure = false;
  let nearMatchOnly = false;
  const symbols = components.some((c) => c.symbol && !c.path) ? await definedSymbols(code, ref) : null;

  for (let i = 0; i < components.length; i++) {
    const comp = components[i] as CodeLocation;
    const isPrimary = i === 0;

    if (comp.symbol) {
      // When the report also names the file, verify the definition in that file (works over the
      // GitHub API, where a global symbol scan is not feasible). Otherwise use findSymbol.
      if (comp.path) {
        const content = await code.readFile(comp.path, ref);
        if (content === undefined) {
          if (isPrimary) hardFailure = true;
          findings.push(fail("code_ref", `File ${comp.path} does not exist in ${ref}`, `The report cites ${comp.symbol}() in ${comp.path}, but that file is not present at this version.`, { path: comp.path, symbol: comp.symbol }));
          continue;
        }
        if (definesSymbol(content, comp.symbol)) {
          findings.push(pass("code_ref", `Symbol ${comp.symbol}() exists in ${comp.path} at ${ref}`, "Found a matching definition in the cited file.", { path: comp.path, symbol: comp.symbol }));
          continue;
        }
        const inFile = fileSymbols(content).find((s) => editDistance(comp.symbol as string, s) <= 2);
        if (inFile) {
          nearMatchOnly = true;
          findings.push(inconclusive("code_ref", `Symbol ${comp.symbol}() not found in ${comp.path}; did you mean ${inFile}()?`, "A similarly named definition exists in the cited file; treating as a possible typo.", { path: comp.path, symbol: comp.symbol, nearMatch: inFile }));
          continue;
        }
        if (isPrimary) hardFailure = true;
        findings.push(fail("code_ref", `Symbol ${comp.symbol}() does not exist in ${comp.path} at ${ref}`, `${comp.path} exists but defines no ${comp.symbol}, and nothing in it is close enough to be a typo.`, { path: comp.path, symbol: comp.symbol }));
        continue;
      }

      const locs = await code.findSymbol(comp.symbol, ref);
      if (locs.length > 0) {
        findings.push(pass("code_ref", `Symbol ${comp.symbol}() exists in ${ref}`, `Defined at ${locs.map((l) => `${l.path}:${l.line ?? "?"}`).join(", ")}.`, { symbol: comp.symbol, locations: locs }));
        continue;
      }
      const pool = symbols ?? (await definedSymbols(code, ref));
      if (pool.includes(comp.symbol)) {
        findings.push(pass("code_ref", `Symbol ${comp.symbol} exists in ${ref}`, "Found a matching definition.", { symbol: comp.symbol }));
        continue;
      }
      const near = pool.find((s) => editDistance(comp.symbol as string, s) <= 2);
      if (near) {
        nearMatchOnly = true;
        findings.push(inconclusive("code_ref", `Symbol ${comp.symbol}() not found in ${ref}; did you mean ${near}()?`, `No definition of ${comp.symbol} exists, but ${near} is within a typo's distance. Treating as a possible typo for a human to confirm.`, { symbol: comp.symbol, nearMatch: near }));
        continue;
      }
      if (isPrimary) hardFailure = true;
      findings.push(fail("code_ref", `Symbol ${comp.symbol}() does not exist in ${ref}`, `No definition of ${comp.symbol} exists in the source at ${ref}, and nothing is close enough to be a typo.`, { symbol: comp.symbol }));
      continue;
    }

    if (comp.path) {
      const content = await code.readFile(comp.path, ref);
      if (content !== undefined) {
        findings.push(pass("code_ref", `File ${comp.path} exists in ${ref}`, "The cited file is present at this version.", { path: comp.path }));
        continue;
      }
      const files = await code.listFiles(ref);
      const near = files.find((f) => editDistance(base(f), base(comp.path)) <= 2);
      if (near) {
        nearMatchOnly = true;
        findings.push(inconclusive("code_ref", `File ${comp.path} not found in ${ref}; did you mean ${near}?`, "The cited file does not exist, but a similarly named file does. Treating as a possible typo.", { path: comp.path, nearMatch: near }));
        continue;
      }
      if (isPrimary) hardFailure = true;
      findings.push(fail("code_ref", `File ${comp.path} does not exist in ${ref}`, "The cited file is not present at this version.", { path: comp.path }));
    }
  }

  return { findings, hardFailure, nearMatchOnly, primaryComponent: primaryComponentKey(components) };
}

function base(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function finding(kind: Finding["kind"], status: Finding["status"], title: string, detail: string, evidence?: Record<string, unknown>): Finding {
  return { kind, status, title, detail, ...(evidence ? { evidence } : {}) };
}
const pass = (k: Finding["kind"], t: string, d: string, e?: Record<string, unknown>) => finding(k, "pass", t, d, e);
const fail = (k: Finding["kind"], t: string, d: string, e?: Record<string, unknown>) => finding(k, "fail", t, d, e);
const inconclusive = (k: Finding["kind"], t: string, d: string, e?: Record<string, unknown>) => finding(k, "inconclusive", t, d, e);
