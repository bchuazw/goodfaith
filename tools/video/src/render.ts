/** Renders HTML templates to PNG with Playwright (fonts from Google Fonts, waited for before the shot). */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { CARDS as CARD_DIR, ensureDir } from "./env.js";

let browser: Browser | undefined;
let pageCache: Page | undefined;

async function pageFor(w: number, h: number): Promise<Page> {
  browser ??= await chromium.launch({ channel: "chromium" });
  if (!pageCache) pageCache = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await pageCache.setViewportSize({ width: w, height: h });
  return pageCache;
}

/** Full-frame render. */
export async function renderPng(html: string, file: string, w = 1920, h = 1080): Promise<string> {
  const page = await pageFor(w, h);
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, type: "png" });
  return file;
}

/** Tight render of #cap with a transparent background, cached by content hash. Returns path and size. */
export async function renderOverlay(html: string, kind: string): Promise<{ file: string; w: number; h: number }> {
  const dir = ensureDir(path.join(CARD_DIR, "overlays"));
  const key = crypto.createHash("sha256").update(html).digest("hex").slice(0, 14);
  const file = path.join(dir, `${kind}-${key}.png`);
  const meta = `${file}.json`;
  if (fs.existsSync(file) && fs.existsSync(meta)) return { file, ...(JSON.parse(fs.readFileSync(meta, "utf8")) as { w: number; h: number }) };
  const page = await pageFor(1920, 1080);
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const el = page.locator("#cap");
  await el.screenshot({ path: file, omitBackground: true });
  const box = await el.boundingBox();
  const size = { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) };
  fs.writeFileSync(meta, JSON.stringify(size));
  return { file, ...size };
}

export async function closeRenderer(): Promise<void> {
  await browser?.close();
  browser = undefined;
  pageCache = undefined;
}
