// The report form's "Affected code" field, read without an LLM. The web app stores the form as markdown
// sections (apps/web/lib/hero-reports.ts composeReportBody), so the field is the "## Affected code"
// section: one location per line, e.g. "- `src/notes.ts`, `registerNoteRoutes()`". Degraded mode cites
// these first, ahead of anything regex extraction finds in the rest of the body.

import type { CodeLocation } from "@goodfaith/core";

const FILE = /`?((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|hpp|py|go|rb|rs|java|php))`?(?::(\d+))?/i;
const SYMBOL = /`([A-Za-z_$][\w$]*)(?:\(\))?`|\b([A-Za-z_$][\w$]*)\(\)/g;

/** The text of the body's "Affected code" section, or undefined when it has none. */
export function affectedCodeSection(body: string): string | undefined {
  const heading = /^#{1,6}[ \t]*Affected code[ \t]*:?[ \t]*$/im.exec(body);
  if (!heading) return undefined;
  const rest = body.slice(heading.index + heading[0].length);
  const next = rest.search(/^#{1,6}[ \t]/m);
  const section = (next >= 0 ? rest.slice(0, next) : rest).trim();
  return section || undefined;
}

/** Code locations listed in the "Affected code" section: a file, a symbol, or a symbol in a file, per line. */
export function affectedCodeComponents(body: string): CodeLocation[] {
  const section = affectedCodeSection(body);
  if (!section) return [];
  const out: CodeLocation[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s*/, "");
    if (!line) continue;
    const file = FILE.exec(line);
    const path = file?.[1];
    const lineNo = file?.[2] ? Number(file[2]) : undefined;
    const symbols = [...new Set([...line.matchAll(SYMBOL)].map((m) => (m[1] ?? m[2]) as string))];
    if (path && symbols.length > 0) for (const symbol of symbols) out.push({ path, symbol, ...(lineNo ? { line: lineNo } : {}) });
    else if (path) out.push({ path, ...(lineNo ? { line: lineNo } : {}) });
    else for (const symbol of symbols) out.push({ path: "", symbol });
    if (out.length >= 20) break;
  }
  return out.slice(0, 20);
}
