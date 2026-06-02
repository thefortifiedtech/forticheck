import os
import time
import requests
import subprocess
import json

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
DISCORD_TOKEN = env_vars.get("DISCORD_TOKEN")
DLMM_CHANNEL_ID = env_vars.get("DLMM_CHANNEL_ID")
API_BASE = "https://dlmm.datapi.meteora.ag/pools"

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

def audit_meteora_pool(mint):
    """Check a specific token for explosive DLMM pools"""
    try:
        # Step 1: Find DLMM pool address via DexScreener
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
            
        # Step 2: Fetch pool data from Meteora Datapi
        headers = {"User-Agent": "Mozilla/5.0"}
        response = requests.get(f"{API_BASE}/{pool_id}", headers=headers, timeout=10)
        
        if response.status_code != 200:
            return None
            
        pool = response.json()
        
        bin_step = pool.get("pool_config", {}).get("bin_step")
        if bin_step is None:
            bin_step = int(pool.get("bin_step", 0))
        apr = pool.get("apy", float(pool.get("apr", 0)) * 100)
        liquidity = pool.get("tvl", float(pool.get("liquidity", 0)))
        
        # The exact filter logic requested
        if int(bin_step) >= 100 and float(apr) > 500 and float(liquidity) > 1000:
            return {
                "pool_address": pool_id,
                "bin_step": int(bin_step),
                "apr": float(apr),
                "liquidity": float(liquidity)
            }
        return None
    except Exception as e:
        print(f"Meteora API Error for {mint}: {e}")
        return None

def scan_cycle():
    print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting Scan Cycle...")
    
    tokens = get_gmgn_tokens()
    if not tokens:
        print("No tokens found from GMGN.")
        return
        
    print(f"Found {len(tokens)} active tokens. Auditing Meteora pools...")
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
        pool_data = audit_meteora_pool(mint)
        if pool_data:
            pool_id = pool_data["pool_address"]
            
            # Prevent duplicate alerts
            if pool_id in seen_pools:
                continue
                
            seen_pools.add(pool_id)
            hits += 1
            
            symbol = token.get("symbol", "Unknown")
            
            embed = {
                "title": "🚨 DLMM ALPHA DETECTED",
                "description": f"Explosive configuration found for **{symbol}**!\n`{mint}`",
                "color": 0xFFD700,
                "fields": [
                    {"name": "Bin Step", "value": str(pool_data["bin_step"]), "inline": True},
                    {"name": "APR", "value": f"{pool_data['apr']:.0f}%", "inline": True},
                    {"name": "Liquidity", "value": f"${pool_data['liquidity']:,.0f}", "inline": True},
                    {"name": "Rug Ratio", "value": f"{rug_ratio:.2f}", "inline": True},
                    {"name": "Smart Degens", "value": str(token.get("smart_degen_count", 0)), "inline": True},
                    {"name": "Pool Link", "value": f"[View on Meteora](https://www.meteora.ag/dlmm/{pool_id})", "inline": False}
                ]
            }
            send_discord_message(f"New Alpha: {symbol}", embed)
            
            # Rate limit Meteora requests slightly to be safe
            time.sleep(0.5)
            
    print(f"Cycle complete. Discovered {hits} new alpha pools.")

if __name__ == "__main__":
    print("🚀 Meteora Alpha Scanner (GMGN Discovery Engine) Active")
    
    # Run once immediately
    scan_cycle()
    
    while True:
        print("Sleeping for 5 minutes...")
        time.sleep(300)
        scan_cycle()
