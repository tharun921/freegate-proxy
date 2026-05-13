const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();

// ── Serve the public UI ──────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Browser pool ─────────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ],
    defaultViewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// ── Apply stealth patches to hide automation ──────────────────
async function applyStealthPatches(page) {
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Fake chrome runtime
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    // Fake plugins
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // Fake languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // Fix permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(params);
  });
}

// ── URL rewriting ─────────────────────────────────────────────
function rewriteHtml(html, origin, proxyBase) {
  // Rewrite absolute URLs in src/href/action
  html = html.replace(
    /(href|src|action)=["'](https?:\/\/[^"' >]+)["']/gi,
    (_, attr, url) => `${attr}="${proxyBase}${encodeURIComponent(url)}"`
  );
  // Rewrite root-relative URLs
  html = html.replace(
    /(href|src|action)=["'](\/(?!\/)[^"']*|\/?)["']/gi,
    (match, attr, url) => {
      try {
        const abs = new URL(url, origin).href;
        return `${attr}="${proxyBase}${encodeURIComponent(abs)}"`;
      } catch { return match; }
    }
  );

  // Inject navigation interceptor
  const script = `
<script>
(function(){
  var BASE = ${JSON.stringify(proxyBase)};
  var ORIGIN = ${JSON.stringify(origin)};
  document.addEventListener('click', function(e){
    var a = e.target.closest('a[href]');
    if (!a) return;
    var h = a.getAttribute('href');
    if (!h || h.startsWith('#') || h.startsWith('javascript:') || h.startsWith('mailto:')) return;
    var abs;
    try { abs = new URL(h, ORIGIN).href; } catch { return; }
    if (!abs.startsWith('http')) return;
    e.preventDefault(); e.stopPropagation();
    location.href = BASE + encodeURIComponent(abs);
  }, true);
})();
</script>`;
  return html.replace(/<\/head>/i, script + '</head>');
}

// ── Error page ────────────────────────────────────────────────
function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Error</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;min-height:100vh;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;
  text-align:center;padding:20px}
.icon{font-size:64px;margin-bottom:8px}
h2{color:#ef4444;font-size:1.4rem}
p{color:#64748b;max-width:460px;line-height:1.6;font-size:0.9rem}
a{padding:12px 32px;background:#6366f1;color:#fff;border-radius:10px;
  text-decoration:none;font-weight:600;display:inline-block;margin-top:8px}
</style></head>
<body>
  <div class="icon">⚠️</div>
  <h2>Failed to Load Page</h2>
  <p>${message}</p>
  <a href="/">← Go Back</a>
</body></html>`;
}

// ── Main proxy route ──────────────────────────────────────────
app.get('/api', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return res.redirect('/'); }

  const origin = targetUrl.origin;
  const proxyBase = `${req.protocol}://${req.headers.host}/api?url=`;

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await applyStealthPatches(page);

    const response = await page.goto(target, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait extra if Cloudflare challenge is detected
    const title = await page.title();
    if (title.includes('Just a moment') || title.includes('Attention Required')) {
      console.log('CF challenge detected, waiting 8s...');
      await new Promise(r => setTimeout(r, 8000));
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    const contentType = response?.headers()['content-type'] || 'text/html';
    const status = response?.status() || 200;

    let html = await page.content();
    html = rewriteHtml(html, origin, proxyBase);

    await page.close();
    res.status(status)
       .set('Content-Type', 'text/html; charset=utf-8')
       .removeHeader('X-Frame-Options')
       .send(html);

  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.error('Proxy error:', err.message);
    res.status(500).send(errorPage(err.message));
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Stealth Proxy running at http://localhost:${PORT}`));