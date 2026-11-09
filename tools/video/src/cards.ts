/**
 * Renders the title cards named in script.json (plus the thumbnails) to out/cards/*.png.
 *   pnpm --filter @goodfaith/video cards
 */
import path from "node:path";
import { CARDS, ensureDir, OUT } from "./env.js";
import { closeRenderer, renderPng } from "./render.js";
import { beats, loadScript } from "./script.js";
import { CARDS as TEMPLATES, thumbnail } from "./templates.js";

export async function renderCards(): Promise<void> {
  ensureDir(CARDS);
  const wanted = new Set(beats(loadScript()).flatMap((b) => ("card" in b.visual ? [b.visual.card] : [])));
  for (const name of wanted) {
    const t = TEMPLATES[name];
    if (!t) throw new Error(`script.json uses card "${name}", which src/templates.ts does not define`);
    await renderPng(t(), path.join(CARDS, `${name}.png`));
    console.log(`card ${name}`);
  }
}

export async function renderThumbnails(): Promise<void> {
  const dir = ensureDir(OUT);
  await renderPng(thumbnail(1280, 720), path.join(dir, "thumbnail-youtube-16x9.png"), 1280, 720);
  await renderPng(thumbnail(1500, 1000), path.join(dir, "thumbnail-devpost-3x2.png"), 1500, 1000);
  console.log("thumbnails 16:9 (1280x720) and 3:2 (1500x1000)");
}

if (process.argv[1]?.endsWith("cards.ts")) {
  await renderCards();
  await renderThumbnails();
  await closeRenderer();
}
