#!/usr/bin/env node
/**
 * BTC 现货交易监测脚本
 * 自动抓取 Binance 公开 API，计算多个短线指标并输出买入评分
 */

const BINANCE = 'https://api.binance.com/api/v3';
const SYMBOL  = 'BTCUSDT';
const INTERVAL = process.argv[2] || '5m';   // 可传参: 1m 5m 15m 1h
const LIMIT    = 100;

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
}

async function fetchTicker() {
    return get(`${BINANCE}/ticker/24hr?symbol=${SYMBOL}`);
}

async function fetchKlines() {
    const data = await get(`${BINANCE}/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}`);
    return data.map(d => ({ o:+d[1], h:+d[2], l:+d[3], c:+d[4], v:+d[5] }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function ema(arr, period) {
    if (arr.length < period) return null;
    const k = 2 / (period + 1);
    let val = arr.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
    return val;
}

function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let g = 0, l = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        d > 0 ? g += d : l -= d;
    }
    const ag = g / period, al = l / period;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function macdHist(closes) {
    if (closes.length < 26) return null;
    const macdVals = [];
    for (let i = 26; i <= closes.length; i++) {
        const e12 = ema(closes.slice(0, i), 12);
        const e26 = ema(closes.slice(0, i), 26);
        if (e12 && e26) macdVals.push(e12 - e26);
    }
    const sig = ema(macdVals, 9);
    const line = macdVals[macdVals.length - 1];
    return { line, sig, hist: line - (sig || 0) };
}

function bollingerPos(closes, period = 20) {
    const s = closes.slice(-period);
    const mean = s.reduce((a, b) => a + b) / period;
    const std  = Math.sqrt(s.map(x => (x - mean) ** 2).reduce((a, b) => a + b) / period);
    const price = closes[closes.length - 1];
    return { pos: (price - (mean - 2*std)) / (4*std), lower: mean - 2*std, upper: mean + 2*std };
}

function volRatio(volumes) {
    const avg = volumes.slice(-20, -1).reduce((a, b) => a + b) / 19;
    return volumes[volumes.length - 1] / avg;
}

// ─── Score ────────────────────────────────────────────────────────────────────
function score(closes, volumes, rsiThresh = 35) {
    let pts = 0;
    const hits = [];

    const r = rsi(closes);
    if (r !== null) {
        if (r < rsiThresh)  { pts += 25; hits.push(`RSI ${r.toFixed(1)} < ${rsiThresh} ✓`); }
        else if (r < 45)    { pts += 12; hits.push(`RSI ${r.toFixed(1)} 偏低`); }
        else if (r > 70)    { pts -= 15; hits.push(`RSI ${r.toFixed(1)} 超买 ✗`); }
    }

    const m = macdHist(closes);
    if (m) {
        if (m.hist > 0 && m.line < 0) { pts += 20; hits.push(`MACD 底部金叉 ✓`); }
        else if (m.hist > 0)           { pts += 10; hits.push(`MACD 柱翻正`); }
        else                           { pts -= 10; hits.push(`MACD 柱为负 ✗`); }
    }

    const e9  = ema(closes, 9);
    const e21 = ema(closes, 21);
    if (e9 && e21) {
        const diff = (e9 - e21) / e21 * 100;
        if (diff > 0 && diff < 0.5) { pts += 20; hits.push(`EMA9/21 刚金叉 ✓`); }
        else if (diff > 0.5)         { pts +=  8; hits.push(`EMA9 在 EMA21 上方`); }
        else                         { pts -= 10; hits.push(`EMA9 在 EMA21 下方 ✗`); }
    }

    const bb = bollingerPos(closes);
    if (bb.pos < 0.15)  { pts += 20; hits.push(`触及布林下轨 ✓`); }
    else if (bb.pos < 0.3) { pts += 8;  hits.push(`布林带偏低区域`); }
    else if (bb.pos > 0.85) { pts -= 10; hits.push(`布林带偏高 ✗`); }

    const vr = volRatio(volumes);
    if (vr > 1.5) { pts += 15; hits.push(`量比 ${vr.toFixed(2)}x 放量 ✓`); }
    else if (vr > 1.2) { pts += 7; hits.push(`量比 ${vr.toFixed(2)}x 温和放量`); }

    return { score: Math.max(0, Math.min(100, pts)), hits, rsi: r, macd: m, vr };
}

// ─── Report ───────────────────────────────────────────────────────────────────
function bar(pct, width = 30) {
    const filled = Math.round(pct / 100 * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function rating(s) {
    if (s >= 70) return '🟢 强烈买入';
    if (s >= 50) return '🟡 关注 / 轻仓试探';
    if (s >= 30) return '⚪ 中性观望';
    return '🔴 暂缓 / 回避';
}

async function main() {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ₿  BTC 现货监测报告   ${now}`);
    console.log(`${'─'.repeat(52)}`);

    let ticker, klines;
    try {
        [ticker, klines] = await Promise.all([fetchTicker(), fetchKlines()]);
    } catch(e) {
        console.error('  ❌ 数据获取失败:', e.message);
        process.exit(1);
    }

    const price   = +ticker.lastPrice;
    const chg     = +ticker.priceChangePercent;
    const high24  = +ticker.highPrice;
    const low24   = +ticker.lowPrice;
    const closes  = klines.map(k => k.c);
    const volumes = klines.map(k => k.v);

    console.log(`  价格:  $${price.toLocaleString('en-US', {minimumFractionDigits:2})}`);
    console.log(`  24H:   ${chg >= 0 ? '▲' : '▼'} ${chg.toFixed(2)}%   高 $${high24.toLocaleString()}   低 $${low24.toLocaleString()}`);
    console.log(`  周期:  ${INTERVAL}`);

    const { score: s, hits, rsi: r, vr } = score(closes, volumes);

    console.log(`\n  综合评分  [${bar(s)}]  ${s}/100`);
    console.log(`  建议:     ${rating(s)}\n`);
    console.log(`  触发指标:`);
    hits.forEach(h => console.log(`    · ${h}`));

    console.log(`${'─'.repeat(52)}\n`);

    // 输出 JSON 供外部工具解析
    const result = {
        timestamp: new Date().toISOString(),
        price, change24h: chg, interval: INTERVAL,
        score: s, rating: rating(s), indicators: hits
    };
    process.stdout.write(''); // flush
    // 写入日志文件
    const fs = await import('fs');
    const logPath = '/home/user/706/btc-alert.log';
    const line = JSON.stringify(result) + '\n';
    fs.appendFileSync(logPath, line);
}

main();
