/**
 * Assembles out/goodfaith-demo.mp4 (1080p30 H.264 + AAC, narration at -16 LUFS) and out/goodfaith-demo.srt
 * from script.json, out/narration.json (tts), out/cards (cards) and out/raw (record).
 *
 *   pnpm --filter @goodfaith/video assemble
 *
 * Timing: each beat lasts max(minSeconds, lead + narration + tail). Recorded windows are fitted to that:
 * sped up (badged "Sped up N×" from 1.25×), cut, or held on their last frame. Beats from one continuous
 * recording hard-cut; everything else crossfades.
 */
import fs from "node:fs";
import path from "node:path";
import { type Cue, cues, srt } from "./captions.js";
import { CARDS, ensureDir, OUT, RAW } from "./env.js";
import { duration, ff, loudness } from "./ffmpeg.js";
import type { SegmentLog } from "./record.js";
import { closeRenderer, renderOverlay } from "./render.js";
import { type Beat, beats as allBeats, type Fit, loadScript } from "./script.js";
import { caption, popupFrame, speedBadge } from "./templates.js";

const W = 1920;
const H = 1080;
const FPS = 30;
const BUILD = path.join(OUT, "build");

type Narration = { voice: string; clips: Record<string, { file: string; seconds: number }> };
type Plan = Beat & {
  scene: string;
  index: number;
  narration_s: number;
  clip: string;
  lead: number;
  seconds: number;
  fadeIn: boolean;
  start: number;
  speed?: number;
  file?: string;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function segmentLog(name: string): SegmentLog {
  const file = path.join(RAW, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no recording for segment "${name}": run the record step (${file})`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as SegmentLog;
}

/** Window [from, to] of a source, fitted into `seconds`: returns the trim start, the speed and how long the source plays. */
function fit(from: number, to: number, seconds: number, mode: Fit = "speed", maxSpeed = 3): { start: number; speed: number; play: number } {
  const L = Math.max(0.1, to - from);
  if (mode === "head") return { start: from, speed: 1, play: Math.min(L, seconds) };
  if (mode === "tail") return { start: Math.max(from, to - seconds), speed: 1, play: Math.min(L, seconds) };
  const s = L / seconds;
  if (s <= 1) return { start: from, speed: 1, play: L };
  if (s <= maxSpeed) return { start: from, speed: s, play: L };
  return { start: to - seconds * maxSpeed, speed: maxSpeed, play: seconds * maxSpeed };
}

function continuous(prev: Beat | undefined, next: Beat): boolean {
  if (!prev) return false;
  const a = prev.visual;
  const b = next.visual;
  return "clip" in a && "clip" in b && a.clip === b.clip && a.to === b.from;
}

type Overlays = { inputs: string[]; chain: string; final: string };

/** Speed badge and caption cues as overlay inputs numbered from `first`; the chain starts from [base]. */
async function overlays(plan: Plan, beatCues: Cue[], first: number): Promise<Overlays> {
  const inputs: string[] = [];
  const steps: string[] = [];
  let label = "base";
  let n = first;
  const add = (file: string, x: string, y: string, enable?: string) => {
    inputs.push(file);
    const out = `o${n}`;
    steps.push(`[${label}][${n}:v]overlay=x=${x}:y=${y}${enable ? `:enable='${enable}'` : ""}:format=auto[${out}]`);
    label = out;
    n++;
  };
  if (plan.speed && plan.speed >= 1.25) {
    const b = await renderOverlay(speedBadge(Math.round(plan.speed * 2) / 2), "badge");
    add(b.file, `${W - b.w - 40}`, "40");
  }
  for (const c of beatCues) {
    const o = await renderOverlay(caption(c.text), "caption");
    add(o.file, `${Math.round((W - o.w) / 2)}`, `${H - o.h - 54}`, `between(t,${r3(c.start)},${r3(c.end)})`);
  }
  return { inputs, chain: steps.length ? `;${steps.join(";")}` : "", final: label };
}

async function renderBeat(plan: Plan, beatCues: Cue[]): Promise<string> {
  const out = path.join(ensureDir(path.join(BUILD, "beats")), `${plan.id}.mp4`);
  const D = r3(plan.seconds);
  const v = plan.visual;
  const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an", "-t", String(D)];
  const inputs = (o: Overlays) => o.inputs.flatMap((f) => ["-i", f]);

  if ("card" in v) {
    const png = path.join(CARDS, `${v.card}.png`);
    if (!fs.existsSync(png)) throw new Error(`missing card ${png}: run the cards step`);
    const ov = await overlays(plan, beatCues, 1);
    await ff(["-loop", "1", "-framerate", String(FPS), "-t", String(D), "-i", png, ...inputs(ov), "-filter_complex", `[0:v]scale=${W}:${H},setsar=1,format=yuv420p[base]${ov.chain}`, "-map", `[${ov.final}]`, ...enc, out]);
    return out;
  }

  if ("clip" in v) {
    const log = segmentLog(v.clip);
    const from = log.markers[v.from];
    const to = v.to === "end" ? log.markers.end : log.markers[v.to];
    if (from === undefined || to === undefined) throw new Error(`${plan.id}: markers ${v.from}/${v.to} missing in ${v.clip}.json`);
    const f = fit(from, to, D, v.fit, v.maxSpeed);
    plan.speed = f.speed;
    const ov = await overlays(plan, beatCues, 1);
    const hold = Math.max(0, D - f.play / f.speed + 0.1);
    const vf = `[0:v]trim=start=${r3(f.start)}:duration=${r3(f.play)},setpts=(PTS-STARTPTS)/${r3(f.speed)},fps=${FPS},scale=${W}:${H}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${r3(hold)},format=yuv420p[base]`;
    await ff(["-i", log.video, ...inputs(ov), "-filter_complex", `${vf}${ov.chain}`, "-map", `[${ov.final}]`, ...enc, out]);
    return out;
  }

  // The PayPal window: its own recording, composed over a dimmed still of the app at the moment it opened.
  const log = segmentLog(v.popup);
  if (!log.popup) throw new Error(`${v.popup}.json has no PayPal popup recording`);
  const pm = log.popup.markers;
  const end = (pm.approve ?? pm.closed ?? duration(log.popup.video)) + 0.7;
  const f = fit(0.3, Math.min(end, pm.closed ?? end), D, v.fit, v.maxSpeed);
  plan.speed = f.speed;
  const ov = await overlays(plan, beatCues, 3);
  const dsf = 4 / 3;
  const pw = Math.round(log.popup.cssSize.width * dsf);
  const ph = Math.round(log.popup.cssSize.height * dsf);
  const scale = Math.min(1, (H - 130 - 60) / ph);
  const sw = Math.round((pw * scale) / 2) * 2;
  const sh = Math.round((ph * scale) / 2) * 2;
  const frame = await renderOverlay(popupFrame(sw, sh, log.popup.host), "popupframe");
  const fx = Math.round((W - frame.w) / 2);
  const fy = Math.round((H - frame.h) / 2);
  const bgAt = r3(Math.max(0, (log.markers["popup-open"] ?? 0) + 0.4));
  const hold = Math.max(0, D - f.play / f.speed + 0.1);
  const graph = [
    `[0:v]trim=start=${bgAt}:duration=0.2,setpts=PTS-STARTPTS,fps=${FPS},scale=${W}:${H},setsar=1,gblur=sigma=7,eq=brightness=-0.16:saturation=0.7,tpad=stop_mode=clone:stop_duration=${r3(D + 1)}[bg]`,
    `[1:v]trim=start=${r3(f.start)}:duration=${r3(f.play)},setpts=(PTS-STARTPTS)/${r3(f.speed)},fps=${FPS},crop=${pw}:${ph}:0:0,scale=${sw}:${sh}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${r3(hold)}[pp]`,
    `[bg][2:v]overlay=x=${fx}:y=${fy}[bf]`,
    `[bf][pp]overlay=x=${fx + 8}:y=${fy + 52}:shortest=0,format=yuv420p[base]`,
  ].join(";");
  await ff(["-i", log.video, "-i", log.popup.video, "-i", frame.file, ...inputs(ov), "-filter_complex", `${graph}${ov.chain}`, "-map", `[${ov.final}]`, ...enc, out]);
  return out;
}

export async function assemble(): Promise<void> {
  const script = loadScript();
  const narrationFile = path.join(OUT, "narration.json");
  if (!fs.existsSync(narrationFile)) throw new Error("out/narration.json is missing: run the tts step");
  const narration = JSON.parse(fs.readFileSync(narrationFile, "utf8")) as Narration;
  const xf = script.crossfadeSeconds;
  const list = allBeats(script);

  // 1. The plan: durations, transitions and absolute start times.
  const plans: Plan[] = [];
  let length = 0;
  list.forEach((b, i) => {
    const clip = narration.clips[b.id];
    if (!clip) throw new Error(`no narration for ${b.id}: run the tts step`);
    const fadeIn = i > 0 && !continuous(list[i - 1], b);
    const next = list[i + 1];
    const fadeOut = !!next && !continuous(b, next);
    const lead = (i === 0 ? 0.6 : 0.12) + (fadeIn ? xf : 0);
    const tail = script.padSeconds + (fadeOut ? xf : 0) + (next && next.scene !== b.scene ? 0.35 : 0);
    const seconds = Math.max(b.minSeconds, lead + clip.seconds + tail);
    const start = fadeIn ? length - xf : length;
    plans.push({ ...b, index: i, narration_s: clip.seconds, clip: clip.file, lead, seconds, fadeIn, start });
    length = start + seconds;
  });

  // 2. Captions and beat videos.
  const allCues: Cue[] = [];
  for (const p of plans) {
    const local = cues(p.caption ?? p.narration, p.lead, p.narration_s);
    allCues.push(...local.map((c) => ({ ...c, start: c.start + p.start, end: c.end + p.start })));
    p.file = await renderBeat(p, local);
    console.log(`beat ${p.id.padEnd(17)} ${p.seconds.toFixed(2)}s at ${p.start.toFixed(2)}s${p.speed && p.speed > 1.01 ? `  (${p.speed.toFixed(2)}x)` : ""}`);
  }
  await closeRenderer();

  // 3. Video: crossfades and cuts, one filtergraph. xfade insists that both inputs share a timebase, and
  // concat emits 1/1000000 while fps emits 1/30, so every link is pinned to AVTB after each step.
  const vInputs = plans.flatMap((p) => ["-i", p.file as string]);
  const parts: string[] = plans.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,fps=${FPS},format=yuv420p,settb=AVTB[b${i}]`);
  let cur = "b0";
  let acc = plans[0]?.seconds ?? 0;
  for (let i = 1; i < plans.length; i++) {
    const p = plans[i] as Plan;
    const out = `v${i}`;
    if (p.fadeIn) {
      parts.push(`[${cur}][b${i}]xfade=transition=fade:duration=${xf}:offset=${r3(acc - xf)},settb=AVTB[${out}]`);
      acc += p.seconds - xf;
    } else {
      parts.push(`[${cur}][b${i}]concat=n=2:v=1:a=0,settb=AVTB[${out}]`);
      acc += p.seconds;
    }
    cur = out;
  }
  const silent = path.join(BUILD, "video.mp4");
  await ff([...vInputs, "-filter_complex", parts.join(";"), "-map", `[${cur}]`, "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS), silent]);
  const total = duration(silent);

  // 4. Narration: each clip at its absolute time, then two-pass loudnorm to -16 LUFS.
  const aInputs = plans.flatMap((p) => ["-i", p.clip]);
  const delays = plans.map((p, i) => `[${i}:a]aresample=48000,adelay=${Math.round((p.start + p.lead) * 1000)}:all=1[a${i}]`);
  const mix = `${delays.join(";")};${plans.map((_, i) => `[a${i}]`).join("")}amix=inputs=${plans.length}:normalize=0:dropout_transition=0,apad=whole_dur=${r3(total)}[mix]`;
  const rawAudio = path.join(BUILD, "narration-raw.wav");
  await ff([...aInputs, "-filter_complex", mix, "-map", "[mix]", "-t", String(r3(total)), "-ac", "2", "-c:a", "pcm_s16le", rawAudio]);
  const measure = await ff(["-i", rawAudio, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]).catch(async () => "");
  const json = /\{[\s\S]*?"input_i"[\s\S]*?\}/.exec(measure)?.[0];
  const m = json ? (JSON.parse(json) as Record<string, string>) : undefined;
  const ln = m
    ? `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : "loudnorm=I=-16:TP=-1.5:LRA=11";
  const audio = path.join(BUILD, "narration.wav");
  await ff(["-i", rawAudio, "-af", `${ln},aresample=48000`, "-ar", "48000", "-c:a", "pcm_s16le", audio]);

  // 5. Mux.
  const mp4 = path.join(OUT, "goodfaith-demo.mp4");
  await ff(["-i", silent, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", mp4]);
  fs.writeFileSync(path.join(OUT, "goodfaith-demo.srt"), srt(allCues));

  // 6. Report.
  const timings = script.scenes.map((sc) => {
    const ps = plans.filter((p) => p.scene === sc.id);
    const first = ps[0] as Plan;
    const last = ps.at(-1) as Plan;
    return { scene: sc.id, start: r3(first.start), end: r3(last.start + last.seconds), seconds: r3(last.start + last.seconds - first.start) };
  });
  const lufs = await loudness(mp4);
  const report = { file: mp4, seconds: r3(duration(mp4)), lufs, voice: narration.voice, scenes: timings, beats: plans.map((p) => ({ id: p.id, start: r3(p.start), seconds: r3(p.seconds), narration: r3(p.narration_s), speed: p.speed ? r3(p.speed) : 1 })) };
  fs.writeFileSync(path.join(OUT, "timings.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const t of timings) console.log(`${t.scene.padEnd(6)} ${t.start.toFixed(1).padStart(6)}s -> ${t.end.toFixed(1).padStart(6)}s  (${t.seconds.toFixed(1)}s)`);
  console.log(`${mp4}: ${report.seconds.toFixed(1)}s, ${lufs.toFixed(1)} LUFS`);
  if (report.seconds > script.targetSeconds) console.log(`WARNING: over the ${script.targetSeconds}s target`);
}

if (process.argv[1]?.endsWith("assemble.ts")) {
  assemble().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
