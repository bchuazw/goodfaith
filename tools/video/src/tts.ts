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

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/s+/).filter(Boolean);

/**
 * Did the clip say the line, and only the line? TTS models sometimes read the style note aloud, so the
 * transcript is compared with the text: no more than two extra words and 85% of the words present.
 */
export function matches(text: string, transcript: string): boolean {
  const want = norm(text);
  const got = norm(transcript);
  const have = new Set(got);
  const hit = want.filter((w) => have.has(w)).length / Math.max(1, want.length);
  return got.length <= want.length + 2 && hit >= 0.85;
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
          fs.rmSync(candidate);
          console.log(`  attempt ${attempt}: transcript does not match, regenerating ("${transcript.slice(0, 90)}")`);
          continue;
        }
        fs.renameSync(candidate, file);
        fs.writeFileSync(sidecar, JSON.stringify({ text, transcript, verified }));
        return { file, seconds: duration(file), model, voice: opts.voice, cached: false, ...(transcript ? { transcript } : {}), verified };
      } catch (e) {
        lastError = e;
        console.log(`  ${model} failed: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }
  }
  throw lastError;
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
