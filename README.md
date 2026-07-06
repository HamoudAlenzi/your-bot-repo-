# 🛒 Acc Store Bot — Premium Edition

A Discord store bot with a full web control panel. Post products with multiple images, let customers buy through a **private ticket** channel, approve their payment receipt, and the bot **auto-delivers the account credentials and closes the ticket** — all controlled from a beautiful web dashboard.

## ✨ Features

### Core Flow
1. **Post a product** (with multiple images) → Bot posts an embed to your Discord channel with **Buy** / **Details** buttons
2. Customer clicks **Buy** → selects payment method (STC Pay / Al Rajhi / PayPal / Crypto)
3. Bot creates a **private ticket channel** between customer and admin
4. Customer uploads receipt screenshot in the ticket
5. Bot posts an admin review panel with **Approve** / **Reject** / **Close** buttons
6. Admin clicks **Approve** → Bot delivers account credentials in the ticket AND via DM, then **auto-closes the ticket** after a configurable delay (default 10s)

### Multi-Image Upload
- Upload 1–4 screenshots per product from the panel
- All images are embedded in the **same Discord message** as attachments (not separate messages)
- First image becomes the main `setImage`, the rest appear as additional embeds
- Images are persisted to `/uploads/` and re-attached when posting

### Control Panel (panel.html)
- **Dashboard** — live stats (products, available stock, open tickets, revenue), recent activity log, quick actions
- **Products** — grid view, add/edit/delete, multi-image upload with preview, filter by game/status, search
- **Bulk Import** — paste `email:password` lines to mass-create accounts
- **Tickets** — list of open/closed tickets, view customer info, send messages to ticket from panel, force-close
- **Payments** — review pending payment requests, approve/reject from panel
- **Orders** — full order history with delivered credentials
- **Customers** — auto-tracked after first purchase, blacklist/unblacklist
- **Pools** — group similar accounts
- **Settings** — configure everything: Discord channels, ticket category, admin role/IDs, payment methods, auto-close delay
- **Logs** — live system log

### Persistent Storage
- All data is saved to `store.json` (auto-saved on every change, throttled)
- Uploaded images saved to `uploads/` directory

## 🚀 Setup

### 1. Create your Discord bot
1. Go to https://discord.com/developers/applications → New Application
2. **Bot** tab → Reset Token → copy the token
3. Enable **MESSAGE CONTENT INTENT**, **SERVER MEMBERS INTENT**, **GUILD MESSAGE INTENTS** (all three Privileged Gateway Intents)
4. **OAuth2** → URL Generator → scopes: `bot` + permissions: `Administrator` → invite the bot to your server

### 2. Configure environment
Create a `.env` file (see `.env.example`):
```env
DISCORD_TOKEN=your_bot_token_here
PORT=3000
```

### 3. Install & run
```bash
npm install
npm start
```
Open http://localhost:3000 in your browser → the control panel loads automatically.

### 4. First-time setup in the panel
1. Open the **Settings** tab → click **Refresh Discord Channels**
2. Set:
   - **Ticket Category** (create a category in Discord first — tickets will be created as channels inside it)
   - **Admin Role** (a role that can see/approve all tickets)
   - **Admin User IDs** (comma-separated Discord user IDs who can approve — right-click yourself in Discord → Copy ID with Developer Mode enabled)
   - **Products Channel** (where products are posted)
   - **Log Channel** (optional)
3. Fill in payment method details (STC Pay number, IBAN, PayPal email, crypto address)
4. Click **Save All Settings**
5. Go to **Products** → **Add Product** → upload images, fill credentials → Save → Bot posts it to Discord

## 📂 File Structure
```
.
├── bot.js            # Discord bot + Express API server
├── panel.html        # Full control panel (served at /)
├── package.json      # Dependencies
├── Procfile          # For Render/Heroku deployment
├── .env.example      # Environment template
├── store.json        # Auto-created — your database
└── uploads/          # Auto-created — product images
```

## ☁️ Deployment (Render.com / Heroku)
1. Push these files to a GitHub repo
2. Create a new Web Service on Render → connect the repo
3. Set env var: `DISCORD_TOKEN=your_token`
4. Build command: `npm install`
5. Start command: `node bot.js` (the Procfile already specifies `web: node bot.js`)
6. Deploy → access panel at your service URL

## 🔒 Permissions & Security
- Only **Admin Role** members and listed **Admin User IDs** can approve/reject payments and close tickets
- Ticket channels are hidden from everyone except the customer and admins
- The panel currently has no auth gate — if you deploy publicly, add basic auth or a token at the Express layer (e.g. behind Cloudflare Access)

## 🎛️ Ticket Lifecycle
```
[Buy clicked] → [Payment method selected] → [Ticket channel created]
   ↓
[Customer uploads receipt in ticket]
   ↓
[Bot posts admin review embed with Approve/Reject/Close buttons]
   ↓
[Admin clicks Approve]
   ↓
[Bot posts account credentials in ticket + DMs customer]
   ↓
[After 10s (configurable) → Bot deletes the ticket channel]
   ↓
[Ticket marked closed in panel; order recorded in Orders tab]
```

## 🛠️ Troubleshooting
- **Bot says "Ticket category not configured"** → Go to Settings → set Ticket Category → Save
- **Images not appearing in Discord post** → Make sure the bot has **Attach Files** and **Embed Links** permissions in the products channel
- **Approve button does nothing** → Make sure your Discord User ID is in `adminIds` (Settings) OR you have the configured Admin Role
- **Panel shows bot as Offline** → `DISCORD_TOKEN` not set or invalid; check the bot console log
- **Channel dropdowns empty in Settings** → Click "Refresh Discord Channels" — the bot must be in the server

## 📜 License
MIT — use it, modify it, sell accounts with it. Just don't blame me if a customer charges back.
