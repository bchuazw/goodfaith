/**
 * Narration with Gemini TTS: one clip per beat of script.json, cached by a hash of (model, voice, style, text),
 * so only edited lines are regenerated. Writes out/narration.json with each clip's path and length.
 *
 *   pnpm --filter @goodfaith/video tts                 # all beats, with the voice from script.json
 *   pnpm --filter @goodfaith/video voices              # the hook line in each audition voice -> out/voices/
 *   ... tts --voice Kore                               # override the voice
 *
 * GEMINI_API_KEY comes from the root .env.local and is sent only to Google's API, in a header.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { args, CACHE, ensureDir, OUT, secret } from "./env.js";
import { duration, ff } from "./ffmpeg.js";
import { beats, loadScript, words } from "./script.js";
import { transcribe } from "./transcribe.js";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

type Clip = { file: string; seconds: number; model: string; voice: string; cached: boolean; transcript?: string; verified?: boolean };

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Numbers up to 9999 as the words a transcript would use ("20" -> "twenty", "500" -> "five hundred"). */
function numberWords(n: number): string {
  if (n < 20) return ONES[n] as string;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  if (n < 10000) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ""}`;
  return String(n);
}

/** Words of a line, with "$20" and "twenty-dollar" normalised to the same tokens. */
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/\$\s?(\d+)/g, (_, d: string) => `${d} dollar`)
    .replace(/\d+/g, (d) => numberWords(Number(d)))
    .replace(/dollars\b/g, "dollar")
    .replace(/[^a-z' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Share of the line's words heard in the transcript (0..1). */
export function similarity(text: string, transcript: string): number {
  const want = norm(text);
  const have = new Set(norm(transcript));
  return want.filter((w) => have.has(w)).length / Math.max(1, want.length);
}

/**
 * Did the clip say the line, and only the line? TTS models sometimes read the style note aloud, so the
 * transcript is compared with the text: no more than two extra words and 85% of the words present.
 */
export function matches(text: string, transcript: string): boolean {
  const got = norm(transcript);
  return got.length <= norm(text).length + 2 && similarity(text, transcript) >= 0.85;
}

/** A 16-bit PCM WAV header around raw little-endian samples. */
function wav(pcm: Buffer, rate = 24000, channels = 1): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function synthesize(model: string, voice: string, style: string, text: string): Promise<Buffer> {
  const body = {
    contents: [{ parts: [{ text: `${style}\n\n${text}` }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": secret("GEMINI_API_KEY") },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string } }> } }> };
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!part) throw new Error(`${model} returned no audio`);
      const data = Buffer.from(part.data, "base64");
      if (/wav/i.test(part.mimeType) || data.subarray(0, 4).toString() === "RIFF") return data;
      const rate = Number(/rate=(\d+)/.exec(part.mimeType)?.[1] ?? 24000);
      return wav(data, rate);
    }
    const text = await res.text();
    // Rate limits: honour the server's retry delay a few times before giving up on this model.
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const delay = Number(/"retryDelay":\s*"(\d+)/.exec(text)?.[1] ?? 20);
      console.log(`  ${model}: HTTP ${res.status}, retrying in ${delay}s`);
      await sleep((delay + 1) * 1000);
      continue;
    }
    throw new Error(`${model}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
}

/** Trims leading and trailing silence, keeping a short natural edge; resamples to 48 kHz mono. */
async function tidy(input: string, output: string): Promise<void> {
  const trim = "silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.06";
  await ff(["-i", input, "-af", `${trim},areverse,${trim},areverse,aresample=48000`, "-ac", "1", "-c:a", "pcm_s16le", output]);
}

export async function speak(text: string, opts: { voice: string; style: string; models: string[] }): Promise<Clip> {
  const dir = ensureDir(path.join(CACHE, "tts"));
  let lastError: unknown;
  // The closest take so far across models and attempts; used when no take verifies, rather than failing the run.
  let best: { file: string; model: string; transcript: string; score: number; target: string } | undefined;
  for (const model of opts.models) {
    const key = crypto.createHash("sha256").update(JSON.stringify([model, opts.voice, opts.style, text])).digest("hex").slice(0, 16);
    const file = path.join(dir, `${key}.wav`);
    const sidecar = `${file}.json`;
    if (fs.existsSync(file) && !fs.existsSync(sidecar)) {
      // A clip cached before verification existed: check it once.
      const transcript = await transcribe(file).catch(() => undefined);
      if (transcript !== undefined && !matches(text, transcript)) fs.rmSync(file);
      else fs.writeFileSync(sidecar, JSON.stringify({ text, transcript, verified: transcript !== undefined }));
    }
    if (fs.existsSync(file)) {
      const meta = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { transcript?: string; verified?: boolean };
      return { file, seconds: duration(file), model, voice: opts.voice, cached: true, ...meta };
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const raw = await synthesize(model, opts.voice, opts.style, text);
        const tmp = path.join(dir, `${key}.raw.wav`);
        fs.writeFileSync(tmp, raw);
        await tidy(tmp, tmp.replace(".raw.wav", ".try.wav"));
        fs.rmSync(tmp);
        const candidate = tmp.replace(".raw.wav", ".try.wav");
        let transcript: string | undefined;
        try {
          transcript = await transcribe(candidate);
        } catch (e) {
          console.log(`  could not verify (${e instanceof Error ? e.message.slice(0, 80) : e}); keeping the clip unverified`);
        }
        const verified = transcript === undefined ? false : matches(text, transcript);
        if (transcript !== undefined && !verified) {
          const score = matches(text, `${transcript}`) ? 1 : similarity(text, transcript) - (norm(transcript).length > norm(text).length + 2 ? 0.5 : 0);
          console.log(`  attempt ${attempt}: transcript does not match (${(score * 100).toFixed(0)}%), regenerating ("${transcript.slice(0, 90)}")`);
          if (!best || score > best.score) {
            if (best) fs.rmSync(best.file, { force: true });
            const kept = path.join(dir, `${key}.best.wav`);
            fs.renameSync(candidate, kept);
            best = { file: kept, model, transcript, score, target: file };
          } else {
            fs.rmSync(candidate);
          }
          continue;
        }
        fs.renameSync(candidate, file);
        fs.writeFileSync(sidecar, JSON.stringify({ text, transcript, verified }));
        if (best) fs.rmSync(best.file, { force: true });
        return { file, seconds: duration(file), model, voice: opts.voice, cached: false, ...(transcript ? { transcript } : {}), verified };
      } catch (e) {
        lastError = e;
        console.log(`  ${model} failed: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }
  }
  if (best) {
    // Nothing verified word for word: keep the closest take and say so, rather than stopping the pipeline.
    console.log(`  WARNING: no take verified; keeping the closest (${(best.score * 100).toFixed(0)}%, ${best.model}). Listen to it: "${best.transcript.slice(0, 120)}"`);
    fs.renameSync(best.file, best.target);
    fs.writeFileSync(`${best.target}.json`, JSON.stringify({ text, transcript: best.transcript, verified: false }));
    return { file: best.target, seconds: duration(best.target), model: best.model, voice: opts.voice, cached: false, transcript: best.transcript, verified: false };
  }
  throw lastError ?? new Error(`no model produced audio for "${text.slice(0, 60)}"`);
}

/** Asks Gemini (audio in) to rate the takes for a calm, credible narrator. A second opinion, not the decision. */
async function rateVoices(takes: Array<[string, string]>): Promise<string> {
  const parts: unknown[] = [];
  for (const [v, f] of takes) parts.push({ text: `Take "${v}":` }, { inlineData: { mimeType: "audio/wav", data: fs.readFileSync(f).toString("base64") } });
  parts.push({
    text: "These are narration takes for a hackathon demo video about a security product. Rate each take 1-10 for calm, credible, clear, and natural pacing, then name the best one for a trustworthy voice-over. Answer in four short lines.",
  });
  for (const model of ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.7-flash"]) {
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": secret("GEMINI_API_KEY") },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) continue;
    const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return `rating (${model}):
${j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? ""}`;
  }
  return "rating unavailable";
}

async function main() {
  const a = args();
  const script = loadScript();
  const models = [script.tts.model, ...script.tts.fallbacks];
  const style = script.tts.style;

  if (a.audition) {
    const dir = ensureDir(path.join(OUT, "voices"));
    const hook = script.scenes[0]?.beats.map((b) => b.narration).join(" ") ?? "";
    for (const voice of script.tts.auditionVoices) {
      const clip = await speak(hook, { voice, style, models });
      const dest = path.join(dir, `${voice}.wav`);
      fs.copyFileSync(clip.file, dest);
      console.log(`${voice.padEnd(8)} ${clip.seconds.toFixed(2)}s  ${((words(hook) / clip.seconds) * 60).toFixed(0)} wpm  verified=${clip.verified}  ${clip.model}${clip.cached ? " (cached)" : ""}  -> ${dest}`);
    }
    console.log(await rateVoices(script.tts.auditionVoices.map((v) => [v, path.join(dir, `${v}.wav`)])));
    return;
  }

  const voice = typeof a.voice === "string" ? a.voice : script.tts.voice;
  const manifest: Record<string, Clip & { scene: string; words: number }> = {};
  let total = 0;
  for (const b of beats(script)) {
    const clip = await speak(b.narration, { voice, style, models });
    manifest[b.id] = { ...clip, scene: b.scene, words: words(b.narration) };
    total += clip.seconds;
    console.log(`${b.id.padEnd(16)} ${clip.seconds.toFixed(2)}s  ${clip.model}${clip.cached ? " (cached)" : ""}`);
  }
  fs.writeFileSync(path.join(OUT, "narration.json"), `${JSON.stringify({ voice, generatedAt: new Date().toISOString(), clips: manifest }, null, 2)}\n`);
  const allWords = beats(script).reduce((n, b) => n + words(b.narration), 0);
  console.log(`narration ${total.toFixed(1)}s, ${allWords} words, ${((allWords / total) * 60).toFixed(0)} wpm`);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("tts.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
