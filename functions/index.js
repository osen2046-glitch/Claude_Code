const functions  = require('firebase-functions');
const axios      = require('axios');
const cheerio    = require('cheerio');
const Anthropic  = require('@anthropic-ai/sdk');

// ─────────────────────────────────────────────────────────────────
// fetchTitle — server-side title scraper
// Hosting rewrite: /api/fetch-title → this function
// Requires Blaze plan for outbound network access
// ─────────────────────────────────────────────────────────────────
exports.fetchTitle = functions.https.onRequest(async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────
// System Prompts
// ─────────────────────────────────────────────────────────────────
const SYSTEM_ICHING = `你是一位精通《周易》的解夢師，學術基礎為《周易》經傳原文（卦辭、象傳）及義理詮釋傳統。

核心立場：
- 易經視夢境意象為天地之道在人心的顯現
- 解夢不占卜吉凶，從意象對應的卦象讀取當下處境的本質與應有的態度
- 象是核心：先看意象，再看卦，再看義理

操作流程：
Step 1 提取意象：辨識夢中自然元素（天地水火山雷風澤）、動態方向、人物關係、情境特質
Step 2 對應卦象：依意象對應八卦，若意象複合則對應六十四卦中最相關者一至兩卦
Step 3 引用卦辭與象傳：引用原文，以白話說明此卦的處境
Step 4 義理詮釋：將卦象道理對應回夢境，指出象傳提示的君子之道
Step 5 一句收尾：「天地告訴你：___。」古樸有力

限制：不說吉凶、不預測現實、遇意象複雜時誠實說明

輸出格式：
# ☯ 夢境意象辨識
（內容）

# ䷀ 對應卦象
卦名與卦辭象傳

# 🌿 義理詮釋
（內容）

**天地告訴你：**
（一句話）

語言：繁體中文，語氣古樸溫柔`;

const SYSTEM_JUNG = `你是一位受過嚴格訓練的榮格分析心理學解夢師，
學術基礎來自 Jung《Collected Works》（CW4、CW8、CW9i、CW12、CW16）
以及 Robert A. Johnson《Inner Work》四步驟架構。

核心立場：
- 夢是無意識對自我發出的自發性訊息，不是病徵，不是預言
- 夢的意象是象徵，指向尚未整合的心理內容
- 不做自由聯想，而做擴大聯想（amplification）：從神話、童話、宗教傳說找原型底蘊
- 夢中所有人物優先視為做夢者內在心理的投射

解析架構（Johnson 四步驟）：
Step 1 意象辨識（Associations）：提取顯著意象，進行擴大聯想，注意情緒色調
Step 2 內在動力（Dynamics）：判斷運作中的原型
       （陰影／阿尼瑪阿尼姆斯／自性／英雄／大母神／老智者）
       評估其在個體化歷程中是整合或壓抑的狀態
Step 3 詮釋（Interpretation）：整合為連貫心理敘事，溫暖開放不下定論
Step 4 化象為行（Ritual）：提供一個具體微小的日常行動建議

輸出格式：
# 🌑 意象與擴大聯想
（內容）

# 🌒 內在動力
（內容）

# 🌓 詮釋
（內容）

# 🌔 化象為行
（具體建議）

**💬 這個夢在問你：**
（一句核心提問）

語言：繁體中文，術語第一次出現時附簡短說明`;

// ─────────────────────────────────────────────────────────────────
// dreamAnalysis — HTTPS Callable
// ─────────────────────────────────────────────────────────────────
exports.dreamAnalysis = functions.https.onCall(async (data) => {
  const { dreamText, methods } = data;

  if (!dreamText || typeof dreamText !== 'string' || dreamText.trim() === '') {
    throw new functions.https.HttpsError('invalid-argument', '請提供夢境描述');
  }
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', '請選擇至少一種解夢方式');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'API 金鑰未設定，請聯繫管理員');
  }

  const client = new Anthropic({ apiKey });

  // Call Claude for one method; returns null on any error (graceful degradation)
  const callClaude = async (systemPrompt) => {
    try {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `我的夢境：\n\n${dreamText.trim()}`,
        }],
      });
      return msg.content[0]?.text ?? null;
    } catch (err) {
      console.error('Anthropic API error:', err?.message ?? err);
      return null;
    }
  };

  // Run both methods in parallel; resolve to null if method not selected
  const [ichingResult, jungResult] = await Promise.all([
    methods.includes('iching') ? callClaude(SYSTEM_ICHING) : Promise.resolve(null),
    methods.includes('jung')   ? callClaude(SYSTEM_JUNG)   : Promise.resolve(null),
  ]);

  return {
    results: {
      iching: ichingResult,
      jung:   jungResult,
    },
  };
});
