'use strict';
// FalconTrader Paper Terminal v3. SQLite-backed paper simulator. No broker orders are sent.
const express = require('express');
const Db = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.FTT_SECRET || 'CHANGE_ME_SET_A_PRIVATE_SECRET';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'paper.db');
const db = new Db(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS t (
  id INTEGER PRIMARY KEY, acct TEXT NOT NULL, sym TEXT NOT NULL, side INTEGER NOT NULL,
  t0 INTEGER NOT NULL, entry REAL NOT NULL, sl REAL NOT NULL, sl0 REAL NOT NULL,
  tp1 REAL NOT NULL, tp2 REAL NOT NULL, q REAL NOT NULL, qo REAL NOT NULL,
  tp1d INTEGER DEFAULT 0, gross REAL DEFAULT 0, comm REAL DEFAULT 0,
  t1 INTEGER, day TEXT, lat INTEGER, xs REAL DEFAULT 0, xn REAL DEFAULT 0,
  pv REAL DEFAULT 1, risk REAL DEFAULT 0, source TEXT DEFAULT 'WEBHOOK'
);
CREATE TABLE IF NOT EXISTS inst (
  sym TEXT PRIMARY KEY, tick REAL, pv REAL, qty REAL, comm REAL, slip REAL, ok INTEGER,
  lot_min REAL DEFAULT 0.01, lot_max REAL DEFAULT 100, lot_step REAL DEFAULT 0.01,
  contract_size REAL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS pending_orders (id INTEGER PRIMARY KEY, sym TEXT NOT NULL, side INTEGER NOT NULL, order_type TEXT NOT NULL, entry REAL NOT NULL, sl REAL NOT NULL, tp REAL NOT NULL, qty REAL NOT NULL, risk REAL NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fills (id INTEGER PRIMARY KEY, trade_id INTEGER NOT NULL, ts INTEGER NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, gross REAL NOT NULL, commission REAL NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily_marks (day TEXT NOT NULL, sym TEXT NOT NULL, price REAL NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(day,sym));
`);
function addColumn(table, def) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch (e) { if (!String(e.message).includes('duplicate column')) throw e; } }
for (const c of [
  'xs REAL DEFAULT 0','xn REAL DEFAULT 0','pv REAL DEFAULT 1','risk REAL DEFAULT 0','source TEXT DEFAULT \'WEBHOOK\'','entry_comm REAL DEFAULT 0'
]) addColumn('t', c);
for (const c of [
  'lot_min REAL DEFAULT 0.01','lot_max REAL DEFAULT 100','lot_step REAL DEFAULT 0.01','contract_size REAL DEFAULT 1'
]) addColumn('inst', c);

const DEFAULTS = {
  cap: 100000, leverage: 50, riskPct: 1, accountCurrency: 'USD',
  defaultRR: 2, autoRisk: 1, allowOvernight: 1
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  db.prepare('INSERT OR IGNORE INTO cfg(k,v) VALUES(?,?)').run(k, String(v));
}
const SEEDS = [
  ['XAUUSD', 0.01, 100, 0.01, 0, 1, 1, 0.01, 100, 0.01, 100],
  ['EURUSD', 0.00001, 100000, 0.01, 0, 1, 1, 0.01, 100, 0.01, 100000],
  ['GBPUSD', 0.00001, 100000, 0.01, 0, 1, 1, 0.01, 100, 0.01, 100000],
  ['USDJPY', 0.001, 700, 0.01, 0, 1, 1, 0.01, 100, 0.01, 100000],
  ['BTCUSD', 0.1, 1, 0.001, 0, 1, 1, 0.001, 100, 0.001, 1],
  ['ETHUSD', 0.01, 1, 0.01, 0, 1, 1, 0.01, 100, 0.01, 1],
  ['NAS100', 0.1, 1, 0.1, 0, 1, 1, 0.1, 100, 0.1, 1],
  ['US30', 1, 1, 0.1, 0, 1, 1, 0.1, 100, 0.1, 1],
  ['AUDUSD', 0.00001, 100000, 0.01, 0, 1, 1, 0.01, 100, 0.01, 100000],
  ['GBPJPY', 0.001, 700, 0.01, 0, 1, 1, 0.01, 100, 0.01, 100000]
];
const normalizeSymbol = s => String(s || '').toUpperCase().replace(/^.*:/, '').replace(/!$/, '').trim();
const getInst = db.prepare('SELECT * FROM inst WHERE sym=?');
function ensureInst(sym) {
  sym = normalizeSymbol(sym);
  let r = getInst.get(sym);
  if (!r) {
    const d = SEEDS.find(x => x[0] === sym);
    if (d) {
      db.prepare(`INSERT INTO inst(sym,tick,pv,qty,comm,slip,ok,lot_min,lot_max,lot_step,contract_size)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(...d);
    } else {
      // Unknown contracts must be configured by the user before they can be traded.
      db.prepare(`INSERT INTO inst(sym,tick,pv,qty,comm,slip,ok,lot_min,lot_max,lot_step,contract_size)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(sym, 0.01, 1, 0.01, 0, 1, 0, 0.01, 100, 0.01, 1);
    }
    r = getInst.get(sym);
  }
  return r;
}
for (const d of SEEDS) ensureInst(d[0]);
const last = Object.create(null);
const pending = Object.create(null);
const config = () => Object.fromEntries(db.prepare('SELECT k,v FROM cfg').all().map(x => [x.k, Number.isFinite(Number(x.v)) ? Number(x.v) : x.v]));
const putConfig = (k, v) => db.prepare('INSERT OR REPLACE INTO cfg(k,v) VALUES(?,?)').run(k, String(v));
const openTrade = (acct, sym, source = null) => source ? db.prepare('SELECT * FROM t WHERE acct=? AND sym=? AND qo>0 AND source=? ORDER BY id DESC LIMIT 1').get(acct, sym, source) : db.prepare('SELECT * FROM t WHERE acct=? AND sym=? AND qo>0 ORDER BY id DESC LIMIT 1').get(acct, sym);
const roundDown = (v, step) => Math.floor((v + 1e-10) / step) * step;
const roundLot = (v, i) => Math.max(0, Number(roundDown(v, Number(i.lot_step) || 0.01).toFixed(8)));
function priceValue(i) { return Number(i.pv) > 0 ? Number(i.pv) : 1; }
function riskFor(entry, sl, qty, i) { return Math.abs(entry - sl) * priceValue(i) * qty + qty * Number(i.comm || 0) * 2; }
function sizeForRisk(entry, sl, i, cfg) {
  const budget = Number(cfg.cap) * Number(cfg.riskPct) / 100;
  const perLot = riskFor(entry, sl, 1, i);
  if (!(entry > 0 && sl > 0 && perLot > 0 && budget > 0)) return { qty: 0, budget, risk: 0, reason: 'Enter a valid entry, stop loss and capital.' };
  const qty = roundLot(Math.min(Number(i.lot_max), budget / perLot), i);
  const risk = riskFor(entry, sl, qty, i);
  if (qty < Number(i.lot_min) || risk > budget + 1e-6) return { qty: 0, budget, risk, reason: `Minimum volume (${i.lot_min}) would exceed the ${cfg.riskPct}% risk cap.` };
  return { qty, budget, risk, reason: '' };
}
function marginFor(entry, qty, i, cfg) {
  return Math.abs(entry) * Number(i.contract_size || 1) * qty / Math.max(1, Number(cfg.leverage) || 50);
}
function tradePV(t, i) { return Number(t.pv) > 0 && (Number(t.pv) !== 1 || Number(i.pv) === 1) ? Number(t.pv) : priceValue(i); }
function exitFill(t, requestedQty, rawPrice, isStop = false) {
  const i = ensureInst(t.sym);
  const n = Math.min(Number(t.qo), Math.max(0, Number(requestedQty)));
  if (!(n > 0)) return;
  let px = Number(rawPrice);
  if (isStop) px -= Number(t.side) * Number(i.slip || 0) * Number(i.tick || 0);
  const remaining = Math.max(0, Number(t.qo) - n);
  const now = Date.now();
  const gross = (px - Number(t.entry)) * Number(t.side) * n * tradePV(t, i);
  const cost = n * Number(i.comm || 0);
  db.prepare(`UPDATE t SET gross=gross+?,comm=comm+?,qo=?,xs=COALESCE(xs,0)+?,xn=COALESCE(xn,0)+?,
    t1=?,day=? WHERE id=?`).run(gross, cost, remaining, px * n, n,
      remaining <= 1e-8 ? now : null,
      remaining <= 1e-8 ? new Date(now + 19800000).toISOString().slice(0,10) : null, t.id);
  db.prepare('INSERT INTO fills(trade_id,ts,qty,price,gross,commission,reason) VALUES(?,?,?,?,?,?,?)').run(t.id, now, n, px, gross, cost, isStop ? 'STOP' : 'TARGET_OR_MANUAL');
}
function calcFloating(t) {
  const l = last[t.sym];
  if (!l || !(Number(l.p) > 0) || Number(t.qo) <= 0) return null;
  const i = ensureInst(t.sym);
  return (Number(l.p) - Number(t.entry)) * Number(t.side) * Number(t.qo) * tradePV(t, i);
}
function validateTrade({ sym, side, entry, sl, tp, tp1, tp2, qty, acct = 'MANUAL', source = 'MANUAL' }) {
  const i = ensureInst(sym), cfg = config();
  entry = Number(entry); sl = Number(sl); tp = Number(tp);
  const target1 = Number(tp1 == null ? tp : tp1), target2 = Number(tp2 == null ? tp : tp2);
  if (!i.ok) throw Object.assign(new Error(`${sym} needs symbol contract settings before trading.`), { status: 422 });
  if (!(entry > 0 && sl > 0 && tp > 0) || !['BUY','SELL'].includes(side)) throw Object.assign(new Error('Enter valid entry, stop-loss and take-profit prices.'), { status: 400 });
  if ((side === 'BUY' && !(sl < entry && target1 > entry && target2 > entry)) || (side === 'SELL' && !(sl > entry && target1 < entry && target2 < entry))) throw Object.assign(new Error('For BUY, SL must be below entry and both targets above. For SELL, reverse those levels.'), { status: 400 });
  const sizing = sizeForRisk(entry, sl, i, cfg);
  if (!sizing.qty) throw Object.assign(new Error(sizing.reason), { status: 422 });
  const requested = qty == null || qty === '' ? sizing.qty : roundLot(Number(qty), i);
  if (!(requested >= Number(i.lot_min) && requested <= Number(i.lot_max))) throw Object.assign(new Error(`Volume must be between ${i.lot_min} and ${i.lot_max} in ${i.lot_step} increments.`), { status: 422 });
  const risk = riskFor(entry, sl, requested, i);
  if (risk > sizing.budget + 1e-6) throw Object.assign(new Error(`Risk ${risk.toFixed(2)} exceeds the ${cfg.riskPct}% cap (${sizing.budget.toFixed(2)}). Reduce volume.`), { status: 422 });
  const margin = marginFor(entry, requested, i, cfg);
  const metrics = accountMetrics(acct);
  if (margin > metrics.freeMargin + 1e-6) throw Object.assign(new Error(`Insufficient free margin. Required ${margin.toFixed(2)}, available ${metrics.freeMargin.toFixed(2)}.`), { status: 422 });
  return { i, cfg, sym: normalizeSymbol(sym), side: side === 'BUY' ? 1 : -1, entry, sl, tp: target2, tp1: target1, tp2: target2, qty: requested, risk, margin, acct, source };
}
function insertTrade(v) {
  const now = Date.now();
  const tp2 = v.tp2;
  const entryCost = v.qty * Number(v.i.comm || 0);
  const res = db.prepare(`INSERT INTO t(acct,sym,side,t0,entry,sl,sl0,tp1,tp2,q,qo,comm,lat,pv,risk,source,entry_comm)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.acct, v.sym, v.side, now, v.entry, v.sl, v.sl, v.tp1, tp2,
      v.qty, v.qty, entryCost, null, priceValue(v.i), v.risk, v.source, entryCost);
  return { id: Number(res.lastInsertRowid), qty: v.qty, risk: v.risk, margin: v.margin };
}
function accountMetrics(acct = 'MANUAL') {
  const cfg = config();
  const trades = db.prepare('SELECT * FROM t WHERE acct=? ORDER BY id').all(acct);
  let realizedGross = 0, costs = 0, floating = 0, openCount = 0, usedMargin = 0;
  for (const t of trades) {
    realizedGross += Number(t.gross || 0);
    costs += Number(t.comm || 0);
    if (Number(t.qo) > 0) {
      openCount++;
      const f = calcFloating(t);
      if (f != null) floating += f;
      usedMargin += marginFor(Number(t.entry), Number(t.qo), ensureInst(t.sym), cfg);
    }
  }
  const balance = Number(cfg.cap) + realizedGross - costs;
  const equity = balance + floating;
  return { balance, equity, floating, realized: realizedGross - costs, totalPnl: equity - Number(cfg.cap), openCount,
    usedMargin, freeMargin: equity - usedMargin, cap: Number(cfg.cap), leverage: Number(cfg.leverage), riskPct: Number(cfg.riskPct) };
}
function dayPnl(acct = 'MANUAL') {
  const today = new Date(Date.now() + 19800000).toISOString().slice(0,10);
  const start = Date.parse(today + 'T00:00:00+05:30');
  const end = start + 86400000;
  const openedToday = db.prepare('SELECT * FROM t WHERE acct=? AND t0>=? AND t0<?').all(acct, start, end);
  const entryCosts = openedToday.reduce((sum,t) => sum + Number(t.entry_comm || 0), 0);
  const fillsToday = db.prepare(`SELECT f.*, t.acct, t.sym, t.side, t.entry, t.t0, t.pv FROM fills f JOIN t ON t.id=f.trade_id WHERE t.acct=? AND f.ts>=? AND f.ts<?`).all(acct,start,end);
  let pnl = fillsToday.reduce((sum,f) => sum + Number(f.gross || 0) - Number(f.commission || 0), 0) - entryCosts;
  // For trades carried overnight, today's realised fills exclude the previous close's unrealised P&L.
  for (const f of fillsToday) {
    if (Number(f.t0) >= start) continue;
    const prev = db.prepare('SELECT price FROM daily_marks WHERE sym=? AND day<? ORDER BY day DESC LIMIT 1').get(f.sym,today);
    if (prev) pnl -= (Number(prev.price)-Number(f.entry))*Number(f.side)*Number(f.qty)*tradePV(f,ensureInst(f.sym));
  }
  const open = db.prepare('SELECT * FROM t WHERE acct=? AND qo>0').all(acct);
  for (const t of open) {
    const q = last[t.sym]; if (!q) continue;
    const f = db.prepare('SELECT price FROM daily_marks WHERE sym=? AND day<? ORDER BY day DESC LIMIT 1').get(t.sym,today);
    if (Number(t.t0) >= start) pnl += (Number(q.p)-Number(t.entry))*Number(t.side)*Number(t.qo)*tradePV(t,ensureInst(t.sym));
    else if (f) pnl += (Number(q.p)-Number(f.price))*Number(t.side)*Number(t.qo)*tradePV(t,ensureInst(t.sym));
  }
  // Legacy rows from before fill logging: use their completed-trade net as the best available daily approximation.
  const legacy = db.prepare(`SELECT * FROM t WHERE acct=? AND day=? AND id NOT IN (SELECT DISTINCT trade_id FROM fills)`).all(acct,today);
  pnl += legacy.reduce((sum,t) => sum + Number(t.gross || 0) - Number(t.comm || 0), 0);
  return pnl;
}
function closeTrade(t, price, qty, isStop = false) {
  if (!t) throw Object.assign(new Error('Open position not found.'), { status: 404 });
  exitFill(t, qty == null ? Number(t.qo) : Number(qty), price, isStop);
  return db.prepare('SELECT * FROM t WHERE id=?').get(t.id);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.text({ type: ['text/plain', 'application/octet-stream'], limit: '100kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'FalconTrader Paper Terminal', version: 3 }));
app.post('/hook', (req, res) => {
  let m;
  try { m = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { return res.status(400).json({ error: 'invalid_json' }); }
  if (!m || m.secret !== SECRET) { console.warn('Rejected webhook: invalid secret'); return res.status(403).json({ error: 'invalid_secret' }); }
  const sym = normalizeSymbol(m.symbol), type = String(m.type || '').toUpperCase();
  const source = String(m.strategy_name || m.indicator || m.source || 'WEBHOOK').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0,48) || 'WEBHOOK';
  if (!sym || !type) return res.status(422).json({ error: 'missing_symbol_or_type' });
  try {
    const i = ensureInst(sym);
    if (type === 'BAR') {
      const p = Number(m.c);
      if (!(p > 0)) return res.status(422).json({ error: 'invalid_close_price' });
      last[sym] = { p, t: Number(m.t || Date.now()), o: Number(m.o), h: Number(m.h), l: Number(m.l), c: p, receivedAt: Date.now() };
      const istDay = new Date(Date.now() + 19800000).toISOString().slice(0,10);
      db.prepare('INSERT OR REPLACE INTO daily_marks(day,sym,price,ts) VALUES(?,?,?,?)').run(istDay,sym,p,Date.now());
      if (!i.ok && Number(m.tick) > 0 && Number(m.pv) > 0) {
        // Auto-detect tick/point value for an unknown symbol, but keep it disabled until the user confirms lot and contract settings.
        db.prepare('UPDATE inst SET tick=?,pv=? WHERE sym=?').run(Number(m.tick), Number(m.pv), sym);
      }
      const cfg = config();
      // Trigger manually staged limit/stop orders from the incoming one-minute OHLC feed.
      const staged = db.prepare('SELECT * FROM pending_orders WHERE sym=? ORDER BY id').all(sym);
      for (const po of staged) {
        const hi = Number(m.h), lo = Number(m.l), op = Number(m.o || m.c);
        const trigger = po.order_type === 'BUY_LIMIT' ? lo <= po.entry : po.order_type === 'SELL_LIMIT' ? hi >= po.entry : po.order_type === 'BUY_STOP' ? hi >= po.entry : lo <= po.entry;
        const sellStopTrigger = false;
        if (trigger || sellStopTrigger) {
          try { const v = validateTrade({ sym, side: po.side > 0 ? 'BUY' : 'SELL', entry: po.entry, sl: po.sl, tp: po.tp, qty: po.qty, acct: 'MANUAL', source: 'PENDING' }); insertTrade(v); db.prepare('DELETE FROM pending_orders WHERE id=?').run(po.id); }
          catch (e) { console.warn('Pending order skipped:', e.message); db.prepare('DELETE FROM pending_orders WHERE id=?').run(po.id); }
        }
      }
      const z = openTrade('REAL', sym); // quote feed still auto-manages manual/legacy positions only
      const managedByIndicator = z && !['MANUAL','PENDING','WEBHOOK'].includes(String(z.source || '').toUpperCase());
      if (z && !managedByIndicator && last[sym].h > 0 && last[sym].l > 0 && Number(m.t) >= Math.floor(Number(z.t0) / 60000) * 60000 + 60000) {
        const hit = (level, target) => (Number(z.side) > 0) === target ? Number(m.h) >= level : Number(m.l) <= level;
        // Conservative OHLC rule: if both stop and target are inside a bar, assume stop first.
        if (hit(Number(z.sl), false)) closeTrade(z, Number(z.sl), Number(z.qo), true);
        else if (!Number(z.tp1d) && hit(Number(z.tp1), true)) {
          const cur = db.prepare('SELECT * FROM t WHERE id=?').get(z.id);
          const half = roundLot(Number(cur.qo) / 2, i);
          const n = half >= Number(i.lot_min) && half < Number(cur.qo) ? half : Number(cur.qo);
          exitFill(cur, n, Number(cur.tp1), false);
          db.prepare('UPDATE t SET tp1d=1,sl=? WHERE id=?').run(process.env.BE === '1' ? cur.entry : cur.sl, cur.id);
        } else if (Number(z.tp1d) && hit(Number(z.tp2), true)) closeTrade(z, Number(z.tp2), Number(z.qo), false);
      }
      return res.json({ ok: true, type: 'BAR', symbol: sym });
    }
    if (type === 'PENDING') pending[sym + source + m.direction] = m.order_type;
    else if (type === 'PENDING_CANCEL') delete pending[sym + source + m.direction];
    else if (type === 'ENTRY') {
      if (!['BUY','SELL'].includes(String(m.direction).toUpperCase())) return res.status(422).json({ error: 'invalid_direction' });
      const side = String(m.direction).toUpperCase();
      for (const acct of ['MIRROR','REAL']) {
        const prior = openTrade(acct, sym, source);
        if (prior) closeTrade(prior, Number(m.entry) || Number(last[sym]?.p), Number(prior.qo), false);
        const i2 = ensureInst(sym);
        const sizing = sizeForRisk(Number(m.entry), Number(m.sl), i2, config());
        if (!sizing.qty) { console.warn(`Skipped ${type} ${sym}: ${sizing.reason}`); continue; }
        const v = validateTrade({ sym, side, entry: Number(m.entry), sl: Number(m.sl), tp: Number(m.tp2 || m.tp1), tp1: Number(m.tp1 || m.tp2), tp2: Number(m.tp2 || m.tp1), qty: sizing.qty, acct, source });
        const stp = /STOP/.test(pending[sym + source + side] || '');
        if (stp) v.entry += v.side * Number(i2.slip || 0) * Number(i2.tick || 0);
        insertTrade(v);
      }
      delete pending[sym + source + side];
    } else if (['TP1','TP2','SL','BE_EXIT'].includes(type)) {
      for (const acct of ['MIRROR','REAL']) {
        let t = openTrade(acct, sym, source);
        if (!t) continue;
        if (type === 'TP1') {
          const half = roundLot(Number(t.qo) / 2, i);
          const n = half >= Number(i.lot_min) && half < Number(t.qo) ? half : Number(t.qo);
          exitFill(t, n, Number(m.tp1 ?? m.level ?? t.tp1), false);
          db.prepare('UPDATE t SET tp1d=1,sl=? WHERE id=?').run(m.be_active === 'true' ? t.entry : t.sl, t.id);
        } else if (type === 'TP2') closeTrade(t, Number(m.tp2 ?? m.level ?? t.tp2), Number(t.qo), false);
        else if (type === 'SL') closeTrade(t, Number(m.sl), Number(t.qo), true);
        else closeTrade(t, Number(t.entry), Number(t.qo), true);
      }
    } else if (type === 'ZONE') {
      // Zone-only alerts are informational; they must not create/close positions.
    } else {
      return res.status(422).json({ error: 'unsupported_type', type });
    }
    return res.json({ ok: true, type, symbol: sym });
  } catch (e) {
    console.error('Webhook processing error:', e.message);
    return res.status(e.status || 500).json({ error: e.message || 'webhook_processing_failed' });
  }
});

app.get('/api/data', (req, res) => {
  const cfg = config();
  const acct = ['MANUAL','MIRROR','REAL'].includes(String(req.query.acct || '').toUpperCase()) ? String(req.query.acct || 'MANUAL').toUpperCase() : 'MANUAL';
  const trades = db.prepare('SELECT * FROM t WHERE acct=? ORDER BY id DESC LIMIT 5000').all(acct).map(t => {
    const i = ensureInst(t.sym);
    const pv = tradePV(t, i);
    const floating = Number(t.qo) > 0 && last[t.sym]
      ? (Number(last[t.sym].p) - Number(t.entry)) * Number(t.side) * Number(t.qo) * pv : null;
    return { ...t, pv, floating, net: Number(t.gross || 0) + (floating || 0) - Number(t.comm || 0), quote: last[t.sym] || null };
  });
  const inst = db.prepare('SELECT * FROM inst ORDER BY sym').all().map(i => ({ ...i, quote: last[i.sym] || null }));
  const metrics = accountMetrics(acct);
  const pendingOrders = db.prepare('SELECT * FROM pending_orders ORDER BY id DESC').all();
  res.json({ trades, inst, cfg, acct, pendingOrders, ...metrics, dailyPnl: dayPnl(acct), last, serverTime: Date.now() });
});
app.post('/api/manual', (req, res) => {
  try {
    const b = req.body || {};
    const sym = normalizeSymbol(b.symbol);
    const i = ensureInst(sym);
    const entry = Number(b.entry) > 0 ? Number(b.entry) : Number(last[sym]?.p);
    if (!(entry > 0)) return res.status(409).json({ error: `No live price for ${sym}. Configure a TradingView bar-feed alert or enter a price manually.` });
    const side = String(b.side || '').toUpperCase();
    const sl = Number(b.sl), cfg = config();
    let tp = Number(b.tp);
    if (!(tp > 0) && entry > 0 && sl > 0 && ['BUY','SELL'].includes(side)) tp = side === 'BUY' ? entry + (entry - sl) * Number(cfg.defaultRR) : entry - (sl - entry) * Number(cfg.defaultRR);
    const sizing = sizeForRisk(entry, sl, i, cfg);
    if (!sizing.qty) return res.status(422).json({ error: sizing.reason });
    const v = validateTrade({ sym, side, entry, sl, tp, qty: b.qty || sizing.qty, acct: String(b.account || 'MANUAL'), source: 'MANUAL' });
    const trade = insertTrade(v);
    return res.json({ ok: true, trade, message: `Paper ${side} opened: ${v.qty} lots; estimated risk ${v.risk.toFixed(2)}.` });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message || 'manual_trade_failed' }); }
});
app.post('/api/pending', (req, res) => {
  try {
    const b = req.body || {}, sym = normalizeSymbol(b.symbol), i = ensureInst(sym);
    const type = String(b.orderType || '').toUpperCase();
    const side = type.startsWith('BUY') ? 'BUY' : type.startsWith('SELL') ? 'SELL' : '';
    const entry = Number(b.entry), sl = Number(b.sl), cfg = config();
    let tp = Number(b.tp);
    if (!(tp > 0) && entry > 0 && sl > 0 && side) tp = side === 'BUY' ? entry + (entry - sl) * Number(cfg.defaultRR) : entry - (sl - entry) * Number(cfg.defaultRR);
    if (!['BUY_LIMIT','SELL_LIMIT','BUY_STOP','SELL_STOP'].includes(type)) return res.status(400).json({ error: 'Choose a valid pending order type.' });
    const v = validateTrade({ sym, side, entry, sl, tp, qty: b.qty || undefined, acct: 'MANUAL', source: 'PENDING' });
    const quote = last[sym]?.p;
    if (quote > 0) {
      const validPlacement = type === 'BUY_LIMIT' ? entry < quote : type === 'SELL_LIMIT' ? entry > quote : type === 'BUY_STOP' ? entry > quote : entry < quote;
      if (!validPlacement) return res.status(422).json({ error: `The ${type.replace('_',' ')} entry is on the wrong side of current price ${quote}.` });
    }
    const r = db.prepare('INSERT INTO pending_orders(sym,side,order_type,entry,sl,tp,qty,risk,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(sym, v.side, type, entry, sl, tp, v.qty, v.risk, Date.now());
    return res.json({ ok: true, id: Number(r.lastInsertRowid), qty: v.qty, risk: v.risk });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message || 'pending_order_failed' }); }
});
app.delete('/api/pending/:id', (req, res) => {
  const r = db.prepare('DELETE FROM pending_orders WHERE id=?').run(Number(req.params.id));
  return r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'pending_order_not_found' });
});

app.post('/api/close', (req, res) => {
  try {
    const b = req.body || {};
    const t = db.prepare('SELECT * FROM t WHERE id=? AND qo>0').get(Number(b.id));
    if (!t) return res.status(404).json({ error: 'open_position_not_found' });
    const px = Number(b.price) > 0 ? Number(b.price) : Number(last[t.sym]?.p);
    if (!(px > 0)) return res.status(409).json({ error: `No current quote for ${t.sym}; cannot estimate a market close.` });
    closeTrade(t, px, Number(t.qo), false);
    return res.json({ ok: true });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.secret !== SECRET) return res.status(403).json({ error: 'Settings secret is incorrect.' });
  const cap = Number(b.cap), leverage = Number(b.leverage), riskPct = Number(b.riskPct), rr = Number(b.defaultRR);
  if (!(cap > 0 && leverage >= 1 && leverage <= 1000 && riskPct > 0 && riskPct <= 1 && rr > 0 && rr <= 20)) {
    return res.status(422).json({ error: 'Capital must be positive, leverage 1–1000, risk cap >0–1%, and R:R 0–20.' });
  }
  for (const [k, v] of Object.entries({ cap, leverage, riskPct, defaultRR: rr, autoRisk: 1 })) putConfig(k, v);
  const sym = normalizeSymbol(b.sym);
  if (sym) {
    const current = ensureInst(sym);
    const num = (key, fallback) => b[key] === '' || b[key] == null ? fallback : Number(b[key]);
    const tick = num('tick', current.tick), pv = num('pv', current.pv), comm = num('comm', current.comm), slip = num('slip', current.slip);
    const lotMin = num('lotMin', current.lot_min), lotMax = num('lotMax', current.lot_max), lotStep = num('lotStep', current.lot_step), contract = num('contractSize', current.contract_size);
    if (![tick,pv,comm,slip,lotMin,lotMax,lotStep,contract].every(Number.isFinite) || tick <= 0 || pv <= 0 || comm < 0 || slip < 0 || lotMin <= 0 || lotMax < lotMin || lotStep <= 0 || contract <= 0) return res.status(422).json({ error: 'Check symbol tick, point value, commission, slippage, lot min/max/step and contract size.' });
    db.prepare(`UPDATE inst SET tick=?,pv=?,comm=?,slip=?,lot_min=?,lot_max=?,lot_step=?,contract_size=?,ok=1 WHERE sym=?`)
      .run(tick,pv,comm,slip,lotMin,lotMax,lotStep,contract,sym);
  }
  return res.json({ ok: true, cfg: config() });
});
app.post('/api/reset', (req, res) => {
  const b = req.body || {};
  if (b.secret !== SECRET) return res.status(403).json({ error: 'Reset secret is incorrect.' });
  if (b.confirm !== 'YES') return res.status(400).json({ error: 'Reset requires explicit YES confirmation.' });
  const transaction = db.transaction(() => { db.prepare('DELETE FROM t').run(); db.prepare('DELETE FROM pending_orders').run(); db.prepare('DELETE FROM fills').run(); db.prepare('DELETE FROM daily_marks').run(); db.prepare("DELETE FROM cfg WHERE k LIKE 'last:%'").run(); });
  transaction();
  for (const k of Object.keys(last)) delete last[k];
  for (const k of Object.keys(pending)) delete pending[k];
  return res.json({ ok: true, message: 'Paper account reset to configured starting capital. Trade history, open positions and in-memory quotes cleared; risk/settings retained.' });
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`FalconTrader Paper Terminal v3 listening on ${PORT}`));
