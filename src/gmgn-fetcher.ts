import { GMGNAgent } from './gmgn-sdk';
import * as dotenv from 'dotenv';
import { 
    saveTrenchesCache, 
    saveTrendingCache, 
    saveTokenInfoCache, 
    pruneGMGNCache,
    getTokenInfoCache 
} from './whitelabel';

dotenv.config();

const API_KEY = process.env.GMGN_API_KEY || '';
const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || '/tmp/empty-key';

// Single shared agent instance for both chains (rate limit is per IP, not per chain)
const sharedGmgn = new GMGNAgent({ apiKey: API_KEY, privateKeyPath: PRIVATE_KEY_PATH, chain: 'sol' });

const POLL_INTERVAL_MS = 60000; // 60 seconds - slower to respect rate limits
const PRUNE_INTERVAL_MS = 300000; // 5 minutes
const TOKENINFO_BATCH_SIZE = 50; // Max token info calls per cycle
const CALL_DELAY_MS = 800; // Delay between API calls (GMGN recommends ~500ms for 2 req/sec)

let isRunning = false;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTrenches(chain: 'sol' | 'bsc') {
    sharedGmgn.chain = chain;
    console.log(`[GMGN Fetcher] Fetching trenches for ${chain}...`);
    
    try {
        const data = await sharedGmgn.getTrenchesData();
        
        const newCreations = data.filter((t: any) => t._stage === 'NEW_CREATION');
        const completed = data.filter((t: any) => t._stage === 'FULL_ALERT');
        
        if (newCreations.length > 0) {
            saveTrenchesCache(chain, 'NEW_CREATION', newCreations);
            console.log(`[GMGN Fetcher] Cached ${newCreations.length} NEW_CREATION tokens for ${chain}`);
        }
        if (completed.length > 0) {
            saveTrenchesCache(chain, 'FULL_ALERT', completed);
            console.log(`[GMGN Fetcher] Cached ${completed.length} FULL_ALERT tokens for ${chain}`);
        }
        
        return [...newCreations, ...completed];
    } catch (error: any) {
        console.error(`[GMGN Fetcher] Error fetching trenches for ${chain}:`, error.message);
        return [];
    }
}

async function fetchTrending(chain: 'sol' | 'bsc') {
    sharedGmgn.chain = chain;
    console.log(`[GMGN Fetcher] Fetching trending for ${chain}...`);
    
    try {
        const data = await sharedGmgn.getTrendingData();
        if (data.length > 0) {
            saveTrendingCache(chain, data);
            console.log(`[GMGN Fetcher] Cached ${data.length} trending tokens for ${chain}`);
        }
        return data;
    } catch (error: any) {
        console.error(`[GMGN Fetcher] Error fetching trending for ${chain}:`, error.message);
        return [];
    }
}

async function fetchAndCacheTokenInfo(tokens: any[], chain: 'sol' | 'bsc') {
    if (tokens.length === 0) return;
    
    const uniqueAddresses = [...new Set(tokens.map(t => t.address).filter(Boolean))];
    console.log(`[GMGN Fetcher] Fetching token info for ${uniqueAddresses.length} tokens on ${chain} (max ${TOKENINFO_BATCH_SIZE})...`);
    
    // Prioritize tokens with high smart money/renowned (these are what bots need for alerts)
    const prioritized = uniqueAddresses
        .map(addr => {
            const token = tokens.find(t => t.address === addr);
            const smart = token?.smart_degen_count || 0;
            const renowned = token?.renowned_count || 0;
            return { addr, priority: smart + renowned * 2 }; // Weight renowned higher
        })
        .sort((a, b) => b.priority - a.priority)
        .map(x => x.addr);
    
    // Limit to batch size
    const toFetch = prioritized.slice(0, TOKENINFO_BATCH_SIZE);
    
    for (const address of toFetch) {
        // Check cache first
        const cached = getTokenInfoCache(chain, address, 300);
        if (cached) {
            continue;
        }
        
        sharedGmgn.chain = chain;
        try {
            const info = await sharedGmgn.getTokenInfo(address);
            saveTokenInfoCache(chain, address, info);
            console.log(`[GMGN Fetcher] Cached token info for ${address} on ${chain}`);
        } catch (error: any) {
            console.error(`[GMGN Fetcher] Error fetching token info for ${address}:`, error.message);
        }
        
        // Rate limit friendly delay between token info calls
        await delay(CALL_DELAY_MS);
    }
}

async function fetchAll() {
    if (isRunning) {
        console.log('[GMGN Fetcher] Previous fetch still running, skipping...');
        return;
    }
    
    isRunning = true;
    console.log(`\n[GMGN Fetcher] === Starting fetch cycle at ${new Date().toISOString()} ===`);
    
    // Fetch trenches and trending sequentially with delays to respect rate limits
    const solTrenches = await fetchTrenches('sol');
    await delay(CALL_DELAY_MS);
    
    const bscTrenches = await fetchTrenches('bsc');
    await delay(CALL_DELAY_MS);
    
    const solTrending = await fetchTrending('sol');
    await delay(CALL_DELAY_MS);
    
    const bscTrending = await fetchTrending('bsc');
    await delay(CALL_DELAY_MS);
    
    // Fetch token info for all discovered tokens
    await fetchAndCacheTokenInfo([...solTrenches, ...solTrending], 'sol');
    await delay(CALL_DELAY_MS);
    await fetchAndCacheTokenInfo([...bscTrenches, ...bscTrending], 'bsc');
    
    console.log(`[GMGN Fetcher] === Fetch cycle complete ===`);
    isRunning = false;
}

async function pruneCache() {
    console.log('[GMGN Fetcher] Pruning old cache entries...');
    pruneGMGNCache(3600); // Remove entries older than 1 hour
}

function startPolling() {
    console.log('[GMGN Fetcher] Starting centralized GMGN polling...');
    
    // Initial fetch
    fetchAll();
    
    // Schedule recurring fetches
    setInterval(fetchAll, POLL_INTERVAL_MS);
    
    // Schedule cache pruning
    setInterval(pruneCache, PRUNE_INTERVAL_MS);
}

startPolling();

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('[GMGN Fetcher] Shutting down...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[GMGN Fetcher] Shutting down...');
    process.exit(0);
});