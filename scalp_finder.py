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

# Resurrection Configurations
RESURRECTION_MIN_AGE = get_env("RESURRECTION_MIN_AGE", "3d")
RESURRECTION_MIN_MC = float(get_env("RESURRECTION_MIN_MC", 50000))
RESURRECTION_MAX_MC = float(get_env("RESURRECTION_MAX_MC", 1500000))
RESURRECTION_MIN_PRICE_CHANGE_5M = float(get_env("RESURRECTION_MIN_PRICE_CHANGE_5M", 5.0))
RESURRECTION_MAX_PRICE_CHANGE_5M = float(get_env("RESURRECTION_MAX_PRICE_CHANGE_5M", 25.0))
RESURRECTION_MIN_SWAPS = int(get_env("RESURRECTION_MIN_SWAPS", 20))
RESURRECTION_ALERT_COOLDOWN = int(get_env("RESURRECTION_ALERT_COOLDOWN", 3600))

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
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS resurrection_seen_tokens (
                address TEXT PRIMARY KEY,
                detected_at INTEGER NOT NULL
            )
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error initializing DB: {e}")

def has_seen_token(address, is_resurrected=False):
    table = "resurrection_seen_tokens" if is_resurrected else "velocity_seen_tokens"
    cooldown = RESURRECTION_ALERT_COOLDOWN if is_resurrected else VELOCITY_ALERT_COOLDOWN
    if cooldown <= 0:
        return False
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cutoff = int(time.time()) - cooldown
        cursor.execute(
            f"SELECT 1 FROM {table} WHERE address = ? AND detected_at > ?",
            (address, cutoff)
        )
        row = cursor.fetchone()
        conn.close()
        return row is not None
    except Exception as e:
        print(f"Error checking token in DB: {e}")
        return False

def add_seen_token(address, is_resurrected=False):
    table = "resurrection_seen_tokens" if is_resurrected else "velocity_seen_tokens"
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            f"INSERT OR REPLACE INTO {table} (address, detected_at) VALUES (?, ?)",
            (address, int(time.time()))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error adding token to DB: {e}")

def get_gmgn_trending(min_created=None, max_created=None):
    """Fetch trending tokens from GMGN with optional age filters"""
    cmd = ["npx", "gmgn-cli", "market", "trending", "--chain", "sol", "--interval", "1m", "--limit", "50", "--raw"]
    if min_created:
        cmd.extend(["--min-created", min_created])
    if max_created:
        cmd.extend(["--max-created", max_created])
        
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

def format_duration(seconds):
    """Format token age into a readable duration string (e.g. 5d 6h, 3h 12m)"""
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours = minutes // 60
    minutes = minutes % 60
    if hours < 24:
        return f"{hours}h {minutes}m"
    days = hours // 24
    hours = hours % 24
    return f"{days}d {hours}h"

def process_token(token, is_resurrected=False):
    address = token.get("address")
    if not address:
        return False

    # Prevent duplicate alerts
    if has_seen_token(address, is_resurrected):
        return False

    try:
        # Parse parameters safely
        market_cap = float(token.get("market_cap", 0))
        price_change_5m = float(token.get("price_change_percent5m", 0))
        swaps_1m = int(token.get("swaps", 0))
        is_wash_trading = token.get("is_wash_trading", False)
        rug_ratio = float(token.get("rug_ratio", 1.0))
        
        # Apply track-specific filters
        if is_resurrected:
            # 1. Market Cap: between RESURRECTION_MIN_MC and RESURRECTION_MAX_MC
            if not (RESURRECTION_MIN_MC <= market_cap <= RESURRECTION_MAX_MC):
                return False

            # 2. 5-Minute Price Change: between RESURRECTION_MIN_PRICE_CHANGE_5M and RESURRECTION_MAX_PRICE_CHANGE_5M
            if not (RESURRECTION_MIN_PRICE_CHANGE_5M <= price_change_5m <= RESURRECTION_MAX_PRICE_CHANGE_5M):
                return False

            # 3. 1-Minute Swaps: > RESURRECTION_MIN_SWAPS
            if swaps_1m < RESURRECTION_MIN_SWAPS:
                return False
        else:
            # Standard Track (New Launches)
            # 1. Market Cap: between $100,000 and $500,000
            if not (100000 <= market_cap <= 500000):
                return False

            # 2. 5-Minute Price Change: between +8% and +15%
            if not (8.0 <= price_change_5m <= 15.0):
                return False

            # 3. 1-Minute Swaps: > 40
            if swaps_1m <= 40:
                return False

        # 4. Safety Checks (Shared): is_wash_trading == False and rug_ratio < 0.20
        if is_wash_trading is True or str(is_wash_trading).lower() == "true":
            return False

        if rug_ratio >= 0.20:
            return False

        # Token matches all filters! Send Alert.
        name = token.get("name", "Unknown")
        symbol = token.get("symbol", "Unknown")
        
        # Format clean, premium embed
        if is_resurrected:
            # Calculate token age
            creation_timestamp = token.get("creation_timestamp", 0)
            token_age_str = "Unknown"
            if creation_timestamp > 0:
                age_seconds = int(time.time()) - int(creation_timestamp)
                if age_seconds > 0:
                    token_age_str = format_duration(age_seconds)
            
            # Neon Purple/Violet (0xD000FF) for Resurrection alert
            embed = {
                "title": f"♻️ Resurrection Alert: {symbol} ({name})",
                "description": f"Dormant/older token experiencing a sudden volume spike and positive momentum.\n`{address}`",
                "color": 0xD000FF,
                "fields": [
                    {"name": "📈 5M Price Change", "value": f"+{price_change_5m:.2f}%", "inline": True},
                    {"name": "💸 Market Cap", "value": f"${market_cap:,.0f}", "inline": True},
                    {"name": "🔄 1M Swaps (Velocity)", "value": str(swaps_1m), "inline": True},
                    {"name": "⏳ Token Age", "value": token_age_str, "inline": True},
                    {"name": "🛡️ Rug Ratio", "value": f"{rug_ratio:.2f}", "inline": True},
                    {"name": "🧹 Wash Trading?", "value": "No" if not is_wash_trading else "Yes", "inline": True},
                    {"name": "👥 Holders", "value": str(token.get("holder_count", "N/A")), "inline": True},
                    {"name": "📊 GMGN Chart", "value": f"[View on GMGN](https://gmgn.ai/sol/token/{address})", "inline": False},
                    {"name": "🔍 DexScreener", "value": f"[View on DexScreener](https://dexscreener.com/solana/{address})", "inline": False}
                ],
                "footer": {
                    "text": f"Velocity Scalp Engine • Resurrection Track • {time.strftime('%Y-%m-%d %H:%M:%S')}"
                }
            }
            send_discord_message(f"Resurrection Alert: {symbol}", embed)
        else:
            # Neon Cyan (0x00E5FF) for New Launch alert
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
                    "text": f"Velocity Scalp Engine • New Launch Track • {time.strftime('%Y-%m-%d %H:%M:%S')}"
                }
            }
            send_discord_message(f"Velocity Scalp Alert: {symbol}", embed)
            
        add_seen_token(address, is_resurrected)
        return True
    except Exception as e:
        print(f"Error processing token {address}: {e}")
        return False

def scan_cycle():
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting Scan Cycle...")
    
    # Track 1: New Launches (< 3d)
    print("Scanning Track 1: New Launches (< 3 days)...")
    new_launches = get_gmgn_trending(max_created="3d")
    new_launch_hits = 0
    if new_launches:
        print(f"Fetched {len(new_launches)} new launches. Applying filters...")
        for token in new_launches:
            if process_token(token, is_resurrected=False):
                new_launch_hits += 1
    else:
        print("No new launches fetched.")

    # Track 2: Resurrections (>= 3d)
    print(f"Scanning Track 2: Resurrections (>= {RESURRECTION_MIN_AGE})...")
    resurrections = get_gmgn_trending(min_created=RESURRECTION_MIN_AGE)
    resurrection_hits = 0
    if resurrections:
        print(f"Fetched {len(resurrections)} potential resurrections. Applying filters...")
        for token in resurrections:
            if process_token(token, is_resurrected=True):
                resurrection_hits += 1
    else:
        print("No potential resurrections fetched.")

    print(f"Scan cycle complete. Sent {new_launch_hits} New Launch alerts and {resurrection_hits} Resurrection alerts.")

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
