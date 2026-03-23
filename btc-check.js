#!/usr/bin/env node
/**
 * BTC 现货交易监测脚本
 * 自动抓取 Binance 公开 API，计算多个短线指标并输出买入评分
 *
 * 推送配置（在 btc-config.json 中设置，或通过环境变量）：
 *   NOTIFY_MODE    = telegram | dingtalk | feishu | ntfy | none
 *   NOTIFY_SCORE   = 最低推送分数阈值，默认 50（仅在 ≥ 此分数时推送）
 *
 *   Telegram:   TG_TOKEN, TG_CHAT_ID
 *   钉钉:        DD_WEBHOOK
 *   飞书:        FS_WEBHOOK
 *   ntfy.sh:    NTFY_TOPIC（如 btc-my-alerts）
 */

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const LOGPATH  = resolve(__dir, 'btc-alert.log');
const CFGPATH  = resolve(__dir, 'btc-config.json');

// ─── Config (file > env > defaults) ──────────────────────────────────────────
function loadConfig() {
    let file = {};
    if (existsSync(CFGPATH)) {
        try { file = JSON.parse(readFileSync(CFGPATH, 'utf8')); } catch {}
    }
    const e = process.env;
    return {
        mode:       e.NOTIFY_MODE   || file.mode       || 'none',
        minScore:   +(e.NOTIFY_SCORE|| file.minScore   || 50),
        tgToken:    e.TG_TOKEN      || file.tgToken     || '',
        tgChatId:   e.TG_CHAT_ID    || file.tgChatId    || '',
        ddWebhook:  e.DD_WEBHOOK    || file.ddWebhook    || '',
        fsWebhook:  e.FS_WEBHOOK    || file.fsWebhook    || '',
        ntfyTopic:  e.NTFY_TOPIC    || file.ntfyTopic    || 'btc-alerts',
    };
}

const CFG      = loadConfig();
const BINANCE  = 'https://api.binance.com/api/v3';
const SYMBOL   = 'BTCUSDT';
const INTERVAL = process.argv[2] || '5m';
const LIMIT    = 100;

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}
async function fetchTicker()  { return get(`${BINANCE}/ticker/24hr?symbol=${SYMBOL}`); }
async function fetchKlines()  {
    const d = await get(`${BINANCE}/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}`);
    return d.map(d => ({ c:+d[4], v:+d[5] }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function ema(arr, p) {
    if (arr.length < p) return null;
    const k = 2 / (p + 1);
    let v = arr.slice(0, p).reduce((a, b) => a + b) / p;
    for (let i = p; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
}
function rsi(c, p = 14) {
    if (c.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = c.length - p; i < c.length; i++) {
        const d = c[i] - c[i-1]; d > 0 ? g += d : l -= d;
    }
    const ag = g/p, al = l/p;
    return al === 0 ? 100 : 100 - 100 / (1 + ag/al);
}
function macdHist(c) {
    if (c.length < 26) return null;
    const mv = [];
    for (let i = 26; i <= c.length; i++) {
        const e12 = ema(c.slice(0,i),12), e26 = ema(c.slice(0,i),26);
        if (e12 && e26) mv.push(e12 - e26);
    }
    const sig  = ema(mv, 9);
    const line = mv[mv.length-1];
    return { line, sig, hist: line - (sig||0) };
}
function bbPos(c, p = 20) {
    const s    = c.slice(-p);
    const mean = s.reduce((a,b)=>a+b)/p;
    const std  = Math.sqrt(s.map(x=>(x-mean)**2).reduce((a,b)=>a+b)/p);
    return (c[c.length-1] - (mean - 2*std)) / (4*std);
}
function volRatio(v) {
    const avg = v.slice(-20,-1).reduce((a,b)=>a+b)/19;
    return v[v.length-1] / avg;
}

// ─── Score ────────────────────────────────────────────────────────────────────
function calcScore(closes, volumes) {
    let pts = 0; const hits = [];
    const r = rsi(closes);
    if (r !== null) {
        if      (r < 35) { pts += 25; hits.push(`RSI ${r.toFixed(1)} 超卖 ✓`); }
        else if (r < 45) { pts += 12; hits.push(`RSI ${r.toFixed(1)} 偏低`); }
        else if (r > 70) { pts -= 15; hits.push(`RSI ${r.toFixed(1)} 超买 ✗`); }
    }
    const m = macdHist(closes);
    if (m) {
        if      (m.hist > 0 && m.line < 0) { pts += 20; hits.push(`MACD 底部金叉 ✓`); }
        else if (m.hist > 0)                { pts += 10; hits.push(`MACD 柱翻正`); }
        else                                { pts -= 10; hits.push(`MACD 柱为负 ✗`); }
    }
    const e9 = ema(closes,9), e21 = ema(closes,21);
    if (e9 && e21) {
        const d = (e9-e21)/e21*100;
        if      (d > 0 && d < 0.5) { pts += 20; hits.push(`EMA9/21 刚金叉 ✓`); }
        else if (d > 0.5)           { pts +=  8; hits.push(`EMA9 在 EMA21 上方`); }
        else                        { pts -= 10; hits.push(`EMA9 在 EMA21 下方 ✗`); }
    }
    const bp = bbPos(closes);
    if      (bp < 0.15) { pts += 20; hits.push(`触及布林下轨 ✓`); }
    else if (bp < 0.30) { pts +=  8; hits.push(`布林带偏低区域`); }
    else if (bp > 0.85) { pts -= 10; hits.push(`布林带偏高 ✗`); }
    const vr = volRatio(volumes);
    if      (vr > 1.5)  { pts += 15; hits.push(`量比 ${vr.toFixed(2)}x 放量 ✓`); }
    else if (vr > 1.2)  { pts +=  7; hits.push(`量比 ${vr.toFixed(2)}x 温和放量`); }
    return { score: Math.max(0, Math.min(100, pts)), hits };
}

function rating(s) {
    if (s >= 70) return '🟢 强烈买入';
    if (s >= 50) return '🟡 关注 / 轻仓试探';
    if (s >= 30) return '⚪ 中性观望';
    return '🔴 暂缓 / 回避';
}
function bar(pct, w=30) {
    const f = Math.round(pct/100*w);
    return '█'.repeat(f) + '░'.repeat(w-f);
}

// ─── Notify ───────────────────────────────────────────────────────────────────
async function notify(score, price, chg, hits) {
    if (CFG.mode === 'none' || score < CFG.minScore) return;

    const emoji  = score >= 70 ? '🚨' : '👁';
    const time   = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const detail = hits.map(h => `  · ${h}`).join('\n');
    const text   =
`${emoji} BTC 买入预警 ${time}
价格: $${price.toLocaleString('en-US',{minimumFractionDigits:2})}  ${chg>=0?'▲':'▼'}${Math.abs(chg).toFixed(2)}%
评分: ${score}/100  ${rating(score)}
周期: ${INTERVAL}
指标:
${detail}`;

    try {
        if (CFG.mode === 'telegram') {
            await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: CFG.tgChatId, text, parse_mode: 'HTML' })
            });
            console.log('  📨 Telegram 推送完成');

        } else if (CFG.mode === 'dingtalk') {
            await fetch(CFG.ddWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ msgtype:'text', text:{ content: text } })
            });
            console.log('  📨 钉钉推送完成');

        } else if (CFG.mode === 'feishu') {
            await fetch(CFG.fsWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ msg_type:'text', content:{ text } })
            });
            console.log('  📨 飞书推送完成');

        } else if (CFG.mode === 'ntfy') {
            await fetch(`https://ntfy.sh/${CFG.ntfyTopic}`, {
                method: 'POST',
                headers: {
                    'Title':    `BTC 评分 ${score}/100`,
                    'Priority': score >= 70 ? 'high' : 'default',
                    'Tags':     score >= 70 ? 'rotating_light,btc' : 'eyes,btc',
                    'Content-Type': 'text/plain; charset=utf-8'
                },
                body: text
            });
            console.log(`  📨 ntfy 推送完成 → https://ntfy.sh/${CFG.ntfyTopic}`);
        }
    } catch(e) {
        console.error('  ⚠️  推送失败:', e.message);
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ₿  BTC 监测报告   ${now}`);
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
    const closes  = klines.map(k => k.c);
    const volumes = klines.map(k => k.v);

    console.log(`  价格:  $${price.toLocaleString('en-US',{minimumFractionDigits:2})}`);
    console.log(`  24H:   ${chg>=0?'▲':'▼'} ${chg.toFixed(2)}%`);
    console.log(`  推送:  ${CFG.mode}  (阈值 ≥${CFG.minScore})`);

    const { score, hits } = calcScore(closes, volumes);

    console.log(`\n  评分  [${bar(score)}]  ${score}/100`);
    console.log(`  建议:  ${rating(score)}\n`);
    hits.forEach(h => console.log(`    · ${h}`));
    console.log(`${'─'.repeat(52)}\n`);

    // 写入日志
    appendFileSync(LOGPATH,
        JSON.stringify({ timestamp: new Date().toISOString(), price, chg, interval: INTERVAL, score, rating: rating(score), hits }) + '\n'
    );

    // 推送
    await notify(score, price, chg, hits);
}

main();
