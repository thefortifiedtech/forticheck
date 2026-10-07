import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});
app.use(express.json());

// Initialize database
const dbPath = process.env.DB_PATH || path.join(__dirname, '../whitelabel.db');
const db = new Database(dbPath);

// Serve static files
app.use(express.static(path.join(__dirname, '../web/static')));

// Initialize tables
function initDatabase() {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS whitelabel_configs (
                guild_id TEXT PRIMARY KEY,
                solana_channel_id TEXT,
                bsc_channel_id TEXT,
                license_key TEXT NOT NULL,
                bot_name TEXT,
                custom_embed_title TEXT,
                custom_footer TEXT,
                is_active INTEGER DEFAULT 1,
                activated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seen_tokens (
                token_address TEXT PRIMARY KEY,
                chain TEXT NOT NULL,
                added_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cto_watchlist (
                token_address TEXT PRIMARY KEY,
                chain TEXT NOT NULL,
                symbol TEXT NOT NULL,
                detected_at INTEGER NOT NULL,
                initial_smart_money INTEGER NOT NULL,
                initial_renowned INTEGER NOT NULL,
                last_alerted_smart_money INTEGER NOT NULL,
                last_alerted_renowned INTEGER NOT NULL,
                golden_phoenix_alerted INTEGER DEFAULT 0,
                is_migrated INTEGER DEFAULT 0
            );
        `);
    } catch (error) {
        console.error('[Web Server DB] Error initializing tables:', error);
    }
}

initDatabase();

// API Routes

// GET /api/health - Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// GET /api/tokens - Get all seen tokens with basic info
    app.get('/api/tokens', (req, res) => {
        try {
            const rows = db.prepare(`
                SELECT 
                    st.token_address,
                    st.chain,
                    st.added_at,
                    ctw.symbol,
                    ctw.detected_at,
                    ctw.initial_smart_money,
                    ctw.initial_renowned,
                    ctw.golden_phoenix_alerted,
                    ctw.is_migrated
                FROM seen_tokens st
                LEFT JOIN cto_watchlist ctw ON st.token_address = ctw.token_address
                ORDER BY st.added_at DESC
                LIMIT 100
            `).all();
            
            // Add computed alert reason for each token
            const enriched = (rows as any[]).map((token: any) => {
                const reasons: string[] = [];
                const smartMoney = token.initial_smart_money || 0;
                const kol = token.initial_renowned || 0;
                const isMigrated = token.is_migrated === 1;
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
                if (isMigrated) {
                    reasons.push('Migrated to DEX - Community takeover complete');
                } else if (token.detected_at) {
                    reasons.push('Bonding curve phase - Pre-migration');
                }
                if (reasons.length === 0) {
                    reasons.push('Token scanned');
                }
                
                return { ...token, alert_reason: reasons };
            });
            
            res.json(enriched);
        } catch (error) {
            console.error('[Web Server] Error fetching tokens:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

// GET /api/whitelabel - Get all active white-label configs
app.get('/api/whitelabel', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT 
                guild_id,
                solana_channel_id,
                bsc_channel_id,
                bot_name,
                custom_embed_title,
                custom_footer,
                activated_at
            FROM whitelabel_configs
            WHERE is_active = 1
        `).all();
        
        res.json(rows);
    } catch (error) {
        console.error('[Web Server] Error fetching white-label configs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/watchlist - Get all watchlist tokens
    app.get('/api/watchlist', (req, res) => {
        try {
            const rows = db.prepare(`
                SELECT 
                    token_address,
                    chain,
                    symbol,
                    detected_at,
                    initial_smart_money,
                    initial_renowned,
                    last_alerted_smart_money,
                    last_alerted_renowned,
                    golden_phoenix_alerted,
                    is_migrated
                FROM cto_watchlist
                ORDER BY detected_at DESC
                LIMIT 200
            `).all();
            
            // Add computed alert reason for each token
            const enriched = (rows as any[]).map((token: any) => {
                const reasons: string[] = [];
                const smartMoney = token.initial_smart_money || 0;
                const kol = token.initial_renowned || 0;
                const isMigrated = token.is_migrated === 1;
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
                if (isMigrated) {
                    reasons.push('Migrated to DEX - Community takeover complete');
                } else {
                    reasons.push('Bonding curve phase - Pre-migration');
                }
                if (reasons.length === 0) {
                    reasons.push('CTO flag - Dev exited, community taking over');
                }
                
                return { ...token, alert_reason: reasons };
            });
            
            res.json(enriched);
        } catch (error) {
            console.error('[Web Server] Error fetching watchlist:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    
    // GET /api/watchlist/:tokenAddress - Get specific watchlist token with full details
    app.get('/api/watchlist/:tokenAddress', (req, res) => {
        try {
            const { tokenAddress } = req.params;
            const row = db.prepare(`
                SELECT 
                    token_address,
                    chain,
                    symbol,
                    detected_at,
                    initial_smart_money,
                    initial_renowned,
                    last_alerted_smart_money,
                    last_alerted_renowned,
                    golden_phoenix_alerted,
                    is_migrated
                FROM cto_watchlist
                WHERE token_address = ?
            `).get(tokenAddress) as any;
            
            if (!row) {
                return res.status(404).json({ error: 'Token not found in watchlist' });
            }
            
            // Compute alert reason
            const reasons: string[] = [];
            const smartMoney = row.initial_smart_money || 0;
            const kol = row.initial_renowned || 0;
            const isMigrated = row.is_migrated === 1;
            const golden = row.golden_phoenix_alerted === 1;
            
            if (golden) {
                reasons.push('🔥 Golden Phoenix Alert - High-yield DLMM pool detected');
            }
            if (smartMoney >= 10) {
                reasons.push(`🧠 High Conviction Signal: ${smartMoney} Smart Money wallets detected`);
            } else if (smartMoney >= 5) {
                reasons.push(`📊 Smart Money Activity: ${smartMoney} smart degen wallets`);
            } else if (smartMoney > 0) {
                reasons.push(`👁️ Minor Smart Money: ${smartMoney} wallet(s) detected`);
            }
            if (kol >= 5) {
                reasons.push(`🚀 KOL Endorsement: ${kol} renowned wallets holding`);
            } else if (kol >= 1) {
                reasons.push(`🌟 KOL Interest: ${kol} renowned wallet(s) detected`);
            }
            if (isMigrated) {
                reasons.push('✅ Token migrated to DEX - Community takeover complete');
            } else {
                reasons.push('⏳ Bonding curve phase - Pre-migration opportunity');
            }
            if (reasons.length === 0) {
                reasons.push('🚩 CTO flag detected - Dev exited, community taking over');
            }
            
            res.json({ ...row, alert_reason: reasons });
        } catch (error) {
            console.error('[Web Server] Error fetching watchlist token:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

// GET /api/stats - Get dashboard statistics
app.get('/api/stats', (req, res) => {
    try {
        const totalTokens = db.prepare('SELECT COUNT(*) as count FROM seen_tokens').get() as any;
        const totalWatchlist = db.prepare('SELECT COUNT(*) as count FROM cto_watchlist').get() as any;
        const activeWhiteLabel = db.prepare('SELECT COUNT(*) as count FROM whitelabel_configs WHERE is_active = 1').get() as any;
        
        const recentTokens = db.prepare(`
            SELECT COUNT(*) as count
            FROM seen_tokens
            WHERE added_at >= ?
        `).get(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)) as any;
        
        const recentAlerts = db.prepare(`
            SELECT COUNT(*) as count
            FROM cto_watchlist
            WHERE detected_at >= ?
        `).get(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)) as any;
        
        const stats = {
            totalTokens: totalTokens.count,
            totalWatchlist: totalWatchlist.count,
            activeWhiteLabel: activeWhiteLabel.count,
            recentTokens: recentTokens.count,
            recentAlerts: recentAlerts.count
        };
        
        res.json(stats);
    } catch (error) {
        console.error('[Web Server] Error fetching stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/tokens - Add a token to seen_tokens
app.post('/api/tokens', (req, res) => {
    try {
        const { tokenAddress, chain } = req.body;
        
        if (!tokenAddress || !chain) {
            return res.status(400).json({ error: 'tokenAddress and chain are required' });
        }
        
        db.prepare('INSERT OR IGNORE INTO seen_tokens (token_address, chain, added_at) VALUES (?, ?, ?)')
            .run(tokenAddress, chain, Math.floor(Date.now() / 1000));
        
        res.json({ success: true, tokenAddress, chain });
    } catch (error) {
        console.error('[Web Server] Error adding token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/watchlist/:tokenAddress - Update watchlist token
app.put('/api/watchlist/:tokenAddress', (req, res) => {
    try {
        const { tokenAddress } = req.params;
        const { lastAlertedSmartMoney, lastAlertedRenowned } = req.body;
        
        db.prepare(`
            UPDATE cto_watchlist
            SET last_alerted_smart_money = ?, last_alerted_renowned = ?
            WHERE token_address = ?
        `).run(lastAlertedSmartMoney, lastAlertedRenowned, tokenAddress);
        
        res.json({ success: true, tokenAddress });
    } catch (error) {
        console.error('[Web Server] Error updating watchlist token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[Web Server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler - serve SPA index.html for client-side routing
app.use('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Endpoint not found' });
    } else {
        res.sendFile(path.join(__dirname, '../web/static/index.html'));
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`[Web Server] Server running on port ${PORT}`);
});
