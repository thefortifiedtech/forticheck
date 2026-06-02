# ⚙️ FortiCheck White-Label Commands Guide

This document outlines the commands available to server administrators for registering, activating, and customizing the bot's branding (name, embed titles, footer) on their Discord servers.

---

## 🔒 Permission Requirements
To prevent abuse, all white-label commands are restricted.
* **Who can run them**: Only server **Administrators** or the **Server Owner**.
* **Error response**: If an unauthorized user attempts to run any configuration command, the bot will reply:  
  `❌ Only administrators can configure the white label settings for this bot.`

---

## 🚀 Setup & Registration

The bot supports dual-chain alerting (Solana and BSC). Servers must register their alert channels using a valid Whop license key.

### 1. Register Solana Alerts
Run this command in the channel where you want the **Solana** signals to be broadcast:
```discord
!register <license_key>
```
* **What it does**: Validates the license key via Whop. If valid, binds that channel to Solana alerts, saves the configuration, and unlocks customization commands.

### 2. Register BSC Alerts
Run this command in the channel where you want the **BSC** signals to be broadcast:
```discord
!registerbsc <license_key>
```
* **What it does**: Binds that channel to BSC alerts and saves the configuration.

> [!NOTE]
> * You can register both chains in the same channel or in separate channels.
> * If the license key starts with `TEST-` or the `WHOP_API_KEY` is not configured in the bot's `.env`, the validation step is bypassed automatically.

---

## 🎨 Customization Commands

Once a server is registered, administrators can run the following commands in the server to customize the bot's appearance:

| Command | Syntax | Description | Default Behavior |
| :--- | :--- | :--- | :--- |
| **Set Bot Name** | `!setname <bot_name>` | Updates the bot's nickname *only* within this Discord server. | Default bot username |
| **Set Custom Title** | `!settitle <prefix>` | Replaces the alert embed title prefixes (e.g. `💎 PHOENIX:`) with your custom prefix. | Default prefixes |
| **Set Custom Footer** | `!setfooter <text>` | Overrides the footer text at the bottom of the alert embeds. | `Phoenix Scanner Auto-Signal` |
| **View Configuration** | `!status` | Returns a diagnostic embed detailing the active settings for the server. | N/A |

### Command Examples & Details

#### `!setname <bot_name>`
Sets the bot's nickname in the current server. 
* **Example**: `!setname FortiAlerts`
* **Behind the Scenes**: Updates the database and immediately sets the server nickname. On bot restarts, nicknames are automatically re-synced.
* *Note: The bot must have the "Change Nickname" permission in your server.*

#### `!settitle <prefix>`
Replaces default alert title prefixes with your custom brand name.
* **Example**: `!settitle 🪐 MY BRAND`
* **Effect**: Converts a title like `💎 PHOENIX: Community Takeover` into `🪐 MY BRAND Community Takeover`.
* **Clearing**: Run `!settitle` (with no arguments) to revert to the default prefixes.

#### `!setfooter <text>`
Changes the footer text at the bottom of alert embeds.
* **Example**: `!setfooter Powered by MyCommunity`
* **Clearing**: Run `!setfooter` (with no arguments) to revert to the default footer.

#### `!status`
Displays a summary of the current settings. 
* **Example**: `!status`
* **Output**:
  ```yaml
  Status: 🟢 Active
  License Key: `TEST-LICE...1234`
  Solana Alerts Channel: #solana-alerts
  BSC Alerts Channel: #bsc-alerts
  Custom Name: FortiAlerts
  Custom Title Prefix: 🪐 MY BRAND
  Custom Footer: Powered by MyCommunity
  ```
