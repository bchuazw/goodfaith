/**
 * Verifies narration clips: Gemini transcribes each one, so a clip that read the style note aloud, skipped
 * words or garbled a name shows up as a text diff. Usage: tsx src/transcribe.ts <file.wav> [...]
 */
import fs from "node:fs";
import { secret } from "./env.js";

const MODELS = (process.env.TRANSCRIBE_MODELS ?? "gemini-3.5-flash,gemini-flash-latest,gemini-3.7-flash").split(",");

async function once(model: string, file: string): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": secret("GEMINI_API_KEY") },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: fs.readFileSync(file).toString("base64") } }, { text: "Transcribe this audio verbatim. Output only the words spoken." }] }],
    }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";
}

export async function transcribe(file: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 9; i++) {
    try {
      return await once(MODELS[i % MODELS.length] as string, file);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(last);
}

if (process.argv[1]?.endsWith("transcribe.ts")) {
  for (const f of process.argv.slice(2)) console.log(`${f}\n  ${await transcribe(f)}`);
}
