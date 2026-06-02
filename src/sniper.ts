import { Client, TextChannel } from 'discord.js';
import { GMGNAgent } from './gmgn-sdk';

export async function attemptSnipe(tokenAddress: string, symbol: string, gmgn: GMGNAgent, client: Client) {
    if (process.env.SNIPER_ENABLED !== 'true') return;

    const amount = parseFloat(process.env.SNIPER_BUY_AMOUNT_SOL || '0.06');
    const wallet = process.env.SNIPER_WALLET_ADDRESS;
    const privateKey = process.env.SNIPER_PRIVATE_KEY;
    const apiKey = process.env.SNIPER_API_KEY;
    const slippage = parseFloat(process.env.SNIPER_SLIPPAGE || '0.10');
    const priorityFee = parseFloat(process.env.SNIPER_PRIORITY_FEE || '0.002');
    const tipFee = parseFloat(process.env.SNIPER_TIP_FEE || '0.0001');
    const sniperChannelId = process.env.SNIPER_DISCORD_CHANNEL_ID;
    
    const waitWindowMins = parseFloat(process.env.SNIPER_JUST_MIGRATED_WINDOW_MINUTES || '5');
    const dropThreshold = parseFloat(process.env.SNIPER_POST_MIGRATION_DROP_THRESHOLD || '-0.15');
    
    if (!wallet || !privateKey || !apiKey) {
        console.error(`[SNIPER] SNIPER_WALLET_ADDRESS, SNIPER_PRIVATE_KEY, or SNIPER_API_KEY not set in .env!`);
        return;
    }

    // Run sniper execution asynchronously to prevent blocking the caller
    (async () => {
        let channel: TextChannel | null = null;
        if (sniperChannelId) {
            try {
                channel = await client.channels.fetch(sniperChannelId) as TextChannel;
            } catch (e) {
                console.error(`[SNIPER] Failed to fetch sniper discord channel:`, e);
            }
        }

        try {
            const tokenInfo = await gmgn.getTokenInfo(tokenAddress);
            
            // Rule 1: Incomplete Bonding Curve
            if (tokenInfo.launchpad === 'pump' && tokenInfo.launchpad_progress < 1) {
                console.log(`[SNIPER] Aborting auto-buy for ${symbol}: Bonding curve incomplete.`);
                return;
            }

            // Rule 2: Post-Migration Drop Check
            if (tokenInfo.migrated_timestamp > 0) {
                const minsSinceMigration = (Date.now() / 1000 - tokenInfo.migrated_timestamp) / 60;
                if (minsSinceMigration < waitWindowMins) {
                    console.log(`[SNIPER] ${symbol} migrated ${minsSinceMigration.toFixed(1)} mins ago. Waiting 4 minutes to verify stability...`);
                    const initialPrice = tokenInfo.price;
                    
                    // Wait 4 minutes (240 seconds)
                    await new Promise(resolve => setTimeout(resolve, 240000));
                    
                    const newTokenInfo = await gmgn.getTokenInfo(tokenAddress);
                    const newPrice = newTokenInfo.price;
                    if (initialPrice > 0 && newPrice > 0) {
                        const drop = (newPrice - initialPrice) / initialPrice;
                        if (drop <= dropThreshold) {
                            console.log(`[SNIPER] Aborting auto-buy for ${symbol}: Price dropped by ${(drop * 100).toFixed(1)}% after migration.`);
                            return;
                        }
                    }
                }
            }

            // Rule 3: Volume Check (Has traded in last 5 mins)
            const klines = await gmgn.getTokenKline(tokenAddress, '1m');
            if (!klines || klines.length === 0) {
                console.log(`[SNIPER] Aborting auto-buy for ${symbol}: No recent trade data found.`);
                return;
            }
            
            const lastTradeTime = klines[klines.length - 1].time; // in ms
            const minsSinceLastTrade = (Date.now() - lastTradeTime) / 60000;
            
            if (minsSinceLastTrade >= 5) {
                console.log(`[SNIPER] Aborting auto-buy for ${symbol}: Has not traded in the last ${minsSinceLastTrade.toFixed(1)} mins (Dead volume).`);
                return;
            }

            console.log(`[SNIPER] Executing auto-buy for ${symbol} (${tokenAddress}) - Amount: ${amount} SOL`);
            const result = await gmgn.submitSniperTrade(tokenAddress, amount, wallet, privateKey, apiKey, slippage, priorityFee, tipFee);
            if (result && (result.code === 0 || result.hash || result.order_id || result.status === 'submitted')) {
                console.log(`[SNIPER] Successfully bought ${symbol}! Hash: ${result.hash}`);
                if (channel) {
                    const hashLink = result.hash ? `[Solscan](https://solscan.io/tx/${result.hash})` : '';
                    await channel.send(`🔫 **Sniper Executed!** Bought ${amount} SOL of ${symbol}.\nOrder submitted to GMGN with TP/SL conditions. ${hashLink}`);
                }
            } else {
                console.error(`[SNIPER] Failed to buy ${symbol}:`, result);
                if (channel) {
                    await channel.send(`❌ **Sniper Failed!** Could not execute buy for ${symbol}. Check console logs.`);
                }
            }
        } catch (error) {
            console.error(`[SNIPER] Exception during auto-buy for ${symbol}:`, error);
        }
    })();
}
