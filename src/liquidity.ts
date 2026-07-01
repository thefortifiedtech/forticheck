import { Connection, PublicKey } from '@solana/web3.js';
// @ts-ignore
import { LIQUIDITY_STATE_LAYOUT_V4 } from '@raydium-io/raydium-sdk';
import DLMM from '@meteora-ag/dlmm';
// @ts-ignore
import BN from 'bn.js';

export interface LiquidityReport {
    poolAddress: string;
    poolType: 'Raydium V4' | 'Meteora DLMM' | 'Pump.fun' | 'Unknown';
    lockStatus: 'Locked' | 'Burned' | 'Dangerous' | 'Unknown' | 'Bonding Curve';
    burnPercentage?: number;
    activationPoint?: string;
    activationType?: number;
    error?: string;
}

// Known lockers / burn addresses
const STREAMFLOW_PROGRAM = 'strmZsyRW5cMAJQofxpNwBw5hYvE14V42c67K85pMWX';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Helper to fetch the top pair for a token using DexScreener API
 */
export async function getTopPairAddress(tokenAddress: string): Promise<string | null> {
    try {
        const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`);
        const pairs = await res.json();
        if (pairs && pairs.length > 0) {
            // Get the pair with highest liquidity on Solana
            const solanaPairs = pairs.filter((p: any) => p.chainId === 'solana');
            if (solanaPairs.length === 0) return null;
            
            const sortedPairs = solanaPairs.sort((a: any, b: any) => {
                const liqA = a.liquidity?.usd || 0;
                const liqB = b.liquidity?.usd || 0;
                return liqB - liqA;
            });
            return sortedPairs[0].pairAddress;
        }
        return null;
    } catch (err) {
        console.error("Failed to fetch from DexScreener:", err);
        return null;
    }
}

/**
 * Analyzes the liquidity status of a given pair address
 */
export async function getLiquidityStatus(connection: Connection, pairAddressString: string): Promise<LiquidityReport> {
    const defaultReport: LiquidityReport = {
        poolAddress: pairAddressString,
        poolType: 'Unknown',
        lockStatus: 'Unknown',
    };

    try {
        const pairPubkey = new PublicKey(pairAddressString);
        const accountInfo = await connection.getAccountInfo(pairPubkey);

        if (!accountInfo) {
            return { ...defaultReport, error: "Pair account not found on-chain." };
        }

        const ownerId = accountInfo.owner.toBase58();

        if (ownerId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') {
            // Raydium V4
            defaultReport.poolType = 'Raydium V4';
            try {
                const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
                const lpMint = poolState.lpMint;

                // Check LP Mint Supply
                const supplyRes = await connection.getTokenSupply(lpMint);
                const totalSupplyStr = supplyRes.value.amount;

                // Get Largest Holders
                const largestAccounts = await connection.getTokenLargestAccounts(lpMint);
                if (largestAccounts.value.length > 0) {
                    const topAccount = largestAccounts.value[0];
                    const topAccountPubkey = topAccount.address;
                    
                    // Fetch parsed top account
                    const topAccountInfoParsed = await connection.getParsedAccountInfo(topAccountPubkey);
                    const parsedData = (topAccountInfoParsed.value?.data as any)?.parsed?.info;
                    
                    if (parsedData) {
                        const topOwner = parsedData.owner;
                        
                        if (topOwner === INCINERATOR || topOwner === SYSTEM_PROGRAM) {
                            const burnAmountStr = topAccount.amount;
                            const totalBN = new BN(totalSupplyStr);
                            const burnBN = new BN(burnAmountStr);
                            
                            if (totalBN.isZero()) {
                                defaultReport.lockStatus = 'Dangerous';
                                defaultReport.burnPercentage = 0;
                            } else {
                                const percentBurned = burnBN.muln(10000).div(totalBN).toNumber() / 100;
                                defaultReport.burnPercentage = percentBurned;
                                
                                if (percentBurned > 90) {
                                    defaultReport.lockStatus = 'Burned';
                                } else {
                                    defaultReport.lockStatus = 'Dangerous';
                                }
                            }
                        } else {
                            defaultReport.lockStatus = 'Dangerous';
                            defaultReport.burnPercentage = 0;
                        }
                    } else {
                        defaultReport.lockStatus = 'Dangerous';
                    }
                } else {
                    defaultReport.lockStatus = 'Dangerous';
                }
            } catch (err: any) {
                return { ...defaultReport, error: "Failed to parse Raydium pool: " + err.message };
            }

        } else if (ownerId === 'LBUZKhRxPF3XUpBCjp4kVnZq36kL2Zq2BHTtFk5Bebk') {
            // Meteora DLMM
            defaultReport.poolType = 'Meteora DLMM';
            try {
                const dlmmPool = await DLMM.create(connection, pairPubkey);
                const lbPair = dlmmPool.lbPair;

                defaultReport.activationPoint = lbPair.activationPoint.toString();
                defaultReport.activationType = lbPair.activationType;

                const creatorStr = lbPair.creator.toBase58();

                // If the creator is incinerated or is streamflow, it's considered safe/locked
                if (creatorStr === INCINERATOR || creatorStr === SYSTEM_PROGRAM || creatorStr === STREAMFLOW_PROGRAM) {
                    defaultReport.lockStatus = 'Locked';
                } else {
                    defaultReport.lockStatus = 'Dangerous';
                }

            } catch (err: any) {
                return { ...defaultReport, error: "Failed to parse Meteora pool: " + err.message };
            }
        } else if (ownerId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' || ownerId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') {
            // Pump.fun
            defaultReport.poolType = 'Pump.fun';
            defaultReport.lockStatus = 'Bonding Curve';
        } else {
            return { ...defaultReport, error: `Unsupported DEX program: ${ownerId}` };
        }

        return defaultReport;

    } catch (err: any) {
        return { ...defaultReport, error: err.message || 'Unknown error occurred.' };
    }
}

export interface ExplosiveMeteoraData {
    status: string;
    bin_step: number;
    apr: string;
    fee: string;
    liq: string;
    link: string;
    raw_apr: number;
}

/**
 * Scans Meteora DLMM for explosive bin configurations.
 * Returns pool details if the 'Golden Ratio' is found.
 */
export async function auditMeteoraExplosive(mintAddress: string): Promise<ExplosiveMeteoraData | null> {
    try {
        // Step 1: Find DLMM pool address via DexScreener
        const dexRes = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mintAddress}`);
        if (!dexRes.ok) return null;
        const pairs = await dexRes.json() || [];
        
        let poolId = null;
        for (const pair of pairs) {
            if (pair.dexId === 'meteora' && pair.labels?.includes('DLMM')) {
                poolId = pair.pairAddress;
                break;
            }
        }
        
        if (!poolId) return null; // No DLMM pool found

        // Step 2: Fetch pool data from Meteora Datapi
        const url = `https://dlmm.datapi.meteora.ag/pools/${poolId}`;
        const response = await fetch(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(5000) 
        });
        
        if (response.ok) {
            const pool = await response.json();
            
            const binStep = pool.pool_config?.bin_step ?? parseInt(pool.bin_step || '0', 10);
            const baseFee = pool.pool_config?.base_fee_pct ?? parseFloat(pool.base_fee_percentage || '0');
            const apr24h = pool.apy ?? (parseFloat(pool.apr || '0') * 100);
            const liquidity = pool.tvl ?? parseFloat(pool.liquidity || '0');

            if (binStep >= 80 && apr24h > 200) {
                const isExplosive = binStep >= 100 && apr24h > 500 && liquidity > 1000;
                return {
                    status: isExplosive ? "🚨 EXPLOSIVE" : "✅ HIGH VOLATILITY",
                    bin_step: binStep,
                    apr: `${apr24h.toFixed(0)}%`,
                    fee: `${baseFee}%`,
                    liq: `$${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
                    link: `https://www.meteora.ag/dlmm/${poolId}`,
                    raw_apr: apr24h
                };
            }
        }
        return null;
    } catch (error) {
        console.error(`Meteora API Error for ${mintAddress}:`, error);
        return null;
    }
}
