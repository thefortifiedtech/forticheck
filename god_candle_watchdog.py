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
GOD_CANDLE_CHANNEL_ID = get_env("GOD_CANDLE_CHANNEL_ID", "1524546505191456899")
DB_FILE = get_env("DB_PATH", "db/whitelabel.db")

# God Candle Thresholds
GOD_CANDLE_MIN_MC = float(get_env("GOD_CANDLE_MIN_MC", 100000))
GOD_CANDLE_MAX_MC = float(get_env("GOD_CANDLE_MAX_MC", 10000000))
GOD_CANDLE_MIN_SWAPS = int(get_env("GOD_CANDLE_MIN_SWAPS", 75))
GOD_CANDLE_MIN_HOT_LEVEL = int(get_env("GOD_CANDLE_MIN_HOT_LEVEL", 2))
GOD_CANDLE_COOLDOWN = int(get_env("GOD_CANDLE_COOLDOWN", 3600))

def init_db():
    try:
        db_dir = os.path.dirname(DB_FILE)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
            
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS god_candle_seen_tokens (
                address TEXT PRIMARY KEY,
                detected_at INTEGER NOT NULL
            )
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error initializing DB: {e}")

def has_seen_token(address):
    if GOD_CANDLE_COOLDOWN <= 0:
        return False
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cutoff = int(time.time()) - GOD_CANDLE_COOLDOWN
        cursor.execute(
            "SELECT 1 FROM god_candle_seen_tokens WHERE address = ? AND detected_at > ?",
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
            "INSERT OR REPLACE INTO god_candle_seen_tokens (address, detected_at) VALUES (?, ?)",
            (address, int(time.time()))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error adding token to DB: {e}")

def get_gmgn_trending():
    """Fetch 100 trending tokens from GMGN"""
    cmd = ["npx", "gmgn-cli", "market", "trending", "--chain", "sol", "--interval", "1m", "--limit", "100", "--raw"]
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
    if not DISCORD_TOKEN or not GOD_CANDLE_CHANNEL_ID:
        print("Missing Discord credentials or Channel ID.")
        return

    url = f"https://discord.com/api/v10/channels/{GOD_CANDLE_CHANNEL_ID}/messages"
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
        print(f"God Candle warning sent to Discord for token: {embed['title']}")
    except Exception as e:
        print(f"Error sending to Discord: {e}")

def check_for_imminent_god_candle(token_data):
    """
    Scans for order flow compression and heavy absorption metrics 
    that precede a vertical breakout.
    """
    address = token_data.get("address")
    if not address or has_seen_token(address):
        return

    try:
        mcap = float(token_data.get('market_cap', 0))
        change_1m = float(token_data.get('price_change_percent1m', token_data.get('price_change_percent', 0)))
        change_5m = float(token_data.get('price_change_percent5m', 0))
        
        buys_1m = int(token_data.get('buys_1m', token_data.get('buys', 0)))
        sells_1m = int(token_data.get('sells_1m', token_data.get('sells', 0)))
        swaps_1m = buys_1m + sells_1m
        
        is_wash_trading = token_data.get('is_wash_trading', True)
        # Handle string booleans from some environments
        if isinstance(is_wash_trading, str):
            is_wash_trading = is_wash_trading.lower() == "true"
            
        rug_ratio = float(token_data.get('rug_ratio', 1.0))
        hot_level = int(token_data.get('hot_level', 0))

        # Check Conditions
        
        # 1. Target established mid-caps (configurable mc range)
        if GOD_CANDLE_MIN_MC <= mcap <= GOD_CANDLE_MAX_MC:
            
            # 2. Extreme micro-volume activity
            if swaps_1m > GOD_CANDLE_MIN_SWAPS:
                
                # 3. The Absorption Check (High selling pressure but price refuses to drop)
                if sells_1m > buys_1m * 1.5 and change_1m >= 0:
                    
                    # 4. Safety verification
                    if not is_wash_trading and rug_ratio < 0.15:
                        
                        # 5. Strategic smart wallet loading
                        if hot_level >= GOD_CANDLE_MIN_HOT_LEVEL:
                            trigger_god_candle_warning(token_data, mcap, change_1m, change_5m, buys_1m, sells_1m, swaps_1m, rug_ratio, hot_level)
    except Exception as e:
        print(f"Error checking token {address} for God Candle: {e}")

def trigger_god_candle_warning(token, mcap, change_1m, change_5m, buys_1m, sells_1m, swaps_1m, rug_ratio, hot_level):
    address = token.get("address")
    symbol = token.get("symbol", "Unknown")
    name = token.get("name", "Unknown")
    
    print(f"🔥 GOD CANDLE IMMINENT: {symbol} - Supply fully absorbed at {mcap} Mcap.")

    # High-priority "🚨 PRESSURE MATRIX WARNING" embed
    embed = {
        "title": f"🚨 Imminent Breakout: {symbol} ({name})",
        "description": f"**[PRESSURE MATRIX WARNING]**\nOrder flow compression and heavy sell absorption detected. Supply is fully absorbed!\n`{address}`",
        "color": 0xFF3B30, # Crimson Red
        "fields": [
            {"name": "📈 Price Momentum", "value": f"1M: `+{change_1m:+.2f}%` | 5M: `+{change_5m:+.2f}%`", "inline": False},
            {"name": "💸 Market Cap", "value": f"${mcap:,.0f}", "inline": True},
            {"name": "🔥 Hot Level", "value": f"Level {hot_level}", "inline": True},
            {"name": "🔄 1M Activity", "value": f"**{swaps_1m}** swaps\n📥 Buys: {buys_1m}\n📤 Sells: {sells_1m}", "inline": True},
            {"name": "🛡️ Rug Ratio", "value": f"{rug_ratio:.2f}", "inline": True},
            {"name": "👥 Holders", "value": str(token.get("holder_count", "N/A")), "inline": True},
            {"name": "📊 GMGN Chart", "value": f"[View on GMGN](https://gmgn.ai/sol/token/{address})", "inline": False},
            {"name": "🔍 DexScreener", "value": f"[View on DexScreener](https://dexscreener.com/solana/{address})", "inline": False}
        ],
        "footer": {
            "text": f"God Candle Watchdog • {time.strftime('%Y-%m-%d %H:%M:%S')}"
        }
    }
    
    send_discord_message(f"🚨 Imminent Breakout: {symbol} ({name})", embed)
    add_seen_token(address)

def scan_cycle():
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Checking for imminent breakouts...")
    trending_tokens = get_gmgn_trending()
    
    if not trending_tokens:
        print("No trending tokens fetched.")
        return

    print(f"Scanning {len(trending_tokens)} trending tokens against pressure matrix...")
    for token in trending_tokens:
        check_for_imminent_god_candle(token)

if __name__ == "__main__":
    print("🚀 God Candle Watchdog Active (Checking every 30 seconds)")
    init_db()
    
    # Run loop
    while True:
        try:
            scan_cycle()
        except Exception as e:
            print(f"Error in watchdog loop: {e}")
        time.sleep(30)
