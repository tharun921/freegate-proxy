// home-proxy.js — Run this on your HOME PC
// It creates a residential IP relay that bypasses Cloudflare

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

getBrowser().catch(console.error); // pre-warm

async function stealth(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

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

    await page.setRequestInterception(true);
    page.on('request', r => {
      if (['media', 'font'].includes(r.resourceType())) return r.abort();
      r.continue();
    });

    await stealth(page);

    const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for Cloudflare — on HOME IP it passes in 3-5 seconds
    for (let i = 0; i < 15; i++) {
      const [title, body] = await Promise.all([
        page.title(),
        page.evaluate(() => document.body?.innerText || ''),
      ]);
      const isCF =
        title.includes('Just a moment') ||
        body.includes('Performing security verification') ||
        body.includes('Checking your browser');
      if (!isCF) { console.log('✅ Loaded:', target); break; }
      console.log(`Waiting for CF (${i + 1}/15)...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    await new Promise(r => setTimeout(r, 1000));
    let html = await page.content();
    html = rewrite(html, origin, base);
    await page.close();
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);

  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).send(`<h2>Error: ${err.message}</h2><a href="/">Back</a>`);
  }
});

app.listen(4000, () => {
  console.log('');
  console.log('✅ HOME PROXY RUNNING');
  console.log('📡 Now run: npx ngrok http 4000');
  console.log('📋 Copy the ngrok URL and use it on your college laptop');
  console.log('');
});
