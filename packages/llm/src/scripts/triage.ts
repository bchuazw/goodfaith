/**
 * Deterministic triage heuristics for the zero-key demo. These replace the old shopping-agent
 * scripts: instead of driving a buyer, they read a security report (and the deterministic evidence
 * Good Faith has already computed) and produce the three structured outputs the triage engine asks
 * for — claim extraction, a slop/severity assessment and a duplicate-similarity score.
 *
 * Everything here is a pure function of the prompt text, so the scripted provider gives the same
 * answer every run. The report body is untrusted and arrives quarantined; we decode it only to read
 * it as data, never as instructions.
 */
import type { ScriptContext } from "../types.js";
import { detectInjectionSignals, unquarantine } from "../untrusted.js";

// ---------------------------------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------------------------------

/** The readable text of a prompt: decoded untrusted blocks plus any surrounding trusted text. */
function readableText(prompt: string): string {
  const blocks = unquarantine(prompt);
  const untrusted = blocks.map((b) => b.content).join("\n");
  // Keep the trusted remainder too (title, evidence) so claim parsing sees everything.
  const trusted = prompt.replace(/<<<UNTRUSTED_DATA[\s\S]*?<<<END_UNTRUSTED_DATA id="[0-9a-z]+">>>/g, " ");
  return `${trusted}\n${untrusted}`;
}

/** The untrusted body only (decoded), or the whole prompt if nothing was quarantined. */
function untrustedBody(prompt: string): string {
  const blocks = unquarantine(prompt);
  return blocks.length > 0 ? blocks.map((b) => b.content).join("\n") : prompt;
}

const CWE_BY_KEYWORD: Array<{ re: RegExp; cwe: string }> = [
  { re: /\bIDOR\b|insecure direct object reference|broken object level|\bBOLA\b|missing (?:an )?owner(?:ship)? check|authori[sz]ation bypass/i, cwe: "CWE-639 Authorization Bypass Through User-Controlled Key" },
  { re: /path traversal|directory traversal|\.\.\/|\bLFI\b|arbitrary file read/i, cwe: "CWE-22 Improper Limitation of a Pathname to a Restricted Directory" },
  { re: /mass assignment|auto[- ]?binding|over[- ]?posting|privilege escalation|\brole\b.*\badmin\b/i, cwe: "CWE-915 Improperly Controlled Modification of Object Attributes" },
  { re: /\bXSS\b|cross[- ]site scripting/i, cwe: "CWE-79 Cross-site Scripting" },
  { re: /\bSQL injection\b|\bSQLi\b/i, cwe: "CWE-89 SQL Injection" },
  { re: /\bSSRF\b|server[- ]side request forgery/i, cwe: "CWE-918 Server-Side Request Forgery" },
  { re: /\bCSRF\b|cross[- ]site request forgery/i, cwe: "CWE-352 Cross-Site Request Forgery" },
];

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|hpp|py|go|rb|rs|java|php)$/i;

export interface ClaimsBag {
  version?: string;
  vulnClass?: string;
  components: Array<{ path: string; symbol?: string; line?: number }>;
  impact: string;
  preconditions: string[];
  poc?: { steps: Array<{ method: string; path: string; as?: string; body?: string }> };
  severityClaim?: string;
}

// ---------------------------------------------------------------------------------------------------
// 1. Claim extraction
// ---------------------------------------------------------------------------------------------------

export function extractClaimsFromReport(prompt: string): ClaimsBag {
  const text = readableText(prompt);
  const body = untrustedBody(prompt);

  const version = /\b(?:v(?:ersion)?\s*|against\s+\w*\s*|lantern\s+|curl\s+)?(\d+\.\d+\.\d+)\b/i.exec(text)?.[1];
  const vulnClass = extractVulnClass(text);
  const components = extractComponents(body);
  const poc = extractPoc(body);
  const impact = extractImpact(body);
  const preconditions = extractPreconditions(body);
  const severityClaim = /\b(critical|high|medium|low)\b\s*(?:severity|impact)?/i.exec(text)?.[1]?.toLowerCase();

  const bag: ClaimsBag = { components, impact, preconditions };
  if (version) bag.version = version;
  if (vulnClass) bag.vulnClass = vulnClass;
  if (poc) bag.poc = poc;
  if (severityClaim) bag.severityClaim = severityClaim;
  return bag;
}

function extractVulnClass(text: string): string | undefined {
  const explicit = /\bCWE-\d+\b(?:[:\s]+[A-Za-z][\w ,'/()-]{0,70})?/i.exec(text)?.[0];
  if (explicit) return explicit.replace(/\s+/g, " ").replace(/[\s)\].,;]+$/, "").trim();
  for (const { re, cwe } of CWE_BY_KEYWORD) if (re.test(text)) return cwe;
  return undefined;
}

function extractComponents(body: string): Array<{ path: string; symbol?: string; line?: number }> {
  const out: Array<{ path: string; symbol?: string; line?: number }> = [];
  const seen = new Set<string>();
  const push = (c: { path: string; symbol?: string; line?: number }) => {
    const key = `${c.path}|${c.symbol ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  };

  // "symbol() in path" or "symbol in path" — pair a function with the file that holds it.
  for (const m of body.matchAll(/`?([A-Za-z_$][\w$]*)(?:\(\))?`?[ \t]+(?:in|of|within|inside|at)[ \t]+`?([\w./-]+)`?/g)) {
    const symbol = m[1] as string;
    const path = (m[2] as string).replace(/[.,;:]+$/, "");
    if (SOURCE_EXT.test(path)) push({ path, symbol });
  }

  // Bare file paths.
  for (const m of body.matchAll(/`?((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|hpp|py|go|rb|rs|java|php))`?(?::(\d+))?/gi)) {
    const path = m[1] as string;
    const line = m[2] ? Number(m[2]) : undefined;
    push(line ? { path, line } : { path });
  }

  // Backticked or call-style symbols not already paired with a file.
  for (const m of body.matchAll(/`([A-Za-z_$][\w$]*)\(\)`|`([A-Za-z_$][\w$]{3,})`|\b([A-Za-z_$][\w$]{3,})\(\)/g)) {
    const symbol = (m[1] ?? m[2] ?? m[3]) as string;
    if (SOURCE_EXT.test(`x.${symbol}`)) continue;
    if (!out.some((c) => c.symbol === symbol)) push({ path: "", symbol });
  }

  return out;
}

function extractImpact(body: string): string {
  const sentences = body.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => /\b(impact|allows?|lets?|leads? to|results? in|exposes?|leaks?|discloses?|able to|can (?:read|access|escalate|modify|delete))\b/i.test(s));
  const chosen = (hit ?? sentences.find((s) => s.trim().length > 0) ?? "").trim();
  return chosen.length > 400 ? `${chosen.slice(0, 397)}...` : chosen;
}

function extractPreconditions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(?:precondition|prerequisite|requires?|assuming|given)\s*:?\s*([^\n.]{3,160})/gi)) {
    const text = (m[1] as string).trim();
    if (text) out.push(text);
  }
  return out.slice(0, 5);
}

// A method + path, either at the start of a line (`GET /api/x`) or inside a curl command
// (`curl -X PATCH https://host/api/x`). The host, if present, is dropped — paths are target-relative.
const HTTP_STEP = /(?:^|\s|`|\$)(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s'"]+)?(\/[^\s'"]*)/gi;

function extractPoc(body: string): { steps: Array<{ method: string; path: string; as?: string; body?: string }> } | undefined {
  const lines = body.split("\n");
  const steps: Array<{ method: string; path: string; as?: string; body?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    HTTP_STEP.lastIndex = 0;
    for (let m = HTTP_STEP.exec(line); m; m = HTTP_STEP.exec(line)) {
      const method = (m[1] as string).toUpperCase();
      const path = (m[2] as string).replace(/[).,;'"`]+$/, "");
      if (!path.startsWith("/") || path.startsWith("//")) continue;
      if (/\/:|[*]/.test(path)) continue; // a route template like /api/notes/:id, not an executable PoC step
      const context = `${line}\n${lines[i + 1] ?? ""}\n${lines[i + 2] ?? ""}`;
      const as = /\(?\bas[:\s]+(alice|bob|admin|anonymous|[a-z0-9_-]{2,32})\)?/i.exec(context)?.[1];
      let bodyText = /(?:-d|--data(?:-raw)?)\s+'([^']*)'/.exec(line)?.[1] ?? /(?:-d|--data(?:-raw)?)\s+"([^"]*)"/.exec(line)?.[1];
      if (!bodyText && method !== "GET") {
        const next = (lines[i + 1] ?? "").trim();
        if (/^\{.*\}$/.test(next)) bodyText = next;
      }
      const step: { method: string; path: string; as?: string; body?: string } = { method, path };
      if (as && as !== "anonymous") step.as = as;
      if (bodyText && method !== "GET") step.body = bodyText;
      steps.push(step);
    }
  }
  return steps.length > 0 ? { steps } : undefined;
}

// ---------------------------------------------------------------------------------------------------
// 2. Slop / severity assessment
// ---------------------------------------------------------------------------------------------------

export interface AssessBag {
  slopScore: number;
  slopReasons: string[];
  injectionSuspected: boolean;
  severity?: { level: string; cvss?: string; rationale: string };
}

/** Reads the trusted evidence lines Good Faith put in the prompt (`key: true/false/value`). */
function evidence(prompt: string): Map<string, string> {
  const map = new Map<string, string>();
  const section = /EVIDENCE[\s\S]*?(?:$|\n\n)/i.exec(prompt)?.[0] ?? prompt;
  for (const m of section.matchAll(/^\s*[-*]?\s*([a-z_]+)\s*:\s*([^\n]+)$/gim)) {
    map.set((m[1] as string).toLowerCase(), (m[2] as string).trim());
  }
  return map;
}

const truthy = (v: string | undefined) => v !== undefined && /^(true|yes|1)$/i.test(v.trim());

export function assessReport(ctx: Pick<ScriptContext, "user">): AssessBag {
  const ev = evidence(ctx.user);
  const body = untrustedBody(ctx.user);
  const detected = detectInjectionSignals(body).some((s) => !s.weak);
  const injectionSuspected = truthy(ev.get("injection_detected")) || detected;
  const canaryHit = truthy(ev.get("canary_hit"));

  let score = 0.1;
  const reasons: string[] = [];
  if (canaryHit) {
    score = 0.02;
    reasons.push("The PoC reproduced against the sandbox, so the report is not slop.");
  } else {
    if (ev.has("version_exists") && !truthy(ev.get("version_exists"))) {
      score += 0.5;
      reasons.push("The claimed version does not exist in the project.");
    }
    if (truthy(ev.get("hard_code_ref_failure"))) {
      score += 0.5;
      reasons.push("The primary cited code does not exist at the claimed version and has no near match.");
    }
    if (injectionSuspected) {
      score += 0.6;
      reasons.push("The report contains instructions aimed at the AI triager (a prompt-injection attempt).");
    }
    if (truthy(ev.get("impossible_impact"))) {
      score += 0.3;
      reasons.push("The claimed impact is inconsistent with how the cited code behaves.");
    }
    if (reasons.length === 0) reasons.push("No hard fabrication evidence was found; the claim is unverified rather than fabricated.");
  }
  const slopScore = Math.max(0, Math.min(1, score));
  const severity = suggestSeverity(ev.get("vuln_class"), canaryHit, ev.get("claimed_severity"));
  return { slopScore, slopReasons: reasons, injectionSuspected, ...(severity ? { severity } : {}) };
}

function suggestSeverity(vulnClass: string | undefined, canaryHit: boolean, claimed: string | undefined): AssessBag["severity"] | undefined {
  const cwe = vulnClass ?? "";
  if (/CWE-639|IDOR/i.test(cwe)) {
    return { level: "high", cvss: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N", rationale: "An authenticated user can read another user's private data by object id." };
  }
  if (/CWE-22|traversal/i.test(cwe)) {
    return { level: "high", cvss: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N", rationale: "Path traversal discloses server files (secrets.env) outside the upload directory." };
  }
  if (/CWE-915|mass assignment/i.test(cwe)) {
    return { level: "high", cvss: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N", rationale: "Mass assignment lets a normal user set their own role to administrator." };
  }
  if (claimed && /^(critical|high|medium|low)$/i.test(claimed)) {
    return { level: claimed.toLowerCase(), rationale: canaryHit ? "Matches the reporter's claimed severity and reproduced in the sandbox." : "Provisional, based on the reporter's claim; not independently reproduced." };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// 3. Duplicate similarity
// ---------------------------------------------------------------------------------------------------

export interface DuplicateBag {
  matches: Array<{ priorId: string; similarity: number }>;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9/_.-]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function scoreDuplicates(ctx: Pick<ScriptContext, "user">): DuplicateBag {
  const lines = ctx.user.split("\n");
  const newFields = parseFields(lines.find((l) => /^\s*NEW\s*:/i.test(l)) ?? "");
  const newText = tokens(`${newFields.title} ${newFields.summary}`);
  const matches: Array<{ priorId: string; similarity: number }> = [];
  for (const line of lines) {
    const m = /^\s*[-*]?\s*id\s*=\s*([^\s;]+)\s*;(.*)$/i.exec(line);
    if (!m) continue;
    const priorId = m[1] as string;
    const cand = parseFields(m[2] as string);
    // The DUPLICATE policy keys on same class + same primary component; weight those, and let the
    // title/summary overlap break ties. A bug of a different class/component can never reach 0.8.
    const classMatch = cweKey(newFields.class) !== "" && cweKey(newFields.class) === cweKey(cand.class);
    const compMatch = norm(newFields.component) !== "" && norm(newFields.component) === norm(cand.component);
    const textSim = jaccard(newText, tokens(`${cand.title} ${cand.summary}`));
    const similarity = Math.round((0.34 * (classMatch ? 1 : 0) + 0.34 * (compMatch ? 1 : 0) + 0.32 * textSim) * 100) / 100;
    matches.push({ priorId, similarity });
  }
  matches.sort((a, b) => b.similarity - a.similarity);
  return { matches };
}

function parseFields(line: string): { class: string; component: string; title: string; summary: string } {
  const get = (key: string) => new RegExp(`\\b${key}\\s*=\\s*([^;\\n]+)`, "i").exec(line)?.[1]?.trim() ?? "";
  return { class: get("class"), component: get("component"), title: get("title"), summary: get("summary") };
}

const norm = (s: string) => s.toLowerCase().replace(/[`'"\s]/g, "");
const cweKey = (s: string) => /cwe-\d+/i.exec(s)?.[0]?.toUpperCase() ?? norm(s);
