import fs from "node:fs";
import path from "node:path";
import { VIDEO_DIR } from "./env.js";

export type Visual =
  | { card: string }
  | { clip: string; from: string; to: string; fit?: Fit; maxSpeed?: number }
  | { popup: string; fit?: Fit; maxSpeed?: number };
/** speed: play faster (up to maxSpeed) to fit, then keep the tail; head/tail: cut to length; a short source holds its last frame. */
export type Fit = "speed" | "head" | "tail";

export type Beat = { id: string; narration: string; caption?: string; action: string; visual: Visual; minSeconds: number };
export type Scene = { id: string; title: string; action: string; minSeconds: number; beats: Beat[] };
export type Script = {
  title: string;
  targetSeconds: number;
  tts: { model: string; fallbacks: string[]; voice: string; auditionVoices: string[]; style: string };
  padSeconds: number;
  crossfadeSeconds: number;
  scenes: Scene[];
};

export function loadScript(file = path.join(VIDEO_DIR, "script.json")): Script {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Script;
}

export const beats = (s: Script): Array<Beat & { scene: string }> => s.scenes.flatMap((sc) => sc.beats.map((b) => ({ ...b, scene: sc.id })));

export const words = (t: string): number => t.split(/\s+/).filter(Boolean).length;
