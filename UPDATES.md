# isiam store — Update Notes (v2.1)

## ✅ What you asked for

### Buyers can now reliably multi-select camos AND guns
Multi-select existed in the menus, but two bugs broke it in practice — both are fixed:

1. **"Guns missing" after bot restart** — selected guns were matched by comparing emoji
   objects by reference (`g.emoji === gun.emoji`), which always fails after the bot
   reloads data.json. Buyers clicking Confirm got an error.
2. **Crash when selecting many items** — the old code packed every selected index into
   the button's customId. Discord limits customIds to 100 characters, so selecting many
   camos/guns caused "Invalid Form Body" and the confirm button never appeared.

**Fix:** selections are now stored server-side for 30 minutes and the confirm button
carries only a short key (`bstgc_<id>` / `camocc_<id>`). Old product posts made before
the update still work (legacy handlers kept). Tested: selecting all 25 camos at once
works, total price is calculated correctly, and double-clicking Confirm can't create a
duplicate ticket.

## 🔒 Critical security fix
`app.use(express.static(__dirname))` served **your entire folder publicly** — anyone who
opened `https://your-app.up.railway.app/data.json` could download all customer emails,
passwords, codes, and sales. `bot.js` source was public too. Now only `logo.png`,
`favicon.ico`, `panel.html` and `/images/*` are served; everything else requires login.

## 🐛 Other bugs fixed
- **Public post overwritten**: for gun services with a single category, clicking
  "Order Boost" replaced the public product post for everyone. Now always ephemeral.
- **Panel showed success on errors**: the panel treated 400/500 responses as success
  (e.g. "Payment approved!" when it actually failed). Now real errors show.
- **Out-of-stock deliveries**: approving a payment for an empty pool/digital product
  delivered empty credentials/codes. Now the panel blocks it with a clear message.
- **Wrong ticket completed**: "Complete Boost/Camo" completed the *first* in-progress
  ticket for a service — wrong with multiple buyers. New per-ticket endpoint
  (`POST /api/tickets/:id/complete`) completes exactly the ticket you clicked.
- **Broken Discord links in panel**: ticket "Open" buttons linked to `@me/...` which
  doesn't work for server channels. Tickets now store the guild ID and link correctly.
- **60-second autosave**: the comment existed but the code didn't. Added.
- **Broken HTML nesting** in the Settings page (stray `</div>`).
- **Misleading gun pricing text** in the boosting form (said "99 levels × $13 = $13").
- Custom emoji strings (`<:name:id>`) in camo slots are now normalized properly.
- Completing a boost/camo now also marks the order **Delivered** so revenue stats count it.
- `.env` file support added (no dependency) — you can run locally with a `.env` file.

## ✨ New features
- **Enhanced admin panel:**
  - **Setup Checklist** on the dashboard — shows exactly what's still missing
    (bot online, channels, owner ID, payment methods) with where to fix it.
  - **Quick Actions** row on the dashboard.
  - **Dynamic camo slots** — up to 25 camos (was 6), each with emoji + price, plus
    one-click "Load BO7 Mastery/Base Camos" presets, add/remove rows.
  - **Dynamic boosting slots** — up to 10 (was 5), add/remove rows.
  - **Receipt previews** — payment requests show the receipt image inline.
  - **Per-ticket Complete buttons** (safe with multiple buyers).
  - **Export Orders to CSV** (Excel-compatible, Arabic-safe).
- **Buyer Guide** — one click posts a beautiful bilingual "How to Buy" embed
  (steps, payment methods, your terms) to any channel. Find it in Dashboard →
  Quick Actions or Settings → Buyer Guide.

## 🧪 Testing
`test/run-tests.js` runs the real bot against offline mocks that enforce real Discord
limits and simulates full buyer flows (multi-select guns, multi-select camos, coupons,
receipt upload, approve, credentials modal, complete). **58/58 checks pass.**
Note: the test sandbox had no access to npmjs.org or discord.com, so the live Discord
login must be verified on your host (Railway) — run `npm install` then deploy as usual.
The `test/` folder is optional and not needed in production.

## ⚠️ IMPORTANT — do this now
Your Discord bot token and panel password were shared in plain text (including in this
chat). Treat them as compromised:
1. Go to https://discord.com/developers/applications → your app → **Bot → Reset Token**.
2. Put the NEW token in Railway → Variables → `DISCORD_TOKEN` (never in code or chat).
3. Consider changing `PANEL_PASSWORD` too.
