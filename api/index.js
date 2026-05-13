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
  { host: '216.10.27.159',  port: 6837 },  // US Los Angeles
  { host: '198.23.243.226', port: 6361 },  // US Bloomingdale
  { host: '45.38.107.97',   port: 6014 },  // US Seattle
  { host: '31.59.20.176',   port: 6754 },  // UK London
  { host: '23.229.19.94',   port: 8689 },  // US Los Angeles
  { host: '107.172.163.27', port: 6543 },  // US
  { host: '142.111.67.146', port: 5611 },  // Japan
  { host: '191.96.254.138', port: 6185 },  // US
  { host: '31.58.9.4',      port: 6077 },  // Germany
  { host: '31.56.127.193',  port: 7684 },  // US
];

let currentProxyIdx = 0;
let _browser = null;
let _launchPromise = null;

// ── Get or launch browser with current proxy ──────────────────
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launchPromise) return _launchPromise;

  const proxy = PROXIES[currentProxyIdx % PROXIES.length];
  console.log(`🚀 Launching browser via ${proxy.host}:${proxy.port}`);

  _launchPromise = puppeteer.launch({
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
  }).then(b => {
    _browser = b;
    _launchPromise = null;
    _browser.on('disconnected', () => {
      console.log('⚠️ Browser disconnected');
      _browser = null;
      _launchPromise = null;
    });
    console.log(`✅ Browser ready via proxy ${proxy.host}`);
    return b;
  });

  return _launchPromise;
}

// Pre-warm
getBrowser().catch(e => console.error('Pre-launch:', e.message));

// ── Switch to next proxy and relaunch ─────────────────────────
async function rotateProxy() {
  currentProxyIdx = (currentProxyIdx + 1) % PROXIES.length;
  const proxy = PROXIES[currentProxyIdx];
  console.log(`🔄 Rotating to proxy: ${proxy.host}:${proxy.port}`);
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
  }
  return getBrowser();
}

// ── Stealth patches ───────────────────────────────────────────
async function stealth(page) {
  await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
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
  });
}

// ── Detect Cloudflare ─────────────────────────────────────────
async function isCF(page) {
  try {
    const title = await page.title().catch(() => '');
    const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    return (
      title.includes('Just a moment') ||
      title.includes('Attention Required') ||
      body.includes('Performing security verification') ||
      body.includes('Checking your browser') ||
      body.includes('verify you are human') ||
      body.includes('Enable JavaScript and cookies')
    );
  } catch { return false; }
}

// ── Rewrite links through proxy ───────────────────────────────
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

function errPage(msg) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Error</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;min-height:100vh;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;text-align:center;padding:24px}
.icon{font-size:56px}h2{color:#ef4444;font-size:1.3rem;font-weight:700}
p{color:#64748b;max-width:480px;line-height:1.7;font-size:.88rem}
a{margin-top:12px;padding:12px 32px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
</style></head>
<body><div class="icon">⚠️</div><h2>Failed to Load</h2><p>${msg}</p>
<a href="/">← Go Back</a></body></html>`;
}

// ── Cache ─────────────────────────────────────────────────────
const cache = new Map();

// ── MAIN PROXY ROUTE ──────────────────────────────────────────
app.get('/api', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');
  let parsed;
  try { parsed = new URL(target); } catch { return res.redirect('/'); }

  const origin = parsed.origin;
  const base = `${req.protocol}://${req.headers.host}/api?url=`;

  // Serve cache if fresh (30s)
  const cached = cache.get(target);
  if (cached && Date.now() - cached.time < 30000) {
    return res.set('Content-Type', 'text/html; charset=utf-8').send(cached.html);
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (['media', 'font'].includes(r.resourceType())) return r.abort();
      r.continue();
    });

    await stealth(page);

    console.log(`→ Fetching: ${target}`);
    const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for CF to solve via residential IP (should be 3-8 seconds max)
    let cfPassed = false;
    for (let i = 0; i < 12; i++) {
      if (!(await isCF(page))) { cfPassed = true; console.log('✅ CF passed!'); break; }
      console.log(`⏳ CF active (${i + 1}/12)...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    // If CF still active after 24s, rotate proxy for next request
    if (!cfPassed) {
      console.log('⚠️ CF not passing, rotating proxy for next request...');
      rotateProxy().catch(() => {});
      await page.close();
      return res.status(503).send(errPage(
        'Cloudflare challenge not solved. <b>Click Go Back and try again</b> — switching to a different proxy automatically.'
      ));
    }

    await new Promise(r => setTimeout(r, 1000));
    let html = await page.content();
    html = rewrite(html, origin, base);
    await page.close();
    cache.set(target, { html, time: Date.now() });

    res.status(resp?.status() || 200)
       .set('Content-Type', 'text/html; charset=utf-8')
       .send(html);

  } catch (err) {
    if (page) { try { await page.close(); } catch (_) {} }
    console.error('[ERR]', err.message);
    // Rotate proxy on error
    rotateProxy().catch(() => {});
    res.status(500).send(errPage(
      `<b>Error:</b> ${err.message}<br><br>Switching proxy. <b>Please try again in 5 seconds.</b>`
    ));
  }
});

app.get('/health', (_, res) =>
  res.json({ ok: true, proxy: PROXIES[currentProxyIdx % PROXIES.length], total: PROXIES.length })
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`✅ FreeGate running on port ${PORT} with ${PROXIES.length} residential proxies`)
);