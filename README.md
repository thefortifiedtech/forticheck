# FortiCheck

FortiCheck is a multi-chain (Solana & BSC) token intelligence platform that scans for high-signal trading opportunities using the GMGN API. It runs as a suite of Docker services with a centralized rate-limit-safe fetcher, shared SQLite cache, real-time Discord alerts, and a web dashboard.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      GMGN FETCHER (Centralized)                 │
│  • Polls GMGN every 60s (trenches, trending, token info)        │
│  • Single IP, single queue, respects 2 req/sec rate limit       │
│  • Writes to shared SQLite cache (gmgn_trenches_cache,          │
│    gmgn_trending_cache, gmgn_tokeninfo_cache)                   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  SOLANA BOT     │   │   BSC BOT       │   │  PYTHON WATCH-  │
│  (Phoenix)      │   │  (Phoenix)      │   │  DOGS           │
│                 │   │                 │   │                 │
│ • CTO scanner   │   │ • CTO scanner   │   │ • DLMM Alpha    │
│ • Discord alerts│   │ • Discord alerts│   │ • God Candle    │
│ • Sniper        │   │ • Sniper        │   │ • Velocity Scalp│
└────────┬────────┘   └────────┬────────┘   │ • Resurrection  │
         │                     │            └────────┬────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │   WEB DASHBOARD     │
                    │  (Express + Static) │
                    │                     │
                    │ • /api/alerts       │
                    │ • /api/watchlist    │
                    │ • /api/stats        │
                    │ • /api/whitelabel   │
                    └─────────────────────┘
```

## Services

| Service | Description | Port |
|---------|-------------|------|
| `gmgn-fetcher` | Centralized GMGN polling, cache writer | — |
| `solana-bot` | Solana Phoenix scanner, Discord alerts, sniper | 3001 (web) |
| `bsc-bot` | BSC Phoenix scanner, Discord alerts, sniper | — |
| `dlmm-alpha` | Meteora DLMM pool alpha scanner | — |
| `god-candle-watchdog` | Order flow compression / breakout detector | — |
| `velocity-scalp` | High velocity trade finder (new + resurrection) | — |
| `solana-watchdog` | CTO watchdog (smart money/KOL/migration tracking) | — |
| `bsc-watchdog` | BSC CTO watchdog | — |
| `web` | Dashboard + API endpoints | 3001 |

All services share `/app/db/whitelabel.db` via docker-compose volume mount.

## Scanners & Alert Types

| Type | Source | Description |
|------|--------|-------------|
| `CTO_PHOENIX` | Phoenix Scanner | Community takeover tokens with smart money/KOL accumulation |
| `DLMM_ALPHA` | DLMM Alpha Scanner | High bin-step (>=100) Meteora pools with volume |
| `GOD_CANDLE` | God Candle Watchdog | Imminent breakout - sell absorption + price holding |
| `VELOCITY_SCALP` | Velocity Scalp Finder | Rapid volume surge + momentum (new launches + resurrections) |
| `RESURRECTION` | Resurrection Scanner | Dormant tokens reviving with volume/price spike |

## Web Dashboard

Access at `http://localhost:3001`

- **Unified Alert Feed** (`/api/alerts`) - All scanners combined, sorted by time
- **Watchlist** (`/api/watchlist`) - CTO tokens with smart money/KOL counts
- **Stats** (`/api/stats`) - Token counts, watchlist size, recent activity
- **Whitelabel Config** (`/api/whitelabel`) - Active Discord integrations

Filters: chain, scanner type, time range, smart money/KOL thresholds. Auto-refresh every 30s. Click any alert for detail modal.

## Discord Integration

- White-label multi-tenant: `!ps-register <license_key>` per server
- Custom bot name, embed title prefix, footer per guild
- Separate Solana/BSC alert channels per server
- Default production channels if not white-labeled

## Rate Limit Strategy

- **Single GMGNAgent instance** shared across all TypeScript services
- **Request queue** with parsed reset-time backoff (handles `GMT+00:00` format)
- **Fetcher delays**: 800ms between API calls, 50 token info max/cycle
- **Cache TTLs**: Trenches 180s, Trending 180s, TokenInfo 300s
- **Watchdogs** use cache-first with CLI fallback + exponential backoff

## Configuration

Environment variables (`.env`):

```bash
# Required
DISCORD_TOKEN=your_bot_token
GMGN_API_KEY=your_gmgn_key
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...

# Channels (default production)
DISCORD_CHANNEL_ID=solana_alerts_channel
BSC_DISCORD_CHANNEL_ID=bsc_alerts_channel
DLMM_CHANNEL_ID=dlmm_alerts_channel
GOD_CANDLE_CHANNEL_ID=god_candle_channel
VELOCITY_SCALPS_CHANNEL_ID=velocity_channel

# Database (docker-compose mounts ./db -> /app/db)
DB_PATH=/app/db/whitelabel.db

# White-label licensing
WHOP_API_KEY=your_whop_key

# Sniper (optional)
SNIPER_TAKE_PROFIT_PERCENT=30
SNIPER_STOP_LOSS_PERCENT=35
SNIPER_TRAILING_ENABLED=true
```

## Deployment

```bash
# Build all images
docker compose build

# Start all services
docker compose up -d

# View logs
docker compose logs -f gmgn-fetcher
docker compose logs -f solana-bot
docker compose logs -f web

# Dashboard
open http://localhost:3001
```

## Database Schema

Key tables:
- `whitelabel_configs` - Discord server configurations
- `seen_tokens` - Deduplication for scanners
- `cto_watchlist` - Phoenix tokens with smart money/KOL tracking
- `gmgn_trenches_cache` - Trenches data (NEW_CREATION, FULL_ALERT)
- `gmgn_trending_cache` - Trending token data
- `gmgn_tokeninfo_cache` - Token metadata (price, launchpad, wallet tags)
- `dlmm_seen_pools` - DLMM alpha pool deduplication
- `god_candle_seen_tokens` - God Candle deduplication
- `velocity_seen_tokens` / `resurrection_seen_tokens` - Velocity/Resurrection deduplication

## Disclaimer

This code is provided for educational and informational purposes only. The authors make no representations or guarantees of financial gain. Trading cryptocurrencies carries significant risk. Use at your own risk.