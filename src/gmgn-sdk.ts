import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';

const execAsync = util.promisify(exec);

export class GMGNAgent {
    private apiKey: string;
    private privateKeyPath: string;
    public chain: string;

    constructor(options: { apiKey: string, privateKeyPath: string, chain?: string }) {
        this.apiKey = options.apiKey;
        this.privateKeyPath = options.privateKeyPath;
        this.chain = options.chain || 'sol';
        
        // Ensure API key is available for gmgn-cli
        if (this.apiKey) {
            process.env.GMGN_API_KEY = this.apiKey;
        }
    }

    private requestQueue: (() => Promise<void>)[] = [];
    private isProcessingQueue = false;

    private async enqueueCommand(command: string, envOverrides: Record<string, string> = {}): Promise<string> {
        return new Promise((resolve, reject) => {
            this.requestQueue.push(async () => {
                try {
                    const { stdout } = await execAsync(command, { 
                        env: { 
                            ...process.env, 
                            ...envOverrides,
                            HOME: '/tmp/empty-home' // Sandbox CLI to prevent it from reading global ~/.config/gmgn/.env
                        } 
                    });
                    resolve(stdout);
                } catch (err) {
                    reject(err);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const task = this.requestQueue.shift();
            if (task) {
                await task();
                // 2 req/sec rate limit = 500ms minimum delay. Use 600ms to be safe.
                await new Promise(resolve => setTimeout(resolve, 600));
            }
        }

        this.isProcessingQueue = false;
    }

    async getTokenSecurity(tokenAddress: string): Promise<any> {
        console.log(`[GMGN SDK] Fetching security data via gmgn-cli for ${tokenAddress}`);
        try {
            const stdout = await this.enqueueCommand(`npx gmgn-cli token security --chain ${this.chain} --address ${tokenAddress} --raw`);
            const data = JSON.parse(stdout.trim());
            
            return {
                isHoneypot: data.is_honeypot === "yes" || data.honeypot === 1,
                top10Concentration: data.top_10_holder_rate ? (parseFloat(data.top_10_holder_rate) * 100).toFixed(2) : 'Unknown',
                renouncedMint: data.renounced_mint,
                renouncedFreezeAccount: data.renounced_freeze_account,
                buyTax: data.buy_tax,
                sellTax: data.sell_tax,
                burn_status: data.burn_status,
                burn_ratio: data.burn_ratio,
                lock_summary: data.lock_summary
            };
        } catch (error: any) {
            console.error(`[GMGN SDK] Error fetching security data: ${error.message}`);
            return {
                isHoneypot: false,
                top10Concentration: 'Unknown',
                renouncedMint: false,
                renouncedFreezeAccount: false,
                buyTax: 0,
                sellTax: 0
            };
        }
    }

    async getTokenInfo(tokenAddress: string): Promise<any> {
        try {
            const stdout = await this.enqueueCommand(`npx gmgn-cli token info --chain ${this.chain} --address ${tokenAddress} --raw`);
            const data = JSON.parse(stdout.trim());
            return {
                name: data.name || 'Unknown',
                symbol: data.symbol || 'Unknown',
                isToken2022: data.standard === "2022",
                stat: data.stat || {},
                pool: data.pool || {},
                launchpad: data.launchpad || '',
                launchpad_progress: data.launchpad_progress || 0,
                migrated_timestamp: data.migrated_timestamp || 0,
                price: parseFloat(data.price || '0')
            };
        } catch (error: any) {
            console.error(`[GMGN SDK] Error fetching token info: ${error.message}`);
            return { name: 'Unknown', symbol: 'Unknown', isToken2022: false, stat: {}, pool: {}, launchpad: '', launchpad_progress: 0, migrated_timestamp: 0, price: 0 };
        }
    }

    async getTokenKline(tokenAddress: string, resolution: string = '1m'): Promise<any[]> {
        try {
            const stdout = await this.enqueueCommand(`npx gmgn-cli market kline --chain ${this.chain} --address ${tokenAddress} --resolution ${resolution} --raw`);
            const data = JSON.parse(stdout.trim());
            return data.list || [];
        } catch (error: any) {
            console.error(`[GMGN SDK] Error fetching token kline: ${error.message}`);
            return [];
        }
    }

    async getTrenchesData(): Promise<any[]> {
        try {
            const stdout = await this.enqueueCommand(`npx gmgn-cli market trenches --chain ${this.chain} --type new_creation near_completion completed --limit 100 --raw`);
            const data = JSON.parse(stdout.trim());
            
            const newCreations = (data.new_creation || []).map((t: any) => ({ ...t, _stage: 'NEW_CREATION' }));
            const completed = (data.completed || []).map((t: any) => ({ ...t, _stage: 'FULL_ALERT' }));
            
            return [...newCreations, ...completed];
        } catch (error: any) {
            console.error(`[GMGN SDK] Error fetching trenches data: ${error.message}`);
            return [];
        }
    }

    async getSignals(): Promise<any[]> {
        try {
            const stdout = await this.enqueueCommand(`npx gmgn-cli market signal --chain ${this.chain} --raw`);
            const data = JSON.parse(stdout.trim());
            return Array.isArray(data) ? data : (data.data || []);
        } catch (error: any) {
            console.error(`[GMGN SDK] Error fetching signals: ${error.message}`);
            return [];
        }
    }

    async getTrendingData(): Promise<any[]> {
        try {
            const stdout = await this.enqueueCommand(`npx gmgn-cli market trending --chain ${this.chain} --interval 1m --limit 100 --raw`);
            const data = JSON.parse(stdout.trim());
            return data.data?.rank || [];
        } catch (error: any) {
            console.error(`[GMGN SDK] Error fetching trending data: ${error.message}`);
            return [];
        }
    }

    async getTokenHolders(tokenAddress: string, limit: number = 100): Promise<any[]> {
        try {
            const stdout = await this.enqueueCommand(`npx gmgn-cli token holders --chain ${this.chain} --address ${tokenAddress} --limit ${limit} --raw`);
            const data = JSON.parse(stdout.trim());
            return Array.isArray(data) ? data : (data.list || []);
        } catch (error: any) {
            console.error(`[GMGN SDK] Error fetching token holders: ${error.message}`);
            return [];
        }
    }

    async submitSniperTrade(tokenAddress: string, amountSol: number, walletAddress: string, privateKey: string, apiKey: string, slippage: number, priorityFee: number, tipFee: number): Promise<any> {
        try {
            const rawAmount = Math.floor(amountSol * 1e9); // Convert SOL to lamports
            
            // Auto-format PEM if user only pasted the base64 string
            let formattedPrivateKey = privateKey.trim();
            if (!formattedPrivateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                formattedPrivateKey = `-----BEGIN PRIVATE KEY-----\n${formattedPrivateKey}\n-----END PRIVATE KEY-----`;
            }
            // User configures raw percentages (e.g., 25 for +25% profit, 25 for -25% loss)
            // GMGN API directly interprets price_scale as the delta percentage from entry.
            const tpPercentRaw = process.env.SNIPER_TAKE_PROFIT_PERCENT || "30";
            const trailActivationRaw = process.env.SNIPER_TRAILING_ACTIVATION_PERCENT || "20";
            const trailDrawdownRaw = process.env.SNIPER_TRAILING_DRAWDOWN_PERCENT || "20";
            const stopLossRaw = process.env.SNIPER_STOP_LOSS_PERCENT || "35";

            const tpPriceScale = tpPercentRaw.toString();
            const trailActivationScale = trailActivationRaw.toString();
            const stopLossScale = stopLossRaw.toString();
            const trailDrawdownScale = trailDrawdownRaw.toString();
            
            const trailingEnabled = process.env.SNIPER_TRAILING_ENABLED !== 'false';

            let conditionsObj = [];
            if (trailingEnabled) {
                conditionsObj = [
                    { order_type: "profit_stop_trace", side: "sell", price_scale: trailActivationScale, drawdown_rate: trailDrawdownScale, sell_ratio: "100" },
                    { order_type: "loss_stop", side: "sell", price_scale: stopLossScale, sell_ratio: "100" }
                ];
            } else {
                conditionsObj = [
                    { order_type: "profit_stop", side: "sell", price_scale: tpPriceScale, sell_ratio: "100" },
                    { order_type: "loss_stop", side: "sell", price_scale: stopLossScale, sell_ratio: "100" }
                ];
            }
            const conditions = JSON.stringify(conditionsObj);
            const command = `npx gmgn-cli swap --chain ${this.chain} ` +
                `--from ${walletAddress} ` +
                `--input-token So11111111111111111111111111111111111111112 ` +
                `--output-token ${tokenAddress} ` +
                `--amount ${rawAmount} ` +
                `--slippage ${slippage} ` +
                `--priority-fee ${priorityFee} ` +
                `--tip-fee ${tipFee} ` +
                `--condition-orders '${conditions}' ` +
                `--sell-ratio-type buy_amount --raw`;

            const stdout = await this.enqueueCommand(command, { 
                GMGN_PRIVATE_KEY: formattedPrivateKey,
                GMGN_API_KEY: apiKey
            });
            return JSON.parse(stdout.trim());
        } catch (error: any) {
            console.error(`[GMGN SDK] Error submitting sniper trade for ${tokenAddress}: ${error.message}`);
            return null;
        }
    }
}
