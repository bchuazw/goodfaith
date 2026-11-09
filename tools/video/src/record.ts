/**
 * Records the real app with Playwright, one video per segment (slop, real, proof) plus the PayPal popup as
 * its own page. Each segment logs markers (seconds from the start of its video) that script.json's beats cut
 * between, and the run saves the gallery screenshots.
 *
 *   pnpm --filter @goodfaith/video record -- --base http://localhost:3100 [--only slop,real] [--headed]
 *   pnpm --filter @goodfaith/video record -- --base https://goodfaith-bounties.vercel.app
 *
 * Capture: Chromium runs at a real device scale factor of 4/3 with a 1440x810 CSS viewport, so recordVideo
 * (and screenshots) get true 1920x1080 pixels of a 1440-wide layout. The sandbox buyer login comes from the
 * root .env.local (PAYPAL_SANDBOX_BUYER_EMAIL / _PASSWORD) and is typed into PayPal's own page, never logged.
 */
import fs from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright";
import { args, BASE_URL, ensureDir, env, RAW, SHOTS, secret } from "./env.js";

const VIEW = { width: 1440, height: 810 };
const POPUP = { width: 500, height: 760 };
const DSF = 4 / 3;

type Markers = Record<string, number>;
export type SegmentLog = {
  segment: string;
  base: string;
  recordedAt: string;
  video: string;
  markers: Markers;
  reportId?: string;
  popup?: { video: string; markers: Markers; cssSize: { width: number; height: number }; host: string };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Visible cursor: a dot that follows real mouse events, with a press ripple
// ---------------------------------------------------------------------------------------------

const CURSOR = `(() => {
  if (window.__gfCursor) return; window.__gfCursor = true;
  const install = () => {
    const dot = document.createElement("div");
    const ring = document.createElement("div");
    const base = { position: "fixed", left: "-100px", top: "-100px", borderRadius: "50%", pointerEvents: "none", zIndex: "2147483647" };
    Object.assign(dot.style, base, { width: "20px", height: "20px", marginLeft: "-10px", marginTop: "-10px", background: "rgba(42, 74, 222, 0.30)",
      border: "2px solid rgba(42, 74, 222, 0.95)", boxShadow: "0 0 0 2.5px rgba(255,255,255,0.9), 0 3px 10px rgba(0,0,0,0.28)", transition: "transform 110ms ease, background 110ms ease" });
    Object.assign(ring.style, base, { width: "44px", height: "44px", marginLeft: "-22px", marginTop: "-22px", border: "2px solid rgba(42, 74, 222, 0.7)", opacity: "0", transform: "scale(0.4)" });
    document.documentElement.append(ring, dot);
    const at = (x, y) => { for (const el of [dot, ring]) { el.style.left = x + "px"; el.style.top = y + "px"; } };
    addEventListener("mousemove", (e) => at(e.clientX, e.clientY), true);
    addEventListener("mousedown", (e) => {
      at(e.clientX, e.clientY);
      dot.style.transform = "scale(0.72)"; dot.style.background = "rgba(42, 74, 222, 0.6)";
      ring.animate([{ opacity: 0.9, transform: "scale(0.4)" }, { opacity: 0, transform: "scale(1.5)" }], { duration: 520, easing: "ease-out" });
    }, true);
    addEventListener("mouseup", () => { dot.style.transform = "scale(1)"; dot.style.background = "rgba(42, 74, 222, 0.30)"; }, true);
  };
  if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install);
})();`;

/**
 * Camera hygiene: blurs PayPal sandbox account emails wherever they render (PayPal's login, the maintainer
 * console's payer and payout rows), as the app's researcher view already does. CSSOM styles only, so it
 * works under PayPal's CSP and never changes what the page does.
 */
const MASK = `(() => {
  if (window.__gfMask) return; window.__gfMask = true;
  const RX = /@(personal|business)\.example\.com/i;
  const hide = (el) => {
    if (!el || el.__gfMasked) return; el.__gfMasked = true;
    el.style.setProperty("color", "transparent", "important");
    el.style.setProperty("text-shadow", "0 0 10px rgba(40, 44, 70, 0.8)", "important");
  };
  const scan = () => {
    for (const i of document.querySelectorAll("input")) {
      const key = (i.id + " " + i.name + " " + i.type + " " + (i.autocomplete || "")).toLowerCase();
      if (RX.test(i.value || "") || (/email|login/.test(key) && i.type !== "password" && i.value)) hide(i);
    }
    const root = document.body || document.documentElement;
    if (!root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (RX.test(n.nodeValue || "")) hide(n.parentElement);
  };
  setInterval(scan, 100);
  addEventListener("input", scan, true);
})();`;

// ---------------------------------------------------------------------------------------------
// Human pacing
// ---------------------------------------------------------------------------------------------

const cursorPos = new WeakMap<Page, { x: number; y: number }>();

async function glideTo(page: Page, x: number, y: number, ms = 650): Promise<void> {
  const from = cursorPos.get(page) ?? { x: VIEW.width * 0.62, y: VIEW.height * 0.55 };
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(ms / steps);
  }
  cursorPos.set(page, { x, y });
}

/** Re-shows the cursor after a navigation (the dot only appears on mouse events). */
async function wake(page: Page): Promise<void> {
  const p = cursorPos.get(page) ?? { x: VIEW.width * 0.62, y: VIEW.height * 0.55 };
  await page.mouse.move(p.x + 1, p.y + 1);
  await page.mouse.move(p.x, p.y);
}

/** Moves the cursor to the right-hand gutter, off the content. */
async function park(page: Page): Promise<void> {
  await glideTo(page, VIEW.width - 70, VIEW.height * 0.62, 500);
}

async function smoothScrollTo(page: Page, target: Locator | number, block: "start" | "center" = "center", offset = 0): Promise<void> {
  const top =
    typeof target === "number"
      ? target
      : await target.evaluate(
          (el, o) => {
            const r = el.getBoundingClientRect();
            const y = o.block === "start" ? r.top + window.scrollY - 96 : r.top + window.scrollY - (window.innerHeight - r.height) / 2;
            return Math.max(0, y + o.offset);
          },
          { block, offset },
        );
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: "smooth" }), top);
  // Wait until the scroll settles.
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await sleep(60);
    const y = await page.evaluate(() => window.scrollY);
    if (Math.abs(y - last) < 0.5) break;
    last = y;
  }
}

async function click(page: Page, target: Locator, opts: { pause?: number; scroll?: boolean } = {}): Promise<void> {
  await target.waitFor({ state: "visible", timeout: 60_000 });
  if (opts.scroll !== false) {
    const box = await target.boundingBox();
    if (!box || box.y < 70 || box.y + box.height > VIEW.height - 20) await smoothScrollTo(page, target);
  }
  const box = await target.boundingBox();
  if (!box) throw new Error("click target has no box");
  await glideTo(page, box.x + box.width / 2, box.y + box.height / 2);
  await sleep(opts.pause ?? 220);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}

// ---------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------

async function launch(headed: boolean): Promise<Browser> {
  return chromium.launch({
    channel: "chromium",
    headless: !headed,
    args: [`--force-device-scale-factor=${DSF}`, "--window-size=1600,1000", "--hide-scrollbars", "--disable-features=Translate"],
  });
}

async function sizePage(context: BrowserContext, page: Page, size: { width: number; height: number }): Promise<void> {
  const cdp = await context.newCDPSession(page);
  // deviceScaleFactor 0 keeps the browser's real (forced) scale factor, so captures are in device pixels.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
}

class Segment {
  markers: Markers = {};
  page!: Page;
  t0 = 0;
  reportId?: string;
  popup?: SegmentLog["popup"];
  constructor(
    readonly name: string,
    readonly context: BrowserContext,
    readonly base: string,
  ) {}

  async open(): Promise<Page> {
    this.page = await this.context.newPage();
    this.t0 = Date.now();
    await sizePage(this.context, this.page, VIEW);
    return this.page;
  }

  mark(name: string): void {
    this.markers[name] = (Date.now() - this.t0) / 1000;
    console.log(`  [${this.name}] ${name.padEnd(14)} ${this.markers[name].toFixed(1)}s`);
  }

  async goto(p: string): Promise<void> {
    await this.page.goto(this.base + p, { waitUntil: "load", timeout: 90_000 });
    await sleep(700);
    await wake(this.page);
  }

  async shot(name: string): Promise<void> {
    await this.page.screenshot({ path: path.join(ensureDir(SHOTS), `${name}.png`) });
  }

  async finish(): Promise<SegmentLog> {
    this.mark("end");
    await sleep(400);
    const video = this.page.video();
    await this.page.close();
    const dest = path.join(RAW, `${this.name}.webm`);
    await video?.saveAs(dest);
    await video?.delete();
    const log: SegmentLog = {
      segment: this.name,
      base: this.base,
      recordedAt: new Date().toISOString(),
      video: dest,
      markers: this.markers,
      ...(this.reportId ? { reportId: this.reportId } : {}),
      ...(this.popup ? { popup: this.popup } : {}),
    };
    fs.writeFileSync(path.join(RAW, `${this.name}.json`), `${JSON.stringify(log, null, 2)}\n`);
    return log;
  }
}

// ---------------------------------------------------------------------------------------------
// PayPal: the JS SDK v6 button opens PayPal's own window; log in as the sandbox buyer and approve
// ---------------------------------------------------------------------------------------------

async function approveInPayPal(seg: Segment, opts: { screenshot?: string } = {}): Promise<void> {
  const page = seg.page;
  const button = page.locator("paypal-button").first();
  await button.waitFor({ state: "visible", timeout: 60_000 });
  await smoothScrollTo(page, button);
  await sleep(500);
  const popupPromise = seg.context.waitForEvent("page", { timeout: 45_000 });
  seg.mark("paypal-click");
  await click(page, button, { scroll: false, pause: 350 });
  const popup = await popupPromise;
  const p0 = Date.now();
  const pm: Markers = {};
  const pmark = (n: string) => {
    pm[n] = (Date.now() - p0) / 1000;
    console.log(`  [${seg.name}:paypal] ${n.padEnd(10)} ${pm[n].toFixed(1)}s`);
  };
  await sizePage(seg.context, popup, POPUP);
  seg.mark("popup-open");
  cursorPos.set(popup, { x: POPUP.width / 2, y: POPUP.height * 0.7 });

  const email = secret("PAYPAL_SANDBOX_BUYER_EMAIL");
  const password = secret("PAYPAL_SANDBOX_BUYER_PASSWORD");
  const submit = popup.locator('#payment-submit-btn, [data-testid="submit-button-initial"], [data-id="payment-submit-btn"]').first();
  const deadline = Date.now() + 150_000;
  let host = "www.sandbox.paypal.com";
  let reviewed = false;
  while (!popup.isClosed()) {
    if (Date.now() > deadline) throw new Error("PayPal approval did not finish in 150 s");
    try {
      host = new URL(popup.url()).host || host;
    } catch {}
    try {
      if (await popup.locator("#acceptAllButton").isVisible()) {
        await click(popup, popup.locator("#acceptAllButton"), { scroll: false });
        continue;
      }
      const emailBox = popup.locator("#email");
      if ((await emailBox.isVisible()) && !(await emailBox.inputValue())) {
        await sleep(700);
        await click(popup, emailBox, { scroll: false });
        await emailBox.pressSequentially(email, { delay: 28 });
        pmark("email");
        const next = popup.locator("#btnNext");
        if (await next.isVisible()) await click(popup, next, { scroll: false });
        continue;
      }
      const pw = popup.locator("#password");
      if ((await pw.isVisible()) && !(await pw.inputValue())) {
        await click(popup, pw, { scroll: false });
        await pw.pressSequentially(password, { delay: 22 });
        pmark("password");
        await click(popup, popup.locator("#btnLogin"), { scroll: false });
        continue;
      }
      if (!reviewed && (await submit.isVisible()) && (await submit.isEnabled())) {
        reviewed = true;
        pmark("review");
        await sleep(1800); // let the $20.00 authorization read
        if (opts.screenshot) await popup.screenshot({ path: path.join(ensureDir(SHOTS), `${opts.screenshot}.png`) });
        await click(popup, submit, { scroll: true, pause: 400 });
        pmark("approve");
        continue;
      }
    } catch (e) {
      if (popup.isClosed()) break;
      if (!String(e).includes("closed")) console.log(`  paypal: ${String(e).split("\n")[0]}`);
    }
    await sleep(300);
  }
  pmark("closed");
  seg.mark("popup-close");
  const video = popup.video();
  const dest = path.join(RAW, `${seg.name}-popup.webm`);
  await video?.saveAs(dest);
  await video?.delete();
  seg.popup = { video: dest, markers: pm, cssSize: POPUP, host };
}

// ---------------------------------------------------------------------------------------------
// Live triage on the researcher's status page
// ---------------------------------------------------------------------------------------------

function stage(page: Page, label: string): Locator {
  return page.locator('ol[aria-live="polite"] > li').filter({ has: page.locator("h4", { hasText: label }) });
}

async function waitStage(seg: Segment, label: string, index: number, marker: string, follow = true): Promise<void> {
  const li = stage(seg.page, label);
  await Promise.race([
    li.getByText(`Step ${index} done`).waitFor({ state: "attached", timeout: 280_000 }),
    seg.page
      .getByText("Triage stopped:")
      .waitFor({ state: "attached", timeout: 280_000 })
      .then(async () => {
        throw new Error(`triage failed: ${await seg.page.getByText("Triage stopped:").innerText()}`);
      }),
  ]);
  seg.mark(marker);
  if (follow) await smoothScrollTo(seg.page, li, "center", 120);
  await park(seg.page);
}

async function waitVerdict(seg: Segment, expected: string): Promise<void> {
  const stamp = seg.page.locator('ol[aria-live="polite"] .stamp');
  await stamp.waitFor({ state: "visible", timeout: 280_000 });
  const label = (await stamp.innerText()).trim();
  seg.mark("verdict");
  if (!label.toUpperCase().includes(expected)) console.log(`  WARNING: expected ${expected}, the verdict is ${label}`);
  await smoothScrollTo(seg.page, stage(seg.page, "Verdict"), "center", 60);
}

async function submitExample(seg: Segment, example: string, show: (page: Page) => Promise<void>, shots: { form?: string; popup?: string }): Promise<void> {
  const page = seg.page;
  await seg.goto("/p/lantern/report");
  seg.mark("form");
  await sleep(1300);
  await click(page, page.getByRole("button", { name: example }));
  await sleep(700);
  seg.mark("example");
  await show(page);
  if (shots.form) await seg.shot(shots.form);
  await approveInPayPal(seg, shots.popup ? { screenshot: shots.popup } : {});
  await page.waitForURL(/\/r\/[^/?#]+/, { timeout: 90_000 });
  seg.reportId = new URL(page.url()).pathname.split("/").pop();
  seg.mark("status");
  await wake(page);
  await park(page);
}

// ---------------------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------------------

async function recordSlop(context: BrowserContext, base: string): Promise<SegmentLog> {
  const seg = new Segment("slop", context, base);
  const page = await seg.open();
  await submitExample(
    seg,
    "Polished AI slop",
    async (p) => {
      await smoothScrollTo(p, p.locator("#title"), "start", -40);
      await sleep(1200);
      await glideTo(p, 560, 560, 900);
      await sleep(1400);
    },
    { form: "1-report-form", popup: "paypal-popup" },
  );
  await sleep(600);
  await waitStage(seg, "Cited code exists", 3, "code-refs");
  await seg.shot("3-live-triage");
  await waitStage(seg, "Sandbox replay", 5, "replay");
  await waitVerdict(seg, "SLOP");
  await sleep(2600);

  await seg.goto(`/console/r/${seg.reportId}`);
  seg.mark("console");
  await sleep(1600);
  await seg.shot("4-slop-evidence");
  await click(page, page.getByRole("button", { name: /Capture the deposit/ }));
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await sleep(1400);
  await click(page, dialog.getByRole("checkbox"), { scroll: false });
  const confirm = dialog.locator("#capture-confirm");
  await click(page, confirm, { scroll: false });
  await confirm.pressSequentially("CAPTURE", { delay: 70 });
  await sleep(500);
  await click(page, dialog.getByRole("button", { name: /^Capture \$/ }), { scroll: false, pause: 350 });
  await page.getByText("Deposit captured").first().waitFor({ timeout: 60_000 });
  seg.mark("captured");
  await sleep(700);
  await glideTo(page, VIEW.width - 300, 420, 800);
  await sleep(2600);
  return seg.finish();
}

async function recordReal(context: BrowserContext, base: string): Promise<SegmentLog> {
  const seg = new Segment("real", context, base);
  const page = await seg.open();
  await submitExample(
    seg,
    "Real IDOR with an HTTP PoC",
    async (p) => {
      await smoothScrollTo(p, p.locator("#title"), "start", -40);
      await sleep(900);
      await smoothScrollTo(p, p.getByText("Proof of concept", { exact: true }).first(), "start", -20);
      await sleep(600);
      const path = p.locator('input[value="/api/notes/note_2"]').first();
      if (await path.isVisible().catch(() => false)) {
        const b = await path.boundingBox();
        if (b) await glideTo(p, b.x + b.width * 0.6, b.y + b.height / 2, 900);
      }
      await sleep(1600);
    },
    {},
  );
  await sleep(600);
  await waitStage(seg, "Cited code exists", 3, "code-refs", false);
  await waitStage(seg, "Sandbox replay", 5, "replay");
  await waitVerdict(seg, "REPRODUCED");
  // The replay transcript with the leaked canary, then the stamp.
  await smoothScrollTo(page, stage(page, "Sandbox replay"), "start", -10);
  await sleep(2200);
  await seg.shot("5-reproduced-replay");
  await smoothScrollTo(page, stage(page, "Verdict"), "center", 40);
  await sleep(1800);

  await seg.goto(`/console/r/${seg.reportId}`);
  seg.mark("console");
  await sleep(1400);
  await click(page, page.getByRole("button", { name: /Pay the bounty/ }));
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await sleep(2200);
  await click(page, dialog.getByRole("button", { name: /^Pay \$/ }), { scroll: false, pause: 350 });
  await page.getByText("Bounty sent with PayPal Payouts").first().waitFor({ timeout: 90_000 });
  seg.mark("paid");
  await sleep(900);
  // Payouts settle asynchronously: refresh from PayPal until the item leaves PENDING (or give up after ~40 s).
  const aside = page.locator("aside");
  for (let i = 0; i < 6; i++) {
    const text = await aside.innerText();
    if (/SUCCESS|UNCLAIMED|Paid|Succeeded/i.test(text) && !/PENDING/.test(text)) break;
    const refresh = page.getByRole("button", { name: /Refresh payout from PayPal/ });
    if (await refresh.isVisible().catch(() => false)) await click(page, refresh, { pause: 200 });
    await sleep(6000);
  }
  const payout = page.getByText("Sender batch").first();
  if (await payout.isVisible().catch(() => false)) await smoothScrollTo(page, payout, "center");
  await glideTo(page, VIEW.width - 260, 500, 700);
  await sleep(3200);
  return seg.finish();
}

async function recordProof(context: BrowserContext, base: string): Promise<SegmentLog> {
  const seg = new Segment("proof", context, base);
  const page = await seg.open();
  await seg.goto("/console");
  seg.mark("console");
  await page.locator(".ag-row").first().waitFor({ timeout: 30_000 }).catch(() => {});
  await sleep(1200);
  await seg.shot("6-console");
  const rows = page.locator(".ag-center-cols-container .ag-row");
  const n = Math.min(3, await rows.count());
  for (let i = 0; i < n; i++) {
    const b = await rows.nth(i).boundingBox();
    if (b) await glideTo(page, b.x + b.width * 0.35, b.y + b.height / 2, 600);
    await sleep(700);
  }
  await sleep(1000);
  await seg.goto("/p/lantern");
  const t = page.locator("#transparency");
  await t.waitFor({ state: "attached", timeout: 30_000 });
  await sleep(500);
  await smoothScrollTo(page, t, "start", -10);
  seg.mark("transparency");
  await seg.shot("7-transparency");
  await glideTo(page, 700, 420, 900);
  await sleep(3800);
  return seg.finish();
}

// ---------------------------------------------------------------------------------------------

const SEGMENTS: Record<string, (c: BrowserContext, base: string) => Promise<SegmentLog>> = { slop: recordSlop, real: recordReal, proof: recordProof };

async function main() {
  const a = args();
  const base = BASE_URL();
  const only = typeof a.only === "string" ? a.only.split(",") : Object.keys(SEGMENTS);
  ensureDir(RAW);
  const browser = await launch(!!a.headed);
  const context = await browser.newContext({ viewport: null, colorScheme: "light", locale: "en-US", recordVideo: { dir: ensureDir(path.join(RAW, "tmp")), size: { width: 1920, height: 1080 } } });
  await context.addInitScript(CURSOR);
  await context.addInitScript(MASK);
  const token = env().GOODFAITH_MAINTAINER_TOKEN?.trim();
  if (token) await context.addCookies([{ name: "gf_maintainer", value: token, url: base }]);
  console.log(`recording ${only.join(", ")} from ${base}`);
  try {
    for (const name of only) {
      const fn = SEGMENTS[name];
      if (!fn) throw new Error(`unknown segment ${name}`);
      console.log(`segment ${name}`);
      await fn(context, base);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
