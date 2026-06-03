import { Client, TextChannel, Message, PermissionFlagsBits } from 'discord.js';
import Database from 'better-sqlite3';
import path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '../whitelabel.db');
const db = new Database(dbPath);

// Initialize tables
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

// Run migration to add is_migrated if table already exists
try {
    db.exec(`ALTER TABLE cto_watchlist ADD COLUMN is_migrated INTEGER DEFAULT 0;`);
    console.log("[Whitelabel DB] Added is_migrated column to cto_watchlist");
} catch (e: any) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('already exists')) {
        console.error("[Whitelabel DB] Error updating schema:", e);
    }
}

export interface WhiteLabelConfig {
    guildId: string;
    solanaChannelId: string | null;
    bscChannelId: string | null;
    licenseKey: string;
    botName: string | null;
    customEmbedTitle: string | null;
    customFooter: string | null;
    isActive: boolean;
    activatedAt: number;
}

export function getWhiteLabelConfig(guildId: string): WhiteLabelConfig | null {
    try {
        const row = db.prepare('SELECT * FROM whitelabel_configs WHERE guild_id = ?').get(guildId) as any;
        if (!row) return null;
        return {
            guildId: row.guild_id,
            solanaChannelId: row.solana_channel_id,
            bscChannelId: row.bsc_channel_id,
            licenseKey: row.license_key,
            botName: row.bot_name,
            customEmbedTitle: row.custom_embed_title,
            customFooter: row.custom_footer,
            isActive: row.is_active === 1,
            activatedAt: row.activated_at
        };
    } catch (error) {
        console.error(`[Whitelabel DB] Error fetching config for guild ${guildId}:`, error);
        return null;
    }
}

export function saveWhiteLabelConfig(config: WhiteLabelConfig): void {
    try {
        const stmt = db.prepare(`
            INSERT INTO whitelabel_configs (
                guild_id, solana_channel_id, bsc_channel_id, license_key, bot_name, custom_embed_title, custom_footer, is_active, activated_at
            ) VALUES (
                @guildId, @solanaChannelId, @bscChannelId, @licenseKey, @botName, @customEmbedTitle, @customFooter, @isActive, @activatedAt
            )
            ON CONFLICT(guild_id) DO UPDATE SET
                solana_channel_id = excluded.solana_channel_id,
                bsc_channel_id = excluded.bsc_channel_id,
                license_key = excluded.license_key,
                bot_name = excluded.bot_name,
                custom_embed_title = excluded.custom_embed_title,
                custom_footer = excluded.custom_footer,
                is_active = excluded.is_active,
                activated_at = excluded.activated_at
        `);
        
        stmt.run({
            guildId: config.guildId,
            solanaChannelId: config.solanaChannelId,
            bscChannelId: config.bscChannelId,
            licenseKey: config.licenseKey,
            botName: config.botName,
            customEmbedTitle: config.customEmbedTitle,
            customFooter: config.customFooter,
            isActive: config.isActive ? 1 : 0,
            activatedAt: config.activatedAt
        });
    } catch (error) {
        console.error(`[Whitelabel DB] Error saving config for guild ${config.guildId}:`, error);
    }
}

export function getAllWhiteLabelConfigs(): WhiteLabelConfig[] {
    try {
        const rows = db.prepare('SELECT * FROM whitelabel_configs WHERE is_active = 1').all() as any[];
        return rows.map(row => ({
            guildId: row.guild_id,
            solanaChannelId: row.solana_channel_id,
            bscChannelId: row.bsc_channel_id,
            licenseKey: row.license_key,
            botName: row.bot_name,
            customEmbedTitle: row.custom_embed_title,
            customFooter: row.custom_footer,
            isActive: row.is_active === 1,
            activatedAt: row.activated_at
        }));
    } catch (error) {
        console.error(`[Whitelabel DB] Error fetching all active configs:`, error);
        return [];
    }
}

export async function validateWhopLicense(licenseKey: string, guildId: string, channelId: string): Promise<boolean> {
    if (licenseKey.startsWith('TEST-')) {
        console.log(`[Whop] Test license key detected: ${licenseKey}. Bypassing API call.`);
        return true;
    }
    const whopApiKey = process.env.WHOP_API_KEY;
    if (!whopApiKey) {
        console.warn(`[Whop] WHOP_API_KEY is not set in .env. Treating all keys as valid for development.`);
        return true;
    }

    try {
        const url = `https://api.whop.com/api/v2/memberships/${licenseKey}/validate_license`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${whopApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                metadata: {
                    guildId,
                    channelId
                }
            })
        });

        if (response.ok) {
            console.log(`[Whop] License key ${licenseKey} validated successfully.`);
            return true;
        } else {
            const errorText = await response.text();
            console.error(`[Whop] Validation failed for license key ${licenseKey}. Status: ${response.status}. Error: ${errorText}`);
            return false;
        }
    } catch (error) {
        console.error(`[Whop] Error calling Whop API:`, error);
        return false;
    }
}

export async function syncNicknamesOnStartup(client: Client) {
    console.log(`[Whitelabel] Syncing nicknames on startup...`);
    const configs = getAllWhiteLabelConfigs();
    for (const config of configs) {
        if (config.botName) {
            try {
                const guild = await client.guilds.fetch(config.guildId);
                if (guild) {
                    const me = await guild.members.fetchMe();
                    if (me && me.nickname !== config.botName) {
                        await me.setNickname(config.botName);
                        console.log(`[Whitelabel] Synced nickname to "${config.botName}" in guild ${guild.name} (${guild.id})`);
                    }
                }
            } catch (e: any) {
                console.error(`[Whitelabel] Failed to sync nickname in guild ${config.guildId}:`, e.message);
            }
        }
    }
}

export function customizeEmbedForGuild(embed: any, guildId: string | null): any {
    if (!guildId) return embed;
    const config = getWhiteLabelConfig(guildId);
    if (!config) return embed;

    // Clone the embed to avoid modifying the original referenced object
    const customized = { ...embed };

    if (config.customEmbedTitle && customized.title) {
        // Replace base title prefixes with custom title prefix
        customized.title = customized.title.replace(/^(💎 PHOENIX:|🟢 \[FULL ALERT\]|🟡 \[PRE-ALERT\]|💎 BSC PHOENIX:|🟢 \[BSC FULL ALERT\]|🟡 \[BSC PRE-ALERT\]|💎 \[PRE-ALERT\]|💎 \[BSC PRE-ALERT\])/, config.customEmbedTitle);
    }
    if (config.customFooter) {
        customized.footer = { text: config.customFooter };
    }
    return customized;
}

export async function handleWhiteLabelCommands(message: Message, isBsc: boolean): Promise<boolean> {
    if (message.author.bot || !message.guild) return false;

    const content = message.content.trim();
    if (!content.startsWith('!ps-')) return false;

    const args = content.slice(4).split(/\s+/);
    const command = args[0].toLowerCase();
    const commandArg = args.slice(1).join(' ').trim();

    const allowedCommands = ['register', 'registerbsc', 'setname', 'settitle', 'setfooter', 'status'];
    if (!allowedCommands.includes(command)) return false;

    // Route commands to prevent duplicate processing by solana-bot and bsc-bot:
    // - bsc-bot (isBsc === true) only handles 'registerbsc'
    // - solana-bot (isBsc === false) handles 'register', 'setname', 'settitle', 'setfooter', and 'status'
    const isTargetBscCommand = command === 'registerbsc';
    if (isTargetBscCommand !== isBsc) {
        return true; // Intercepted, but ignored by this bot instance to prevent double execution/replies
    }

    // Check permissions: only administrators or guild owners should be allowed to customize the bot
    const member = message.member;
    if (!member || (!member.permissions.has(PermissionFlagsBits.Administrator) && message.guild.ownerId !== member.id)) {
        await message.reply("❌ Only administrators can configure the white label settings for this bot.");
        return true;
    }

    try {
        if (command === 'register' || command === 'registerbsc') {
            if (!commandArg) {
                await message.reply(`❌ Please provide a license key. Usage: \`!ps-${command} <license_key>\``);
                return true;
            }

            const statusMessage = await message.reply("⏳ Validating license key with Whop...");
            const isValid = await validateWhopLicense(commandArg, message.guild.id, message.channel.id);
            if (!isValid) {
                await statusMessage.edit("❌ Invalid license key. Please purchase a license from Whop or double-check your key.");
                return true;
            }

            const currentConfig = getWhiteLabelConfig(message.guild.id);
            const config: WhiteLabelConfig = currentConfig || {
                guildId: message.guild.id,
                solanaChannelId: null,
                bscChannelId: null,
                licenseKey: commandArg,
                botName: null,
                customEmbedTitle: null,
                customFooter: null,
                isActive: true,
                activatedAt: Math.floor(Date.now() / 1000)
            };

            config.licenseKey = commandArg;
            config.isActive = true;
            config.activatedAt = Math.floor(Date.now() / 1000);

            const isRegisteringBsc = command === 'registerbsc';
            if (isRegisteringBsc) {
                config.bscChannelId = message.channel.id;
            } else {
                config.solanaChannelId = message.channel.id;
            }

            saveWhiteLabelConfig(config);

            const channelType = isRegisteringBsc ? 'BSC Alerts' : 'Solana Alerts';
            await statusMessage.edit(`✅ Bot successfully registered for **${channelType}**! \n` +
                `• License: \`${commandArg.slice(0, 8)}...${commandArg.slice(-4)}\`\n` +
                `• Alert Channel: <#${message.channel.id}>\n\n` +
                `You can now customize the bot with these commands:\n` +
                `• \`!ps-setname <bot_name>\` - Set bot nickname in this server\n` +
                `• \`!ps-settitle <prefix>\` - Set custom alert title prefix\n` +
                `• \`!ps-setfooter <text>\` - Set custom alert footer text\n` +
                `• \`!ps-status\` - View current configuration`);
            return true;
        }

        if (command === 'setname') {
            const config = getWhiteLabelConfig(message.guild.id);
            if (!config || !config.isActive) {
                await message.reply("❌ This server is not registered. Please register first using `!ps-register <license_key>`.");
                return true;
            }
            if (!commandArg) {
                await message.reply("❌ Please specify a name. Usage: `!ps-setname <bot_name>`.");
                return true;
            }
            config.botName = commandArg;
            saveWhiteLabelConfig(config);

            try {
                const me = await message.guild.members.fetchMe();
                await me.setNickname(commandArg);
                await message.reply(`✅ Bot nickname updated to **${commandArg}** in this server!`);
            } catch (e: any) {
                console.error(`Failed to set nickname in guild ${message.guild.id}:`, e);
                await message.reply(`✅ Saved name **${commandArg}** to database, but failed to update nickname. Please ensure the bot has "Change Nickname" permission and is not higher in the role hierarchy than the administrator.`);
            }
            return true;
        }

        if (command === 'settitle') {
            const config = getWhiteLabelConfig(message.guild.id);
            if (!config || !config.isActive) {
                await message.reply("❌ This server is not registered. Please register first using `!ps-register <license_key>`.");
                return true;
            }
            config.customEmbedTitle = commandArg || null;
            saveWhiteLabelConfig(config);
            
            if (commandArg) {
                await message.reply(`✅ Custom alert title prefix set to: **${commandArg}**`);
            } else {
                await message.reply(`✅ Custom alert title prefix cleared. Using default.`);
            }
            return true;
        }

        if (command === 'setfooter') {
            const config = getWhiteLabelConfig(message.guild.id);
            if (!config || !config.isActive) {
                await message.reply("❌ This server is not registered. Please register first using `!ps-register <license_key>`.");
                return true;
            }
            config.customFooter = commandArg || null;
            saveWhiteLabelConfig(config);
            
            if (commandArg) {
                await message.reply(`✅ Custom alert footer set to: **${commandArg}**`);
            } else {
                await message.reply(`✅ Custom alert footer cleared. Using default.`);
            }
            return true;
        }

        if (command === 'status') {
            const config = getWhiteLabelConfig(message.guild.id);
            if (!config) {
                await message.reply("❌ This server is not registered. Please register first using `!ps-register <license_key>`.");
                return true;
            }
            const maskedKey = config.licenseKey ? `${config.licenseKey.slice(0, 8)}...${config.licenseKey.slice(-4)}` : 'None';
            const statusEmbed = {
                color: 0x00FF00,
                title: "⚙️ White Label Configuration Status",
                fields: [
                    { name: "Status", value: config.isActive ? "🟢 Active" : "🔴 Inactive", inline: true },
                    { name: "License Key", value: `\`${maskedKey}\``, inline: true },
                    { name: "Solana Alerts Channel", value: config.solanaChannelId ? `<#${config.solanaChannelId}>` : "Not Registered", inline: false },
                    { name: "BSC Alerts Channel", value: config.bscChannelId ? `<#${config.bscChannelId}>` : "Not Registered", inline: false },
                    { name: "Custom Name", value: config.botName || "*Default*", inline: true },
                    { name: "Custom Title Prefix", value: config.customEmbedTitle || "*Default*", inline: true },
                    { name: "Custom Footer", value: config.customFooter || "*Default*", inline: false }
                ],
                timestamp: new Date().toISOString()
            };
            await message.reply({ embeds: [statusEmbed] });
            return true;
        }
    } catch (err: any) {
        console.error(`[Whitelabel Command] Error executing ${command}:`, err);
        await message.reply(`❌ An error occurred while executing that command: ${err.message}`);
        return true;
    }

    return false;
}

export async function broadcastSolanaAlert(client: Client, baseEmbed: any, symbol: string, tokenAddress: string) {
    const defaultChannelId = process.env.DISCORD_CHANNEL_ID;
    
    // 1. Get all registered white-label channel IDs for Solana
    const configs = getAllWhiteLabelConfigs();
    const wlSolanaChannelIds = new Set<string>();
    for (const config of configs) {
        if (config.isActive && config.solanaChannelId) {
            wlSolanaChannelIds.add(config.solanaChannelId);
        }
    }

    // 2. Send to default production channel ONLY if it's NOT registered as a white-label channel
    if (defaultChannelId && !wlSolanaChannelIds.has(defaultChannelId)) {
        try {
            const channel = await client.channels.fetch(defaultChannelId) as TextChannel;
            if (channel) {
                await channel.send({ content: `**PHOENIX DETECTED: ${symbol}**`, embeds: [baseEmbed] });
            }
        } catch (e: any) {
            console.error(`[Whitelabel] Failed to send Solana alert to default production channel:`, e.message);
        }
    }

    // 3. Send to all active white-label channels
    for (const config of configs) {
        if (config.isActive && config.solanaChannelId) {
            try {
                const channel = await client.channels.fetch(config.solanaChannelId) as TextChannel;
                if (channel) {
                    const customizedEmbed = customizeEmbedForGuild(baseEmbed, config.guildId);
                    await channel.send({ content: `**PHOENIX DETECTED: ${symbol}**`, embeds: [customizedEmbed] });
                }
            } catch (e: any) {
                console.error(`[Whitelabel] Failed to send Solana alert to white-label channel ${config.solanaChannelId} in guild ${config.guildId}:`, e.message);
            }
        }
    }
}

export async function broadcastBscAlert(client: Client, baseEmbed: any, symbol: string, tokenAddress: string) {
    const defaultChannelId = process.env.BSC_DISCORD_CHANNEL_ID;
    
    // 1. Get all registered white-label channel IDs for BSC
    const configs = getAllWhiteLabelConfigs();
    const wlBscChannelIds = new Set<string>();
    for (const config of configs) {
        if (config.isActive && config.bscChannelId) {
            wlBscChannelIds.add(config.bscChannelId);
        }
    }

    // 2. Send to default production channel ONLY if it's NOT registered as a white-label channel
    if (defaultChannelId && !wlBscChannelIds.has(defaultChannelId)) {
        try {
            const channel = await client.channels.fetch(defaultChannelId) as TextChannel;
            if (channel) {
                await channel.send({ content: `**BSC PHOENIX DETECTED: ${symbol}**`, embeds: [baseEmbed] });
            }
        } catch (e: any) {
            console.error(`[Whitelabel] Failed to send BSC alert to default production channel:`, e.message);
        }
    }

    // 3. Send to all active white-label channels
    for (const config of configs) {
        if (config.isActive && config.bscChannelId) {
            try {
                const channel = await client.channels.fetch(config.bscChannelId) as TextChannel;
                if (channel) {
                    const customizedEmbed = customizeEmbedForGuild(baseEmbed, config.guildId);
                    await channel.send({ content: `**BSC PHOENIX DETECTED: ${symbol}**`, embeds: [customizedEmbed] });
                }
            } catch (e: any) {
                console.error(`[Whitelabel] Failed to send BSC alert to white-label channel ${config.bscChannelId} in guild ${config.guildId}:`, e.message);
            }
        }
    }
}

export function hasSeenToken(tokenAddress: string, chain: string): boolean {
    try {
        const row = db.prepare('SELECT 1 FROM seen_tokens WHERE token_address = ? AND chain = ?').get(tokenAddress, chain);
        return !!row;
    } catch (error) {
        console.error(`[Whitelabel DB] Error checking seen token ${tokenAddress}:`, error);
        return false;
    }
}

export function addSeenToken(tokenAddress: string, chain: string): void {
    try {
        db.prepare('INSERT OR IGNORE INTO seen_tokens (token_address, chain, added_at) VALUES (?, ?, ?)')
          .run(tokenAddress, chain, Math.floor(Date.now() / 1000));
    } catch (error) {
        console.error(`[Whitelabel DB] Error adding seen token ${tokenAddress}:`, error);
    }
}

export function pruneSeenTokens(chain: string, maxAgeSeconds: number): void {
    try {
        const threshold = Math.floor(Date.now() / 1000) - maxAgeSeconds;
        db.prepare('DELETE FROM seen_tokens WHERE chain = ? AND added_at < ?').run(chain, threshold);
    } catch (error) {
        console.error(`[Whitelabel DB] Error pruning seen tokens for ${chain}:`, error);
    }
}

export function addTokenToWatchlist(
    tokenAddress: string,
    symbol: string,
    chain: string,
    smartDegenCount: number,
    renownedCount: number,
    isMigrated: number = 0
): void {
    try {
        const now = Math.floor(Date.now() / 1000);
        db.prepare(`
            INSERT OR IGNORE INTO cto_watchlist (
                token_address, chain, symbol, detected_at, initial_smart_money, initial_renowned,
                last_alerted_smart_money, last_alerted_renowned, golden_phoenix_alerted, is_migrated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).run(tokenAddress, chain, symbol, now, smartDegenCount, renownedCount, smartDegenCount, renownedCount, isMigrated);
    } catch (error) {
        console.error(`[Whitelabel DB] Error adding token to watchlist ${tokenAddress}:`, error);
    }
}

export function isSignalMigrated(event: any): boolean {
    if (event._stage === 'NEW_CREATION') return false;
    if (event.exchange === 'pump' && (event.progress !== undefined && event.progress < 1)) return false;
    if (event.migrated_pool_exchange || event.pool_type_str) return true;
    if (event.launchpad === '' || event.launchpad === undefined) return true;
    return true;
}

