const express = require('express');
const puppeteer = require('rebrowser-puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Browser instance ─────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  console.log('🚀 Launching stealth browser...');
  _browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1280, height: 720 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
    // rebrowser-puppeteer patch: disable Runtime.Enable to hide from Cloudflare
    env: { ...process.env, REBROWSER_PATCHES_RUNTIME_FIX_MODE: 'addBinding' },
  });
  _browser.on('disconnected', () => { _browser = null; });
  console.log('✅ Browser ready');
  return _browser;
}

// Pre-warm on startup
getBrowser().catch(e => console.error('Pre-launch failed:', e.message));

// ── Stealth patches ──────────────────────────────────────────
async function stealth(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });
  await page.evaluateOnNewDocument(() => {
    // Core stealth patches
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;
    window.chrome = {
      runtime: { id: undefined },
      loadTimes: () => {},
      csi: () => {},
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
    };
    Object.defineProperty(navigator, 'plugins', {
      get: () => Object.assign([{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
        { item: () => null, namedItem: () => null, refresh: () => {} }),
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    // Fix permissions
    const orig = window.navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = p =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : orig(p);
  });
}

// ── Try to solve Cloudflare Turnstile ───────────────────────
async function solveTurnstile(page) {
  try {
    // Find all iframes - Turnstile is inside one
    const frames = page.frames();
    for (const frame of frames) {
      const url = frame.url();
      if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
        console.log('Found Turnstile iframe, attempting interaction...');
        // Try clicking the checkbox
        await frame.waitForSelector('input[type="checkbox"]', { timeout: 3000 });
        await frame.click('input[type="checkbox"]');
        console.log('Clicked Turnstile checkbox');
        return true;
      }
    }
  } catch (_) {}

  // Try clicking on the main page Turnstile widget
  try {
    await page.waitForSelector('[data-sitekey]', { timeout: 3000 });
    await page.click('[data-sitekey]');
    console.log('Clicked Turnstile widget');
  } catch (_) {}

  return false;
}

// ── Detect if CF challenge is active ─────────────────────────
async function isCFActive(page) {
  try {
    const [title, body] = await Promise.all([
      page.title(),
      page.evaluate(() => document.body?.innerText || ''),
    ]);
    return (
      title.includes('Just a moment') ||
      title.includes('Attention Required') ||
      body.includes('Performing security verification') ||
      body.includes('Checking your browser') ||
      body.includes('Please wait') ||
      body.includes('Enable JavaScript and cookies') ||
      body.includes('verify you are human')
    );
  } catch { return false; }
}

// ── Rewrite HTML links through proxy ────────────────────────
function rewrite(html, origin, base) {
  html = html.replace(
    /(href|src|action)=["'](https?:\/\/[^"' >]+)["']/gi,
    (_, a, u) => `${a}="${base}${encodeURIComponent(u)}"`
  );
  html = html.replace(
    /(href|src|action)=["'](\/(?!\/)[^"']*|\/?)["']/gi,
    (m, a, u) => {
      try { return `${a}="${base}${encodeURIComponent(new URL(u, origin).href)}"`; }
      catch { return m; }
    }
  );
  const script = `<script>
(function(){
  var B=${JSON.stringify(base)},O=${JSON.stringify(origin)};
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');if(!a)return;
    var h=a.getAttribute('href');
    if(!h||h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('mailto:'))return;
    try{e.preventDefault();location.href=B+encodeURIComponent(new URL(h,O).href);}catch(e){}
  },true);
})();
</script>`;
  return html.replace('</head>', script + '</head>');
}

// ── Error page ────────────────────────────────────────────────
function errPage(msg) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Error</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;min-height:100vh;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;text-align:center;padding:24px}
.icon{font-size:56px}h2{color:#ef4444;font-size:1.3rem;font-weight:700}
p{color:#64748b;max-width:480px;line-height:1.7;font-size:.88rem}
a{margin-top:12px;padding:12px 32px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
</style></head>
<body>
  <div class="icon">⚠️</div>
  <h2>Failed to Load</h2>
  <p>${msg}</p>
  <a href="/">← Go Back</a>
</body></html>`;
}

// ── Cache ─────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30000;
const inProgress = new Map();

// ── PROXY ─────────────────────────────────────────────────────
app.get('/api', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');
  let parsed;
  try { parsed = new URL(target); } catch { return res.redirect('/'); }

  const origin = parsed.origin;
  const base = `${req.protocol}://${req.headers.host}/api?url=`;

  const cached = cache.get(target);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.set('Content-Type', 'text/html; charset=utf-8').send(cached.html);
  }

  if (inProgress.has(target)) {
    // Show a waiting page that auto-refreshes
    return res.status(202).send(`<!DOCTYPE html><html>
<head><meta charset="UTF-8"><meta http-equiv="refresh" content="5;url=/api?url=${encodeURIComponent(target)}">
<title>Loading...</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;
min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;text-align:center}
.spin{width:44px;height:44px;border:4px solid rgba(99,102,241,.2);border-top:4px solid #6366f1;
border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
p{color:#64748b;font-size:.9rem}a{color:#6366f1;text-decoration:none}</style></head>
<body><div class="spin"></div><p>Loading through gateway... auto-refreshing in 5s</p>
<a href="/">← Cancel</a></body></html>`);
  }

  inProgress.set(target, true);
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', r => {
      if (['media', 'font'].includes(r.resourceType())) return r.abort();
      r.continue();
    });

    await stealth(page);

    console.log(`→ Fetching: ${target}`);
    const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Try to solve CF challenge — up to 30 seconds
    for (let i = 0; i < 15; i++) {
      if (!(await isCFActive(page))) { console.log('✅ CF passed'); break; }
      if (i === 0) await solveTurnstile(page);
      console.log(`⏳ CF active (${i + 1}/15)...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    await new Promise(r => setTimeout(r, 1500));

    let html = await page.content();
    html = rewrite(html, origin, base);
    await page.close();
    inProgress.delete(target);
    cache.set(target, { html, time: Date.now() });

    res.status(resp?.status() || 200).set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (err) {
    if (page) await page.close().catch(() => {});
    inProgress.delete(target);
    console.error('[ERR]', err.message);
    res.status(500).send(errPage(`<b>${err.message}</b>`));
  }
});

app.get('/health', (_, res) => res.json({ ok: true, browser: !!_browser }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ FreeGate proxy on port ${PORT}`));