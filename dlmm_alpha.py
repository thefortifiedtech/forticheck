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
DLMM_CHANNEL_ID = get_env("DLMM_CHANNEL_ID")
API_BASE = "https://dlmm.datapi.meteora.ag/pools"
DB_FILE = get_env("DB_PATH", "whitelabel.db")

def init_db():
    try:
        # Ensure the directory exists
        db_dir = os.path.dirname(DB_FILE)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
            
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS dlmm_seen_pools (
                pool_address TEXT PRIMARY KEY,
                token_address TEXT,
                detected_at INTEGER NOT NULL
            )
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error initializing DB: {e}")

def has_seen_pool(pool_address):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM dlmm_seen_pools WHERE pool_address = ?", (pool_address,))
        row = cursor.fetchone()
        conn.close()
        return row is not None
    except Exception as e:
        print(f"Error checking pool in DB: {e}")
        return False

def add_seen_pool(pool_address, token_address):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR IGNORE INTO dlmm_seen_pools (pool_address, token_address, detected_at) VALUES (?, ?, ?)",
            (pool_address, token_address, int(time.time()))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error adding pool to DB: {e}")

# Cache to avoid duplicate alerts
seen_pools = set()

def send_discord_message(content, embed=None):
    if not DISCORD_TOKEN or not DLMM_CHANNEL_ID:
        print("Missing Discord credentials.")
        return

    url = f"https://discord.com/api/v10/channels/{DLMM_CHANNEL_ID}/messages"
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
        print(f"Alert sent to Discord: {embed['description'].splitlines()[-1] if embed else 'Text alert'}")
    except Exception as e:
        print(f"Error sending to Discord: {e}")

def get_gmgn_tokens():
    """Fetch active tokens from GMGN Trenches"""
    cmd = ["npx", "gmgn-cli", "market", "trenches", "--chain", "sol", "--type", "completed", "near_completion", "new_creation", "--limit", "30", "--raw"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        
        # Combine all categories
        all_tokens = []
        for key in ["completed", "near_completion", "new_creation"]:
            if key in data and isinstance(data[key], list):
                all_tokens.extend(data[key])
                
        return all_tokens
    except Exception as e:
        print(f"Error fetching from GMGN: {e}")
        return []

def get_gmgn_trending():
    """Fetch trending tokens from GMGN"""
    cmd = ["npx", "gmgn-cli", "market", "trending", "--chain", "sol", "--interval", "1m", "--limit", "30", "--raw"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        res_json = json.loads(result.stdout)
        if "data" in res_json and "rank" in res_json["data"]:
            return res_json["data"]["rank"]
        return []
    except Exception as e:
        print(f"Error fetching trending from GMGN: {e}")
        return []

def audit_meteora_pool(mint):
    """Check a specific token for explosive DLMM pools"""
    matched_pools = []
    try:
        # Step 1: Find all DLMM pools address via DexScreener
        dex_res = requests.get(f"https://api.dexscreener.com/token-pairs/v1/solana/{mint}", timeout=10)
        if dex_res.status_code != 200:
            return []
            
        pairs = dex_res.json() or []
        
        dlmm_pairs = []
        for pair in pairs:
            if pair.get("dexId") == "meteora" and "DLMM" in pair.get("labels", []):
                pool_id = pair.get("pairAddress")
                if pool_id:
                    try:
                        pair_volume_24h = float(pair.get("volume", {}).get("h24", 0))
                    except (TypeError, ValueError):
                        pair_volume_24h = 0.0
                    dlmm_pairs.append((pool_id, pair_volume_24h))
                    
        # Step 2: Fetch pool data from Meteora Datapi for each DLMM pool
        for pool_id, pair_volume_24h in dlmm_pairs:
            try:
                headers = {"User-Agent": "Mozilla/5.0"}
                response = requests.get(f"{API_BASE}/{pool_id}", headers=headers, timeout=10)
                
                if response.status_code != 200:
                    continue
                    
                pool = response.json()
                
                bin_step = pool.get("pool_config", {}).get("bin_step")
                if bin_step is None:
                    bin_step = int(pool.get("bin_step", 0))
                apr = pool.get("apy", float(pool.get("apr", 0)) * 100)
                liquidity = pool.get("tvl", float(pool.get("liquidity", 0)))
                
                volume_data = pool.get("volume", {})
                pool_volume_24h = 0.0
                if isinstance(volume_data, dict):
                    try:
                        pool_volume_24h = float(volume_data.get("24h", 0))
                    except (TypeError, ValueError):
                        pool_volume_24h = 0.0
                elif isinstance(volume_data, (int, float)):
                    pool_volume_24h = float(volume_data)
                    
                volume_24h = max(pair_volume_24h, pool_volume_24h)
                
                # Extract fees and base fee
                fees_data = pool.get("fees", {})
                fees_24h = 0.0
                if isinstance(fees_data, dict):
                    try:
                        fees_24h = float(fees_data.get("24h", 0))
                    except (TypeError, ValueError):
                        fees_24h = 0.0
                        
                base_fee = pool.get("pool_config", {}).get("base_fee_pct")
                if base_fee is None:
                    try:
                        base_fee = float(pool.get("base_fee_percentage", 0))
                    except (TypeError, ValueError):
                        base_fee = 0.0
                        
                volume_to_tvl = volume_24h / liquidity if liquidity > 0 else 0.0
                fee_tvl_ratio = (fees_24h / liquidity) * 100 if liquidity > 0 else 0.0
                
                # The filter logic: high bin step (>= 100) and high volume
                min_volume = float(get_env("DLMM_MIN_VOLUME", 1000))
                if int(bin_step) >= 100 and volume_24h >= min_volume:
                    matched_pools.append({
                        "pool_address": pool_id,
                        "pair_name": pool.get("name", f"Unknown-{mint[:4]}"),
                        "bin_step": int(bin_step),
                        "base_fee": base_fee,
                        "apr": float(apr),
                        "liquidity": float(liquidity),
                        "volume_24h": volume_24h,
                        "volume_to_tvl": volume_to_tvl,
                        "fee_tvl_ratio": fee_tvl_ratio
                    })
            except Exception as e:
                print(f"Meteora API Error for pool {pool_id}: {e}")
                
        return matched_pools
    except Exception as e:
        print(f"Meteora API Error for {mint}: {e}")
        return []

def scan_cycle():
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting Scan Cycle...")
    
    trenches = get_gmgn_tokens()
    trending = get_gmgn_trending()
    
    # Combine and de-duplicate tokens by address, tracking their source
    seen_addresses = {}
    
    for t in trenches:
        addr = t.get("address")
        if addr:
            t["source_type"] = "new"
            seen_addresses[addr] = t
            
    for t in trending:
        addr = t.get("address")
        if addr:
            if addr not in seen_addresses:
                t["source_type"] = "trending"
                seen_addresses[addr] = t
                
    tokens = list(seen_addresses.values())
            
    if not tokens:
        print("No tokens found from GMGN.")
        return
        
    print(f"Found {len(tokens)} active tokens ( trenches + trending ). Auditing Meteora pools...")
    hits = 0
    
    for token in tokens:
        mint = token.get("address")
        if not mint:
            continue
            
        # 1. Validation: rug_ratio < 0.3
        rug_ratio = token.get("rug_ratio", 1.0)
        is_wash_trading = token.get("is_wash_trading", False)
        
        if rug_ratio >= 0.3 or is_wash_trading:
            continue
            
        # 2. Check Meteora
        pools_data = audit_meteora_pool(mint)
        for pool_data in pools_data:
            pool_id = pool_data["pool_address"]
            
            # Prevent duplicate alerts using database persistence
            if has_seen_pool(pool_id):
                continue
                
            add_seen_pool(pool_id, mint)
            hits += 1
            
            symbol = token.get("symbol", "Unknown")
            pair_name = pool_data.get("pair_name", symbol)
            
            source_type = token.get("source_type", "new")
            alert_title = "🚨 DLMM Alpha: New Token Alert" if source_type == "new" else "🚨 DLMM Alpha: Trending Token Alert"
            
            embed = {
                "title": alert_title,
                "description": f"Explosive configuration found for **{pair_name}**!\n`{mint}`",
                "color": 0xFFD700,
                "fields": [
                    {"name": "Pair", "value": pair_name, "inline": True},
                    {"name": "Bin Step", "value": str(pool_data["bin_step"]), "inline": True},
                    {"name": "Base Fee", "value": f"{pool_data['base_fee']:.2f}%", "inline": True},
                    {"name": "APR", "value": f"{pool_data['apr']:.0f}%", "inline": True},
                    {"name": "Volume (24h)", "value": f"${pool_data['volume_24h']:,.0f}", "inline": True},
                    {"name": "Liquidity", "value": f"${pool_data['liquidity']:,.0f}", "inline": True},
                    {"name": "Vol / TVL (24h)", "value": f"{pool_data['volume_to_tvl']:.2f}x", "inline": True},
                    {"name": "Fee / TVL (24h)", "value": f"{pool_data['fee_tvl_ratio']:.2f}%", "inline": True},
                    {"name": "Rug Ratio", "value": f"{rug_ratio:.2f}", "inline": True},
                    {"name": "Smart Degens", "value": str(token.get("smart_degen_count", 0)), "inline": True},
                    {"name": "Pool Link", "value": f"[View on Meteora](https://www.meteora.ag/dlmm/{pool_id})", "inline": False},
                    {"name": "HawkFi Link", "value": f"[Manage on HawkFi](https://www.hawkfi.ag/meteora/{pool_id})", "inline": False},
                    {"name": "GMGN Chart", "value": f"[View Chart](https://gmgn.ai/sol/token/{mint})", "inline": False}
                ]
            }
            send_discord_message(f"DLMM Alpha Detected: {pair_name}", embed)
            
            # Rate limit Meteora requests slightly to be safe
            time.sleep(0.5)
            
    print(f"Cycle complete. Discovered {hits} new alpha pools.")
 
if __name__ == "__main__":
    print("🚀 Meteora Alpha Scanner (GMGN Discovery Engine) Active")
    
    # Initialize SQLite Database
    init_db()
    
    # Run once immediately
    scan_cycle()
    
    while True:
        print("Sleeping for 5 minutes...")
        time.sleep(300)
        scan_cycle()
