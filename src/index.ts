import { Client, GatewayIntentBits, Events, AttachmentBuilder, TextChannel } from 'discord.js';
import { Connection } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';
import express from 'express';
import path from 'path';
import { GMGNAgent } from './gmgn-sdk';
import { auditMeteoraExplosive } from './liquidity';
import { analyzeCluster, ClusterReport } from './scanner';
import { BotConfig } from './config';
import { attemptSnipe } from './sniper';
import { syncNicknamesOnStartup, handleWhiteLabelCommands, broadcastSolanaAlert, customizeEmbedForGuild, hasSeenToken, addSeenToken, pruneSeenTokens, addTokenToWatchlist, isSignalMigrated, getTrenchesCache, getTrendingCache, getTokenInfoCache } from './whitelabel';

dotenv.config();

import fs from 'fs';

// Web server setup (Express for dashboard/API endpoints)
const WEB_PORT = process.env.WEB_PORT || 3001;
const webServer = express();

// Serve static dashboard from the web interface
webServer.use(express.static(path.join(__dirname, 'web/static')));

// API health endpoint
webServer.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API stats endpoint
webServer.get('/api/stats', (req, res) => {
    try {
        const { db } = require('./whitelabel');
        const totalTokens = db.prepare('SELECT COUNT(*) as count FROM seen_tokens').get().count;
        const totalWatchlist = db.prepare('SELECT COUNT(*) as count FROM cto_watchlist').get().count;
        const activeWhiteLabel = db.prepare('SELECT COUNT(*) as count FROM whitelabel_configs WHERE is_active = 1').get().count;
        
        const recentTokens = db.prepare(`
            SELECT COUNT(*) as count FROM seen_tokens WHERE added_at >= ?
        `).get(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)).count;
        
        const recentAlerts = db.prepare(`
            SELECT COUNT(*) as count FROM cto_watchlist WHERE detected_at >= ?
        `).get(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)).count;
        
        const stats = {
            totalTokens,
            totalWatchlist,
            activeWhiteLabel,
            recentTokens,
            recentAlerts
        };
        
        res.json(stats);
    } catch (error) {
        console.error('[Web Server] Error fetching stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API whitelabel endpoint
webServer.get('/api/whitelabel', (req, res) => {
    try {
        const { db } = require('./whitelabel');
        const rows = db.prepare(`
            SELECT guild_id, solana_channel_id, bsc_channel_id, bot_name, custom_embed_title, custom_footer, activated_at 
            FROM whitelabel_configs WHERE is_active = 1
        `).all();
        res.json(rows);
    } catch (error) {
        console.error('[Web Server] Error fetching whitelabel:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API watchlist endpoint
webServer.get('/api/watchlist', (req, res) => {
    try {
        const { db, getTokenInfoCache } = require('./whitelabel');
        const rows = db.prepare(`
            SELECT token_address, chain, symbol, detected_at, initial_smart_money, initial_renowned, golden_phoenix_alerted, is_migrated 
            FROM cto_watchlist ORDER BY detected_at DESC LIMIT 200
        `).all();
        
        // Helper to check live migration status from token info cache
        const isMigratedLive = (chain: string, address: string): boolean => {
            const info = getTokenInfoCache(chain, address, 300);
            if (!info) return false;
            return info.launchpad !== 'pump' || (info.launchpad_progress || 0) >= 1;
        };
        
        // Enrich with computed alert reasons
        const enriched = rows.map((token: any) => {
            const reasons: string[] = [];
            const smartMoney = token.initial_smart_money || 0;
            const kol = token.initial_renowned || 0;
            const liveMigrated = isMigratedLive(token.chain, token.token_address);
            const golden = token.golden_phoenix_alerted === 1;
            
            if (golden) {
                reasons.push('Golden Phoenix - High-yield DLMM pool detected');
            }
            if (smartMoney >= 10) {
                reasons.push(`High Conviction: ${smartMoney} Smart Money wallets`);
            } else if (smartMoney >= 5) {
                reasons.push(`Smart Money Activity: ${smartMoney} smart degen wallets`);
            } else if (smartMoney > 0) {
                reasons.push(`Minor Smart Money: ${smartMoney} wallet(s)`);
            }
            if (kol >= 5) {
                reasons.push(`KOL Endorsement: ${kol} renowned wallets`);
            } else if (kol >= 1) {
                reasons.push(`KOL Interest: ${kol} renowned wallet(s)`);
            }
            if (liveMigrated) {
                reasons.push('Migrated to DEX - Community takeover complete');
            } else {
                reasons.push('Bonding curve phase - Pre-migration');
            }
            if (reasons.length === 0) {
                reasons.push('CTO flag - Dev exited, community taking over');
            }
            
            return { ...token, is_migrated: liveMigrated, alert_reason: reasons };
        });
        
        res.json(enriched);
    } catch (error) {
        console.error('[Web Server] Error fetching watchlist:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/watchlist/:tokenAddress - Get specific watchlist token with full details
webServer.get('/api/watchlist/:tokenAddress', (req, res) => {
    try {
        const { db, getTokenInfoCache } = require('./whitelabel');
        const tokenAddress = req.params.tokenAddress;
        const row = db.prepare(`
            SELECT token_address, chain, symbol, detected_at, initial_smart_money, initial_renowned, 
                   last_alerted_smart_money, last_alerted_renowned, golden_phoenix_alerted, is_migrated 
            FROM cto_watchlist WHERE token_address = ?
        `).get(tokenAddress);
        
        if (!row) {
            return res.status(404).json({ error: 'Token not found in watchlist' });
        }
        
        // Helper to check live migration status from token info cache
        const isMigratedLive = (chain: string, address: string): boolean => {
            const info = getTokenInfoCache(chain, address, 300);
            if (!info) return false;
            return info.launchpad !== 'pump' || (info.launchpad_progress || 0) >= 1;
        };
        
        // Compute alert reason
        const reasons: string[] = [];
        const smartMoney = row.initial_smart_money || 0;
        const kol = row.initial_renowned || 0;
        const liveMigrated = isMigratedLive(row.chain, row.token_address);
        const golden = row.golden_phoenix_alerted === 1;
        
        if (golden) {
            reasons.push('Golden Phoenix Alert - High-yield DLMM pool detected');
        }
        if (smartMoney >= 10) {
            reasons.push(`High Conviction Signal: ${smartMoney} Smart Money wallets detected`);
        } else if (smartMoney >= 5) {
            reasons.push(`Smart Money Activity: ${smartMoney} smart degen wallets`);
        } else if (smartMoney > 0) {
            reasons.push(`Minor Smart Money: ${smartMoney} wallet(s) detected`);
        }
        if (kol >= 5) {
            reasons.push(`KOL Endorsement: ${kol} renowned wallets holding`);
        } else if (kol >= 1) {
            reasons.push(`KOL Interest: ${kol} renowned wallet(s) detected`);
        }
        if (liveMigrated) {
            reasons.push('Token migrated to DEX - Community takeover complete');
        } else {
            reasons.push('Bonding curve phase - Pre-migration opportunity');
        }
        if (reasons.length === 0) {
            reasons.push('CTO flag detected - Dev exited, community taking over');
        }
        
        res.json({ ...row, is_migrated: liveMigrated, alert_reason: reasons });
    } catch (error) {
        console.error('[Web Server] Error fetching watchlist token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/tokens endpoint
webServer.post('/api/tokens', (req, res) => {
    try {
        const { db } = require('./whitelabel');
        const { tokenAddress, chain } = req.body;
        
        if (!tokenAddress || !chain) {
            return res.status(400).json({ error: 'tokenAddress and chain are required' });
        }
        
        db.prepare('INSERT OR IGNORE INTO seen_tokens (token_address, chain, added_at) VALUES (?, ?, ?)')
            .run(tokenAddress, chain, Math.floor(Date.now() / 1000));
        
        res.json({ success: true });
    } catch (error) {
        console.error('[Web Server] Error adding token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/alerts - Unified real-time alert feed from all scanners
webServer.get('/api/alerts', (req, res) => {
    try {
        const { db, getTokenInfoCache } = require('./whitelabel');
        const alerts: any[] = [];
        
        // Helper to get token info from cache
        const getTokenSymbol = (chain: string, address: string): string => {
            const info = getTokenInfoCache(chain, address, 300);
            return info?.symbol || info?.name || 'Unknown';
        };
        
        // Helper to check CTO flag from cache
        const hasCtoFlag = (chain: string, address: string): boolean => {
            const info = getTokenInfoCache(chain, address, 300);
            return info?.cto_flag === 1 || info?.cto_flag === true;
        };
        
        // Helper to check live migration status from token info cache
        const isMigratedLive = (chain: string, address: string): boolean => {
            const info = getTokenInfoCache(chain, address, 300);
            if (!info) return false;
            return info.launchpad !== 'pump' || (info.launchpad_progress || 0) >= 1;
        };
        
        // 1. CTO Watchlist alerts (Phoenix scanner) - only include tokens matching Discord noise filter
        const ctoRows = db.prepare(`
            SELECT token_address, chain, symbol, detected_at, initial_smart_money, initial_renowned, 
                   golden_phoenix_alerted, is_migrated 
            FROM cto_watchlist 
            WHERE (initial_smart_money >= 5 OR initial_renowned >= 1)
            ORDER BY detected_at DESC 
            LIMIT 100
        `).all();
        
        ctoRows.forEach((t: any) => {
            const reasons: string[] = [];
            if (t.golden_phoenix_alerted === 1) reasons.push('Golden Phoenix - High-yield DLMM pool');
            if ((t.initial_smart_money || 0) >= 10) reasons.push(`High Conviction: ${t.initial_smart_money} Smart Money wallets`);
            else if ((t.initial_smart_money || 0) >= 5) reasons.push(`Smart Money: ${t.initial_smart_money} smart degen wallets`);
            else if ((t.initial_smart_money || 0) > 0) reasons.push(`Minor Smart Money: ${t.initial_smart_money} wallets`);
            if ((t.initial_renowned || 0) >= 5) reasons.push(`KOL Endorsement: ${t.initial_renowned} renowned wallets`);
            else if ((t.initial_renowned || 0) >= 1) reasons.push(`KOL Interest: ${t.initial_renowned} wallets`);
            
            const liveMigrated = isMigratedLive(t.chain, t.token_address);
            if (liveMigrated) reasons.push('Migrated to DEX - Community takeover');
            else reasons.push('Bonding curve phase - Pre-migration');
            if (reasons.length === 0) reasons.push('CTO flag - Dev exited');
            
            alerts.push({
                id: `cto_${t.token_address}`,
                type: 'CTO_PHOENIX',
                source: 'Phoenix Scanner',
                token_address: t.token_address,
                chain: t.chain,
                symbol: t.symbol,
                detected_at: t.detected_at,
                smart_money: t.initial_smart_money || 0,
                kol_count: t.initial_renowned || 0,
                is_migrated: liveMigrated,
                golden_phoenix: t.golden_phoenix_alerted === 1,
                cto_flag: hasCtoFlag(t.chain, t.token_address),
                reason: reasons[0],
                all_reasons: reasons,
                color: t.golden_phoenix_alerted === 1 ? 0xFFD700 : (liveMigrated ? 0x3498DB : 0xF39C12)
            });
        });
        
        // 2. DLMM Alpha alerts
        try {
            const dlmmRows = db.prepare(`
                SELECT pool_address, token_address, detected_at 
                FROM dlmm_seen_pools 
                ORDER BY detected_at DESC 
                LIMIT 50
            `).all();
            
            dlmmRows.forEach((t: any) => {
                const symbol = getTokenSymbol('sol', t.token_address);
                const ctoFlag = hasCtoFlag('sol', t.token_address);
                const meteoraUrl = `https://www.meteora.ag/dlmm/${t.pool_address}`;
                const hawkFiUrl = `https://www.hawkfi.ag/meteora/${t.pool_address}`;
                
                alerts.push({
                    id: `dlmm_${t.pool_address}`,
                    type: 'DLMM_ALPHA',
                    source: 'DLMM Alpha Scanner',
                    token_address: t.token_address,
                    pool_address: t.pool_address,
                    chain: 'sol',
                    detected_at: t.detected_at,
                    symbol: symbol,
                    reason: 'Explosive DLMM pool configuration detected',
                    all_reasons: ['High bin step (>=100) + volume threshold met', ctoFlag ? 'CTO Flag: Community Takeover' : 'CTO Flag: Not detected'],
                    color: 0xFFD700,
                    cto_flag: ctoFlag,
                    pool_links: {
                        meteora: meteoraUrl,
                        hawkfi: hawkFiUrl
                    }
                });
            });
        } catch(e) {}
        
        // 3. God Candle alerts
        try {
            const gcRows = db.prepare(`
                SELECT address, detected_at 
                FROM god_candle_seen_tokens 
                ORDER BY detected_at DESC 
                LIMIT 50
            `).all();
            
            gcRows.forEach((t: any) => {
                const symbol = getTokenSymbol('sol', t.address);
                const ctoFlag = hasCtoFlag('sol', t.address);
                
                alerts.push({
                    id: `gdc_${t.address}`,
                    type: 'GOD_CANDLE',
                    source: 'God Candle Watchdog',
                    token_address: t.address,
                    chain: 'sol',
                    detected_at: t.detected_at,
                    symbol: symbol,
                    reason: 'Imminent breakout - pressure matrix warning',
                    all_reasons: ['Order flow compression detected', 'Heavy sell absorption', 'Supply fully absorbed', ctoFlag ? 'CTO Flag: Community Takeover' : 'CTO Flag: Not detected'],
                    color: 0xFF3B30,
                    cto_flag: ctoFlag
                });
            });
        } catch(e) {}
        
        // 4. Velocity Scalps
        try {
            const vsRows = db.prepare(`
                SELECT address, detected_at 
                FROM velocity_seen_tokens 
                ORDER BY detected_at DESC 
                LIMIT 50
            `).all();
            
            vsRows.forEach((t: any) => {
                const symbol = getTokenSymbol('sol', t.address);
                const ctoFlag = hasCtoFlag('sol', t.address);
                
                alerts.push({
                    id: `vs_${t.address}`,
                    type: 'VELOCITY_SCALP',
                    source: 'Velocity Scalp Finder',
                    token_address: t.address,
                    chain: 'sol',
                    detected_at: t.detected_at,
                    symbol: symbol,
                    reason: 'High velocity trade opportunity detected',
                    all_reasons: ['Rapid volume surge', 'High swap frequency', ctoFlag ? 'CTO Flag: Community Takeover' : 'CTO Flag: Not detected'],
                    color: 0x00FF88,
                    cto_flag: ctoFlag
                });
            });
        } catch(e) {}
        
        // 5. Resurrection alerts
        try {
            const resRows = db.prepare(`
                SELECT address, detected_at 
                FROM resurrection_seen_tokens 
                ORDER BY detected_at DESC 
                LIMIT 50
            `).all();
            
            resRows.forEach((t: any) => {
                const symbol = getTokenSymbol('sol', t.address);
                const ctoFlag = hasCtoFlag('sol', t.address);
                
                alerts.push({
                    id: `res_${t.address}`,
                    type: 'RESURRECTION',
                    source: 'Resurrection Scanner',
                    token_address: t.address,
                    chain: 'sol',
                    detected_at: t.detected_at,
                    symbol: symbol,
                    reason: 'Token resurrection detected - dead coin coming back',
                    all_reasons: ['Price surge after dormancy', 'Volume spike', 'Migrated to DEX - Community takeover', ctoFlag ? 'CTO Flag: Community Takeover' : 'CTO Flag: Not detected'],
                    color: 0x9B59B6,
                    is_migrated: true,
                    cto_flag: ctoFlag
                });
            });
        } catch(e) {}
        
        // 6. Smart Money Accumulation updates (from CTO Watchdog)
        try {
            const watchlistRows = db.prepare(`
                SELECT token_address, chain, symbol, detected_at, initial_smart_money, initial_renowned,
                       last_alerted_smart_money, last_alerted_renowned, golden_phoenix_alerted
                FROM cto_watchlist 
                WHERE last_alerted_smart_money > initial_smart_money
                ORDER BY detected_at DESC 
                LIMIT 50
            `).all();
            
            watchlistRows.forEach((t: any) => {
                const smartDelta = t.last_alerted_smart_money - t.initial_smart_money;
                const ctoFlag = hasCtoFlag(t.chain, t.token_address);
                const liveMigrated = isMigratedLive(t.chain, t.token_address);
                
                alerts.push({
                    id: `sma_${t.token_address}`,
                    type: 'SMART_MONEY_ACCUMULATION',
                    source: 'CTO Watchdog',
                    token_address: t.token_address,
                    chain: t.chain,
                    detected_at: t.detected_at,
                    symbol: t.symbol,
                    smart_money: t.last_alerted_smart_money,
                    initial_smart_money: t.initial_smart_money,
                    smart_delta: smartDelta,
                    kol_count: t.initial_renowned,
                    is_migrated: liveMigrated,
                    golden_phoenix: t.golden_phoenix_alerted === 1,
                    cto_flag: ctoFlag,
                    reason: `Smart Money Accumulation: +${smartDelta} new smart wallets (total: ${t.last_alerted_smart_money})`,
                    all_reasons: [
                        `Smart Money Accumulation: +${smartDelta} new smart wallets`,
                        `Initial: ${t.initial_smart_money} → Current: ${t.last_alerted_smart_money}`,
                        ctoFlag ? 'CTO Flag: Community Takeover' : 'CTO Flag: Not detected',
                        liveMigrated ? 'Migrated to DEX' : 'Bonding curve phase'
                    ],
                    color: 0x9B59B6 // Purple for updates
                });
            });
        } catch(e) {}
        
        // 7. KOL Accumulation updates (from CTO Watchdog)
        try {
            const kolRows = db.prepare(`
                SELECT token_address, chain, symbol, detected_at, initial_smart_money, initial_renowned,
                       last_alerted_smart_money, last_alerted_renowned, golden_phoenix_alerted
                FROM cto_watchlist 
                WHERE last_alerted_renowned > initial_renowned
                ORDER BY detected_at DESC 
                LIMIT 50
            `).all();
            
            kolRows.forEach((t: any) => {
                const kolDelta = t.last_alerted_renowned - t.initial_renowned;
                const ctoFlag = hasCtoFlag(t.chain, t.token_address);
                const liveMigrated = isMigratedLive(t.chain, t.token_address);
                
                alerts.push({
                    id: `kol_${t.token_address}`,
                    type: 'KOL_ACCUMULATION',
                    source: 'CTO Watchdog',
                    token_address: t.token_address,
                    chain: t.chain,
                    detected_at: t.detected_at,
                    symbol: t.symbol,
                    smart_money: t.last_alerted_smart_money,
                    initial_smart_money: t.initial_smart_money,
                    kol_count: t.last_alerted_renowned,
                    initial_kol_count: t.initial_renowned,
                    kol_delta: kolDelta,
                    is_migrated: liveMigrated,
                    golden_phoenix: t.golden_phoenix_alerted === 1,
                    cto_flag: ctoFlag,
                    reason: `KOL Accumulation: +${kolDelta} new KOLs (total: ${t.last_alerted_renowned})`,
                    all_reasons: [
                        `KOL Accumulation: +${kolDelta} new renowned wallets`,
                        `Initial: ${t.initial_renowned} → Current: ${t.last_alerted_renowned}`,
                        ctoFlag ? 'CTO Flag: Community Takeover' : 'CTO Flag: Not detected',
                        liveMigrated ? 'Migrated to DEX' : 'Bonding curve phase'
                    ],
                    color: 0x2ECC71 // Green for KOL updates
                });
            });
        } catch(e) {}
        
        // Sort by detected_at descending
        alerts.sort((a, b) => b.detected_at - a.detected_at);
        
        // Calculate counts
        const counts = {
            total: alerts.length,
            phoenix: alerts.filter(a => a.type === 'CTO_PHOENIX').length,
            dlmm: alerts.filter(a => a.type === 'DLMM_ALPHA').length,
            god_candle: alerts.filter(a => a.type === 'GOD_CANDLE').length,
            velocity: alerts.filter(a => a.type === 'VELOCITY_SCALP').length,
            resurrection: alerts.filter(a => a.type === 'RESURRECTION').length,
            smart_money_accumulation: alerts.filter(a => a.type === 'SMART_MONEY_ACCUMULATION').length,
            kol_accumulation: alerts.filter(a => a.type === 'KOL_ACCUMULATION').length
        };
        
        res.json({ alerts: alerts.slice(0, 200), counts });
    } catch (error) {
        console.error('[Web Server] Error fetching alerts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start web server
const webApp = webServer.listen(WEB_PORT, () => {
    console.log(`[Web Dashboard] Dashboard available at http://localhost:${WEB_PORT}`);
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

if (!DISCORD_TOKEN) {
    console.error("Please provide a DISCORD_TOKEN in your .env file");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');

const GMGN_API_KEY = process.env.GMGN_API_KEY;
const GMGN_KEY_PATH = process.env.GMGN_KEY_PATH;

const gmgn = new GMGNAgent({
    apiKey: GMGN_API_KEY || '',
    privateKeyPath: GMGN_KEY_PATH || ''
});

async function createReportPayload(tokenAddress: string, flags?: { stage?: string, holders?: any[], isWashTrading?: boolean, securityScore?: number }) {
    // 1. Audit Token Security (Using GMGN instead of Helius due to indexing delays on new tokens)
    const gmgnInfo = await gmgn.getTokenInfo(tokenAddress);
    const gmgnSecurity = await gmgn.getTokenSecurity(tokenAddress);
    
    const stat = gmgnInfo.stat || {};
    const ratTraderRate = parseFloat(stat.top_rat_trader_percentage || '0') * 100;
    const bundlerRate = parseFloat(stat.top_bundler_trader_percentage || '0') * 100;
    
    const isHighRiskBundle = bundlerRate > 10;
    const isInsiderLoading = ratTraderRate > 5;
    const stage = flags?.stage || 'UNKNOWN';

    const report = {
        name: gmgnInfo.name,
        symbol: gmgnInfo.symbol,
        mintAddress: tokenAddress,
        isToken2022: gmgnInfo.isToken2022,
        mintAuthority: gmgnSecurity.renouncedMint ? null : 'Present',
        freezeAuthority: gmgnSecurity.renouncedFreezeAccount ? null : 'Present',
        hasPermanentDelegate: false,
        permanentDelegate: null,
        isHighRisk: gmgnSecurity.isHoneypot || (!gmgnSecurity.renouncedMint) || (!gmgnSecurity.renouncedFreezeAccount) || isHighRiskBundle || isInsiderLoading,
        transferFeeBasisPoints: parseFloat(gmgnSecurity.buyTax || '0') * 100,
        isTaxToken: parseFloat(gmgnSecurity.buyTax || '0') > 0 || parseFloat(gmgnSecurity.sellTax || '0') > 0,
        defaultAccountState: gmgnSecurity.isHoneypot ? 'Frozen' : 'Initialized',
        isHoneypot: gmgnSecurity.isHoneypot,
        error: undefined
    };

    // 2. Advanced GMGN Holder Analysis
    const holders = flags?.holders || await gmgn.getTokenHolders(tokenAddress, 100);
    const nonDustHolders = holders.filter((h: any) => h.amount_percentage >= 0.00001);
    
    let isSupplyHijack = false;
    if (holders.length > 0) {
        const topHolder = holders[0];
        if (topHolder.amount_percentage >= 0.5 && (topHolder.is_transfer_in || (topHolder.tags && topHolder.tags.includes('transfer_in')) || (topHolder.maker_token_tags && topHolder.maker_token_tags.includes('transfer_in')))) {
            isSupplyHijack = true;
            report.isHighRisk = true;
        }
    }
    
    let blueChipCount = 0;
    const top50 = holders.slice(0, 50);
    for (const h of top50) {
        const tags = [...(h.tags || []), ...(h.maker_token_tags || [])];
        if (tags.includes('smart_degen') || tags.includes('bluechip_owner') || tags.includes('renowned')) {
            blueChipCount++;
        }
    }

    // 3. Audit Liquidity Status
    let liquidityReport: any = null;
    const pool = gmgnInfo.pool;
    if (pool && pool.pool_address) {
        const lockSummary = gmgnSecurity.lock_summary || {};
        let lockStatus = 'Unknown';
        if (pool.exchange === 'pump' || pool.exchange === 'pump_amm') {
            lockStatus = 'Bonding Curve (Safe)';
        } else if (gmgnSecurity.burn_status === "burn" || parseFloat(gmgnSecurity.burn_ratio || '0') >= 0.9) {
            lockStatus = 'Burned';
        } else if (lockSummary.is_locked) {
            lockStatus = 'Locked';
        } else {
            lockStatus = 'Dangerous';
        }

        liquidityReport = {
            poolAddress: pool.pool_address,
            poolType: pool.exchange ? pool.exchange.toUpperCase() : 'Unknown DEX',
            lockStatus: lockStatus,
            liquidityUsd: parseFloat(pool.liquidity || '0')
        };
    }

    // Calculate a manipulation score out of 100 based on clustered sniper/insider activity
    const rawTop10Concentration = parseFloat(stat.top_10_holder_rate || '0') * 100;
    const manipulationScore = Math.min(100, Math.round(ratTraderRate + bundlerRate));
    const clustersFound = (bundlerRate > 0 ? 1 : 0) + (ratTraderRate > 0 ? 1 : 0);

    const clusterReport = {
        rawTop10Concentration,
        trueTop10Concentration: rawTop10Concentration + ratTraderRate,
        manipulationScore,
        clustersFound,
        error: undefined
    };

    // 4. Prepare Embed
    let embedColor = 0x00ff00; // green
    let statusText = '✅ **SAFE (Basic)**';
    
    // A token's liquidity is safe if it's locked, burned, or still on a safe bonding curve
    const isLiqSafe = liquidityReport && ['Burned', 'Locked', 'Bonding Curve (Safe)'].includes(liquidityReport.lockStatus);
    const isLiqDangerous = !isLiqSafe;
    const isManipulationHigh = clusterReport.manipulationScore > 70;

    if (report.isHighRisk || report.isTaxToken || report.isHoneypot || isLiqDangerous || isManipulationHigh) {
        embedColor = 0xff0000; // red
        statusText = '🚨 **DANGER / HIGH RISK**';
    } else if (report.isToken2022) {
        embedColor = 0x0099ff; // blue
    }
    
    const shouldAlert = !isLiqDangerous; // We shouldn't alert if liquidity is dangerous/unlocked

    let titlePrefix = 'Token Security Report';
    if (stage === 'FULL_ALERT') {
        titlePrefix = '🟢 [FULL ALERT] Liquidity Bonded & Trading';
    } else if (stage === 'NEW_CREATION') {
        titlePrefix = '🟡 [PRE-ALERT] New Creation (Launching)';
    }

    const embed = {
        color: embedColor,
        title: titlePrefix,
        description: `**${report.name} (${report.symbol})**\nAddress: \`${report.mintAddress}\`\n\n**STATUS:** ${statusText}`,
        fields: [] as any[],
        timestamp: new Date().toISOString(),
        footer: {
            text: 'FortiCheck Bot Auto-Signal',
        },
    };

    const securityScore = flags?.securityScore ?? (100 - manipulationScore);
    const top10Concentration = gmgnSecurity.top10Concentration || clusterReport.rawTop10Concentration.toFixed(2);
    
    embed.fields.push({
        name: 'GMGN Security & Vibe',
        value: `**Security Score:** ${securityScore}/100\n**Honeypot (GMGN):** ${gmgnSecurity.isHoneypot ? '🚨 YES' : '✅ NO'}\n**Top 10 Concentration:** ${top10Concentration}%`,
        inline: false,
    });

    embed.fields.push({
        name: 'Holder Distribution & Vibes',
        value: `**Holders (Non-Dust):** ${nonDustHolders.length}\n**Blue Chip Wallets:** ${blueChipCount}\n**Rat/Insider Traders:** ${ratTraderRate.toFixed(2)}%\n**Wash Trading (GMGN):** ${flags?.isWashTrading ? '🚨 YES' : '✅ NO'}`,
        inline: false,
    });

    if (isHighRiskBundle) {
        embed.fields.push({ name: 'Launch Bundlers', value: '🚨 **HIGH RISK BUNDLE** (>10% supplied by bundlers)', inline: false });
    }
    
    if (isInsiderLoading) {
        embed.fields.push({ name: 'Insider Detection', value: '🚨 **INSIDER LOADING** (>5% held by insiders/rats)', inline: false });
    }

    if (isSupplyHijack) {
        embed.fields.push({ name: 'Supply Hijack', value: '🚨 **NANO-PUMP DETECTED** (Top holder owns >50% via transfer)', inline: false });
    }

    const hasTelegram = !!gmgnInfo.link?.telegram;
    if (hasTelegram && blueChipCount === 0) {
        embed.fields.push({ name: 'Bot-Heavy Socials', value: '🚨 **FAKE COMMUNITY RISK** (Has Telegram but 0 Blue Chip Holders)', inline: false });
    }

    // Bullish Signals
    const smartDegenCount = stat.smart_degen_count || 0;
    const renownedCount = stat.renowned_count || 0;
    const holderCount = stat.holder_count || holders.length;
    const ctoFlag = stat.cto_flag === 1;

    const bullishSignals = [];
    if (smartDegenCount >= 10) bullishSignals.push('🧠 **High Conviction** (≥10 Smart Degens)');
    if (renownedCount >= 5) bullishSignals.push('🚀 **Moonshot Potential** (≥5 KOLs)');
    if (holderCount > 500) bullishSignals.push('🤝 **Safe Distribution** (>500 Holders)');
    if (ctoFlag) bullishSignals.push('👑 **Community Takeover** (CTO Flagged)');

    if (bullishSignals.length > 0) {
        embed.fields.push({ name: 'Bullish Signals', value: bullishSignals.join('\\n'), inline: false });
    }

    if (liquidityReport) {
        embed.fields.push({
            name: 'Top Liquidity Pool',
            value: `${liquidityReport.poolType} (\`${liquidityReport.poolAddress}\`)\n**Liquidity:** $${liquidityReport.liquidityUsd.toFixed(2)}`,
            inline: false,
        });

        let lockStatusText = '❔ Unknown';
        if (liquidityReport.lockStatus === 'Burned') {
            lockStatusText = `🔥 Burned (Safe)`;
        } else if (liquidityReport.lockStatus === 'Locked') {
            lockStatusText = `🔒 Locked (Safe)`;
        } else if (liquidityReport.lockStatus === 'Bonding Curve (Safe)') {
            lockStatusText = `💊 Bonding Curve (Pump.fun - Safe)`;
        } else if (liquidityReport.lockStatus === 'Dangerous') {
            lockStatusText = `🚨 DANGEROUS (Not burned or locked)`;
        }

        embed.fields.push({
            name: 'Liquidity Status',
            value: lockStatusText,
            inline: false,
        });
    } else {
        embed.fields.push({
            name: 'Top Liquidity Pool',
            value: `⚠️ No active pool found via GMGN`,
            inline: false,
        });
    }

    const combinedReport = {
        security: report,
        liquidity: liquidityReport,
        clusters: clusterReport
    };

    const jsonBuffer = Buffer.from(JSON.stringify(combinedReport, null, 2), 'utf-8');
    const attachment = new AttachmentBuilder(jsonBuffer, { name: 'safety-report.json' });

    return { embed, attachment, rawReport: combinedReport, shouldAlert };
}

client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    
    // Sync nicknames on startup for registered servers
    syncNicknamesOnStartup(c);
    
    // Poll GMGN Signals for CTO events (reading from centralized cache)
    console.log('🚀 Phoenix Scanner Active: Watching for CTOs & DLMM Yields...');
    
    async function pollSignals() {
        try {
            // Prune seen tokens older than 24 hours
            pruneSeenTokens('sol', 24 * 3600);
            
            // Read from centralized GMGN cache (populated by gmgn-fetcher service)
            const trenchesNew = getTrenchesCache('sol', 'NEW_CREATION', 90);
            const trenchesFull = getTrenchesCache('sol', 'FULL_ALERT', 90);
            const trending = getTrendingCache('sol', 90);
            
            const signals = [...trenchesNew, ...trenchesFull, ...trending];
            
            if (signals.length === 0) {
                console.log('[Phoenix Scanner] No signals in cache yet, waiting for fetcher...');
                return;
            }
            
            for (const event of signals) {
                const tokenAddress = event.address;
                const symbol = event.symbol || 'Unknown';
                const isCto = event.cto_flag === 1 || event.cto_flag === true;
                
                if (!isCto || hasSeenToken(tokenAddress, 'sol')) continue;
                if (event.rug_ratio >= 1) continue;
                
                addSeenToken(tokenAddress, 'sol');
                
                const smartDegenCount = event.smart_degen_count || 0;
                const renownedCount = event.renowned_count || 0;
                const marketCap = parseFloat(event.usd_market_cap) || parseFloat(event.market_cap) || 0;
                
                const trueCreationTimestamp = event.created_timestamp || event.creation_timestamp || event.open_timestamp || 0;
                const ageInHours = trueCreationTimestamp > 0 ? (Math.floor(Date.now() / 1000) - trueCreationTimestamp) / 3600 : 0;
                if (ageInHours > 24) continue;
                
                const socialUpdateTimestamp = event.dexscr_update_link_ts || 0;
                const socialAgeInHours = socialUpdateTimestamp > 0 ? (Math.floor(Date.now() / 1000) - socialUpdateTimestamp) / 3600 : 0;
                if (socialAgeInHours > 24) continue;
                
                const isMigratedInitial = isSignalMigrated(event);
    
                addTokenToWatchlist(tokenAddress, symbol, 'sol', smartDegenCount, renownedCount, isMigratedInitial ? 1 : 0);
                
if ((smartDegenCount >= 5 || renownedCount >= 1) && marketCap > 10000) {
                    const metData = await auditMeteoraExplosive(tokenAddress);
     
                    let tokenInfo = getTokenInfoCache('sol', tokenAddress, 300);
                    if (!tokenInfo) {
                        console.log(`[Phoenix Scanner] Token info not in cache for ${tokenAddress}, skipping alert (fetcher will cache it next cycle)`);
                        continue;
                    }
                    const isMigratedLive = tokenInfo.launchpad !== 'pump' || tokenInfo.launchpad_progress >= 1;
    
                    let color = 0x3498DB;
                    let title = isMigratedLive ? "💎 PHOENIX: Community Takeover" : "💎 [PRE-ALERT] PHOENIX: Community Takeover";
                    let description = `Dev exited, community taking the lead.\n\`${tokenAddress}\``;
    
                    if (metData && metData.status === "🚨 EXPLOSIVE") {
                        color = 0xFFD700;
                        title = "🔥 TIER 1: PHOENIX EXPLOSION";
                        description = `CTO Confirmed + High Bin-Step DLMM Pool found!\n\`${tokenAddress}\``;
                    } else if (metData && metData.status === "✅ HIGH VOLATILITY") {
                        color = 0xF39C12;
                        title = "⚡ TIER 2: PHOENIX VOLATILITY";
                        description = `CTO Confirmed + Active DLMM Pool found!\n\`${tokenAddress}\``;
                    }
    
                    const embed = {
                        color,
                        title,
                        description,
                        fields: [
                            { name: "Market Cap", value: `$${marketCap.toLocaleString('en-US', {maximumFractionDigits: 0})}`, inline: true },
                            { name: "Smart Degens", value: String(smartDegenCount), inline: true },
                            { name: "KOLs (Renowned)", value: String(renownedCount), inline: true }
                        ],
                        timestamp: new Date().toISOString(),
                        footer: { text: 'Phoenix Scanner Auto-Signal' },
                    };
    
                    if (metData) {
                        embed.fields.push({ name: "Meteora DLMM", value: `✅ ${metData.apr} APY`, inline: true });
                        embed.fields.push({ name: "DLMM Specs", value: `**Bin Step:** ${metData.bin_step}\n**Fee:** ${metData.fee}\n**Liquidity:** ${metData.liq}`, inline: false });
                        embed.fields.push({ name: "Pool Link", value: `[💧 Trade on Meteora](${metData.link})`, inline: false });
                    }
                    
                    embed.fields.push({ name: "GMGN Chart", value: `[📈 View on GMGN](https://gmgn.ai/sol/token/${tokenAddress})`, inline: false });
    
                    await broadcastSolanaAlert(c, embed, symbol, tokenAddress);
    
                    attemptSnipe(tokenAddress, symbol, gmgn, c);
                }
            }
            
        } catch (error) {
            console.error("Error polling signals:", error);
        }
    }
    
    // Poll every 15 seconds (reads from local cache, no API calls)
    setInterval(pollSignals, 15000);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // Handle white-label setup commands first
    const wasWlCommand = await handleWhiteLabelCommands(message, false);
    if (wasWlCommand) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command === '!check') {
        const tokenAddress = args[1];

        if (!tokenAddress) {
            await message.reply("Please provide a token address. Usage: `!check <token_address>`");
            return;
        }

        try {
            const statusMessage = await message.reply("🕵️‍♂️ Scanning token... This may take up to 30-45 seconds to process.");
            
            const { embed, attachment } = await createReportPayload(tokenAddress);
            const customizedEmbed = customizeEmbedForGuild(embed, message.guildId);

            await statusMessage.edit({ 
                content: "✅ Scan complete! Here is the formatted report:",
                embeds: [customizedEmbed]
            });

        } catch (error: any) {
            console.error(error);
            await message.reply(`An unexpected error occurred: ${error.message}`);
        }
    }
});

client.login(DISCORD_TOKEN);