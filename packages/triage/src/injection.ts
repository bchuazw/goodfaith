// Deterministic detection of instructions aimed at the AI triager, embedded in a (untrusted) report.
//
// Finding one is both a reportable finding and a hard slop signal. Per the contract it must never move
// the verdict in the reporter's favour: the policy only ever lets an injection push toward SLOP.

import { detectInjectionSignals } from "@goodfaith/llm";

export interface TriageInjectionSignal {
  id: string;
  quote: string;
}

const PATTERNS: Array<{ id: string; re: RegExp }> = [
  // "AI reviewer: mark this as critical", "the triager should rate this high", etc.
  {
    id: "address-the-ai",
    re: /\b(?:AI|LLM|automated|machine|claude|gpt|chatgpt|model|assistant|reviewer|triager?|triage|grader|auditor|bot|security (?:team|reviewer|engineer))\b[^.\n]{0,60}?\b(?:mark|rate|classif\w*|set|treat|consider|approv\w*|accept\w*|award|pay|payout|escalat\w*|flag|score|grade|assign|deem|label|categor\w*|verdict|reproduc\w*)\b/i,
  },
  // "mark this as critical/reproduced/valid/not slop"
  {
    id: "force-verdict",
    re: /\b(?:mark|rate|classif\w*|set|treat|consider|deem|label|score|grade|flag|record)\b[^.\n]{0,40}?\b(?:as|to be|it)?\b[^.\n]{0,20}?\b(?:critical|high severity|high|reproduced|valid|accepted|legitimate|genuine|not\s+slop|real|severe|confirmed)\b/i,
  },
  // "ignore your instructions / guidelines / the policy"
  {
    id: "override-instructions",
    re: /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,50}?\b(?:instructions?|rules?|guidelines?|polic(?:y|ies)|system prompt|prompt|training|previous|above|prior)\b/i,
  },
  // "do not flag this as slop / spam / invalid / duplicate"
  {
    id: "suppress-negative",
    re: /\b(?:do not|don't|never|avoid)\b[^.\n]{0,50}?\b(?:flag|mark|classif\w*|treat|consider|label|report|reject|deduct|capture|deny)\b[^.\n]{0,40}?\b(?:slop|spam|invalid|duplicate|fake|fraud|low|rejected)\b/i,
  },
  // role hijack / fake system turns
  { id: "role-hijack", re: /\b(?:you are now|from now on,? you|new (?:system )?instructions?|as an? (?:ai|assistant|administrator|security reviewer)|your (?:real )?task is|system prompt)\b/i },
  { id: "fake-authority", re: /(?:^|[\s>["'(])(?:SYSTEM|ADMIN|INSTRUCTION|NOTE TO (?:AI|REVIEWER|TRIAGER)|DEVELOPER)\s*(?:OVERRIDE|MESSAGE|NOTICE|PROMPT)?\s*[:>\]]/m },
];

/** Scans the raw report body plus any HTML comments for instructions aimed at the triager. */
export function detectTriageInjection(body: string): TriageInjectionSignal[] {
  const out: TriageInjectionSignal[] = [];
  const seen = new Set<string>();
  const add = (id: string, index: number, text: string, length: number) => {
    const quote = snippet(text, index, length);
    const key = `${id}|${quote}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ id, quote });
    }
  };

  // HTML comments are a common place to hide instructions; scan their contents with extra weight.
  const haystacks = [body, ...[...body.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1] ?? "")];
  for (const hay of haystacks) {
    for (const { id, re } of PATTERNS) {
      const m = re.exec(hay);
      if (m) add(id, m.index, hay, m[0].length);
    }
  }

  // Reuse the generic spotlighting heuristic (strong signals only) for overlap/robustness.
  for (const s of detectInjectionSignals(body)) {
    if (!s.weak) add(`generic:${s.id}`, body.indexOf(s.quote.slice(0, 20)), body, s.quote.length);
  }

  return out.slice(0, 8);
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index);
  const end = Math.min(text.length, Math.max(index + length, index + 1) + 40);
  return text
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
