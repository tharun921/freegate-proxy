const express = require('express');
const puppeteer = require('rebrowser-puppeteer-core');
const chromium = require('@sparticuz/chromium');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── ZenRows API (handles Cloudflare Turnstile automatically) ──
// Sign up FREE at https://app.zenrows.com/register (no credit card needed)
// Get your API key and set it as ZENROWS_API_KEY env var on Render
const ZENROWS_KEY = process.env.ZENROWS_API_KEY || '';

// ── Webshare Datacenter Proxies (for non-CF sites) ────────────
const PROXY_USER = 'nbcsjrwt';
const PROXY_PASS = '175yipijpe0s';
const PROXIES = [
  { host: '216.10.27.159',  port: 6837 },
  { host: '198.23.243.226', port: 6361 },
  { host: '45.38.107.97',   port: 6014 },
  { host: '31.59.20.176',   port: 6754 },
  { host: '23.229.19.94',   port: 8689 },
];
let proxyIdx = 0;

// ── Browser ───────────────────────────────────────────────────
let _browser = null;
let _launching = false;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) {
    await new Promise(r => setTimeout(r, 3000));
    return _browser;
  }
  _launching = true;
  try {
    const proxy = PROXIES[proxyIdx % PROXIES.length];
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
    _browser.on('disconnected', () => { _browser = null; _launching = false; });
  } finally {
    _launching = false;
  }
  return _browser;
}

getBrowser().catch(e => console.error('Pre-launch:', e.message));

// ── Stealth ───────────────────────────────────────────────────
async function stealth(page) {
  try { await page.authenticate({ username: PROXY_USER, password: PROXY_PASS }); } catch (_) {}
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

// ── Check Cloudflare ──────────────────────────────────────────
async function isCF(page) {
  try {
    const [title, body] = await Promise.all([
      page.title().catch(() => ''),
      page.evaluate(() => document.body?.innerText || '').catch(() => ''),
    ]);
    return (
      title.includes('Just a moment') ||
      title.includes('Attention Required') ||
      body.includes('Performing security verification') ||
      body.includes('Checking your browser') ||
      body.includes('verify you are human')
    );
  } catch { return false; }
}

// ── ZenRows API fetch (bypasses Cloudflare Turnstile) ─────────
function zenRowsFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      apikey: ZENROWS_KEY,
      url: targetUrl,
      js_render: 'true',        // runs real browser
      premium_proxy: 'true',    // residential IP
      antibot: 'true',          // bypasses Cloudflare Turnstile
      wait: '3000',             // wait 3s for JS to load
    });
    const reqUrl = `https://api.zenrows.com/v1/?${params}`;
    console.log('→ Using ZenRows for CF-protected site:', targetUrl);
    https.get(reqUrl, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        if (resp.statusCode === 200) resolve(data);
        else reject(new Error(`ZenRows error ${resp.statusCode}: ${data.slice(0, 200)}`));
      });
    }).on('error', reject);
  });
}

// ── Rewrite links ─────────────────────────────────────────────
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
<head><meta charset="UTF-8"><title>Error - FreeGate</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;min-height:100vh;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;text-align:center;padding:24px}
.icon{font-size:56px}h2{color:#ef4444;font-size:1.3rem;font-weight:700}
p{color:#64748b;max-width:480px;line-height:1.7;font-size:.88rem}
.box{background:rgba(99,102,241,.1);border:1px solid #6366f1;border-radius:12px;padding:16px 24px;
  max-width:480px;color:#a5b4fc;font-size:.85rem;line-height:1.7;margin-top:8px}
a{margin-top:12px;padding:12px 32px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
</style></head>
<body><div class="icon">⚠️</div><h2>Failed to Load</h2>
<p>${msg}</p>
<a href="/">← Go Back</a></body></html>`;
}

// ── Cache ─────────────────────────────────────────────────────
const cache = new Map();

// ── MAIN PROXY ────────────────────────────────────────────────
app.get('/api', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');
  let parsed;
  try { parsed = new URL(target); } catch { return res.redirect('/'); }

  const origin = parsed.origin;
  const base = `${req.protocol}://${req.headers.host}/api?url=`;

  const cached = cache.get(target);
  if (cached && Date.now() - cached.time < 30000) {
    return res.set('Content-Type', 'text/html; charset=utf-8').send(cached.html);
  }

  let page;
  try {
    // ── STEP 1: Try with Puppeteer + proxy ────────────────────
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', r => {
      if (['media', 'font'].includes(r.resourceType())) return r.abort();
      r.continue();
    });

    await stealth(page);
    const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait up to 10s for CF on non-Turnstile sites
    for (let i = 0; i < 5; i++) {
      if (!(await isCF(page))) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    const cfStillActive = await isCF(page);

    if (!cfStillActive) {
      // ✅ Loaded without CF issue
      let html = await page.content();
      html = rewrite(html, origin, base);
      await page.close();
      cache.set(target, { html, time: Date.now() });
      return res.status(resp?.status() || 200).set('Content-Type', 'text/html; charset=utf-8').send(html);
    }

    await page.close();
    console.log('CF detected, trying ZenRows...');

    // ── STEP 2: CF detected → use ZenRows if API key available ─
    if (!ZENROWS_KEY) {
      return res.status(403).send(errPage(
        `This site is protected by Cloudflare Turnstile.<br><br>
         <b>To unlock it:</b> Sign up free at <a href="https://app.zenrows.com/register" target="_blank" style="color:#6366f1">zenrows.com</a> 
         → get your API key → add it as <code>ZENROWS_API_KEY</code> in Render Environment Variables.`
      ));
    }

    // Use ZenRows to bypass Cloudflare
    const html = await zenRowsFetch(target);
    const rewritten = rewrite(html, origin, base);
    cache.set(target, { html: rewritten, time: Date.now() });
    return res.set('Content-Type', 'text/html; charset=utf-8').send(rewritten);

  } catch (err) {
    if (page) { try { await page.close(); } catch (_) {} }
    console.error('[ERR]', err.message);

    // Try ZenRows as last resort if we have a key
    if (ZENROWS_KEY) {
      try {
        const html = await zenRowsFetch(target);
        const base2 = `${req.protocol}://${req.headers.host}/api?url=`;
        return res.set('Content-Type', 'text/html; charset=utf-8').send(rewrite(html, origin, base2));
      } catch (zErr) {
        console.error('[ZenRows ERR]', zErr.message);
      }
    }

    res.status(500).send(errPage(`<b>${err.message}</b>`));
  }
});

app.get('/health', (_, res) => res.json({
  ok: true,
  zenrows: !!ZENROWS_KEY,
  proxy: PROXIES[proxyIdx % PROXIES.length],
}));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ FreeGate on port ${PORT} | ZenRows: ${ZENROWS_KEY ? 'YES ✅' : 'NO (add ZENROWS_API_KEY)'}`));