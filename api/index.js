const express = require('express');
const puppeteer = require('rebrowser-puppeteer-core');
const chromium = require('@sparticuz/chromium');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Webshare Residential Proxies ──────────────────────────────
const PROXY_USER = 'nbcsjrwt';
const PROXY_PASS = '175yipijpe0s';
const PROXIES = [
  { host: '31.59.20.176',   port: 6754 },  // UK London
  { host: '45.38.107.97',   port: 6014 },  // US Seattle
  { host: '198.23.243.226', port: 6361 },  // US Bloomingdale
  { host: '216.10.27.159',  port: 6837 },  // US Los Angeles
  { host: '107.172.163.27', port: 6543 },  // US Bloomingdale
  { host: '142.111.67.146', port: 5611 },  // Japan Tokyo
  { host: '191.96.254.138', port: 6185 },  // US Los Angeles
  { host: '31.58.9.4',      port: 6077 },  // Germany Frankfurt
  { host: '23.229.19.94',   port: 8689 },  // US Los Angeles
  { host: '31.56.127.193',  port: 7684 },  // US Seattle
];
let proxyIndex = 0;

function nextProxy() {
  const p = PROXIES[proxyIndex % PROXIES.length];
  proxyIndex++;
  return p;
}

// ── Browser launch with proxy ─────────────────────────────────
let _browser = null;

async function launchBrowser(proxy) {
  if (_browser) { try { await _browser.close(); } catch (_) {} }
  console.log(`🌐 Launching browser via proxy: ${proxy.host}:${proxy.port}`);
  _browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--disable-blink-features=AutomationControlled',
      `--proxy-server=http://${proxy.host}:${proxy.port}`,
    ],
    defaultViewport: { width: 1280, height: 720 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// Pre-warm with first proxy
launchBrowser(PROXIES[0]).catch(e => console.error('Pre-launch:', e.message));

// ── Stealth patches ───────────────────────────────────────────
async function stealth(page) {
  // Authenticate proxy
  await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    const orig = window.navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = p =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : orig(p);
  });
}

// ── Detect CF challenge ───────────────────────────────────────
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
      body.includes('Enable JavaScript and cookies') ||
      body.includes('verify you are human')
    );
  } catch { return false; }
}

// ── Rewrite HTML links through proxy ─────────────────────────
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
  return html.replace('</head>',
    `<script>
(function(){
  var B=${JSON.stringify(base)},O=${JSON.stringify(origin)};
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');if(!a)return;
    var h=a.getAttribute('href');
    if(!h||h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('mailto:'))return;
    try{e.preventDefault();location.href=B+encodeURIComponent(new URL(h,O).href);}catch(e){}
  },true);
})();
</script></head>`
  );
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

// ── PROXY ROUTE ───────────────────────────────────────────────
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

  // Try up to 3 different proxies
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const proxy = nextProxy();
    let page;
    try {
      const browser = await launchBrowser(proxy);
      page = await browser.newPage();

      await page.setRequestInterception(true);
      page.on('request', r => {
        if (['media', 'font'].includes(r.resourceType())) return r.abort();
        r.continue();
      });

      await stealth(page);

      console.log(`[Attempt ${attempt + 1}] Fetching ${target} via ${proxy.host}`);
      const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Wait for CF to solve via residential IP (should be fast — 2-5 seconds)
      for (let i = 0; i < 10; i++) {
        if (!(await isCFActive(page))) { console.log('✅ CF passed!'); break; }
        console.log(`⏳ CF (${i + 1}/10)...`);
        await new Promise(r => setTimeout(r, 2000));
      }

      // Check if CF is still showing after waiting
      if (await isCFActive(page)) {
        console.log(`❌ Proxy ${proxy.host} blocked by CF, trying next...`);
        await page.close();
        lastError = `Proxy ${proxy.host} blocked`;
        continue;
      }

      await new Promise(r => setTimeout(r, 1000));
      let html = await page.content();
      html = rewrite(html, origin, base);
      await page.close();
      cache.set(target, { html, time: Date.now() });
      return res.status(resp?.status() || 200)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(html);

    } catch (err) {
      if (page) await page.close().catch(() => {});
      lastError = err.message;
      console.error(`[Attempt ${attempt + 1}] Error:`, err.message);
    }
  }

  res.status(500).send(errPage(`All proxy attempts failed.<br><b>${lastError}</b>`));
});

app.get('/health', (_, res) => res.json({ ok: true, proxies: PROXIES.length }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ FreeGate Proxy running on port ${PORT} with ${PROXIES.length} residential proxies`));