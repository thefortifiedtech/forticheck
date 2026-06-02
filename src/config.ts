export const BotConfig = {
    pump: {
        prefilter: {
            minVolume: 750,
            minSwaps: 50,
            minVisitors: 10,
            requireSocials: true
        },
        watcher: {
            delayMs: 120000, // 2 minutes (Waiting for Raydium launch)
            minHolders: 100
        }
    },
    organic: {
        prefilter: {
            minVolume: 0,
            minSwaps: 1, // Just needs to be non-zero
            minVisitors: 0,
            requireSocials: true // Organic launches must have socials to avoid blank scams
        },
        watcher: {
            delayMs: 300000, // 5 minutes
            minHolders: 50
        }
    }
};
