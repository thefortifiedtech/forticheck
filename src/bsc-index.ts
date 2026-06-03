import { Client, GatewayIntentBits, Events, AttachmentBuilder, TextChannel } from 'discord.js';
import * as dotenv from 'dotenv';
import { GMGNAgent } from './gmgn-sdk';
import { syncNicknamesOnStartup, handleWhiteLabelCommands, broadcastBscAlert, customizeEmbedForGuild, hasSeenToken, addSeenToken, pruneSeenTokens, addTokenToWatchlist, isSignalMigrated } from './whitelabel';

dotenv.config();

import fs from 'fs';
import path from 'path';

// Token tracking is stored and managed via SQLite (in src/whitelabel.ts)

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BSC_DISCORD_CHANNEL_ID = process.env.BSC_DISCORD_CHANNEL_ID;

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

const GMGN_API_KEY = process.env.GMGN_API_KEY;
const GMGN_KEY_PATH = process.env.GMGN_KEY_PATH;

const gmgn = new GMGNAgent({
    apiKey: GMGN_API_KEY || '',
    privateKeyPath: GMGN_KEY_PATH || '',
    chain: 'bsc'
});

async function createReportPayload(tokenAddress: string, flags?: { stage?: string, holders?: any[], isWashTrading?: boolean, securityScore?: number }) {
    // 1. Audit Token Security (Using GMGN instead of Helius due to indexing delays on new tokens)
    const gmgnInfo = await gmgn.getTokenInfo(tokenAddress);
    const gmgnSecurity = await gmgn.getTokenSecurity(tokenAddress);
    
    const stat = gmgnInfo.stat || {};
    const bundlerRate = parseFloat(stat.top_bundler_trader_percentage || '0') * 100;
    
    const isHighRiskBundle = bundlerRate > 10;
    const stage = flags?.stage || 'UNKNOWN';

    const report = {
        name: gmgnInfo.name,
        symbol: gmgnInfo.symbol,
        mintAddress: tokenAddress,
        isHighRisk: gmgnSecurity.isHoneypot || (!gmgnSecurity.renouncedMint) || (!gmgnSecurity.renouncedFreezeAccount) || isHighRiskBundle,
        transferFeeBasisPoints: parseFloat(gmgnSecurity.buyTax || '0') * 100, // Roughly convert percentage to BPS
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

    // 4. Prepare Embed
    let embedColor = 0x00ff00; // green
    let statusText = '✅ **SAFE (Basic)**';
    
    // A token's liquidity is safe if it's locked, burned, or still on a safe bonding curve
    const isLiqSafe = liquidityReport && ['Burned', 'Locked', 'Bonding Curve (Safe)'].includes(liquidityReport.lockStatus);
    const isLiqDangerous = !isLiqSafe;

    if (report.isHighRisk || report.isTaxToken || report.isHoneypot || isLiqDangerous) {
        embedColor = 0xff0000; // red
        statusText = '🚨 **DANGER / HIGH RISK**';
    }
    
    const shouldAlert = !isLiqDangerous; // We shouldn't alert if liquidity is dangerous/unlocked

    let titlePrefix = 'Token Security Report';
    if (stage === 'FULL_ALERT') {
        titlePrefix = '🟢 [BSC FULL ALERT] Liquidity Trading';
    } else if (stage === 'NEW_CREATION') {
        titlePrefix = '🟡 [BSC PRE-ALERT] New Creation (Launching)';
    }

    const embed = {
        color: embedColor,
        title: titlePrefix,
        description: `**${report.name} (${report.symbol})**\nAddress: \`${report.mintAddress}\`\n\n**STATUS:** ${statusText}`,
        fields: [] as any[],
        timestamp: new Date().toISOString(),
        footer: {
            text: 'BSC Phoenix Scanner Auto-Signal',
        },
    };

    const securityScore = flags?.securityScore ?? 100;
    const top10Concentration = gmgnSecurity.top10Concentration || 'Unknown';
    
    embed.fields.push({
        name: 'GMGN Security & Vibe',
        value: `**Security Score:** ${securityScore}/100\n**Honeypot (GMGN):** ${gmgnSecurity.isHoneypot ? '🚨 YES' : '✅ NO'}\n**Top 10 Concentration:** ${top10Concentration}%`,
        inline: false,
    });

    embed.fields.push({
        name: 'Holder Distribution & Vibes',
        value: `**Holders (Non-Dust):** ${nonDustHolders.length}\n**Blue Chip Wallets:** ${blueChipCount}\n**Wash Trading (GMGN):** ${flags?.isWashTrading ? '🚨 YES' : '✅ NO'}`,
        inline: false,
    });

    if (isHighRiskBundle) {
        embed.fields.push({ name: 'Launch Bundlers', value: '🚨 **HIGH RISK BUNDLE** (>10% supplied by bundlers)', inline: false });
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
            lockStatusText = `💊 Bonding Curve (Safe)`;
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
        liquidity: liquidityReport
    };

    const jsonBuffer = Buffer.from(JSON.stringify(combinedReport, null, 2), 'utf-8');
    const attachment = new AttachmentBuilder(jsonBuffer, { name: 'safety-report.json' });

    return { embed, attachment, rawReport: combinedReport, shouldAlert };
}

client.once(Events.ClientReady, c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    
    // Sync nicknames on startup for registered servers
    syncNicknamesOnStartup(c);
    
    // Poll GMGN Signals for CTO events
    console.log('🚀 BSC Phoenix Scanner Active: Watching for CTOs...');

    setInterval(async () => {
        try {
            // Prune seen tokens older than 24 hours
            pruneSeenTokens('bsc', 24 * 3600);

            const [trenches, trending] = await Promise.all([
                gmgn.getTrenchesData(),
                gmgn.getTrendingData()
            ]);
            
            const signals = [...trenches, ...trending];
            
            for (const event of signals) {
                const tokenAddress = event.address;
                const symbol = event.symbol || 'Unknown';
                const isCto = event.cto_flag === 1 || event.cto_flag === true;
                
                if (!isCto || hasSeenToken(tokenAddress, 'bsc')) continue;
                if (event.rug_ratio >= 1) continue; // Skip 100% rugged tokens
                
                addSeenToken(tokenAddress, 'bsc');
                
                const smartDegenCount = event.smart_degen_count || 0;
                const renownedCount = event.renowned_count || 0;
                const marketCap = parseFloat(event.usd_market_cap) || parseFloat(event.market_cap) || 0;
                
                // Filter out old CTOs that have been trading for > 24 hours
                const trueCreationTimestamp = event.created_timestamp || event.creation_timestamp || event.open_timestamp || 0;
                const ageInHours = trueCreationTimestamp > 0 ? (Math.floor(Date.now() / 1000) - trueCreationTimestamp) / 3600 : 0;
                if (ageInHours > 120) continue;
                
                // Filter out resurrected tokens where the social profile/dex info was updated > 24h ago
                const socialUpdateTimestamp = event.dexscr_update_link_ts || 0;
                const socialAgeInHours = socialUpdateTimestamp > 0 ? (Math.floor(Date.now() / 1000) - socialUpdateTimestamp) / 3600 : 0;
                if (socialAgeInHours > 120) continue;
                
                // Check if signal has migrated
                const isMigratedInitial = isSignalMigrated(event);

                // Add EVERY CTO to the Watchlist for 60-minute monitoring, even if smart money is 0
                addTokenToWatchlist(tokenAddress, symbol, 'bsc', smartDegenCount, renownedCount, isMigratedInitial ? 1 : 0);
                
                // Noise Filter: Must have >= 5 smart money OR >= 1 KOL, AND be alive (>$10k mcap)
                if ((smartDegenCount >= 5 || renownedCount >= 1) && marketCap > 10000) {
                    // Fetch tokenInfo to get the most accurate, live migration status
                    const tokenInfo = await gmgn.getTokenInfo(tokenAddress);
                    const isMigratedLive = tokenInfo.launchpad !== 'pump' && tokenInfo.launchpad !== 'Pump.fun' || tokenInfo.launchpad_progress >= 1;

                    let color = 0x3498DB; // BLUE
                    let title = isMigratedLive ? "💎 BSC PHOENIX: Community Takeover" : "💎 [BSC PRE-ALERT] PHOENIX: Community Takeover";
                    let description = `Dev exited, community taking the lead.\n\`${tokenAddress}\``;

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
                        footer: {
                            text: 'BSC Phoenix Scanner Auto-Signal',
                        },
                    };

                    const dexLinkTarget = event.pool_address || tokenAddress;
                    embed.fields.push({
                        name: "DexScreener",
                        value: `[📈 View on DexScreener](https://dexscreener.com/bsc/${dexLinkTarget})`,
                        inline: false
                    });
                    
                    embed.fields.push({
                        name: "GMGN Chart",
                        value: `[📈 View on GMGN](https://gmgn.ai/bsc/token/${tokenAddress})`,
                        inline: false
                    });

                    await broadcastBscAlert(client, embed, symbol, tokenAddress);
                }
            }
            
        } catch (error) {
            console.error("Error polling BSC signals:", error);
        }
    }, 15000); // Poll every 15 seconds
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // Handle white-label setup commands first
    const wasWlCommand = await handleWhiteLabelCommands(message, true);
    if (wasWlCommand) return;

    const args = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command === '!checkbsc') {
        const tokenAddress = args[1];

        if (!tokenAddress) {
            await message.reply("Please provide a token address. Usage: `!checkbsc <token_address>`");
            return;
        }

        try {
            const statusMessage = await message.reply("🕵️‍♂️ Scanning BSC token... This may take up to 30-45 seconds to process.");
            
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
