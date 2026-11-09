/** Caption cues: narration split at sentence and clause boundaries, timed in proportion to their length. */

const MAX = 62;

export function chunks(text: string): string[] {
  const sentences = text.match(/[^.!?:;]+[.!?:;]+["”]?|[^.!?:;]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    // Short sentences ride together; long ones split at a comma near the middle.
    if (buf && (buf + " " + s).length <= MAX) {
      buf = `${buf} ${s}`;
      continue;
    }
    if (buf) out.push(buf);
    buf = "";
    if (s.length <= MAX) {
      buf = s;
      continue;
    }
    let rest = s;
    while (rest.length > MAX) {
      const commas = [...rest.matchAll(/[,—–] /g)].map((m) => (m.index ?? 0) + 1).filter((i) => i > 14 && i < rest.length - 10);
      let cut = commas.sort((a, b) => Math.abs(a - rest.length / 2) - Math.abs(b - rest.length / 2))[0];
      if (cut === undefined || cut > MAX + 12) {
        const spaces = [...rest.matchAll(/ /g)].map((m) => m.index ?? 0).filter((i) => i <= MAX);
        cut = spaces.at(-1) ?? MAX;
      }
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    buf = rest;
  }
  if (buf) out.push(buf);
  return out;
}

export type Cue = { text: string; start: number; end: number };

/** Cues for one narration clip that starts at `start` and lasts `seconds`. */
export function cues(text: string, start: number, seconds: number): Cue[] {
  const parts = chunks(text);
  const weight = (s: string) => s.length + 6; // a little fixed cost per cue for the pause between them
  const total = parts.reduce((n, p) => n + weight(p), 0);
  let t = start;
  return parts.map((p) => {
    const d = (weight(p) / total) * seconds;
    const cue = { text: p, start: t, end: t + d };
    t += d;
    return cue;
  });
}

const stamp = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms % 1000, 3)}`;
};

export function srt(all: Cue[]): string {
  return `${all.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n")}`;
}
