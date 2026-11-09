/**
 * HTML for every non-recorded frame: title cards, captions, the speed badge, the PayPal window frame and
 * the thumbnails. Fonts and colours mirror apps/web/app/globals.css (Geist, Geist Mono, Instrument Serif;
 * the ink-blue trust palette). No third-party logos: outlets and services appear as plain text.
 */

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=block" rel="stylesheet">';

const TOKENS = `
:root {
  --background: oklch(0.985 0.004 247);
  --foreground: oklch(0.21 0.03 264);
  --card: oklch(1 0 0);
  --primary: oklch(0.49 0.2 264);
  --primary-foreground: oklch(0.99 0 0);
  --muted: oklch(0.965 0.007 255);
  --muted-foreground: oklch(0.52 0.025 262);
  --accent: oklch(0.95 0.025 262);
  --border: oklch(0.915 0.01 255);
  --success: oklch(0.6 0.14 158);
  --success-strong: oklch(0.45 0.11 160);
  --success-soft: oklch(0.965 0.035 160);
  --warning: oklch(0.76 0.16 72);
  --warning-strong: oklch(0.5 0.12 62);
  --danger: oklch(0.58 0.21 25);
  --danger-strong: oklch(0.5 0.19 25);
  --danger-soft: oklch(0.968 0.022 25);
  --seal: oklch(0.74 0.12 80);
  --ink: oklch(0.26 0.1 266);
  --ink-foreground: oklch(0.97 0.01 260);
  --shadow: 0 1px 2px hsl(222 40% 20% / 0.08), 0 18px 48px -12px hsl(222 40% 20% / 0.22);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: Geist, system-ui, sans-serif; color: var(--foreground); -webkit-font-smoothing: antialiased; font-feature-settings: "ss01", "cv11"; }
.serif { font-family: "Instrument Serif", Georgia, serif; font-weight: 400; letter-spacing: -0.01em; }
.mono { font-family: "Geist Mono", ui-monospace, monospace; }
.frame { width: var(--w, 1920px); height: var(--h, 1080px); position: relative; overflow: hidden; }
.light { background: var(--background); }
.ink { background: var(--ink); color: var(--ink-foreground); }
.grid { background-image: linear-gradient(to right, color-mix(in oklch, currentColor 6%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklch, currentColor 6%, transparent) 1px, transparent 1px); background-size: 48px 48px; }
.label { font-family: "Geist Mono", monospace; font-size: 22px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted-foreground); }
`;

export function page(body: string, opts: { w?: number; h?: number; transparent?: boolean; css?: string } = {}): string {
  const w = opts.w ?? 1920;
  const h = opts.h ?? 1080;
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${TOKENS}
:root { --w: ${w}px; --h: ${h}px; }
body { background: ${opts.transparent ? "transparent" : "var(--background)"}; }
${opts.css ?? ""}</style></head><body>${body}</body></html>`;
}

/** The app's mark: a notched seal around a check (apps/web/components/brand.tsx). */
export function seal(size: number, fill = "var(--primary)", check = "var(--primary-foreground)"): string {
  const teeth = 16;
  const pts: string[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (Math.PI * i) / teeth - Math.PI / 2;
    const r = i % 2 === 0 ? 15.5 : 13.6;
    pts.push(`${(16 + r * Math.cos(a)).toFixed(2)},${(16 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}"><polygon points="${pts.join(" ")}" fill="${fill}"/><circle cx="16" cy="16" r="10.2" fill="none" stroke="${check}" stroke-opacity="0.45" stroke-width="1"/><path d="M11.2 16.4l3.2 3.1 6.6-7" fill="none" stroke="${check}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const wordmark = (size = 44, color = "currentColor") =>
  `<span style="display:inline-flex;align-items:center;gap:${size * 0.28}px;color:${color}">${seal(size * 1.05)}<span class="serif" style="font-size:${size}px;line-height:1">Good Faith</span></span>`;

// Icons (lucide paths, MIT): inline SVG so the cards need no network for icons.
const ICON = {
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
  check: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/><path d="m12 15 2 2 4-4"/>',
  x: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m14.5 9.5-5 5"/><path d="m9.5 9.5 5 5"/>',
  ff: '<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>',
};
const icon = (name: keyof typeof ICON, size: number, color = "currentColor", width = 1.8) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

// ---------------------------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------------------------

const SLOP_TITLES = [
  ["Critical", "Remote code execution in the HTTP/3 stream handler"],
  ["Critical", "Heap overflow in chunked transfer decoding"],
  ["High", "Authentication bypass via session token reuse"],
  ["Critical", "Use-after-free in connection pooling"],
  ["High", "Stack buffer overflow in URL glob expansion"],
  ["Critical", "Memory corruption in cookie parser (CVSS 9.8)"],
  ["High", "SSRF through redirect handling"],
  ["Critical", "Integer overflow in WebSocket frame length"],
  ["High", "Out-of-bounds read in header folding"],
  ["Critical", "Double free in TLS session cache"],
  ["High", "Race condition in DNS cache leads to RCE"],
  ["Critical", "Format string vulnerability in verbose logging"],
  ["High", "Timing side channel in password comparison"],
  ["Critical", "Arbitrary file write via content-disposition"],
  ["High", "Prototype pollution in config merge"],
  ["Critical", "Null dereference allows full takeover"],
];

export function hookFlood(): string {
  // Deterministic scatter: a pile of confident report cards, deeper ones fainter.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const cards = SLOP_TITLES.map(([sev, title], i) => {
    const x = -120 + rnd() * 1720;
    const y = -80 + rnd() * 900;
    const rot = -14 + rnd() * 28;
    const depth = i / SLOP_TITLES.length;
    const id = 40000 + Math.floor(rnd() * 59999);
    return `<div class="rc" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;transform:rotate(${rot.toFixed(1)}deg);opacity:${(0.55 + depth * 0.45).toFixed(2)};z-index:${i}">
      <div class="mono rc-h"><span>Report #${id}</span><span class="sev">${sev}</span></div>
      <div class="rc-t">${title}</div>
      <div class="bar" style="width:92%"></div><div class="bar" style="width:${(60 + rnd() * 30).toFixed(0)}%"></div><div class="bar" style="width:${(40 + rnd() * 40).toFixed(0)}%"></div>
      <div class="mono rc-f">Impact: complete compromise · PoC attached</div>
    </div>`;
  }).join("");
  return page(`<div class="frame ink grid">${cards}<div class="vignette"></div></div>`, {
    css: `.rc { position:absolute; width:520px; padding:26px 30px; border-radius:20px; background:var(--card); color:var(--foreground); box-shadow:0 30px 60px -20px rgb(0 0 0 / .55); }
.rc-h { display:flex; justify-content:space-between; font-size:17px; color:var(--muted-foreground); letter-spacing:.04em; }
.sev { color:var(--danger-strong); background:var(--danger-soft); padding:2px 10px; border-radius:999px; font-weight:600; }
.rc-t { font-size:27px; font-weight:600; line-height:1.25; margin:14px 0 18px; letter-spacing:-.01em; }
.bar { height:11px; border-radius:6px; background:var(--muted); margin:9px 0; }
.rc-f { font-size:15px; color:var(--muted-foreground); margin-top:16px; }
.vignette { position:absolute; inset:0; z-index:100; background:radial-gradient(ellipse at center, transparent 45%, color-mix(in oklch, var(--ink) 75%, transparent) 100%); }`,
  });
}

type Headline = { outlet: string; date: string; headline: string };
export const HEADLINES: { curl: Headline; ibb: Headline } = {
  curl: { outlet: "The Register", date: "21 Jan 2026", headline: "Curl shutters bug bounty program to remove incentive for submitting AI slop" },
  ibb: { outlet: "InfoWorld", date: "3 Apr 2026", headline: "Internet Bug Bounty program hits pause on payouts" },
};

export function hookHeadlines(which: "curl" | "ibb"): string {
  const card = (h: Headline, dim: boolean) => `<div class="hl${dim ? " dim" : ""}">
    <div class="mono hl-src">${h.outlet} · ${h.date}</div>
    <div class="serif hl-t">“${h.headline}”</div>
  </div>`;
  const body = which === "curl" ? card(HEADLINES.curl, false) : card(HEADLINES.curl, true) + card(HEADLINES.ibb, false);
  return page(`<div class="frame light grid"><div class="col"><div class="label">2026 · open-source security</div>${body}</div></div>`, {
    css: `.col { position:absolute; left:220px; right:220px; top:50%; transform:translateY(-50%); display:flex; flex-direction:column; gap:40px; }
.hl { background:var(--card); border-radius:24px; padding:44px 56px; box-shadow:var(--shadow); border-left:8px solid var(--danger); }
.hl.dim { opacity:.42; transform:scale(.97); transform-origin:left center; }
.hl-src { font-size:24px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted-foreground); }
.hl-t { font-size:78px; line-height:1.05; margin-top:14px; }`,
  });
}

// ---------------------------------------------------------------------------------------------
// The idea: one line from report to outcome
// ---------------------------------------------------------------------------------------------

export function ideaFlow(lit: 2 | 3): string {
  const node = (i: number, ic: keyof typeof ICON, title: string, sub: string, tone = "var(--primary)") => `<div class="node${i <= lit ? " on" : ""}">
      <div class="ic" style="color:${tone}">${icon(ic, 46, "currentColor", 1.8)}</div>
      <div class="nt">${title}</div><div class="ns">${sub}</div></div>`;
  const out = (ic: keyof typeof ICON, tone: string, soft: string, title: string, sub: string) => `<div class="out${lit >= 3 ? " on" : ""}" style="--tone:${tone};--soft:${soft}">
      <div class="oi">${icon(ic, 34, "currentColor", 2)}</div><div><div class="ot">${title}</div><div class="os">${sub}</div></div></div>`;
  return page(
    `<div class="frame light grid">
      <div class="top">${wordmark(46)}</div>
      <div class="serif head">Make false claims expensive,<br>and true ones <i style="color:var(--primary)">fast.</i></div>
      <div class="flow">
        ${node(1, "file", "Report", "Free to file. A bounty claim posts a deposit.")}
        <div class="link${lit >= 2 ? " on" : ""}"></div>
        ${node(2, "lock", "$20 hold", "PayPal authorization, not a charge", "var(--seal)")}
        <div class="link${lit >= 3 ? " on" : ""}"></div>
        ${node(3, "scan", "Claude reproduces", "Cited code checked · PoC replayed in a sandbox seeded with canaries")}
        <div class="fork${lit >= 3 ? " on" : ""}"></div>
        <div class="outs">
          ${out("check", "var(--success-strong)", "var(--success-soft)", "Reproduced", "Hold voided · bounty paid with PayPal Payouts")}
          ${out("copy", "var(--primary)", "var(--accent)", "Duplicate or honest miss", "Hold voided · nothing charged")}
          ${out("x", "var(--danger-strong)", "var(--danger-soft)", "Slop", "Deposit captured, after a maintainer confirms")}
        </div>
      </div>
    </div>`,
    {
      css: `.top { position:absolute; left:120px; top:84px; }
.head { position:absolute; left:120px; top:200px; font-size:88px; line-height:1.02; }
.flow { position:absolute; left:120px; right:120px; top:520px; display:flex; align-items:center; }
.node { width:300px; flex:none; background:var(--card); border-radius:22px; padding:30px 28px; box-shadow:var(--shadow); opacity:.28; filter:grayscale(1); }
.node.on { opacity:1; filter:none; }
.ic { width:76px; height:76px; border-radius:18px; background:var(--accent); display:flex; align-items:center; justify-content:center; }
.nt { font-size:34px; font-weight:600; margin-top:20px; letter-spacing:-.01em; }
.ns { font-size:21px; line-height:1.35; color:var(--muted-foreground); margin-top:8px; }
.link { flex:1; min-width:30px; height:4px; border-radius:2px; background:var(--border); }
.link.on { background:var(--primary); }
.fork { width:46px; height:4px; background:var(--border); flex:none; }
.fork.on { background:var(--primary); }
.outs { display:flex; flex-direction:column; gap:18px; width:520px; flex:none; }
.out { display:flex; gap:18px; align-items:center; background:var(--card); border-radius:18px; padding:20px 24px; box-shadow:var(--shadow); opacity:.28; filter:grayscale(1); border-left:6px solid var(--tone); }
.out.on { opacity:1; filter:none; }
.oi { width:58px; height:58px; flex:none; border-radius:14px; background:var(--soft); color:var(--tone); display:flex; align-items:center; justify-content:center; }
.ot { font-size:27px; font-weight:600; color:var(--tone); }
.os { font-size:20px; color:var(--muted-foreground); margin-top:4px; }`,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Proof: the eval numbers from the claims ledger (docs/PACKAGING.md §5)
// ---------------------------------------------------------------------------------------------

export function proofEvals(): string {
  const stat = (big: string, tone: string, title: string, sub: string) => `<div class="st" style="--tone:${tone}">
      <div class="big mono">${big}</div><div class="stt">${title}</div><div class="sts">${sub}</div></div>`;
  return page(
    `<div class="frame light grid">
      <div class="col">
        <div class="label">Measured, not claimed</div>
        <div class="serif head">Tested on curl's real reports</div>
        <div class="row">
          ${stat("0 of 5", "var(--success-strong)", "real curl CVE reports flagged as slop", "The control set: honest research is never charged by a machine.")}
          ${stat("2 of 10", "var(--danger-strong)", "published AI-slop reports caught on hard evidence", "They cite code that doesn't exist. The other 8 cite real code, so they go to a human.")}
          ${stat("30 / 30", "var(--primary)", "Lantern test corpus, scripted", "6 / 6 with live Claude Opus 5.5. 0 honest reports called slop.")}
        </div>
        <div class="mono foot">packages/triage/evals · results.curl.json, results.json, results.live.json · measured 24 Oct 2026</div>
      </div>
    </div>`,
    {
      css: `.col { position:absolute; left:140px; right:140px; top:50%; transform:translateY(-50%); }
.head { font-size:92px; line-height:1; margin:18px 0 60px; }
.row { display:grid; grid-template-columns:repeat(3,1fr); gap:36px; }
.st { background:var(--card); border-radius:26px; padding:44px 42px; box-shadow:var(--shadow); border-top:8px solid var(--tone); }
.big { font-size:104px; font-weight:600; letter-spacing:-.04em; color:var(--tone); line-height:1; }
.stt { font-size:31px; font-weight:600; line-height:1.25; margin-top:24px; }
.sts { font-size:23px; line-height:1.4; color:var(--muted-foreground); margin-top:14px; }
.foot { margin-top:48px; font-size:20px; color:var(--muted-foreground); }`,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------------------------

export function closePrinciples(): string {
  return page(
    `<div class="frame ink grid"><div class="col">
      <div class="serif l">Free reports stay free.</div>
      <div class="serif l">Good-faith research gets paid.</div>
      <div class="serif l"><i style="color:var(--seal)">Slop pays for itself.</i></div>
    </div></div>`,
    { css: `.col { position:absolute; left:220px; top:50%; transform:translateY(-50%); } .l { font-size:116px; line-height:1.12; }` },
  );
}

export function closeEnd(): string {
  return page(
    `<div class="frame light grid"><div class="col">
      ${wordmark(132)}
      <div class="tag">Bug bounties that survive the AI-slop era.</div>
      <div class="url mono">goodfaith-bounties.vercel.app</div>
      <div class="stack mono">PayPal Orders v2 · Payments · Payouts · Disputes · Webhooks · JS SDK v6<br>Claude Opus 5.5 · TypeScript · Next.js · AG Grid</div>
      <div class="small mono">Open source · Apache-2.0 · Built for the PayPal AI Hackathon</div>
    </div></div>`,
    {
      css: `.col { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
.tag { font-size:44px; color:var(--muted-foreground); margin-top:28px; }
.url { font-size:40px; color:var(--primary); margin-top:56px; font-weight:500; }
.stack { font-size:24px; line-height:1.7; color:var(--foreground); margin-top:44px; }
.small { font-size:19px; color:var(--muted-foreground); margin-top:30px; letter-spacing:.04em; }`,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------------------------

/** One caption cue, screenshotted tight (element bounds) with a transparent page. */
export function caption(text: string): string {
  return page(`<div id="cap">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`, {
    transparent: true,
    css: `#cap { display:inline-block; max-width:1480px; padding:14px 30px 16px; border-radius:16px; background:color-mix(in oklch, oklch(0.18 0.04 266) 86%, transparent); color:#fff; font-size:40px; font-weight:500; line-height:1.3; text-align:center; letter-spacing:-.005em; }`,
  });
}

export function speedBadge(speed: number): string {
  return page(`<div id="cap">${icon("ff", 26, "currentColor", 2.2)}<span>Sped up ${speed.toFixed(speed % 1 ? 1 : 0)}×</span><span class="dim">real run</span></div>`, {
    transparent: true,
    css: `#cap { display:inline-flex; align-items:center; gap:12px; padding:10px 20px; border-radius:999px; background:color-mix(in oklch, oklch(0.18 0.04 266) 82%, transparent); color:#fff; font-family:"Geist Mono", monospace; font-size:24px; font-weight:500; }
.dim { opacity:.65; }`,
  });
}

/** A neutral browser-window frame around the PayPal popup, showing its real host. */
export function popupFrame(w: number, h: number, host: string): string {
  return page(
    `<div id="cap" style="width:${w + 16}px;height:${h + 60}px"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="url mono">${icon("lock", 18, "currentColor", 2.2)} ${host}</span></div></div>`,
    {
      transparent: true,
      css: `#cap { border-radius:16px; background:oklch(0.97 0.006 255); box-shadow:0 40px 90px -20px rgb(0 0 0 / .55), 0 0 0 1px rgb(0 0 0 / .08); overflow:hidden; }
.bar { height:52px; display:flex; align-items:center; gap:18px; padding:0 18px; }
.dots i { display:inline-block; width:13px; height:13px; border-radius:50%; background:oklch(0.85 0.01 255); margin-right:7px; }
.url { flex:1; display:flex; align-items:center; gap:8px; justify-content:center; font-size:19px; color:var(--muted-foreground); background:var(--card); border-radius:10px; height:34px; margin-right:60px; }`,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Thumbnails: "Slop pays. Good faith gets paid." with the deposit-hold motif
// ---------------------------------------------------------------------------------------------

export function thumbnail(w: number, h: number): string {
  const s = Math.min(w / 1920, h / 1080) * (w / h < 1.6 ? 1.12 : 1);
  return page(
    `<div class="frame ink grid"><div class="wrap">
      <div class="left">
        <div class="wm">${wordmark(56 * s, "var(--ink-foreground)")}</div>
        <div class="serif t">Slop pays.<br><i>Good faith</i><br>gets paid.</div>
      </div>
      <div class="right">
        <div class="hold"><div class="hi">${icon("lock", 54 * s, "var(--seal)", 2)}</div><div><div class="ht mono">$20.00 hold</div><div class="hs">PayPal authorization · not a charge</div></div></div>
        <div class="stamp ok">${icon("check", 46 * s, "currentColor", 2.2)} REPRODUCED <span>$500 paid</span></div>
        <div class="stamp bad">${icon("x", 46 * s, "currentColor", 2.2)} SLOP <span>$20 captured</span></div>
      </div>
    </div></div>`,
    {
      w,
      h,
      css: `.wrap { position:absolute; inset:0; display:flex; align-items:center; padding:0 ${110 * s}px; gap:${70 * s}px; }
.left { flex:1.1; }
.wm { margin-bottom:${40 * s}px; }
.t { font-size:${168 * s}px; line-height:.95; color:var(--ink-foreground); }
.t i { color:var(--seal); }
.right { flex:1; display:flex; flex-direction:column; gap:${34 * s}px; }
.hold { display:flex; align-items:center; gap:${26 * s}px; background:var(--card); color:var(--foreground); border-radius:${26 * s}px; padding:${34 * s}px ${38 * s}px; box-shadow:0 30px 60px -20px rgb(0 0 0 / .6); }
.hi { width:${96 * s}px; height:${96 * s}px; border-radius:${22 * s}px; background:color-mix(in oklch, var(--seal) 18%, white); display:flex; align-items:center; justify-content:center; flex:none; }
.ht { font-size:${54 * s}px; font-weight:600; letter-spacing:-.02em; }
.hs { font-size:${26 * s}px; color:var(--muted-foreground); margin-top:${6 * s}px; }
.stamp { display:inline-flex; align-items:center; gap:${16 * s}px; align-self:flex-start; font-family:"Geist Mono", monospace; font-weight:700; letter-spacing:.14em; font-size:${46 * s}px; padding:${16 * s}px ${28 * s}px; border-radius:${16 * s}px; border:${5 * s}px solid currentColor; background:var(--card); }
.stamp span { font-weight:500; letter-spacing:0; font-size:${32 * s}px; opacity:.8; }
.ok { color:var(--success-strong); transform:rotate(-4deg); margin-left:${20 * s}px; }
.bad { color:var(--danger-strong); transform:rotate(3deg); margin-left:${60 * s}px; }`,
    },
  );
}

export const CARDS: Record<string, () => string> = {
  "hook-flood": hookFlood,
  "hook-curl": () => hookHeadlines("curl"),
  "hook-ibb": () => hookHeadlines("ibb"),
  "idea-hold": () => ideaFlow(2),
  "idea-flow": () => ideaFlow(3),
  "proof-evals": proofEvals,
  "close-principles": closePrinciples,
  "close-end": closeEnd,
};
