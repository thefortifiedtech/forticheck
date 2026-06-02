import { Connection, PublicKey } from '@solana/web3.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface ClusterReport {
    rawTop10Concentration: number;
    trueTop10Concentration: number;
    manipulationScore: number;
    clustersFound: number;
    clusters: {
        funder: string;
        walletCount: number;
        totalPercentage: number;
    }[];
    error?: string;
}

export async function analyzeCluster(connection: Connection, mintAddressString: string): Promise<ClusterReport> {
    const defaultReport: ClusterReport = {
        rawTop10Concentration: 0,
        trueTop10Concentration: 0,
        manipulationScore: 0,
        clustersFound: 0,
        clusters: []
    };

    try {
        const mintPubkey = new PublicKey(mintAddressString);
        
        // 1. Get total supply
        await delay(500);
        const supplyRes = await connection.getTokenSupply(mintPubkey);
        const totalSupply = supplyRes.value.uiAmount || 0;
        
        if (totalSupply === 0) {
            return { ...defaultReport, error: "Total supply is zero." };
        }

        // 2. Get top 20 accounts
        await delay(500);
        const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
        const top20 = largestAccounts.value; 

        if (top20.length === 0) {
            return { ...defaultReport, error: "No token holders found." };
        }

        // 3. Resolve Owners & Get Funders
        const walletData: { owner: string, uiAmount: number, funder: string | null }[] = [];

        // To save RPC calls on free endpoints, we only scan funders for the top 5
        const topAccountsToScan = top20.slice(0, 5);

        await delay(1500); // Massive throttle before batch
        const pubkeysToFetch = topAccountsToScan.map(t => t.address);
        const multipleAccounts = await connection.getMultipleParsedAccounts(pubkeysToFetch);

        for (let idx = 0; idx < topAccountsToScan.length; idx++) {
            const tokenAcc = topAccountsToScan[idx];
            const uiAmount = tokenAcc.uiAmount || 0;
            if (uiAmount === 0) continue;

            try {
                const accInfo = multipleAccounts.value[idx];
                const parsedData = (accInfo?.data as any)?.parsed?.info;
                
                if (parsedData && parsedData.owner) {
                    const owner = parsedData.owner;
                    // Find the funder. This will skip heavily used public wallets due to depth limit.
                    const funder = await getFunder(connection, new PublicKey(owner));
                    walletData.push({ owner, uiAmount, funder });
                }
            } catch (err) {
                // Ignore parse errors for individual accounts
                continue;
            }
        }
        
        // Add the remaining top 5-20 to walletData without scanning funders so they count towards concentration
        for (const tokenAcc of top20.slice(5)) {
            const uiAmount = tokenAcc.uiAmount || 0;
            if (uiAmount > 0) {
                walletData.push({ owner: tokenAcc.address.toBase58(), uiAmount, funder: null });
            }
        }

        // 4. Calculate Raw Top 10
        const sortedRaw = [...walletData].sort((a, b) => b.uiAmount - a.uiAmount);
        const top10Raw = sortedRaw.slice(0, 10);
        const rawTop10Amount = top10Raw.reduce((sum, w) => sum + w.uiAmount, 0);
        const rawTop10Concentration = (rawTop10Amount / totalSupply) * 100;

        // 5. Cluster by Funder
        // Map: funder -> { walletCount, totalAmount }
        const entities = new Map<string, { walletCount: number, totalAmount: number }>();
        
        for (const w of walletData) {
            const key = w.funder ? w.funder : w.owner; 
            
            if (!entities.has(key)) {
                entities.set(key, { walletCount: 0, totalAmount: 0 });
            }
            const entity = entities.get(key)!;
            entity.walletCount += 1;
            entity.totalAmount += w.uiAmount;
        }

        const clusters: { funder: string, walletCount: number, totalPercentage: number }[] = [];
        let manipulationScore = 0;

        for (const [key, entity] of Array.from(entities.entries())) {
            // A cluster is 3 or more wallets funded by the same key
            if (entity.walletCount >= 3 && key !== walletData.find(w => w.owner === key)?.owner) {
                const percentage = (entity.totalAmount / totalSupply) * 100;
                clusters.push({
                    funder: key,
                    walletCount: entity.walletCount,
                    totalPercentage: percentage
                });
                
                manipulationScore += 20; // 20 points per cluster
                manipulationScore += percentage; // 1 point per 1% supply held
            }
        }

        // 6. Calculate True Top 10 Concentration
        const sortedEntities = Array.from(entities.values()).sort((a, b) => b.totalAmount - a.totalAmount);
        const top10Entities = sortedEntities.slice(0, 10);
        const trueTop10Amount = top10Entities.reduce((sum, e) => sum + e.totalAmount, 0);
        const trueTop10Concentration = (trueTop10Amount / totalSupply) * 100;

        // Cap manipulation score at 100
        manipulationScore = Math.min(100, Math.floor(manipulationScore));

        return {
            rawTop10Concentration,
            trueTop10Concentration,
            manipulationScore,
            clustersFound: clusters.length,
            clusters
        };

    } catch (err: any) {
        return { ...defaultReport, error: err.message || 'Unknown error during cluster analysis.' };
    }
}

async function getFunder(connection: Connection, walletAddress: PublicKey): Promise<string | null> {
    let before: string | undefined = undefined;
    let lastSig = '';
    
    try {
        // Max 2 loops * 1000 = 2000 depth to reduce RPC load
        for (let i = 0; i < 2; i++) {
            await delay(1500); // Massive Throttle 1.5s
            const sigs = await connection.getSignaturesForAddress(walletAddress, { limit: 1000, before });
            if (sigs.length === 0) break;
            
            lastSig = sigs[sigs.length - 1].signature;
            before = lastSig;
            
            if (sigs.length < 1000) {
                // We reached the beginning
                break;
            }
            
            if (i === 1 && sigs.length === 1000) {
                // Hit max depth and didn't reach the beginning -> highly active wallet, ignore for clustering
                return null; 
            }
        }
        
        if (!lastSig) return null;
        
        
        await delay(1500);
        // Fetch the parsed transaction
        const tx = await connection.getParsedTransaction(lastSig, { maxSupportedTransactionVersion: 0 });
        if (!tx || !tx.transaction) return null;
        
        // The fee payer is typically the funder for a brand new wallet
        return tx.transaction.message.accountKeys[0].pubkey.toBase58();
    } catch (e) {
        return null; // Rate limited or RPC error
    }
}
