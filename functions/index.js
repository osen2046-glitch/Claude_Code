const functions = require('firebase-functions');
const axios = require('axios');
const cheerio = require('cheerio');

/**
 * fetchTitle — server-side title scraper.
 * Called via Firebase Hosting rewrite: /api/fetch-title → this function.
 * Requires Blaze (pay-as-you-go) plan for outbound network access.
 */
exports.fetchTitle = functions.https.onRequest(async (req, res) => {
  // CORS headers (Hosting rewrites are same-origin, but set anyway for local dev)
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const { url } = req.query;
  if (!url) { res.status(400).json({ error: '缺少 url 參數' }); return; }

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').text() ||
      '';

    res.json({ title: title.trim() });
  } catch {
    res.json({ title: '', error: '無法取得標題' });
  }
});
