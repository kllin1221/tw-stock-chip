/**
 * 台股籌碼分布 — TWSE 本機代理伺服器
 *
 * 功能：
 *   - 繞過 TWSE API 的 CORS 限制
 *   - 自動合併多個月份資料（按請求天數決定抓幾個月）
 *   - 解析 TWSE 民國年份格式
 *   - 回傳標準化 JSON 給前端
 *
 * 安裝：
 *   npm install
 *
 * 啟動：
 *   node server.js
 *
 * 前端呼叫範例：
 *   GET http://localhost:3000/api/stock?symbol=2330&days=60
 */

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = 3000;

// ── TWSE API ──────────────────────────────────
const TWSE_BASE = 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY';

/**
 * TWSE 月份欄位順序：
 * [0] 日期（民國 YY/MM/DD）
 * [1] 成交股數
 * [2] 成交金額
 * [3] 開盤價
 * [4] 最高價
 * [5] 最低價
 * [6] 收盤價
 * [7] 漲跌價差
 * [8] 成交筆數
 */
function parseTWSERow(row) {
  const clean = s => parseFloat(s.replace(/,/g, '')) || 0;
  // 日期：115/04/01 → 2026-04-01
  const parts  = row[0].split('/');
  const year   = parseInt(parts[0]) + 1911;
  const date   = `${year}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
  return {
    date,
    open:   clean(row[3]),
    high:   clean(row[4]),
    low:    clean(row[5]),
    close:  clean(row[6]),
    volume: Math.round(clean(row[1]) / 1000), // 股 → 張
  };
}

/** 取得某月的 TWSE 資料（返回 Promise<array>） */
function fetchTWSEMonth(symbol, dateStr) {
  return new Promise((resolve, reject) => {
    const apiUrl = `${TWSE_BASE}?date=${dateStr}&stockNo=${encodeURIComponent(symbol)}&response=json`;
    https.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChipRadar/1.0)',
        'Referer':    'https://www.twse.com.tw',
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.stat !== 'OK' || !json.data) {
            resolve([]); // 該月無資料（休市等）
          } else {
            resolve(json.data.map(parseTWSERow));
          }
        } catch {
          resolve([]);
        }
      });
    }).on('error', reject);
  });
}

/** 產生需要查詢的月份清單（YYYYMMDD，每月第 1 日） */
function getMonthList(days) {
  const months   = Math.ceil(days / 20) + 1; // 每月約 20 個交易日，多抓 1 個月緩衝
  const result   = [];
  const today    = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    result.push(`${y}${m}01`);
  }
  return result;
}

/** 取得股票名稱（從 TWSE 回傳 title 解析） */
async function fetchStockName(symbol) {
  return new Promise(resolve => {
    const today    = new Date();
    const dateStr  = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}01`;
    const apiUrl   = `${TWSE_BASE}?date=${dateStr}&stockNo=${encodeURIComponent(symbol)}&response=json`;
    https.get(apiUrl, { headers:{ 'User-Agent':'Mozilla/5.0', 'Referer':'https://www.twse.com.tw' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          // title 格式：「台灣證券交易所 XXX 股份有限公司 個股日成交資訊」
          const match = json.title?.match(/(\S+)\s+個股日成交資訊/);
          resolve(match ? match[1].replace(symbol, '').trim() : symbol);
        } catch { resolve(symbol); }
      });
    }).on('error', () => resolve(symbol));
  });
}

// ── HTTP 伺服器 ───────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS headers（允許瀏覽器跨域呼叫）
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── GET /api/stock ──
  if (pathname === '/api/stock' && req.method === 'GET') {
    const symbol = (parsed.query.symbol || '').trim();
    const days   = Math.min(parseInt(parsed.query.days || '60') || 60, 240);

    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '請提供 symbol 參數' }));
      return;
    }

    try {
      console.log(`[${new Date().toLocaleTimeString()}] 查詢 ${symbol} 最近 ${days} 日`);

      const monthList  = getMonthList(days);
      const namePromise = fetchStockName(symbol);

      // 並行抓取各月資料
      const monthlyData = await Promise.all(monthList.map(d => fetchTWSEMonth(symbol, d)));
      const allData     = monthlyData.flat().filter(d => d.close > 0);

      if (!allData.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `查無 ${symbol} 的資料，請確認股票代號` }));
        return;
      }

      // 取最新 N 個交易日
      const trimmed = allData.slice(-days);
      const name    = await namePromise;

      const payload = JSON.stringify({ symbol, name, days: trimmed.length, data: trimmed });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      console.log(`[OK] ${symbol} ${name}，回傳 ${trimmed.length} 筆`);

    } catch (err) {
      console.error('[ERR]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET / (健康檢查) ──
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('台股籌碼雷達 TWSE 代理伺服器 ✅\n呼叫範例：/api/stock?symbol=2330&days=60\n');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║   台股籌碼雷達 TWSE 代理伺服器 已啟動     ║`);
  console.log(`║   http://localhost:${PORT}                   ║`);
  console.log(`╚═══════════════════════════════════════════╝\n`);
  console.log('使用範例：');
  console.log(`  curl "http://localhost:${PORT}/api/stock?symbol=2330&days=60"\n`);
});
