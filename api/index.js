const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Reusable browser instance ────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// ── Stealth: hide automation ─────────────────────────────────
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

// ── Rewrite links to go through proxy ───────────────────────
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
  var B=${JSON.stringify(base)}, O=${JSON.stringify(origin)};
  document.addEventListener('click', function(e){
    var a = e.target.closest('a[href]');
    if (!a) return;
    var h = a.getAttribute('href');
    if (!h || h.startsWith('#') || h.startsWith('javascript:') || h.startsWith('mailto:')) return;
    try { var abs = new URL(h, O).href; e.preventDefault(); location.href = B + encodeURIComponent(abs); } catch(e){}
  }, true);
})();
</script>`;
  return html.replace('</head>', script + '</head>');
}

// ── Error page ────────────────────────────────────────────────
function errPage(msg) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Error</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;min-height:100vh;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;text-align:center;padding:24px}
.icon{font-size:60px}.h2{color:#ef4444;font-size:1.4rem;font-weight:700}
p{color:#64748b;max-width:480px;line-height:1.7;font-size:.9rem}
a{margin-top:12px;padding:12px 32px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
</style></head>
<body>
  <div class="icon">⚠️</div>
  <div class="h2">Failed to Load</div>
  <p>${msg}</p>
  <a href="/">← Go Back</a>
</body></html>`;
}

// ── PROXY ─────────────────────────────────────────────────────
app.get('/api', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');

  let parsed;
  try { parsed = new URL(target); } catch { return res.redirect('/'); }

  const origin = parsed.origin;
  const base = `${req.protocol}://${req.headers.host}/api?url=`;

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Block ads and heavy media to speed up
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (['media', 'font'].includes(r.resourceType())) return r.abort();
      r.continue();
    });

    await stealth(page);

    const resp = await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Auto-solve Cloudflare challenge (waits up to 15s)
    for (let i = 0; i < 8; i++) {
      const title = await page.title();
      if (!title.includes('Just a moment') && !title.includes('Attention Required')) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    await new Promise(r => setTimeout(r, 1000));

    let html = await page.content();
    html = rewrite(html, origin, base);

    await page.close();
    res.status(resp?.status() || 200)
       .set('Content-Type', 'text/html; charset=utf-8')
       .send(html);

  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.error('[ERROR]', err.message);
    res.status(500).send(errPage(`<b>${err.message}</b>`));
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));