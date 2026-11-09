# Demo video pipeline

`tools/video` builds the demo video from the real app: Gemini TTS narration, Playwright recordings of the app and the PayPal sandbox window, HTML title cards and captions, and ffmpeg assembly. Everything it produces goes to `tools/video/out/`, which is gitignored.

## Prerequisites
- `pnpm install` at the repo root, then once: `pnpm --filter @goodfaith/video exec playwright install chromium`.
- `ffmpeg` and `ffprobe` on PATH (built with libx264).
- In the root `.env.local`: `GEMINI_API_KEY` (narration, plus transcript checks), and `PAYPAL_SANDBOX_BUYER_EMAIL` / `PAYPAL_SANDBOX_BUYER_PASSWORD` (typed into PayPal's own window). If the app sets `GOODFAITH_MAINTAINER_TOKEN`, put the same value there; the recorder sends it as the `gf_maintainer` cookie. The scripts never print these values.

## One command
```bash
pnpm --filter @goodfaith/video all -- --base https://goodfaith-bounties.vercel.app
```
This runs, in order: `tts` → `cards` → `record` → `assemble` → `assets`. Add `--skip-record` to reuse `out/raw`, or `--only slop,real` to re-record some segments.

## Steps
| Command (`pnpm --filter @goodfaith/video …`) | What it does | Output |
|---|---|---|
| `voices` | Reads the hook in each audition voice, checks each take by transcribing it, and asks Gemini for a second opinion | `out/voices/*.wav` |
| `tts` | One clip per beat of `script.json`, cached by a hash of (model, voice, style, text), each verified by transcript | `out/narration.json`, `out/cache/tts/` |
| `cards` | Title cards, captions' look, thumbnails (16:9 and 3:2), in the app's fonts and colours | `out/cards/`, `out/thumbnail-*.png` |
| `record -- --base <url>` | Drives the app: slop claim, real IDOR, console and transparency page. One video per segment, the PayPal window as its own video, and timing markers | `out/raw/*.webm`, `out/raw/*.json`, `out/screenshots/` |
| `assemble` | Fits each recorded window to its narration (speed-ups over 1.25× are labelled on screen), burns in captions, crossfades the scenes, normalises narration to −16 LUFS | `out/goodfaith-demo.mp4`, `.srt`, `out/timings.json` |
| `assets` | Six 1920×1080 gallery shots (with the PayPal window composed over the form) and the YouTube text | `out/gallery/`, `out/youtube.md` |

## Editing the script
`tools/video/script.json` holds the scenes. Each scene is split into beats, and each beat has its narration, the on-screen action, a minimum length, and a visual:
- `{ "card": "<name>" }` is a title card from `src/templates.ts`;
- `{ "clip": "<segment>", "from": "<marker>", "to": "<marker>" }` is a window of a recording (the markers are listed in `out/raw/<segment>.json`);
- `{ "popup": "<segment>" }` is the PayPal window.

Every factual line must match a claim marked verified or measured in `docs/PACKAGING.md` §5. Only edited lines are re-synthesised.

## Recording locally
Next 16 lets only one `next dev` run per checkout. If another one is already running, record from a separate worktree with a production build, on a non-default port and its own data file, so the console starts clean:
```bash
git worktree add --detach ../gf-video origin/main && (cd ../gf-video && pnpm install)
pnpm --filter @goodfaith/video serve -- --app ../gf-video --port 3100 --mode live --data ../gf-video-store.json --build
pnpm --filter @goodfaith/video all -- --base http://localhost:3100
```

## How the capture works
Chromium runs with a forced device scale factor of 4/3 and a 1440×810 CSS viewport (set over CDP with `deviceScaleFactor: 0`). As a result `recordVideo` and screenshots get real 1920×1080 pixels of a 1440-wide layout. Playwright's own `deviceScaleFactor` option does not do this: it records CSS pixels.

The recorder injects two things, with CSSOM styles only, so nothing the page does changes:
- a cursor dot with a click ripple;
- a blur over PayPal sandbox account emails, which PayPal's login and the maintainer console show in full.
