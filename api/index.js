const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Pre-launch browser on startup ────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  console.log('🚀 Launching browser...');
  _browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
    defaultViewport: { width: 1280, height: 720 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  _browser.on('disconnected', () => {
    console.log('⚠️ Browser disconnected, will relaunch on next request');
    _browser = null;
  });
  console.log('✅ Browser ready');
  return _browser;
}

// Pre-warm browser immediately on startup
getBrowser().catch(err => console.error('Browser pre-launch failed:', err.message));

// ── Stealth patches ──────────────────────────────────────────
async function stealth(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

// ── Rewrite all links through proxy ─────────────────────────
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

// ── Loading page (shown immediately while proxy fetches) ──────
function loadingPage(target) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Loading...</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;min-height:100vh;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:20px;text-align:center;padding:24px}
.spinner{width:48px;height:48px;border:4px solid rgba(99,102,241,0.2);
  border-top:4px solid #6366f1;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:1.3rem;font-weight:700;color:#f1f5f9}
p{color:#64748b;font-size:0.9rem;max-width:360px;line-height:1.6}
.url{color:#6366f1;font-size:0.85rem;word-break:break-all;max-width:420px}
a{margin-top:8px;padding:10px 24px;background:#1e293b;color:#94a3b8;border-radius:10px;
  text-decoration:none;font-size:0.85rem}
</style></head>
<body>
  <div class="spinner"></div>
  <h2>Opening Website</h2>
  <p>Routing through the stealth gateway.<br>This may take <b>10–30 seconds</b> for first visit.</p>
  <div class="url">${target}</div>
  <a href="/">← Cancel</a>
  <script>
    // Auto-reload to check if content is ready
    setTimeout(function(){ location.reload(); }, 8000);
  </script>
</body></html>`;
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

// ── In-memory cache: target → { html, time } ─────────────────
const cache = new Map();
const CACHE_TTL = 30000; // 30 seconds

// ── In-progress requests to avoid duplicate launches ──────────
const inProgress = new Map();

// ── PROXY ROUTE ───────────────────────────────────────────────
app.get('/api', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');

  let parsed;
  try { parsed = new URL(target); } catch { return res.redirect('/'); }

  const origin = parsed.origin;
  const base = `${req.protocol}://${req.headers.host}/api?url=`;

  // Serve from cache if fresh
  const cached = cache.get(target);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.set('Content-Type', 'text/html; charset=utf-8').send(cached.html);
  }

  // If already fetching this URL, show loading page
  if (inProgress.has(target)) {
    return res.status(202).send(loadingPage(target));
  }

  // Mark as in-progress
  inProgress.set(target, true);

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Block heavy resources for speed
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (['media', 'font'].includes(r.resourceType())) return r.abort();
      r.continue();
    });

    await stealth(page);

    console.log(`Fetching: ${target}`);
    const resp = await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for Cloudflare to fully complete (up to 30s)
    console.log('Waiting for CF challenge...');
    for (let i = 0; i < 15; i++) {
      const bodyText = await page.evaluate(() =>
        (document.body && document.body.innerText) || ''
      );
      const title = await page.title();
      const isCF =
        title.includes('Just a moment') ||
        title.includes('Attention Required') ||
        bodyText.includes('Performing security verification') ||
        bodyText.includes('Checking your browser') ||
        bodyText.includes('Please wait') ||
        bodyText.includes('Enable JavaScript and cookies');
      if (!isCF) {
        console.log('CF challenge passed!');
        break;
      }
      console.log(`CF still active (${i + 1}/15), waiting 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Extra wait for page JS to render
    await new Promise(r => setTimeout(r, 2000));


    let html = await page.content();
    html = rewrite(html, origin, base);

    await page.close();
    inProgress.delete(target);

    // Cache the result
    cache.set(target, { html, time: Date.now() });

    res.status(resp?.status() || 200)
       .set('Content-Type', 'text/html; charset=utf-8')
       .send(html);

  } catch (err) {
    if (page) await page.close().catch(() => {});
    inProgress.delete(target);
    console.error('[ERROR]', err.message);
    res.status(500).send(errPage(`<b>Error:</b> ${err.message}`));
  }
});

app.get('/health', (_, res) => res.json({ ok: true, browser: !!_browser }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));