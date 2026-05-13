const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();

// ── Serve the public UI ──────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Browser pool (reuse browser across requests) ─────────────
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
      '--window-size=1366,768',
    ],
    defaultViewport: { width: 1366, height: 768 },
  });
  // Auto-restart if browser crashes
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// ── URL rewriting so links pass through proxy ─────────────────
function rewriteHtml(html, origin, proxyBase) {
  // Rewrite absolute src/href/action
  html = html.replace(
    /(href|src|action)=["'](https?:\/\/[^"' >]+)["']/gi,
    (_, attr, url) => `${attr}="${proxyBase}${encodeURIComponent(url)}"`
  );
  // Rewrite root-relative
  html = html.replace(
    /(href|src|action)=["'](\/(?!\/)[^"']*|\/?)["']/gi,
    (match, attr, url) => {
      try {
        const abs = new URL(url, origin).href;
        return `${attr}="${proxyBase}${encodeURIComponent(abs)}"`;
      } catch { return match; }
    }
  );
  // Script: intercept navigation + handle SPA routing
  const script = `
<script>
(function(){
  var BASE = ${JSON.stringify(proxyBase)};
  var ORIGIN = ${JSON.stringify(origin)};
  // Intercept <a> clicks
  document.addEventListener('click', function(e){
    var a = e.target.closest('a[href]');
    if (!a) return;
    var h = a.getAttribute('href');
    if (!h || h.startsWith('#') || h.startsWith('javascript:') || h.startsWith('mailto:') || h.startsWith('tel:')) return;
    var abs;
    try { abs = new URL(h, ORIGIN).href; } catch { return; }
    if (!abs.startsWith('http')) return;
    e.preventDefault();
    e.stopPropagation();
    location.href = BASE + encodeURIComponent(abs);
  }, true);
  // Intercept window.open
  var _open = window.open;
  window.open = function(url, name, features) {
    if (url && url.startsWith('http')) {
      location.href = BASE + encodeURIComponent(new URL(url, ORIGIN).href);
      return null;
    }
    return _open.call(window, url, name, features);
  };
  // Override history.pushState / replaceState (SPA navigation)
  var _pushState = history.pushState;
  history.pushState = function(state, title, url) {
    if (url && !url.startsWith('http')) {
      try {
        var abs = new URL(url, ORIGIN).href;
        location.href = BASE + encodeURIComponent(abs);
        return;
      } catch {}
    }
    return _pushState.apply(history, arguments);
  };
})();
</script>`;
  return html.replace(/<\/head>/i, script + '</head>');
}

// ── Error page ────────────────────────────────────────────────
function errorPage(message, hint) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Error</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#f1f5f9;font-family:'Inter',sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;
    flex-direction:column;gap:16px;text-align:center;padding:20px}
  .icon{font-size:64px;margin-bottom:8px}
  h2{color:#ef4444;font-size:1.4rem;margin:0}
  p{color:#64748b;max-width:460px;line-height:1.6;font-size:0.9rem}
  .hint{background:rgba(99,102,241,0.1);border:1px solid #6366f1;
    border-radius:12px;padding:16px 24px;max-width:480px;
    color:#a5b4fc;font-size:0.82rem;line-height:1.7}
  a{padding:12px 32px;background:#6366f1;color:#fff;border-radius:10px;
    text-decoration:none;font-weight:600;margin-top:8px;display:inline-block}
  a:hover{opacity:0.85}
</style></head>
<body>
  <div class="icon">⚠️</div>
  <h2>Failed to Load Page</h2>
  <p>${message}</p>
  ${hint ? `<div class="hint">${hint}</div>` : ''}
  <a href="/">← Go Back</a>
</body></html>`;
}

// ── Main Proxy Route ──────────────────────────────────────────
app.get('/api', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return res.redirect('/'); }

  const origin = targetUrl.origin;
  const proxyBase = `${req.protocol}://${req.headers.host}/api?url=`;

  let browser, page;
  try {
    browser = await getBrowser();
    page = await browser.newPage();

    // Set realistic browser fingerprint
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    });

    // Hide automation signals
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });

    // Navigate — wait up to 30s for Cloudflare challenge to solve
    const response = await page.goto(target, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait extra time if Cloudflare challenge detected
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const isCF = bodyText.includes('Just a moment') ||
                 bodyText.includes('Checking your browser') ||
                 bodyText.includes('Please wait');
    if (isCF) {
      await new Promise(r => setTimeout(r, 8000)); // wait for JS challenge
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }

    const contentType = response?.headers()['content-type'] || 'text/html';
    const status = response?.status() || 200;

    if (contentType.includes('text/html') || !contentType) {
      let html = await page.content();
      html = rewriteHtml(html, origin, proxyBase);
      await page.close();
      res.status(status).set('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    // For binary content — get as buffer
    const buffer = await page.evaluate(() =>
      fetch(location.href)
        .then(r => r.arrayBuffer())
        .then(buf => Array.from(new Uint8Array(buf)))
    );
    await page.close();
    res.set('Content-Type', contentType);
    return res.send(Buffer.from(buffer));

  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.error('Proxy error:', err.message);
    return res.status(500).send(errorPage(
      err.message,
      `<b>💡 Tip:</b> If this is a Cloudflare-protected site, try waiting 10 seconds and refreshing. 
       The stealth browser needs time to solve the challenge automatically.`
    ));
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Stealth Proxy running at http://localhost:${PORT}`));