# FalconTrader Paper Terminal v3

A responsive paper-trading dashboard using the provided FalconTrader logo, a TradingView Advanced Chart widget, a SQLite-backed paper account, manual market and pending orders, risk-based sizing, per-symbol contract settings, trade history, and a confirmed reset. Fresh-install defaults: $50,000 USD capital, 1:50 leverage, 1% maximum risk per trade ($500), 1:2 reward-to-risk, and webhook/reset secret `FTT2025`.

## Features

- Dashboard layout inspired by the supplied reference image.
- TradingView widget embedded using the supplied `tv-advanced-chart` custom element.
- Manual BUY/SELL paper trades and BUY LIMIT / SELL LIMIT / BUY STOP / SELL STOP pending orders.
- Volume sizing from capital × risk percentage ÷ stop distance and per-symbol point value; volume rounds down to the configured lot step.
- Server rejects orders if minimum volume would exceed the risk cap, stop direction is invalid, symbol contract data is unconfigured, or estimated margin is insufficient.
- Default leverage 1:50 and maximum risk 1% of configured starting capital per trade.
- Configurable capital, leverage, risk percentage, default R:R, tick size, point value, lot minimum/maximum/step, contract size, commission and slippage.
- Gross P&L, commissions, net P&L, floating P&L, balance, equity, margin and CSV history.
- Mirror and Realistic accounts for incoming Pine webhook alerts, plus a Manual Paper account.
- Reset requires server secret, browser confirmation and typing `YES`; it clears positions, pending orders, quote cache, fill records and trade history, while retaining starting capital and symbol/risk settings.
- Root URL serves `public/index.html`, fixing the common root-path 404 when HTML is outside the static directory.

## Important accuracy notes

The paper engine calculates price P&L as `(exit price - entry price) × side × lots × configured point value`, minus recorded commissions and simulated stop slippage. Accuracy depends on configuring the correct point value, contract size, tick size, lot constraints and commission for the exact TradingView/broker symbol. Defaults are starter values, not universal broker specifications. Verify each symbol before relying on the simulation.

The TradingView widget is a visual chart embed; it does not expose its live price stream to this app. For server-side live P&L and realistic stop/target simulation, configure a TradingView alert from `ftt_bar_feed.pine` on a 1-minute chart, using the same secret as `FTT_SECRET`. The FTT indicator's ENTRY/TP/SL alerts use the same `/hook` endpoint. The chart may display even while the server quote feed is disconnected.

This app is a paper simulator only. It does not submit orders to a broker.

## Railway deployment / updating the existing project

1. Back up the existing project and the persistent database volume before replacing files.
2. Copy `server.js` and `package.json` into the project root.
3. Copy `public/index.html` and `public/falcon-logo.png` into the `public/` folder.
4. Keep the existing persistent database path if you want to retain previous records. For the Railway volume shown in the earlier setup, use `DB_PATH=/data/paper.db` only if `/data` is the mounted persistent volume in this service.
5. Default server/reset/webhook secret is `FTT2025`. Set Railway variable `FTT_SECRET=FTT2025` and use the same value in the Pine input for the FTT indicator and in the FTT Bar Feed script. This is a convenient initial value, not a production-grade secret: change it to a long random value before making the app public, then update the Pine inputs to match. The Reset Paper Account field uses this exact server secret.
6. Deploy and check `https://YOUR-RAILWAY-DOMAIN/api/health` (expected JSON with `ok: true`) and `/api/data` (expected JSON). The public webhook URL is `https://YOUR-RAILWAY-DOMAIN/hook`.
7. In TradingView, create alerts using `Any alert() function call`. For bar feed, use the `FTT Bar Feed` indicator on a 1-minute chart and use the webhook URL above. For the main FTT indicator, use the same URL and same secret.
8. Open Settings in the dashboard and verify starting capital ($50,000), 1:50 leverage, 1% risk, 1:2 reward-to-risk, and each symbol's contract data. Save the symbol settings after verification. Existing persistent databases keep their already-saved capital setting; set it to $50,000 in Settings if this is an upgrade rather than a fresh install.

## Local run

Requires Node.js 18+ and build tools compatible with `better-sqlite3`.

```bash
npm install
# Windows PowerShell example:
$env:FTT_SECRET = "FTT2025"
$env:DB_PATH = "./paper.db"
npm start
```

Open `http://localhost:3000`.

## API routes

- `GET /api/health` — health check.
- `GET /api/data?acct=MANUAL|MIRROR|REAL` — current account data and quotes.
- `POST /hook` — TradingView webhook (`BAR`, `ENTRY`, `TP1`, `TP2`, `SL`, `BE_EXIT`, pending lifecycle events).
- `POST /api/manual` — manual paper market order.
- `POST /api/pending` and `DELETE /api/pending/:id` — pending orders.
- `POST /api/close` — close a paper position at the latest received quote.
- `POST /api/settings` — update capital/risk and selected symbol contract configuration; requires `secret`.
- `POST /api/reset` — destructive reset; requires `secret` and `confirm: "YES"`.


## Two-indicator source-aware webhooks (updated)

This package includes `FTT_Sniper_V5.10.pine` and `FTT_ZCT_Pending_Zones_V8.4.1.pine`. Each webhook payload includes a `strategy_name` (`SNIPER` or `ZCT_PENDING_ZONES`), and the paper server stores it in the trade `source` field. Entry/exit lifecycle events are matched to that source so one indicator's exit should not close the other indicator's trade for the same symbol. The History page now supports symbol text search and indicator/source filtering, and CSV export uses the current filters.

Configure the same private webhook secret in the app environment (`FTT_SECRET`) and each indicator's Webhook Secret Key. In TradingView, create alerts using the indicator's `alert()` function / “Any alert() function call” and point the webhook URL to `/hook`. Do not reuse a public/shared secret.

**Intrabar timing note:** the Sniper script's alert frequency was changed from bar-close-only to once-per-bar so realtime touch/exit events can be sent without waiting for the candle to close. This may produce intrabar signals that differ from historical confirmed-bar results; test on paper first. Actual delivery latency still depends on TradingView alert execution and webhook/network availability. This is a paper simulator, not a broker execution engine. Existing history rows created before the source tag was added remain labelled `WEBHOOK` because their original indicator identity was not stored.
