import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, 'temporary screenshots');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome/Edge не найден. Установите Google Chrome.');
}

function nextScreenshotPath(label) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const existing = fs.readdirSync(OUT_DIR)
    .map((f) => f.match(/^screenshot-(\d+)/))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  const suffix = label ? `-${label}` : '';
  return path.join(OUT_DIR, `screenshot-${next}${suffix}.png`);
}

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] || '';
const widthArg = process.argv[4] ? parseInt(process.argv[4], 10) : 1440;
const heightArg = process.argv[5] ? parseInt(process.argv[5], 10) : 900;
const fullPage = process.argv.includes('--full') || true;

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: widthArg, height: heightArg, deviceScaleFactor: widthArg < 600 ? 2 : 1 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));

  // Scroll through the whole page in small, frame-paced steps so
  // IntersectionObserver-based reveal animations fire reliably before
  // the full-page screenshot is taken (headless Chrome can otherwise
  // coalesce intersection checks during very fast/instant scrollTo jumps).
  await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const total = document.body.scrollHeight;
    const step = 220;
    for (let y = 0; y <= total; y += step) {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      await raf();
      await wait(45);
    }
    window.scrollTo({ top: total, left: 0, behavior: 'instant' });
    await raf();
    await wait(300);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await raf();
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));

  // Puppeteer's fullPage capture resizes the viewport to the whole document
  // height; `position:fixed` elements then sometimes paint at a stale
  // mid-page offset instead of pinning to the top. Pin them via `absolute`
  // (computed against the unpositioned <body>, so the coordinates match)
  // only for this screenshot — does not affect the real, live page.
  if (fullPage) {
    await page.addStyleTag({
      content: `#site-header,#mobile-drawer,#mobile-backdrop,#scroll-top{position:absolute !important;}`,
    });
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  }

  // Chrome has a ~16384px max texture dimension measured in *device* pixels;
  // full-page screenshots taller than that (CSS height x deviceScaleFactor)
  // can come back tiled/corrupted (sections repeat). Past that, capture
  // viewport-tall segments instead of one shot.
  const deviceScaleFactor = widthArg < 600 ? 2 : 1;
  const docHeight = await page.evaluate(() => document.body.scrollHeight);
  const SAFE_MAX = Math.floor(15000 / deviceScaleFactor);

  if (fullPage && docHeight > SAFE_MAX) {
    const segments = Math.ceil(docHeight / heightArg);
    for (let i = 0; i < segments; i++) {
      // behavior:'instant' overrides the page's CSS `scroll-behavior:smooth`,
      // which otherwise animates window.scrollTo() and can leave the capture
      // mid-transition (segments end up out of order / overlapping).
      await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), i * heightArg);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
      const segPath = nextScreenshotPath(`${label || 'seg'}-part${i + 1}`);
      await page.screenshot({ path: segPath, fullPage: false });
      console.log('Saved:', segPath);
    }
  } else {
    const outPath = nextScreenshotPath(label);
    await page.screenshot({ path: outPath, fullPage });
    console.log('Saved:', outPath);
  }
} finally {
  await browser.close();
}
