const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Single browser instance reused across requests ────────────
let _browser = null;
let _launching = false;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) {
    // Wait for browser that's already launching
    await new Promise(r => setTimeout(r, 3000));
    return _browser;
  }
  _launching = true;
  try {
    _browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',                        // saves RAM on free tier
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,720',
      ],
      defaultViewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });
    _browser.on('disconnected', () => { _browser = null; _launching = false; });
  } finally {
    _launching = false;
  }
  return _browser;
}

// ── Stealth: hide automation signals ─────────────────────────
async function stealth(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    // Override permission query
    const origQuery = window.navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = p =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(p);
  });
}

// ── Rewrite all links/assets to go through this proxy ────────
function rewrite(html, origin, base) {
  // absolute URLs
  html = html.replace(
    /(href|src|action)=["'](https?:\/\/[^"' >]+)["']/gi,
    (_, a, u) => `${a}="${base}${encodeURIComponent(u)}"`
  );
  // root-relative URLs
  html = html.replace(
    /(href|src|action)=["'](\/(?!\/)[^"']*|\/?)["']/gi,
    (m, a, u) => {
      try { return `${a}="${base}${encodeURIComponent(new URL(u, origin).href)}"`; }
      catch { return m; }
    }
  );
  // Intercept JS navigation
  const script = `<script>
(function(){
  var B='${base}', O='${origin}';
  function proxy(url){
    try{ return B+encodeURIComponent(new URL(url,O).href); }catch(e){ return url; }
  }
  // Intercept <a> clicks
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]'); if(!a) return;
    var h=a.getAttribute('href');
    if(!h||h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('mailto:')) return;
    e.preventDefault(); e.stopPropagation();
    location.href=proxy(h);
  },true);
  // Intercept window.location changes
  var desc=Object.getOwnPropertyDescriptor(window,'location');
  // Intercept fetch (rewrite relative URLs)
  var _fetch=window.fetch;
  window.fetch=function(url,opts){
    if(typeof url==='string'&&url.startsWith('/')){
      url=new URL(url,O).href;
    }
    return _fetch(url,opts);
  };
})();
</script>`;
  return html.replace(/<\/head>/i, script + '</head>');
}

// ── Pretty error page ─────────────────────────────────────────
function errPage(msg) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Error</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;
  min-height:100vh;display:flex;align-items:center;justify-content:center;
  flex-direction:column;gap:16px;text-align:center;padding:24px}
.icon{font-size:60px}
h2{color:#ef4444;font-size:1.4rem;font-weight:700}
p{color:#64748b;max-width:480px;line-height:1.7;font-size:.9rem}
a{margin-top:12px;padding:12px 32px;background:#6366f1;color:#fff;
  border-radius:10px;text-decoration:none;font-weight:600;font-size:.95rem}
</style></head>
<body>
  <div class="icon">⚠️</div>
  <h2>Failed to Load</h2>
  <p>${msg}</p>
  <a href="/">← Go Back</a>
</body></html>`;
}

// ── PROXY ROUTE ───────────────────────────────────────────────
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

    // Block ads/trackers to speed up loading
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['media', 'font'].includes(type)) return req.abort();
      req.continue();
    });

    await stealth(page);

    // Navigate with 30s timeout
    const resp = await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Handle Cloudflare challenge — wait up to 15s for it to auto-solve
    let waited = 0;
    while (waited < 15000) {
      const title = await page.title();
      if (!title.includes('Just a moment') && !title.includes('Attention Required')) break;
      await new Promise(r => setTimeout(r, 2000));
      waited += 2000;
    }

    // Extra wait for JS-heavy sites
    await new Promise(r => setTimeout(r, 1500));

    const html = rewrite(await page.content(), origin, base);
    const ct = resp?.headers()['content-type'] || 'text/html';
    const status = resp?.status() || 200;

    await page.close();
    res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(html);

  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.error('[proxy error]', err.message);
    res.status(500).send(errPage(
      `<b>Error:</b> ${err.message}<br><br>
       This may be a temporary issue. <b>Wait 5 seconds and try again.</b>`
    ));
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Stealth Proxy on port ${PORT}`));