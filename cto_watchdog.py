import os
import json
import time
import subprocess
import requests
import sqlite3
import re

API_BASE = "https://dlmm.datapi.meteora.ag/pools"

def load_env():
    env_dict = {}
    try:
        with open(".env", "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    env_dict[key.strip()] = val.strip()
    except Exception as e:
        print(f"Error loading .env: {e}")
    return env_dict

env_vars = load_env()

def get_env(key, default=None):
    val = os.getenv(key)
    if val is not None:
        return val
    return env_vars.get(key, default)

DISCORD_TOKEN = get_env("DISCORD_TOKEN")
DISCORD_CHANNEL_ID = get_env("DISCORD_CHANNEL_ID")
DB_FILE = get_env("DB_PATH", "whitelabel.db")


def send_discord_message(content, embed=None, chain='sol'):
    # 1. Fetch all active white-label configs
    wl_channels = []
    configs = []
    if os.path.exists(DB_FILE):
        try:
            conn = sqlite3.connect(DB_FILE)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS whitelabel_configs (
                    guild_id TEXT PRIMARY KEY,
                    solana_channel_id TEXT,
                    bsc_channel_id TEXT,
                    license_key TEXT NOT NULL,
                    bot_name TEXT,
                    custom_embed_title TEXT,
                    custom_footer TEXT,
                    is_active INTEGER DEFAULT 1,
                    activated_at INTEGER NOT NULL
                )
            """)
            cursor.execute("SELECT guild_id, solana_channel_id, bsc_channel_id, bot_name, custom_embed_title, custom_footer FROM whitelabel_configs WHERE is_active = 1")
            rows = cursor.fetchall()
            for row in rows:
                chan = row["solana_channel_id"] if chain == 'sol' else row["bsc_channel_id"]
                if chan:
                    wl_channels.append(chan)
                    configs.append({
                        "guild_id": row["guild_id"],
                        "channel_id": chan,
                        "bot_name": row["bot_name"],
                        "title_pref": row["custom_embed_title"],
                        "footer_text": row["custom_footer"]
                    })
            conn.close()
        except Exception as e:
            print(f"Error reading whitelabel configs from DB: {e}")

    # 2. Send to default production channel ONLY if it's NOT registered as a white-label channel
    default_channel_id = get_env("DISCORD_CHANNEL_ID" if chain == 'sol' else "BSC_DISCORD_CHANNEL_ID")
    if default_channel_id and default_channel_id not in wl_channels:
        _send_message_direct(default_channel_id, content, embed)

    # 3. Send to all active white-label channels with customization
    for cfg in configs:
        customized_embed = None
        if embed:
            customized_embed = dict(embed)
            if cfg["title_pref"] and "title" in customized_embed:
                customized_embed["title"] = re.sub(
                    r"^(🧠 Smart Money|🌟 KOL|🦅 GOLDEN PHOENIX)",
                    cfg["title_pref"],
                    customized_embed["title"]
                )
            # Handle custom footer
            if cfg["footer_text"]:
                customized_embed["footer"] = {"text": cfg["footer_text"]}
            # Ensure fields array is copied properly
            if "fields" in embed:
                customized_embed["fields"] = [dict(f) for f in embed["fields"]]
        
        _send_message_direct(cfg["channel_id"], content, customized_embed)

def _send_message_direct(channel_id, content, embed=None):
    if not DISCORD_TOKEN:
        print("Missing DISCORD_TOKEN.")
        return
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    headers = {
        "Authorization": f"Bot {DISCORD_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {"content": content}
    if embed:
        payload["embeds"] = [embed]

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=10)
        response.raise_for_status()
        print(f"Watchdog alert sent to channel {channel_id}: {embed.get('title', 'Text alert') if embed else 'Text alert'}")
    except Exception as e:
        print(f"Error sending message to channel {channel_id}: {e}")

def load_watchlist(chain='sol'):
    if not os.path.exists(DB_FILE):
        return {}
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS cto_watchlist (
                token_address TEXT PRIMARY KEY,
                chain TEXT NOT NULL,
                symbol TEXT NOT NULL,
                detected_at INTEGER NOT NULL,
                initial_smart_money INTEGER NOT NULL,
                initial_renowned INTEGER NOT NULL,
                last_alerted_smart_money INTEGER NOT NULL,
                last_alerted_renowned INTEGER NOT NULL,
                golden_phoenix_alerted INTEGER DEFAULT 0
            )
        """)
        cursor.execute("SELECT * FROM cto_watchlist WHERE chain = ?", (chain,))
        rows = cursor.fetchall()
        data = {}
        for row in rows:
            data[row["token_address"]] = {
                "symbol": row["symbol"],
                "detected_at": row["detected_at"],
                "initial_smart_money": row["initial_smart_money"],
                "initial_renowned": row["initial_renowned"],
                "last_alerted_smart_money": row["last_alerted_smart_money"],
                "last_alerted_renowned": row["last_alerted_renowned"],
                "golden_phoenix_alerted": bool(row["golden_phoenix_alerted"])
            }
        conn.close()
        return data
    except Exception as e:
        print(f"Error reading watchlist from DB: {e}")
        return {}

def save_watchlist(active_tokens, chain='sol'):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        # 1. Prune timed out tokens (> 3600s)
        threshold = int(time.time()) - 3600
        cursor.execute("DELETE FROM cto_watchlist WHERE chain = ? AND detected_at < ?", (chain, threshold))
        
        # 2. Update active tokens state
        for mint, data in active_tokens.items():
            cursor.execute("""
                UPDATE cto_watchlist SET
                    last_alerted_smart_money = ?,
                    last_alerted_renowned = ?,
                    golden_phoenix_alerted = ?
                WHERE token_address = ? AND chain = ?
            """, (
                data["last_alerted_smart_money"],
                data["last_alerted_renowned"],
                1 if data["golden_phoenix_alerted"] else 0,
                mint,
                chain
            ))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error syncing watchlist to DB: {e}")

def get_token_info(mint):
    cmd = ["npx", "gmgn-cli", "token", "info", "--chain", "sol", "--address", mint, "--raw"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except Exception as e:
        print(f"Error fetching token info for {mint}: {e}")
        return None

def check_meteora(mint):
    try:
        # Step 1: DexScreener
        dex_res = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{mint}", timeout=10)
        if dex_res.status_code != 200:
            return None
            
        dex_data = dex_res.json() or {}
        pool_id = None
        pairs = dex_data.get("pairs") or []
        for pair in pairs:
            if pair.get("dexId") == "meteora" and "DLMM" in pair.get("labels", []):
                pool_id = pair.get("pairAddress")
                break
                
        if not pool_id:
            return None
            
        # Step 2: Meteora Datapi
        headers = {"User-Agent": "Mozilla/5.0"}
        response = requests.get(f"{API_BASE}/{pool_id}", headers=headers, timeout=10)
        if response.status_code != 200:
            return None
            
        pool = response.json()
        
        bin_step = pool.get("pool_config", {}).get("bin_step")
        if bin_step is None:
            bin_step = int(pool.get("bin_step", 0))
        if int(bin_step) >= 100:
            return pool
        return None
    except Exception as e:
        print(f"Meteora API Error for {mint}: {e}")
        return None

def watchdog_cycle():
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Running CTO Watchdog...")
    
    watchlist = load_watchlist('sol')
    if not watchlist:
        print("Watchlist is empty. Sleeping.")
        return

    current_time = int(time.time())
    active_tokens = {}

    # Cleanup phase
    for mint, data in watchlist.items():
        if current_time - data.get("detected_at", 0) > 3600:
            print(f"Token {mint} exceeded 60 minutes. Removing from watchlist.")
        else:
            active_tokens[mint] = data

    for mint, data in active_tokens.items():
        print(f"Polling {data.get('symbol', 'Unknown')} ({mint})...")
        
        info = get_token_info(mint)
        if not info:
            continue
            
        wallet_stats = info.get("wallet_tags_stat", {})
        current_smart = wallet_stats.get("smart_wallets", data.get("last_alerted_smart_money", 0))
        current_kols = wallet_stats.get("renowned_wallets", data.get("last_alerted_renowned", 0))
        
        # Calculate Market Cap
        try:
            price = float(info.get("price", 0))
            total_supply = float(info.get("total_supply", 0))
            mcap = price * total_supply
        except (ValueError, TypeError):
            mcap = 0
            
        mcap_str = f"${mcap:,.0f}" if mcap > 0 else "Unknown"
        
        initial_smart = data.get("initial_smart_money", 0)
        initial_kols = data.get("initial_renowned", 0)
        
        updated = False

        # 1. Smart Money Trigger (Alert if >= initial + 2, and higher than last alert)
        if current_smart >= initial_smart + 2 and current_smart > data.get("last_alerted_smart_money", 0):
            prefix = "🧠 **SMART MONEY LOADING CTO**"
            is_update = data.get("last_alerted_smart_money", 0) > initial_smart
            if is_update:
                prefix = "🔄 **[UPDATED SIGNAL]** " + prefix
                
            embed = {
                "title": "🧠 Smart Money Accumulation",
                "description": f"{prefix}\n**{data.get('symbol')}** is gathering momentum!\n`{mint}`",
                "color": 0x3498DB if not is_update else 0x9B59B6,
                "fields": [
                    {"name": "Market Cap", "value": mcap_str, "inline": True},
                    {"name": "Current Smart Money", "value": str(current_smart), "inline": True},
                    {"name": "Initial Smart Money", "value": str(initial_smart), "inline": True},
                    {"name": "Chart", "value": f"[View on GMGN](https://gmgn.ai/sol/token/{mint})", "inline": False}
                ]
            }
            send_discord_message(f"CTO Watchdog: {data.get('symbol')}", embed, 'sol')
            data["last_alerted_smart_money"] = current_smart
            updated = True

        # 2. KOL / Renowned Trigger
        if current_kols > data.get("last_alerted_renowned", 0):
            prefix = "🌟 **KOL ENTRY DETECTED**"
            is_update = data.get("last_alerted_renowned", 0) > initial_kols
            if is_update:
                prefix = "🔄 **[UPDATED SIGNAL]** " + prefix
                
            embed = {
                "title": "🌟 KOL Accumulation",
                "description": f"{prefix}\n**{data.get('symbol')}** got a new KOL!\n`{mint}`",
                "color": 0x2ECC71 if not is_update else 0x9B59B6,
                "fields": [
                    {"name": "Market Cap", "value": mcap_str, "inline": True},
                    {"name": "Current KOLs", "value": str(current_kols), "inline": True},
                    {"name": "Initial KOLs", "value": str(initial_kols), "inline": True},
                    {"name": "Chart", "value": f"[View on GMGN](https://gmgn.ai/sol/token/{mint})", "inline": False}
                ]
            }
            send_discord_message(f"CTO Watchdog: {data.get('symbol')}", embed, 'sol')
            data["last_alerted_renowned"] = current_kols
            updated = True

        # 3. Golden Phoenix Trigger
        if not data.get("golden_phoenix_alerted") and current_smart > initial_smart:
            pool = check_meteora(mint)
            if pool:
                bin_step = pool.get("pool_config", {}).get("bin_step") or pool.get("bin_step")
                embed = {
                    "title": "🦅 GOLDEN PHOENIX TRIGGERED",
                    "description": f"🔥 Professional Liquidity Setup on a rising CTO!\n**{data.get('symbol')}**\n`{mint}`",
                    "color": 0xFFD700,
                    "fields": [
                        {"name": "Market Cap", "value": mcap_str, "inline": True},
                        {"name": "Bin Step", "value": str(bin_step), "inline": True},
                        {"name": "Current Smart Money", "value": str(current_smart), "inline": True},
                        {"name": "Meteora DLMM", "value": f"[View Pool](https://www.meteora.ag/dlmm/{pool.get('address')})", "inline": True},
                        {"name": "GMGN Chart", "value": f"[View Chart](https://gmgn.ai/sol/token/{mint})", "inline": True}
                    ]
                }
                send_discord_message(f"Golden Phoenix: {data.get('symbol')}", embed, 'sol')
                data["golden_phoenix_alerted"] = True
                updated = True

        # Sleep to avoid ratelimits
        time.sleep(1)

    # Save state
    save_watchlist(active_tokens, 'sol')

if __name__ == "__main__":
    print("🚀 CTO Watchdog Background Worker Started")
    while True:
        watchdog_cycle()
        print("Sleeping for 5 minutes...")
        time.sleep(300)
