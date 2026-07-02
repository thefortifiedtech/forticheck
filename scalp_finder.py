import os
import time
import requests
import subprocess
import json
import sqlite3

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
VELOCITY_SCALPS_CHANNEL_ID = get_env("VELOCITY_SCALPS_CHANNEL_ID", get_env("VELOCITY_CHANNEL_ID"))
DB_FILE = get_env("DB_PATH", "db/whitelabel.db")
VELOCITY_ALERT_COOLDOWN = int(get_env("VELOCITY_ALERT_COOLDOWN", 3600))

def init_db():
    try:
        db_dir = os.path.dirname(DB_FILE)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
            
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS velocity_seen_tokens (
                address TEXT PRIMARY KEY,
                detected_at INTEGER NOT NULL
            )
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error initializing DB: {e}")

def has_seen_token(address):
    if VELOCITY_ALERT_COOLDOWN <= 0:
        return False
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cutoff = int(time.time()) - VELOCITY_ALERT_COOLDOWN
        cursor.execute(
            "SELECT 1 FROM velocity_seen_tokens WHERE address = ? AND detected_at > ?",
            (address, cutoff)
        )
        row = cursor.fetchone()
        conn.close()
        return row is not None
    except Exception as e:
        print(f"Error checking token in DB: {e}")
        return False

def add_seen_token(address):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO velocity_seen_tokens (address, detected_at) VALUES (?, ?)",
            (address, int(time.time()))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error adding token to DB: {e}")

def get_gmgn_trending():
    """Fetch trending tokens from GMGN"""
    cmd = ["npx", "gmgn-cli", "market", "trending", "--chain", "sol", "--interval", "1m", "--limit", "50", "--raw"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        res_json = json.loads(result.stdout)
        if "data" in res_json and "rank" in res_json["data"]:
            return res_json["data"]["rank"]
        return []
    except Exception as e:
        print(f"Error fetching trending from GMGN: {e}")
        if 'result' in locals() and result.stderr:
            print(f"CLI Error: {result.stderr}")
        return []

def send_discord_message(content, embed=None):
    if not DISCORD_TOKEN or not VELOCITY_SCALPS_CHANNEL_ID:
        print("Missing Discord credentials or Channel ID.")
        return

    url = f"https://discord.com/api/v10/channels/{VELOCITY_SCALPS_CHANNEL_ID}/messages"
    headers = {
        "Authorization": f"Bot {DISCORD_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {"content": content}
    if embed:
        payload["embeds"] = [embed]

    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        print(f"Alert sent to Discord for token: {embed['title']}")
    except Exception as e:
        print(f"Error sending to Discord: {e}")

def scan_cycle():
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting Scan Cycle...")
    trending_tokens = get_gmgn_trending()
    
    if not trending_tokens:
        print("No trending tokens fetched.")
        return

    print(f"Fetched {len(trending_tokens)} trending tokens. Applying filters...")
    hits = 0

    for token in trending_tokens:
        address = token.get("address")
        if not address:
            continue

        # Prevent duplicate alerts
        if has_seen_token(address):
            continue

        try:
            # Parse parameters safely
            market_cap = float(token.get("market_cap", 0))
            price_change_5m = float(token.get("price_change_percent5m", 0))
            swaps_1m = int(token.get("swaps", 0))
            is_wash_trading = token.get("is_wash_trading", False)
            rug_ratio = float(token.get("rug_ratio", 1.0))
            
            # Apply filters
            # 1. Market Cap: between $100,000 and $500,000
            if not (100000 <= market_cap <= 500000):
                continue

            # 2. 5-Minute Price Change: between +8% and +15%
            if not (8.0 <= price_change_5m <= 15.0):
                continue

            # 3. 1-Minute Swaps: > 40
            if swaps_1m <= 40:
                continue

            # 4. Safety Checks: is_wash_trading == False and rug_ratio < 0.20
            # Note: is_wash_trading might be string "true"/"false" in some API outputs, so handle both
            if is_wash_trading is True or str(is_wash_trading).lower() == "true":
                continue

            if rug_ratio >= 0.20:
                continue

            # Token matches all filters! Send Alert.
            name = token.get("name", "Unknown")
            symbol = token.get("symbol", "Unknown")
            
            # Format clean, premium embed
            # Neon Cyan (0x00E5FF) for high energy, premium look
            embed = {
                "title": f"⚡ Velocity Scalp Detected: {symbol} ({name})",
                "description": f"High transaction velocity and positive momentum token matched scalp criteria.\n`{address}`",
                "color": 0x00E5FF, 
                "fields": [
                    {"name": "📈 5M Price Change", "value": f"+{price_change_5m:.2f}%", "inline": True},
                    {"name": "💸 Market Cap", "value": f"${market_cap:,.0f}", "inline": True},
                    {"name": "🔄 1M Swaps (Velocity)", "value": str(swaps_1m), "inline": True},
                    {"name": "🛡️ Rug Ratio", "value": f"{rug_ratio:.2f}", "inline": True},
                    {"name": "🧹 Wash Trading?", "value": "No" if not is_wash_trading else "Yes", "inline": True},
                    {"name": "👥 Holders", "value": str(token.get("holder_count", "N/A")), "inline": True},
                    {"name": "📊 GMGN Chart", "value": f"[View on GMGN](https://gmgn.ai/sol/token/{address})", "inline": False},
                    {"name": "🔍 DexScreener", "value": f"[View on DexScreener](https://dexscreener.com/solana/{address})", "inline": False}
                ],
                "footer": {
                    "text": f"Velocity Scalp Engine • {time.strftime('%Y-%m-%d %H:%M:%S')}"
                }
            }

            send_discord_message(f"Velocity Scalp Alert: {symbol}", embed)
            add_seen_token(address)
            hits += 1
            
        except Exception as e:
            print(f"Error processing token {address}: {e}")

    print(f"Scan cycle complete. Sent {hits} alerts.")

if __name__ == "__main__":
    print("🚀 Velocity Scalp Engine Active (Scanning every 30 seconds)")
    init_db()
    
    # Run loop
    while True:
        try:
            scan_cycle()
        except Exception as e:
            print(f"Error in scan loop: {e}")
        time.sleep(30)
