import { spawn, spawnSync } from "node:child_process";

/** Runs ffmpeg (or ffprobe) and rejects with the tail of stderr on failure. */
export function ff(argv: string[], bin = "ffmpeg"): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, bin === "ffmpeg" ? ["-hide_banner", "-y", "-loglevel", "error", ...argv] : argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve(out + err) : reject(new Error(`${bin} failed (${code}): ${err.slice(-2000)}`))));
  });
}

export function duration(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
  const d = Number.parseFloat(r.stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe could not read the duration of ${file}`);
  return d;
}

/** Integrated loudness (LUFS) of a file, from ffmpeg's ebur128 summary. */
export async function loudness(file: string): Promise<number> {
  const out = await new Promise<string>((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-filter_complex", "ebur128", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", () => resolve(err));
  });
  const m = [...out.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1);
  return m ? Number.parseFloat(m[1] as string) : Number.NaN;
}
