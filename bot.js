// =============================================
// isiam store — Discord Store Bot v2
// Features: Multi-image stacked embeds, private tickets, payment flow,
//           coupons, auto-delivery pools, JSON persistence, panel auth
// Deploy: Railway (set DISCORD_TOKEN + PANEL_PASSWORD env vars)
// =============================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, Partials, StringSelectMenuBuilder, AttachmentBuilder,
  PermissionFlagsBits, ChannelType
} = require('discord.js');

// ===== CONFIG =====
const STORE_NAME = 'isiam store';
const STORE_TAGLINE = 'Premium Accounts Store';
const DATA_FILE = path.join(__dirname, 'data.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin123'; // change via env var!
const COOKIE_NAME = 'isiam_session';
const SESSIONS = new Map(); // sessionId -> expiry timestamp
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

// ===== EXPRESS SERVER =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));
app.use(express.static(__dirname, { index: false }));

// ===== DATA STORE (with JSON persistence) =====
const DEFAULT_STORE = {
  accounts: [],
  orders: [],
  customers: [],
  pools: [],
  coupons: [],
  digitalProducts: [],   // PSN cards, Xbox subs, Netflix, CD keys — instant code delivery
  boostingServices: [],  // CoD/Warzone rank, prestige, gun level boosting — service-based
  camoServices: [],      // CoD/Warzone weapon camo unlock — admin adds camo names, customer picks
  boostSlots: [],        // Customizable boosting slots — admin defines up to 5 options per service
  paymentRequests: [],
  tickets: [],
  logs: [],
  settings: {
    storeName: STORE_NAME,
    currency: '$',
    accountsChannelId: '',
    digitalChannelId: '',     // channel for Digital Products posts (fallback: accountsChannelId)
    boostingChannelId: '',   // channel for Boosting Services posts (fallback: accountsChannelId)
    camoChannelId: '',       // channel for Camo Unlock posts (fallback: accountsChannelId)
    boostSlotChannelId: '',   // channel for Boosting Slots posts (fallback: accountsChannelId)
    ticketCategoryId: '',
    logChannelId: '',
    ownerId: '',
    staffRoleIds: [], // additional roles that can see all tickets
    termsAr: 'الشروط العامة\n━━━━━━━━━━━━━━━\n▪️ يتم تسليم الحساب فور تأكيد الدفع\n▪️ الضمان يبدأ من تاريخ الشراء\n▪️ لا يوجد استرداد بعد تسليم الحساب\n▪️ جميع المبيعات نهائية',
    termsEn: 'General Terms\n━━━━━━━━━━━━━━━\n▪️ Account delivered immediately after payment confirmation\n▪️ Warranty starts from purchase date\n▪️ No refunds after account delivery\n▪️ All sales are final',
    welcomeAr: 'مرحباً بك في متجر isiam! تم فتح تذكرة شراء خاصة لك. اختر طريقة الدفع من القائمة بالأسفل.',
    welcomeEn: 'Welcome to isiam store! A private purchase ticket has been opened. Choose a payment method below.',
    stcPay: { number: '05XXXXXXXX', name: '' },
    alrajhi: { iban: 'SA0000000000000000000', name: '' },
    paypal: { email: 'pay@example.com', name: '' },
    color: 0x9b59ff, // brand purple
    autoCloseSeconds: 15,
    webhookUrl: ''  // External alert webhook (ntfy.sh / IFTTT / Zapier for WhatsApp/Phone alerts)
  },
  nextId: 1
};

let store = loadStore();

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so new fields are added gracefully
      return {
        ...DEFAULT_STORE,
        ...parsed,
        settings: { ...DEFAULT_STORE.settings, ...(parsed.settings || {}) }
      };
    }
  } catch (e) {
    console.error('Failed to load data.json:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STORE));
}

let saveTimer = null;
function saveStore() {
  // Debounced atomic save — write to temp file then rename for crash safety
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('Save failed:', e.message);
    }
  }, 300);
}
// Save on exit
process.on('SIGTERM', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch(e){} process.exit(0); });
process.on('SIGINT', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch(e){} process.exit(0); });

function genId() { const id = store.nextId++; saveStore(); return id; }

function addLog(level, msg) {
  store.logs.unshift({ time: new Date().toISOString(), level, msg });
  if (store.logs.length > 500) store.logs.length = 500;
  saveStore();
}

// Helper: convert base64 data URI to Buffer
function base64ToBuffer(dataUri) {
  const matches = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) return null;
  return { buffer: Buffer.from(matches[2], 'base64'), ext: matches[1] === 'jpeg' ? 'jpg' : matches[1] };
}

function sendLogToDiscord(msg) {
  const chId = store.settings.logChannelId;
  if (chId && client.isReady()) {
    const ch = client.channels.cache.get(chId);
    if (ch) ch.send(msg).catch(() => {});
  }
}

// ===== OWNER ALERT SYSTEM (DM + @here ping + Webhook for WhatsApp/Phone) =====
async function notifyOwner(title, details) {
  const s = store.settings;
  const alertMsg = `🔔 **${title}**\n\n${details}`;

  // 1. DM the owner on Discord
  if (s.ownerId && client.isReady()) {
    try {
      const owner = await client.users.fetch(s.ownerId);
      await owner.send(alertMsg);
    } catch (e) {}
  }

  // 2. @here ping in log channel (triggers Discord mobile push notification)
  if (s.logChannelId && client.isReady()) {
    try {
      const ch = client.channels.cache.get(s.logChannelId);
      if (ch) await ch.send(`@here 🔔 **${title}**\n${details}`);
    } catch (e) {}
  }

  // 3. Send to webhook URL (ntfy.sh / IFTTT / Zapier for WhatsApp/Phone call alerts)
  if (s.webhookUrl) {
    try {
      const http = require('https' === s.webhookUrl.split(':')[0] ? 'https' : 'http');
      const payload = JSON.stringify({ title, details, timestamp: new Date().toISOString() });
      const url = new URL(s.webhookUrl);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || ('https' === url.protocol.replace(':', '') ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, () => {});
      req.on('error', () => {});
      req.write(payload);
      req.end();
    } catch (e) {}
  }
}

// ===== PANEL AUTH MIDDLEWARE =====
function createSession() {
  const sid = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(sid, Date.now() + SESSION_TTL);
  return sid;
}
function isValidSession(sid) {
  if (!sid) return false;
  const exp = SESSIONS.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { SESSIONS.delete(sid); return false; }
  return true;
}
function authMiddleware(req, res, next) {
  // Allow panel.html itself (it handles login flow client-side)
  if (req.path === '/panel.html' || req.path === '/' || req.path === '/logo.png' || req.path === '/favicon.ico') return next();
  // Auth endpoints + backup (backup checks session via query param)
  if (req.path === '/api/login' || req.path === '/api/check-auth' || req.path === '/api/backup') return next();
  // Everything else requires a valid session
  const sid = req.headers['x-session'];
  if (!isValidSession(sid)) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  next();
}
app.use(authMiddleware);

// ===== LOGIN API =====
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== PANEL_PASSWORD) {
    addLog('WARN', `Failed panel login attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Wrong password' });
  }
  const sid = createSession();
  addLog('INFO', `Panel login successful from ${req.ip}`);
  res.json({ token: sid, storeName: store.settings.storeName });
});

app.post('/api/logout', (req, res) => {
  const sid = req.headers['x-session'];
  if (sid) SESSIONS.delete(sid);
  res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
  const sid = req.headers['x-session'];
  res.json({ authenticated: isValidSession(sid) });
});

// ===== SERVE PANEL =====
app.get('/', (req, res) => res.redirect('/panel.html'));
app.get('/panel.html', (req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// ===== STATS =====
app.get('/api/stats', (req, res) => {
  try {
    const delivered = store.orders.filter(o => o.status === 'Delivered');
    const last7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    res.json({
      storeName: store.settings.storeName,
      totalAccounts: store.accounts.length,
      available: store.accounts.filter(a => a.status === 'available').length,
      reserved: store.accounts.filter(a => a.status === 'reserved').length,
      sold: store.accounts.filter(a => a.status === 'sold').length,
      dead: store.accounts.filter(a => a.status === 'dead').length,
      totalRevenue: delivered.reduce((s, o) => s + o.amount, 0),
      revenue30d: delivered.filter(o => new Date(o.date) >= last30).reduce((s, o) => s + o.amount, 0),
      revenue7d: delivered.filter(o => new Date(o.date) >= last7).reduce((s, o) => s + o.amount, 0),
      totalOrders: store.orders.length,
      orders7d: store.orders.filter(o => new Date(o.date) >= last7).length,
      pendingPayments: store.paymentRequests.filter(p => p.status === 'Pending' || p.status === 'Waiting Review').length,
      openTickets: store.tickets.filter(t => t.status !== 'closed').length,
      totalCustomers: store.customers.length,
      activeCoupons: store.coupons.filter(c => c.active && (!c.expiresAt || new Date(c.expiresAt) > new Date()) && c.uses < c.maxUses).length,
      activePools: store.pools.filter(p => p.stock && p.stock.length > 0).length,
      digitalProducts: store.digitalProducts.length,
      digitalInStock: store.digitalProducts.filter(d => d.stock && d.stock.length > 0).length,
      boostingServices: store.boostingServices.length,
      activeBoosts: store.tickets.filter(t => t.status === 'boosting_in_progress').length,
      camoServices: store.camoServices.length,
      boostSlots: store.boostSlots.length,
      botOnline: client.isReady(),
      // Sales chart (last 14 days)
      salesChart: buildSalesChart(delivered, 14),
      topGames: buildTopGames(store.accounts)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function buildSalesChart(delivered, days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    const revenue = delivered.filter(o => o.date && o.date.startsWith(day)).reduce((s, o) => s + o.amount, 0);
    out.push({ date: day, revenue });
  }
  return out;
}
function buildTopGames(accounts) {
  const map = {};
  accounts.forEach(a => { map[a.game] = (map[a.game] || 0) + 1; });
  return Object.entries(map).map(([game, count]) => ({ game, count })).sort((a, b) => b.count - a.count).slice(0, 6);
}

// ===== ACCOUNTS =====
app.get('/api/accounts', (req, res) => {
  try {
    let { search, game, status } = req.query;
    let filtered = store.accounts;
    if (search) { const s = String(search).toLowerCase(); filtered = filtered.filter(a => a.titleEn.toLowerCase().includes(s) || (a.titleAr && a.titleAr.includes(s))); }
    if (game && game !== 'All') filtered = filtered.filter(a => a.game === game);
    if (status && status !== 'All') filtered = filtered.filter(a => a.status === status);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts', (req, res) => {
  try {
    const { titleEn, titleAr, game, price, prestige, stats, warranty, detailsEn, detailsAr, email, pass, extra, images, couponEligible } = req.body;
    if (!titleEn || !price) return res.status(400).json({ error: 'Title and price required' });

    const allImages = Array.isArray(images) ? images : [];
    const acc = {
      id: genId(), titleEn, titleAr: titleAr || '', game: game || 'Other',
      price: parseFloat(price), prestige: prestige || '', stats: stats || '',
      warranty: parseInt(warranty) || 0, detailsEn: detailsEn || '', detailsAr: detailsAr || '',
      email: email || '', pass: pass || '', extra: extra || '',
      images: allImages, couponEligible: couponEligible !== false,
      status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString()
    };

    store.accounts.unshift(acc);
    saveStore();

    const channelId = store.settings.accountsChannelId;
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) {
        postAccountToDiscord(channel, acc).catch(err => {
          console.error('Discord post error:', err.message);
          addLog('ERROR', 'Failed to post account to Discord: ' + err.message);
        });
      }
    }

    addLog('INFO', `Account created: ${titleEn} with ${allImages.length} image(s)`);
    res.json(acc);
  } catch (e) {
    console.error('POST /api/accounts error:', e);
    addLog('ERROR', 'Failed to create account: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// === MULTI-IMAGE STACKED EMBEDS (all images INSIDE one visual embed box) ===
// Technique: 1 main embed with all text + setImage(first image), then 1 image-only
// embed per remaining image — all same color, no footer/title on image embeds.
// Discord renders these as ONE continuous embed box with the colored bar running
// down the entire left side. All images appear WITHIN the embed, not as attachments below.
async function postAccountToDiscord(channel, acc) {
  const allImages = acc.images || [];
  const brandColor = store.settings.color || 0x9b59ff;
  const priceText = store.settings.currency + acc.price.toFixed(2);

  // ===== MAIN EMBED: title, description, all fields, footer, + first image as setImage =====
  const mainEmbed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🛒 ' + acc.titleEn)
    .setDescription(
      (acc.titleAr ? '**' + acc.titleAr + '**\n' : '') +
      '```yaml\n' + acc.game + '```\n' +
      (acc.detailsEn ? '📋 ' + acc.detailsEn + '\n' : '') +
      (acc.detailsAr ? '📋 ' + acc.detailsAr + '\n' : '')
    )
    .addFields(
      { name: '🏆 Rank / Level', value: acc.prestige || '-', inline: true },
      { name: '📊 Stats', value: acc.stats || '-', inline: true },
      { name: '🛡️ Warranty', value: acc.warranty > 0 ? acc.warranty + ' Days' : 'None', inline: true },
      { name: '💰 Price', value: '```fix\n' + priceText + '```', inline: false }
    )
    .setFooter({ text: store.settings.storeName + ' • Product ID: ' + acc.id })
    .setTimestamp();

  if (acc.extra) {
    mainEmbed.addFields({ name: '📝 Extra Info', value: '```' + String(acc.extra).slice(0, 1000) + '```', inline: false });
  }

  // ===== Build attachments + stacked embeds =====
  // First image → main embed's setImage (appears at bottom of main embed, inside the box)
  // Remaining images → each in its own image-only embed (same color, no text)
  //   → Discord merges them visually into one continuous embed box
  const files = [];
  const embeds = [mainEmbed];
  let imageCount = 0;

  for (let i = 0; i < allImages.length; i++) {
    const parsed = base64ToBuffer(allImages[i]);
    if (!parsed) continue;
    const fileName = `img_${acc.id}_${i + 1}.jpg`;
    files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
    imageCount++;

    if (imageCount === 1) {
      // First image goes inside the main embed (bottom)
      mainEmbed.setImage('attachment://' + fileName);
    } else {
      // Each subsequent image gets its own embed — IMAGE ONLY, same color, no footer/title.
      // This is the key to making them visually merge with the main embed into one box.
      const imgEmbed = new EmbedBuilder()
        .setColor(brandColor)
        .setImage('attachment://' + fileName);
      embeds.push(imgEmbed);
    }
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء / Buy Now').setStyle(ButtonStyle.Success).setEmoji('💰'),
    new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('تفاصيل / Details').setStyle(ButtonStyle.Secondary).setEmoji('🔍')
  );

  // Send all embeds in ONE message — they render as one continuous embed box
  const msg = await channel.send({ embeds, components: [row], files });
  acc.discordMessageIds.push(msg.id);
  saveStore();
  addLog('INFO', `Posted ${acc.titleEn} to Discord — ${imageCount} image(s) inside 1 stacked embed box (${embeds.length} embeds)`);
}

// Re-post an account (e.g. after edit, or if Discord message was lost)
app.post('/api/accounts/:id/repost', async (req, res) => {
  try {
    const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const channelId = store.settings.accountsChannelId;
    if (!channelId || !client.isReady()) return res.status(400).json({ error: 'Bot not ready or channel not set' });
    const channel = client.channels.cache.get(channelId);
    if (!channel) return res.status(400).json({ error: 'Channel not found' });
    // Delete old messages first
    for (const mid of acc.discordMessageIds) {
      try { await channel.messages.delete(mid); } catch (e) {}
    }
    acc.discordMessageIds = [];
    await postAccountToDiscord(channel, acc);
    saveStore();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/accounts/:id', (req, res) => {
  try {
    const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const { images, ...rest } = req.body;
    if (images) rest.images = images;
    Object.assign(acc, rest, { id: acc.id });
    saveStore();
    addLog('INFO', 'Account updated: ' + acc.titleEn);
    res.json(acc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Not found' });
    if (acc.discordMessageIds.length && client.isReady()) {
      const channel = client.channels.cache.get(store.settings.accountsChannelId);
      if (channel) for (const mid of acc.discordMessageIds) { try { await channel.messages.delete(mid); } catch(e){} }
    }
    store.accounts = store.accounts.filter(a => a.id !== acc.id);
    saveStore();
    addLog('WARN', 'Account deleted: ' + acc.titleEn);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts/:id/sold', (req, res) => {
  try {
    const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Not found' });
    acc.status = 'sold';
    saveStore();
    addLog('INFO', 'Account marked sold: ' + acc.titleEn);
    res.json(acc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts/bulk', (req, res) => {
  try {
    const { game, price, warranty, credentials } = req.body;
    if (!credentials || !credentials.length) return res.status(400).json({ error: 'No credentials provided' });
    let count = 0;
    credentials.forEach(line => {
      let email = '', pass = line;
      const sep = line.match(/[:|]/);
      if (sep) { const idx = line.indexOf(sep[0]); email = line.slice(0, idx).trim(); pass = line.slice(idx + 1).trim(); }
      store.accounts.unshift({
        id: genId(), titleEn: game + ' Account', titleAr: 'حساب ' + game, game,
        price: parseFloat(price) || 0, prestige: '-', stats: '-', warranty: parseInt(warranty) || 0,
        detailsEn: 'Bulk imported', detailsAr: 'مستورد بالجملة', email, pass, extra: 'Bulk',
        images: [], couponEligible: true, status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString()
      });
      count++;
    });
    saveStore();
    addLog('INFO', `Bulk imported ${count} accounts for ${game}`);
    res.json({ imported: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ORDERS =====
app.get('/api/orders', (req, res) => {
  try {
    let { search, status } = req.query;
    let filtered = store.orders;
    if (search) { const s = String(search).toLowerCase(); filtered = filtered.filter(o => o.id.toLowerCase().includes(s) || (o.cust||'').toLowerCase().includes(s)); }
    if (status && status !== 'All') filtered = filtered.filter(o => o.status === status);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id/deliver', (req, res) => {
  try {
    const order = store.orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const acc = store.accounts.find(a => a.id === parseInt(order.itemId));
    if (acc) { order.email = acc.email; order.pass = acc.pass; acc.status = 'sold'; acc.soldTo = order.custId; }
    order.status = 'Delivered';
    saveStore();
    if (order.custId && client.isReady()) {
      client.users.fetch(order.custId).then(user => {
        user.send(`✅ **${store.settings.storeName} — تم التسليم / Delivered**\n\n**${order.item}**\n📧 Email: \`${order.email}\`\n🔑 Password: \`${order.pass}\`\n\nشكراً لشرائك من ${store.settings.storeName}!`).catch(() => {});
      }).catch(() => {});
    }
    addLog('INFO', `Delivered ${order.id} manually via panel.`);
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id/refund', (req, res) => {
  try {
    const order = store.orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    order.status = 'Refunded';
    const acc = store.accounts.find(a => a.id === parseInt(order.itemId));
    if (acc) { acc.status = 'available'; acc.soldTo = null; }
    saveStore();
    addLog('WARN', `Order ${order.id} refunded`);
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PAYMENTS =====
app.get('/api/payments', (req, res) => {
  try {
    let filtered = store.paymentRequests;
    if (req.query.status && req.query.status !== 'All') filtered = filtered.filter(p => p.status === req.query.status);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Request missing' });
    pr.status = 'Approved';
    pr.approvedAt = new Date().toISOString();

    const acc = store.accounts.find(a => a.id === pr.accountId);
    let deliveredEmail = pr.deliveredEmail || (acc ? acc.email : '');
    let deliveredPass = pr.deliveredPass || (acc ? acc.pass : '');
    let deliveredCode = '';          // for digital products
    let isBoosting = !!pr.boostingServiceId;
    let isDigital = !!pr.digitalProductId;
    let isCamo = !!pr.camoServiceId;

    // POOL purchase — pull from pool stock
    if (pr.poolId) {
      const pool = store.pools.find(p => p.id === pr.poolId);
      if (pool && pool.stock && pool.stock.length > 0) {
        const item = pool.stock.shift();
        deliveredEmail = item.email;
        deliveredPass = item.pass;
        saveStore();
      }
    }
    // DIGITAL purchase — pull a code from digital product stock
    else if (pr.digitalProductId) {
      const dig = store.digitalProducts.find(d => d.id === pr.digitalProductId);
      if (dig && dig.stock && dig.stock.length > 0) {
        const item = dig.stock.shift();
        deliveredCode = item.code;
        saveStore();
      }
    }
    // BOOSTING — don't deliver anything yet, mark ticket as boosting_in_progress
    else if (pr.boostingServiceId) {
      // handled below — no instant delivery
    }
    // CAMO — same as boosting, service-based, mark ticket as camo_in_progress
    else if (pr.camoServiceId) {
      // handled below — no instant delivery
    }
    // REGULAR account
    else if (acc) {
      acc.status = 'sold';
      acc.soldTo = pr.userId;
    }

    const finalAmount = pr.discountedAmount || pr.amount;

    // For boosting/camo: order is 'In Progress', not 'Delivered' yet
    const orderStatus = (isBoosting || isCamo) ? 'In Progress' : 'Delivered';
    const order = {
      id: 'ORD-' + String(1000 + store.orders.length + 1),
      cust: pr.userName, custId: pr.userId,
      item: pr.accountTitle, itemId: String(pr.accountId),
      poolId: pr.poolId || null, digitalProductId: pr.digitalProductId || null,
      boostingServiceId: pr.boostingServiceId || null, camoServiceId: pr.camoServiceId || null,
      amount: finalAmount, originalAmount: pr.amount, couponCode: pr.couponCode || null,
      status: orderStatus,
      paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      email: deliveredEmail, pass: deliveredPass, code: deliveredCode
    };
    store.orders.unshift(order);

    // Sync customer data
    let customer = store.customers.find(c => c.discordId === pr.userId);
    if (!customer) {
      customer = { id: 'u' + genId(), name: pr.userName, discordId: pr.userId, trust: 'Verified', spent: 0, purchases: 0, notes: '', joined: new Date().toISOString().slice(0, 10) };
      store.customers.push(customer);
    }
    customer.purchases += 1;
    customer.spent += finalAmount;

    // Increment coupon usage
    if (pr.couponCode) {
      const c = store.coupons.find(c => c.code === pr.couponCode);
      if (c) c.uses = (c.uses || 0) + 1;
    }

    // ===== ALWAYS SEND DM TO BUYER (professional receipt embed) =====
    const brandColor = store.settings.color || 0x9b59ff;
    const cur = store.settings.currency;
    const storeName = store.settings.storeName;

    async function sendBuyerDM() {
      if (!pr.userId || !client.isReady()) return;
      try {
        const user = await client.users.fetch(pr.userId);
        let dmEmbed;
        if (isCamo) {
          dmEmbed = new EmbedBuilder()
            .setColor(brandColor)
            .setTitle('🎨 تم تأكيد طلبك — فتح الكاموهات')
            .setDescription(
              `**مرحباً ${pr.userName}! 👋**\n\n` +
              `تم استلام دفعتك بنجاح وبدأنا العمل على طلبك.\n\n` +
              `**📋 تفاصيل الطلب:**\n` +
              `🎨 الخدمة: ${pr.accountTitle}\n` +
              `💰 المبلغ: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `💳 الدفع: \`${pr.method}\`\n` +
              `🎫 رقم العملية: \`${pr.id}\`\n\n` +
              `**⏳ الخطوة التالية:**\n` +
              `أرسل بيانات حسابك في التذكرة لبدء فتح الكاموهات.\n` +
              `⏱️ المدة المتوقعة: \`24-72 ساعة\`\n\n` +
              `شكراً لثقتك في **${storeName}**! 🙏`
            )
            .setFooter({ text: storeName + ' • احتفظ بهذه الرسالة' })
            .setTimestamp();
        } else if (isBoosting) {
          dmEmbed = new EmbedBuilder()
            .setColor(brandColor)
            .setTitle('🚀 تم تأكيد طلبك — البوست قيد التنفيذ')
            .setDescription(
              `**مرحباً ${pr.userName}! 👋**\n\n` +
              `تم استلام دفعتك بنجاح وبدأنا العمل على طلبك.\n\n` +
              `**📋 تفاصيل الطلب:**\n` +
              `🚀 الخدمة: ${pr.accountTitle}\n` +
              `💰 المبلغ: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `💳 الدفع: \`${pr.method}\`\n` +
              `🎫 رقم العملية: \`${pr.id}\`\n\n` +
              `**⏳ الخطوة التالية:**\n` +
              `أرسل بيانات حسابك في التذكرة لبدء البوست.\n` +
              `⏱️ المدة المتوقعة: \`24-48 ساعة\`\n\n` +
              `شكراً لثقتك في **${storeName}**! 🙏`
            )
            .setFooter({ text: storeName + ' • احتفظ بهذه الرسالة' })
            .setTimestamp();
        } else if (isDigital && deliveredCode) {
          dmEmbed = new EmbedBuilder()
            .setColor(0x3ddc84)
            .setTitle('🎫 تم تسليم كودك بنجاح!')
            .setDescription(
              `**مرحباً ${pr.userName}! 👋**\n\n` +
              `تم تأكيد دفعتك وإليك الكود الخاص بك:\n\n` +
              `**📋 تفاصيل الطلب:**\n` +
              `🎫 المنتج: ${pr.accountTitle}\n` +
              `💰 المبلغ: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `💳 الدفع: \`${pr.method}\`\n` +
              `🎫 رقم العملية: \`${pr.id}\`\n\n` +
              `**🎁 الكود الخاص بك:**\n` +
              `\`\`\`${deliveredCode}\`\`\`\n\n` +
              `شكراً لشرائك من **${storeName}**! 🙏\n` +
              `لأي استفسار، افتح تذكرة في السيرفر.`
            )
            .setFooter({ text: storeName + ' • احتفظ بهذا الكود في مكان آمن' })
            .setTimestamp();
        } else {
          dmEmbed = new EmbedBuilder()
            .setColor(0x3ddc84)
            .setTitle('✅ تم تسليم حسابك بنجاح!')
            .setDescription(
              `**مرحباً ${pr.userName}! 👋**\n\n` +
              `تم تأكيد دفعتك وإليك بيانات حسابك:\n\n` +
              `**📋 تفاصيل الطلب:**\n` +
              `📦 المنتج: ${pr.accountTitle}\n` +
              `💰 المبلغ: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `💳 الدفع: \`${pr.method}\`\n` +
              `🎫 رقم العملية: \`${pr.id}\`\n\n` +
              `**🔑 بيانات الحساب:**\n` +
              `📧 Email: \`${deliveredEmail}\`\n` +
              `🔑 Password: \`${deliveredPass}\`\n\n` +
              `شكراً لشرائك من **${storeName}**! 🙏\n` +
              `لأي استفسار، افتح تذكرة في السيرفر.`
            )
            .setFooter({ text: storeName + ' • احتفظ ببياناتك في مكان آمن' })
            .setTimestamp();
        }
        await user.send({ embeds: [dmEmbed] });
        addLog('INFO', `DM sent to ${pr.userName} for ${pr.id}`);
      } catch (e) {
        addLog('WARN', `Could not DM ${pr.userName}: ${e.message}`);
      }
    }

    // ===== DELIVER IN TICKET (beautified, Arabic-first) =====
    const ticket = store.tickets.find(t => t.paymentId === pr.id);
    if (ticket && ticket.channelId && client.isReady()) {
      const ticketChannel = client.channels.cache.get(ticket.channelId);
      if (ticketChannel) {
        let deliverEmbed;
        if (isCamo) {
          // CAMO: payment confirmed, ask for account credentials
          ticket.status = 'camo_in_progress';
          const camoSvc = store.camoServices.find(s => s.id === pr.camoServiceId);
          deliverEmbed = new EmbedBuilder()
            .setColor(brandColor)
            .setTitle('✅ تم تأكيد الدفع — بدء فتح الكاموهات')
            .setDescription(
              `**مرحباً ${pr.userName}! 👋**\n\n` +
              `تم استلام دفعتك بنجاح ✅\n\n` +
              `**📋 تفاصيل الطلب:**\n` +
              `🎨 الخدمة: ${pr.accountTitle}\n` +
              `💰 المبلغ: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `🎫 رقم العملية: \`${pr.id}\`\n\n` +
              `**⏳ الخطوة التالية:**\n` +
              `أرسل بيانات حسابك هنا لبدء فتح الكاموهات:\n` +
              `📧 Email + 🔑 Password + أي معلومات مطلوبة\n\n` +
              `⏱️ المدة المتوقعة: \`${camoSvc ? camoSvc.eta : '24-72 ساعة'}\`\n` +
              `🎨 سيتم إشعارك فور اكتمال فتح الكاموهات!`
            )
            .setFooter({ text: storeName + ' • التذكرة مفتوحة حتى اكتمال الخدمة' })
            .setTimestamp();
          await ticketChannel.send({ embeds: [deliverEmbed] });
          addLog('INFO', `Camo ticket ${ticket.id} now in progress for ${pr.userName}`);
        } else if (isBoosting) {
          // BOOSTING: payment confirmed, ask for account credentials
          ticket.status = 'boosting_in_progress';
          deliverEmbed = new EmbedBuilder()
            .setColor(brandColor)
            .setTitle('✅ تم تأكيد الدفع — بدء البوست')
            .setDescription(
              `**مرحباً ${pr.userName}! 👋**\n\n` +
              `تم استلام دفعتك بنجاح ✅\n\n` +
              `**📋 تفاصيل الطلب:**\n` +
              `🚀 الخدمة: ${pr.accountTitle}\n` +
              `💰 المبلغ: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `🎫 رقم العملية: \`${pr.id}\`\n\n` +
              `**⏳ الخطوة التالية:**\n` +
              `أرسل بيانات حسابك هنا لبدء البوست:\n` +
              `📧 Email + 🔑 Password + أي معلومات مطلوبة\n\n` +
              `⏱️ المدة المتوقعة: \`${ticket.boostingEta || '24-48 ساعة'}\`\n` +
              `🚀 سيتم إشعارك فور اكتمال البوست!`
            )
            .setFooter({ text: storeName + ' • التذكرة مفتوحة حتى اكتمال البوست' })
            .setTimestamp();
          await ticketChannel.send({ embeds: [deliverEmbed] });
          addLog('INFO', `Boosting ticket ${ticket.id} now in progress for ${pr.userName}`);
        } else {
          // DELIVER product (account / pool / digital code)
          let deliverText = '';
          if (isDigital && deliveredCode) {
            deliverText = `🎫 **الكود:**\n\`\`\`${deliveredCode}\`\`\``;
          } else {
            deliverText = `📧 **Email:** \`${deliveredEmail}\`\n🔑 **Password:** \`${deliveredPass}\``;
          }
          deliverEmbed = new EmbedBuilder()
            .setColor(0x3ddc84)
            .setTitle('✅ تم تأكيد الدفع — التسليم')
            .setDescription(
              `**مرحباً ${pr.userName}! 👋**\n\n` +
              `تم تأكيد دفعتك بنجاح ✅\n\n` +
              `**📋 تفاصيل الطلب:**\n` +
              `📦 المنتج: ${pr.accountTitle}\n` +
              `💰 المبلغ: \`${cur}${finalAmount.toFixed(2)}\`\n` +
              `💳 الدفع: \`${pr.method}\`\n` +
              `🎫 رقم العملية: \`${pr.id}\`\n\n` +
              `**🎁 التسليم:**\n${deliverText}\n\n` +
              `🙏 شكراً لشرائك من **${storeName}**!\n` +
              `تم إرسال نسخة إلى رسائلك الخاصة 📩`
            )
            .setFooter({ text: storeName + ' • سيتم إغلاق التذكرة تلقائياً خلال ' + (store.settings.autoCloseSeconds || 15) + ' ثانية' })
            .setTimestamp();
          await ticketChannel.send({ embeds: [deliverEmbed] });
          ticket.status = 'closed';
          ticket.closedAt = new Date().toISOString();
          setTimeout(async () => {
            try { await ticketChannel.delete('Purchase completed — ticket auto-closed'); }
            catch (err) { addLog('WARN', `Failed to delete ticket channel: ${err.message}`); }
          }, (store.settings.autoCloseSeconds || 15) * 1000);
        }
        saveStore();
      }
    }

    // ===== ALWAYS SEND DM (regardless of ticket) =====
    await sendBuyerDM();


    sendLogToDiscord(`✅ Payment approved: \`${pr.id}\` for **${pr.accountTitle}** ($${finalAmount}) by ${pr.userName}`);
    addLog('INFO', `Payment approved & delivered: ${pr.id}`);
    saveStore();
    res.json(pr);
  } catch (e) {
    console.error('Approve payment error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/payments/:id/reject', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Not found' });

    const ticket = store.tickets.find(t => t.paymentId === pr.id);
    if (ticket && ticket.channelId && client.isReady()) {
      const ticketChannel = client.channels.cache.get(ticket.channelId);
      if (ticketChannel) {
        const rejectEmbed = new EmbedBuilder()
          .setColor(0xda373c)
          .setTitle('❌ تم رفض الدفع / Payment Rejected')
          .setDescription(
            `طلب رقم: \`${pr.id}\` الخاص بـ **${pr.accountTitle}** تم رفضه.\n\n` +
            `⚠️ يرجى التحقق من المبلغ المدفوع والمحاولة مرة أخرى.\n` +
            `Upload a new receipt or contact support.`
          )
          .setFooter({ text: store.settings.storeName })
          .setTimestamp();
        await ticketChannel.send({ embeds: [rejectEmbed] });
        ticket.status = 'waiting_payment';
        pr.status = 'Pending';
      }
    } else {
      if (pr.userId && client.isReady()) {
        client.users.fetch(pr.userId).then(user => {
          user.send(`❌ **${store.settings.storeName} — Payment Rejected**\n\nطلب رقم: \`${pr.id}\` الخاص بـ **${pr.accountTitle}** تم رفضه. يرجى مراجعة الدعم الفني.`).catch(() => {});
        }).catch(() => {});
      }
      pr.status = 'Rejected';
    }
    saveStore();
    sendLogToDiscord(`❌ Payment rejected: \`${pr.id}\` for **${pr.accountTitle}**`);
    addLog('WARN', `Payment rejected: ${pr.id}`);
    res.json(pr);
  } catch (e) {
    console.error('Reject payment error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== TICKETS =====
app.get('/api/tickets', (req, res) => {
  try {
    let filtered = store.tickets;
    if (req.query.status && req.query.status !== 'All') filtered = filtered.filter(t => t.status === req.query.status);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/close', async (req, res) => {
  try {
    const ticket = store.tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    ticket.status = 'closed';
    ticket.closedAt = new Date().toISOString();

    if (ticket.channelId && client.isReady()) {
      const ch = client.channels.cache.get(ticket.channelId);
      if (ch) {
        await ch.send('🔒 **تم إغلاق التذكرة / Ticket Closed** — سيتم حذفها خلال 5 ثوانٍ.');
        setTimeout(async () => { try { await ch.delete('Ticket closed by admin'); } catch (e) {} }, 5000);
      }
    }

    // Release the account if payment wasn't completed
    const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
    if (pr && (pr.status === 'Pending' || pr.status === 'Rejected')) {
      const acc = store.accounts.find(a => a.id === ticket.accountId);
      if (acc && acc.status === 'reserved') {
        acc.status = 'available';
        acc.soldTo = null;
        addLog('INFO', `Account ${acc.id} released back to available (ticket ${ticket.id} closed)`);
      }
    }
    saveStore();
    addLog('INFO', `Ticket ${ticket.id} closed manually`);
    res.json(ticket);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== CUSTOMERS =====
app.get('/api/customers', (req, res) => { try { res.json(store.customers); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers', (req, res) => { try { const c = { id: 'u' + genId(), ...req.body, joined: req.body.joined || new Date().toISOString().slice(0,10) }; store.customers.push(c); saveStore(); res.json(c); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/customers/:id', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Not found' }); Object.assign(c, req.body); saveStore(); res.json(c); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/blacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Blacklisted'; saveStore(); res.json(c); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/unblacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Verified'; saveStore(); res.json(c); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== POOLS (Auto-Delivery) =====
app.get('/api/pools', (req, res) => { try { res.json(store.pools); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/pools', async (req, res) => {
  try {
    const { name, description, price, game, image } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'Name and price required' });
    const pool = {
      id: genId(), name, description: description || '', price: parseFloat(price),
      game: game || 'Other', image: image || null, stock: [],
      createdAt: new Date().toISOString(), discordMessageIds: []
    };
    store.pools.push(pool);
    saveStore();

    // Post to Discord
    const channelId = store.settings.accountsChannelId;
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) await postPoolToDiscord(channel, pool).catch(e => addLog('ERROR', 'Pool post failed: ' + e.message));
    }

    addLog('INFO', `Pool created: ${name}`);
    res.json(pool);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function postPoolToDiscord(channel, pool) {
  const brandColor = store.settings.color || 0x9b59ff;
  const embed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('⚡ ' + pool.name + ' — Auto-Delivery')
    .setDescription(pool.description || 'Instant auto-delivery after payment!')
    .addFields(
      { name: '🎮 Game', value: pool.game, inline: true },
      { name: '💰 Price', value: store.settings.currency + pool.price.toFixed(2), inline: true },
      { name: '📦 In Stock', value: '```fix\n' + (pool.stock ? pool.stock.length : 0) + '```', inline: true }
    )
    .setFooter({ text: store.settings.storeName + ' • Pool ID: ' + pool.id + ' • Auto-delivery' })
    .setTimestamp();

  const files = [];
  if (pool.image) {
    const parsed = base64ToBuffer(pool.image);
    if (parsed) {
      const fileName = 'pool_' + pool.id + '.jpg';
      files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
      embed.setImage('attachment://' + fileName);
    }
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buypool_' + pool.id).setLabel('شراء فوري / Instant Buy').setStyle(ButtonStyle.Success).setEmoji('⚡')
  );

  const msg = await channel.send({ embeds: [embed], components: [row], files });
  pool.discordMessageIds.push(msg.id);
  saveStore();
}

app.post('/api/pools/:id/stock', (req, res) => {
  try {
    const pool = store.pools.find(p => p.id === parseInt(req.params.id));
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const { credentials } = req.body;
    if (!credentials || !credentials.length) return res.status(400).json({ error: 'No credentials' });
    let count = 0;
    credentials.forEach(line => {
      let email = '', pass = line;
      const sep = line.match(/[:|]/);
      if (sep) { const idx = line.indexOf(sep[0]); email = line.slice(0, idx).trim(); pass = line.slice(idx + 1).trim(); }
      pool.stock.push({ email, pass, addedAt: new Date().toISOString() });
      count++;
    });
    saveStore();
    addLog('INFO', `Added ${count} items to pool ${pool.name}`);
    res.json({ added: count, total: pool.stock.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pools/:id', (req, res) => {
  try {
    store.pools = store.pools.filter(p => p.id !== parseInt(req.params.id));
    saveStore();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DIGITAL PRODUCTS (PSN cards, Xbox subs, Netflix, CD keys — instant code delivery) =====
app.get('/api/digital', (req, res) => { try { res.json(store.digitalProducts); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/digital', async (req, res) => {
  try {
    const { titleEn, titleAr, platform, productType, price, descriptionEn, descriptionAr, image, stock } = req.body;
    if (!titleEn || !price) return res.status(400).json({ error: 'Title and price required' });
    const product = {
      id: genId(), titleEn, titleAr: titleAr || '',
      platform: platform || 'Other',     // PSN / Xbox / Netflix / Steam / CD Key / etc
      productType: productType || 'code', // code / subscription / gift_card / cd_key
      price: parseFloat(price),
      descriptionEn: descriptionEn || '', descriptionAr: descriptionAr || '',
      image: image || null,              // single cover image (base64)
      stock: Array.isArray(stock) ? stock : [],  // [{ code, notes, addedAt }]
      createdAt: new Date().toISOString(), discordMessageIds: []
    };
    store.digitalProducts.push(product);
    saveStore();
    const channelId = store.settings.digitalChannelId || store.settings.accountsChannelId;
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) await postDigitalToDiscord(channel, product).catch(e => addLog('ERROR', 'Digital post failed: ' + e.message));
    }
    addLog('INFO', `Digital product created: ${titleEn} (stock: ${product.stock.length})`);
    res.json(product);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function postDigitalToDiscord(channel, product) {
  const brandColor = store.settings.color || 0x9b59ff;
  const cur = store.settings.currency;
  const stockCount = product.stock ? product.stock.length : 0;
  const embed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🎫 ' + product.titleEn)
    .setDescription(
      (product.titleAr ? '**' + product.titleAr + '**\n' : '') +
      '```yaml\n' + product.platform + ' • ' + product.productType + '```\n' +
      (product.descriptionEn ? '📋 ' + product.descriptionEn + '\n' : '') +
      (product.descriptionAr ? '📋 ' + product.descriptionAr + '\n' : '')
    )
    .addFields(
      { name: '💳 Platform', value: product.platform, inline: true },
      { name: '📦 Type', value: product.productType, inline: true },
      { name: '📊 In Stock', value: '```fix\n' + stockCount + '```', inline: true },
      { name: '💰 Price', value: '```fix\n' + cur + product.price.toFixed(2) + '```', inline: false }
    )
    .setFooter({ text: store.settings.storeName + ' • Digital Product • ID: ' + product.id + ' • Instant delivery' })
    .setTimestamp();
  const files = [];
  if (product.image) {
    const parsed = base64ToBuffer(product.image);
    if (parsed) {
      const fileName = 'digital_' + product.id + '.jpg';
      files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
      embed.setImage('attachment://' + fileName);
    }
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buydig_' + product.id).setLabel('شراء فوري / Buy Instant').setStyle(ButtonStyle.Success).setEmoji('🎫')
  );
  const msg = await channel.send({ embeds: [embed], components: [row], files });
  product.discordMessageIds.push(msg.id);
  saveStore();
}

app.put('/api/digital/:id', (req, res) => {
  try {
    const p = store.digitalProducts.find(d => d.id === parseInt(req.params.id));
    if (!p) return res.status(404).json({ error: 'Not found' });
    Object.assign(p, req.body, { id: p.id });
    saveStore(); res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/digital/:id', (req, res) => {
  try {
    store.digitalProducts = store.digitalProducts.filter(d => d.id !== parseInt(req.params.id));
    saveStore(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/digital/:id/stock', (req, res) => {
  try {
    const p = store.digitalProducts.find(d => d.id === parseInt(req.params.id));
    if (!p) return res.status(404).json({ error: 'Not found' });
    const { codes } = req.body;
    if (!codes || !codes.length) return res.status(400).json({ error: 'No codes provided' });
    let count = 0;
    codes.forEach(line => {
      const trimmed = line.trim(); if (!trimmed) return;
      // Format: code | optional notes  OR  just code
      let code = trimmed, notes = '';
      if (trimmed.includes('|')) { const parts = trimmed.split('|'); code = parts[0].trim(); notes = parts.slice(1).join('|').trim(); }
      p.stock.push({ code, notes, addedAt: new Date().toISOString() });
      count++;
    });
    saveStore();
    addLog('INFO', `Added ${count} codes to digital product ${p.titleEn}`);
    res.json({ added: count, total: p.stock.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== BOOSTING SERVICES (CoD/Warzone rank, prestige, gun level boosting) =====
app.get('/api/boosting', (req, res) => { try { res.json(store.boostingServices); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/boosting', async (req, res) => {
  try {
    const { titleEn, titleAr, game, serviceType, fromRank, toRank, prestigeLevel, gunName, fromLevel, toLevel,
      price, eta, descriptionEn, descriptionAr, images,
      rankList, rankTiers, pricePerRank, maxPrestige, pricePerPrestige, prestigeEmoji, gunList, maxGunLevel } = req.body;
    if (!titleEn || !price) return res.status(400).json({ error: 'Title and price required' });
    const service = {
      id: genId(), titleEn, titleAr: titleAr || '',
      game: game || 'Call of Duty',
      serviceType: serviceType || 'rank',
      // Legacy fixed fields (kept for backward compat, used if no options defined)
      fromRank: fromRank || '', toRank: toRank || '',
      prestigeLevel: prestigeLevel || '',
      gunName: gunName || '', fromLevel: fromLevel || '', toLevel: toLevel || '',
      price: parseFloat(price),
      eta: eta || '24-48 hours',
      descriptionEn: descriptionEn || '', descriptionAr: descriptionAr || '',
      images: Array.isArray(images) ? images : [],
      // ===== Customer-choice config (with emoji support) =====
      // rankList: array of { name, emoji } — e.g. [{name:'Bronze', emoji:'🥉'}, ...]
      // Supports custom emoji tags like '<:bronze:123456>' too
      rankList: Array.isArray(rankList) ? rankList.map(parseRankEntry) : (rankList ? String(rankList).split('\n').map(s=>s.trim()).filter(Boolean).map(parseRankEntry) : []),
      rankTiers: parseInt(rankTiers) || 3,  // tiers per rank (I, II, III = 3). Last rank in list is always single-tier (Top 250)
      pricePerRank: parseFloat(pricePerRank) || 0,
      maxPrestige: parseInt(maxPrestige) || 0,
      pricePerPrestige: parseFloat(pricePerPrestige) || 0,
      prestigeEmoji: prestigeEmoji || '🎖️',
      gunList: parseGunListInput(gunList).gunList,
      gunCategories: parseGunListInput(gunList).gunCategories,
      maxGunLevel: parseInt(maxGunLevel) || 100,
      status: 'active',
      createdAt: new Date().toISOString(), discordMessageIds: []
    };
    store.boostingServices.push(service);
    saveStore();
    const channelId = store.settings.boostingChannelId || store.settings.accountsChannelId;
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) await postBoostingToDiscord(channel, service).catch(e => addLog('ERROR', 'Boosting post failed: ' + e.message));
    }
    addLog('INFO', `Boosting service created: ${titleEn}`);
    res.json(service);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parse rank entry: '🥉 Bronze' or 'Bronze' or '<:bronze:123> Bronze'
function parseRankEntry(line) {
  if (typeof line === 'object') return line; // already parsed
  const trimmed = String(line).trim();
  // Try to extract leading emoji (unicode or custom <:name:id>)
  const customMatch = trimmed.match(/^<:(\w+):(\d+)>\s*(.+)$/);
  if (customMatch) return { emoji: { id: customMatch[2], name: customMatch[1] }, name: customMatch[3].trim() };
  // Unicode emoji at start (1-2 chars)
  const unicodeMatch = trimmed.match(/^(\p{Extended_Pictographic}|\p{Emoji})(\uFE0F)?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji}))*\s*(.+)$/u);
  if (unicodeMatch) {
    const emojiPart = trimmed.slice(0, trimmed.length - unicodeMatch[3].length).trim();
    return { emoji: emojiPart, name: unicodeMatch[3].trim() };
  }
  return { emoji: '', name: trimmed };
}

// Parse gun entry: '🔫 M4A1:0.50' or 'M4A1:0.50' or '<:m4:123> M4A1:0.50'
function parseGunEntry(line) {
  if (typeof line === 'object') return line;
  const trimmed = String(line).trim();
  let emoji = '';
  let rest = trimmed;
  // Custom emoji
  const customMatch = trimmed.match(/^<:(\w+):(\d+)>\s*(.+)$/);
  if (customMatch) { emoji = { id: customMatch[2], name: customMatch[1] }; rest = customMatch[3]; }
  else {
    const unicodeMatch = trimmed.match(/^(\p{Extended_Pictographic}|\p{Emoji})(\uFE0F)?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji}))*\s*(.+)$/u);
    if (unicodeMatch) { emoji = trimmed.slice(0, trimmed.length - unicodeMatch[3].length).trim(); rest = unicodeMatch[3]; }
  }
  // rest = 'GunName:pricePerLevel'
  const parts = rest.split(':');
  const name = parts[0].trim();
  const pricePerLevel = parseFloat(parts[1]) || 0;
  return { name, emoji, pricePerLevel };
}

// Parse gun list input — supports 2 formats:
// Format 1 (flat): ['🔫 M4A1:0.50', '🔫 AK-47:0.50']  → gunList = [{name, emoji, pricePerLevel}, ...]
// Format 2 (categorized): ['# Assault Rifles', '🔫 M4A1:0.50', '🔫 AK-47', '# SMGs', '💨 MP5:0.40']
//   → gunCategories = [{name:'Assault Rifles', emoji:'🔫', guns:[{name,emoji,pricePerLevel},...]}, ...]
// Lines starting with '#' or '##' are category headers (optional emoji after #)
// Returns { gunList: [...flat guns...], gunCategories: [...categories...] or [] }
function parseGunListInput(input) {
  if (typeof input === 'string') input = input.split('\n');
  if (!Array.isArray(input)) return { gunList: [], gunCategories: [] };
  const gunList = []; // flat list
  const gunCategories = []; // categorized
  let currentCat = null;
  for (let line of input) {
    if (typeof line === 'object') { gunList.push(line); continue; }
    line = String(line).trim();
    if (!line) continue;
    // Category header: '# Assault Rifles' or '## 🔫 Assault Rifles'
    if (line.startsWith('#')) {
      const headerText = line.replace(/^#+\s*/, '');
      let catEmoji = '';
      let catName = headerText;
      const customMatch = headerText.match(/^<:(\w+):(\d+)>\s*(.+)$/);
      if (customMatch) { catEmoji = { id: customMatch[2], name: customMatch[1] }; catName = customMatch[3].trim(); }
      else {
        const unicodeMatch = headerText.match(/^(\p{Extended_Pictographic}|\p{Emoji})(\uFE0F)?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji}))*\s*(.+)$/u);
        if (unicodeMatch) { catEmoji = headerText.slice(0, headerText.length - unicodeMatch[3].length).trim(); catName = unicodeMatch[3].trim(); }
      }
      currentCat = { name: catName, emoji: catEmoji, guns: [] };
      gunCategories.push(currentCat);
      continue;
    }
    // Regular gun line
    const gun = parseGunEntry(line);
    gunList.push(gun);
    if (currentCat) currentCat.guns.push(gun);
    else {
      const otherCat = gunCategories.find(c => c.name === 'Other');
      if (otherCat) otherCat.guns.push(gun);
      else gunCategories.push({ name: 'Other', emoji: '🔫', guns: [gun] });
    }
  }
  return { gunList, gunCategories };
}

// Get gun categories from a boosting/camo service
function getGunCategories(service) {
  if (service.gunCategories && service.gunCategories.length > 0) return service.gunCategories;
  if (service.gunList && service.gunList.length > 0) {
    return [{ name: 'All Guns', emoji: '🔫', guns: service.gunList }];
  }
  return [];
}


// Expand rankList into flat list of tiers with emojis
// e.g. rankList=[Bronze,Silver,Gold], rankTiers=3 → [Bronze I, Bronze II, Bronze III, Silver I, Silver II, Silver III, Gold I, Gold II, Gold III]
// Last rank is always single-tier (Top 250 style)
function getExpandedRanks(service) {
  if (!service.rankList || service.rankList.length === 0) return [];
  const tiers = service.rankTiers || 3;
  const tierLabels = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  const out = [];
  for (let r = 0; r < service.rankList.length; r++) {
    const rank = service.rankList[r];
    const isLast = r === service.rankList.length - 1;
    if (isLast) {
      // Last rank (e.g. Top 250) is single tier
      out.push({ label: rank.name, emoji: rank.emoji, rankIdx: r, tierIdx: 0, globalIdx: out.length });
    } else {
      for (let t = 0; t < tiers; t++) {
        out.push({ label: rank.name + ' ' + tierLabels[t], emoji: rank.emoji, rankIdx: r, tierIdx: t, globalIdx: out.length });
      }
    }
  }
  return out;
}

async function postBoostingToDiscord(channel, service) {
  const brandColor = store.settings.color || 0x9b59ff;
  const cur = store.settings.currency;
  const allImages = service.images || [];
  const mainEmbed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🚀 ' + service.titleEn)
    .setDescription(
      (service.titleAr ? '**' + service.titleAr + '**\n' : '') +
      '```yaml\n' + service.game + ' • ' + service.serviceType.replace('_',' ') + '```\n' +
      (service.descriptionEn ? '📋 ' + service.descriptionEn + '\n' : '') +
      (service.descriptionAr ? '📋 ' + service.descriptionAr + '\n' : '')
    )
    .addFields(
      { name: '🎮 Game', value: service.game, inline: true },
      { name: '⏱️ ETA', value: service.eta, inline: true }
    );
  let startingPrice = service.price;
  // Clean embed — don't list all ranks/guns, just show starting price + hint to click Order
  if (service.serviceType === 'rank' && service.rankList && service.rankList.length >= 2 && service.pricePerRank > 0) {
    startingPrice = service.pricePerRank;
    mainEmbed.addFields({ name: '📈 الخدمة', value: 'بوست رتبة — اختر رتبتك الحالية والمستهدفة', inline: false });
  } else if (service.serviceType === 'rank' && service.fromRank && service.toRank) {
    mainEmbed.addFields({ name: '📈 Rank Boost', value: '`' + (service.fromRank||'-') + '` → `' + (service.toRank||'-') + '`', inline: false });
  }
  if (service.serviceType === 'prestige' && service.maxPrestige > 0 && service.pricePerPrestige > 0) {
    startingPrice = service.pricePerPrestige;
    mainEmbed.addFields({ name: '🎖️ الخدمة', value: 'بوست بريستيج — اختر المستوى المستهدف (1-' + service.maxPrestige + ')', inline: false });
  } else if (service.serviceType === 'prestige' && service.prestigeLevel) {
    mainEmbed.addFields({ name: '🎖️ Prestige Level', value: '```fix\n' + service.prestigeLevel + '```', inline: false });
  }
  if (service.serviceType === 'gun_level' && service.gunList && service.gunList.length > 0) {
    const cheapest = Math.min(...service.gunList.map(g => g.pricePerLevel || 0));
    if (cheapest > 0) startingPrice = cheapest;
    const categories = getGunCategories(service);
    if (categories.length > 1) {
      mainEmbed.addFields({ name: '🔫 الخدمة', value: 'بوست مستويات أسلحة — اختر الفئة ثم السلاح (' + categories.length + ' فئات، ' + service.gunList.length + ' سلاح)', inline: false });
    } else {
      mainEmbed.addFields({ name: '🔫 الخدمة', value: 'بوست مستويات أسلحة — ' + service.gunList.length + ' سلاح متاح', inline: false });
    }
  } else if (service.serviceType === 'gun_level' && service.gunName) {
    mainEmbed.addFields({ name: '🔫 Gun', value: service.gunName, inline: true });
  }
  mainEmbed.addFields({ name: '💰 يبدأ من', value: '```fix\n' + cur + startingPrice.toFixed(2) + '```', inline: false });
  mainEmbed.setFooter({ text: store.settings.storeName + ' • اضغط اطلب الآن للتخصيص' });
  mainEmbed.setTimestamp();

  const files = [];
  const embeds = [mainEmbed];
  let imgCount = 0;
  
  // Auto-attach default professional image if no custom images
  if (allImages.length === 0) {
    const defaultImageMap = { 'rank': 'rank-boost.png', 'prestige': 'prestige.png', 'gun_level': 'gun-level.png' };
    const defaultImg = defaultImageMap[service.serviceType];
    if (defaultImg) {
      const imgPath = path.join(__dirname, 'images', defaultImg);
      if (fs.existsSync(imgPath)) {
        const fileName = 'boost_' + service.id + '_default.png';
        files.push(new AttachmentBuilder(fs.readFileSync(imgPath), { name: fileName }));
        mainEmbed.setImage('attachment://' + fileName);
        imgCount = 1;
      }
    }
  }
  
  for (let i = 0; i < allImages.length; i++) {
    const parsed = base64ToBuffer(allImages[i]);
    if (!parsed) continue;
    const fileName = 'boost_' + service.id + '_' + (i + 1) + '.jpg';
    files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
    imgCount++;
    if (imgCount === 1) mainEmbed.setImage('attachment://' + fileName);
    else embeds.push(new EmbedBuilder().setColor(brandColor).setImage('attachment://' + fileName));
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('orderboost_' + service.id).setLabel('اطلب الآن / Order Boost').setStyle(ButtonStyle.Success).setEmoji('🚀')
  );
  const msg = await channel.send({ embeds, components: [row], files });
  service.discordMessageIds.push(msg.id);
  saveStore();
}

app.put('/api/boosting/:id', (req, res) => {
  try {
    const s = store.boostingServices.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    const body = { ...req.body };
    if (body.gunList) {
      const parsed = parseGunListInput(body.gunList);
      body.gunList = parsed.gunList;
      body.gunCategories = parsed.gunCategories;
    }
    Object.assign(s, body, { id: s.id });
    saveStore(); res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/boosting/:id', async (req, res) => {
  try {
    const s = store.boostingServices.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    // Delete Discord messages
    if (s.discordMessageIds && s.discordMessageIds.length && client.isReady()) {
      const channelId = store.settings.boostingChannelId || store.settings.accountsChannelId;
      const ch = client.channels.cache.get(channelId);
      if (ch) for (const mid of s.discordMessageIds) { try { await ch.messages.delete(mid); } catch(e){} }
    }
    store.boostingServices = store.boostingServices.filter(x => x.id !== parseInt(req.params.id));
    saveStore(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-post a boosting service (delete old Discord message, re-post)
app.post('/api/boosting/:id/repost', async (req, res) => {
  try {
    const s = store.boostingServices.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    const channelId = store.settings.boostingChannelId || store.settings.accountsChannelId;
    if (!channelId || !client.isReady()) return res.status(400).json({ error: 'Bot not ready or channel not set' });
    const ch = client.channels.cache.get(channelId);
    if (!ch) return res.status(400).json({ error: 'Channel not found' });
    // Delete old messages
    for (const mid of s.discordMessageIds) { try { await ch.messages.delete(mid); } catch(e){} }
    s.discordMessageIds = [];
    await postBoostingToDiscord(ch, s);
    saveStore();
    addLog('INFO', `Boosting service ${s.id} re-posted to Discord`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark a boosting order complete (admin delivers completion message + closes ticket)
app.post('/api/boosting/:id/complete', async (req, res) => {
  try {
    const service = store.boostingServices.find(s => s.id === parseInt(req.params.id));
    const ticket = store.tickets.find(t => t.boostingServiceId === parseInt(req.params.id) && t.status === 'boosting_in_progress');
    if (!ticket) return res.status(404).json({ error: 'No in-progress boost ticket for this service' });
    const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
    if (pr) pr.status = 'Delivered';
    ticket.status = 'closed';
    ticket.closedAt = new Date().toISOString();
    if (ticket.channelId && client.isReady()) {
      const ch = client.channels.cache.get(ticket.channelId);
      if (ch) {
        const embed = new EmbedBuilder()
          .setColor(0x3ddc84)
          .setTitle('✅ تم اكتمال البوست بنجاح!')
          .setDescription(
            `**مرحباً ${ticket.userName}! 👋**\n\n` +
            `🚨 تم اكتمال خدمة البوست بنجاح!\n\n` +
            `**📋 تفاصيل الخدمة:**\n` +
            `🚀 الخدمة: ${ticket.accountTitle}\n` +
            `🎫 رقم التذكرة: \`${ticket.id}\`\n\n` +
            `🎮 حسابك جاهز الآن — يمكنك الدخول والتحقق!\n\n` +
            `🙏 شكراً لثقتك في **${store.settings.storeName}**!\n` +
            `نتمنى نراك مرة أخرى 🌟`
          )
          .setFooter({ text: store.settings.storeName + ' • سيتم إغلاق التذكرة خلال ' + (store.settings.autoCloseSeconds || 15) + ' ثانية' })
          .setTimestamp();
        await ch.send({ embeds: [embed] });
        setTimeout(async () => { try { await ch.delete('Boost complete — ticket auto-closed'); } catch (e) {} }, (store.settings.autoCloseSeconds || 15) * 1000);
      }
    }
    // ===== DM the buyer that boost is complete =====
    if (ticket.userId && client.isReady()) {
      try {
        const user = await client.users.fetch(ticket.userId);
        const dmEmbed = new EmbedBuilder()
          .setColor(0x3ddc84)
          .setTitle('✅ تم اكتمال البوست بنجاح!')
          .setDescription(
            `**مرحباً ${ticket.userName}! 👋**\n\n` +
            `🚨 تم اكتمال خدمة البوست بنجاح!\n\n` +
            `**📋 تفاصيل الخدمة:**\n` +
            `🚀 الخدمة: ${ticket.accountTitle}\n` +
            `🎫 رقم التذكرة: \`${ticket.id}\`\n\n` +
            `🎮 حسابك جاهز الآن — يمكنك الدخول والتحقق!\n\n` +
            `🙏 شكراً لثقتك في **${store.settings.storeName}**!\n` +
            `لأي استفسار، افتح تذكرة في السيرفر.`
          )
          .setFooter({ text: store.settings.storeName })
          .setTimestamp();
        await user.send({ embeds: [dmEmbed] });
      } catch (e) {}
    }
    saveStore();
    addLog('INFO', `Boosting service ${req.params.id} marked complete, ticket ${ticket.id} closing`);
    sendLogToDiscord(`✅ Boost complete for ticket \`${ticket.id}\` — **${ticket.accountTitle}**`);
    res.json({ success: true, ticketId: ticket.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== CAMO UNLOCK SERVICES (CoD/Warzone weapon camo unlock — admin adds camo names) =====
app.get('/api/camo', (req, res) => { try { res.json(store.camoServices); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/camo', async (req, res) => {
  try {
    const { titleEn, titleAr, game, pricePerCamo, camoList, gunList, eta, descriptionEn, descriptionAr, images } = req.body;
    if (!titleEn || !pricePerCamo) return res.status(400).json({ error: 'Title and price per camo required' });
    const service = {
      id: genId(), titleEn, titleAr: titleAr || '',
      game: game || 'Call of Duty Warzone',
      pricePerCamo: parseFloat(pricePerCamo),
      // camoList: array of { name, emoji, price } — admin adds the camo names
      // If price is 0/empty, uses pricePerCamo as default
      camoList: Array.isArray(camoList) ? camoList.map(parseCamoEntry) : (camoList ? String(camoList).split('\n').map(s=>s.trim()).filter(Boolean).map(parseCamoEntry) : []),
      // gunList: array of { name, emoji } — optional, if empty customer just picks camos
      gunList: parseGunListInput(gunList).gunList,
      gunCategories: parseGunListInput(gunList).gunCategories,
      eta: eta || '24-72 hours',
      descriptionEn: descriptionEn || '', descriptionAr: descriptionAr || '',
      images: Array.isArray(images) ? images : [],
      status: 'active',
      createdAt: new Date().toISOString(), discordMessageIds: []
    };
    store.camoServices.push(service);
    saveStore();
    const channelId = store.settings.camoChannelId || store.settings.accountsChannelId;
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) await postCamoToDiscord(channel, service).catch(e => addLog('ERROR', 'Camo post failed: ' + e.message));
    }
    addLog('INFO', `Camo service created: ${titleEn} (${service.camoList.length} camos)`);
    res.json(service);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parse camo entry: '🟡 Gold:5' or 'Gold:5' or '🟡 Gold' (uses pricePerCamo if no price)
function parseCamoEntry(line) {
  if (typeof line === 'object') return line;
  const trimmed = String(line).trim();
  let emoji = '';
  let rest = trimmed;
  // Custom emoji
  const customMatch = trimmed.match(/^<:(\w+):(\d+)>\s*(.+)$/);
  if (customMatch) { emoji = { id: customMatch[2], name: customMatch[1] }; rest = customMatch[3]; }
  else {
    const unicodeMatch = trimmed.match(/^(\p{Extended_Pictographic}|\p{Emoji})(\uFE0F)?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji}))*\s*(.+)$/u);
    if (unicodeMatch) { emoji = trimmed.slice(0, trimmed.length - unicodeMatch[3].length).trim(); rest = unicodeMatch[3]; }
  }
  // rest = 'CamoName:price' or just 'CamoName'
  const parts = rest.split(':');
  const name = parts[0].trim();
  const price = parts[1] ? parseFloat(parts[1]) : null; // null = use service.pricePerCamo
  return { name, emoji, price };
}

async function postCamoToDiscord(channel, service) {
  const brandColor = store.settings.color || 0x9b59ff;
  const cur = store.settings.currency;
  const allImages = service.images || [];
  const mainEmbed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🎨 ' + service.titleEn)
    .setDescription(
      (service.titleAr ? '**' + service.titleAr + '**\n' : '') +
      '```yaml\n' + service.game + ' • camo unlock```\n' +
      (service.descriptionEn ? '📋 ' + service.descriptionEn + '\n' : '') +
      (service.descriptionAr ? '📋 ' + service.descriptionAr + '\n' : '')
    )
    .addFields(
      { name: '🎮 Game', value: service.game, inline: true },
      { name: '⏱️ ETA', value: service.eta, inline: true },
      { name: '💰 Starting from', value: '```fix\n' + cur + service.pricePerCamo.toFixed(2) + ' per camo```', inline: false }
    );
  // Show gun list if defined
  if (service.gunList && service.gunList.length > 0) {
    const gunsText = service.gunList.slice(0, 20).map(g => {
      const em = g.emoji ? (typeof g.emoji === 'object' ? '<:'+g.emoji.name+':'+g.emoji.id+'>' : g.emoji) + ' ' : '';
      return em + '`' + g.name + '`';
    }).join(', ');
    mainEmbed.addFields({ name: '🔫 Available Guns', value: gunsText, inline: false });
  }
  mainEmbed.setFooter({ text: store.settings.storeName + ' • Camo Unlock • ID: ' + service.id + ' • Click Order to pick your camos' });
  mainEmbed.setTimestamp();

  const files = [];
  const embeds = [mainEmbed];
  let imgCount = 0;
  
  // Auto-attach default camo image if no custom images
  if (allImages.length === 0) {
    const imgPath = path.join(__dirname, 'images', 'camo-unlock.png');
    if (fs.existsSync(imgPath)) {
      const fileName = 'camo_' + service.id + '_default.png';
      files.push(new AttachmentBuilder(fs.readFileSync(imgPath), { name: fileName }));
      mainEmbed.setImage('attachment://' + fileName);
      imgCount = 1;
    }
  }
  
  for (let i = 0; i < allImages.length; i++) {
    const parsed = base64ToBuffer(allImages[i]);
    if (!parsed) continue;
    const fileName = 'camo_' + service.id + '_' + (i + 1) + '.jpg';
    files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
    imgCount++;
    if (imgCount === 1) mainEmbed.setImage('attachment://' + fileName);
    else embeds.push(new EmbedBuilder().setColor(brandColor).setImage('attachment://' + fileName));
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ordercamo_' + service.id).setLabel('اطلب الآن / Order Camo Unlock').setStyle(ButtonStyle.Success).setEmoji('🎨')
  );
  const msg = await channel.send({ embeds, components: [row], files });
  service.discordMessageIds.push(msg.id);
  saveStore();
}

app.put('/api/camo/:id', (req, res) => {
  try {
    const s = store.camoServices.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    const body = { ...req.body };
    if (Array.isArray(body.camoList)) body.camoList = body.camoList.map(parseCamoEntry);
    if (body.gunList) {
      const parsed = parseGunListInput(body.gunList);
      body.gunList = parsed.gunList;
      body.gunCategories = parsed.gunCategories;
    }
    Object.assign(s, body, { id: s.id });
    saveStore(); res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/camo/:id', async (req, res) => {
  try {
    const s = store.camoServices.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.discordMessageIds && s.discordMessageIds.length && client.isReady()) {
      const channelId = store.settings.camoChannelId || store.settings.accountsChannelId;
      const ch = client.channels.cache.get(channelId);
      if (ch) for (const mid of s.discordMessageIds) { try { await ch.messages.delete(mid); } catch(e){} }
    }
    store.camoServices = store.camoServices.filter(x => x.id !== parseInt(req.params.id));
    saveStore(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/camo/:id/repost', async (req, res) => {
  try {
    const s = store.camoServices.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    const channelId = store.settings.camoChannelId || store.settings.accountsChannelId;
    if (!channelId || !client.isReady()) return res.status(400).json({ error: 'Bot not ready or channel not set' });
    const ch = client.channels.cache.get(channelId);
    if (!ch) return res.status(400).json({ error: 'Channel not found' });
    for (const mid of s.discordMessageIds) { try { await ch.messages.delete(mid); } catch(e){} }
    s.discordMessageIds = [];
    await postCamoToDiscord(ch, s);
    saveStore();
    addLog('INFO', `Camo service ${s.id} re-posted to Discord`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark a camo order complete (admin delivers completion message + closes ticket)
app.post('/api/camo/:id/complete', async (req, res) => {
  try {
    const ticket = store.tickets.find(t => t.camoServiceId === parseInt(req.params.id) && t.status === 'camo_in_progress');
    if (!ticket) return res.status(404).json({ error: 'No in-progress camo ticket for this service' });
    const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
    if (pr) pr.status = 'Delivered';
    ticket.status = 'closed';
    ticket.closedAt = new Date().toISOString();
    if (ticket.channelId && client.isReady()) {
      const ch = client.channels.cache.get(ticket.channelId);
      if (ch) {
        const embed = new EmbedBuilder()
          .setColor(0x3ddc84)
          .setTitle('✅ تم اكتمال فتح الكاموهات!')
          .setDescription(
            `**مرحباً ${ticket.userName}! 👋**\n\n` +
            `🎨 تم فتح جميع الكاموهات المطلوبة بنجاح!\n\n` +
            `**📋 تفاصيل الخدمة:**\n` +
            `🎨 الخدمة: ${ticket.accountTitle}\n` +
            `🎫 رقم التذكرة: \`${ticket.id}\`\n\n` +
            `🎮 حسابك جاهز الآن — يمكنك الدخول والتحقق من الكاموهات!\n\n` +
            `🙏 شكراً لثقتك في **${store.settings.storeName}**!\n` +
            `نتمنى نراك مرة أخرى 🌟`
          )
          .setFooter({ text: store.settings.storeName + ' • سيتم إغلاق التذكرة خلال ' + (store.settings.autoCloseSeconds || 15) + ' ثانية' })
          .setTimestamp();
        await ch.send({ embeds: [embed] });
        setTimeout(async () => { try { await ch.delete('Camo complete — ticket auto-closed'); } catch (e) {} }, (store.settings.autoCloseSeconds || 15) * 1000);
      }
    }
    // ===== DM the buyer that camo unlock is complete =====
    if (ticket.userId && client.isReady()) {
      try {
        const user = await client.users.fetch(ticket.userId);
        const dmEmbed = new EmbedBuilder()
          .setColor(0x3ddc84)
          .setTitle('✅ تم اكتمال فتح الكاموهات!')
          .setDescription(
            `**مرحباً ${ticket.userName}! 👋**\n\n` +
            `🎨 تم فتح جميع الكاموهات المطلوبة بنجاح!\n\n` +
            `**📋 تفاصيل الخدمة:**\n` +
            `🎨 الخدمة: ${ticket.accountTitle}\n` +
            `🎫 رقم التذكرة: \`${ticket.id}\`\n\n` +
            `🎮 حسابك جاهز الآن — يمكنك الدخول والتحقق من الكاموهات!\n\n` +
            `🙏 شكراً لثقتك في **${store.settings.storeName}**!\n` +
            `لأي استفسار، افتح تذكرة في السيرفر.`
          )
          .setFooter({ text: store.settings.storeName })
          .setTimestamp();
        await user.send({ embeds: [dmEmbed] });
      } catch (e) {}
    }
    saveStore();
    addLog('INFO', `Camo service ${req.params.id} marked complete, ticket ${ticket.id} closing`);
    sendLogToDiscord(`🎨 Camo complete for ticket \`${ticket.id}\` — **${ticket.accountTitle}**`);
    res.json({ success: true, ticketId: ticket.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== BOOSTING SLOTS (customizable 5-slot boosting services) =====
app.get('/api/boost-slots', (req, res) => { try { res.json(store.boostSlots); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/boost-slots', async (req, res) => {
  try {
    const { titleEn, titleAr, game, price, slots, eta, descriptionEn, descriptionAr, images } = req.body;
    if (!titleEn) return res.status(400).json({ error: 'Title required' });
    const service = {
      id: genId(), titleEn, titleAr: titleAr || '',
      game: game || 'Call of Duty',
      price: parseFloat(price) || 0,
      slots: Array.isArray(slots) ? slots.filter(s => s.name).map(s => ({ name: s.name, price: parseFloat(s.price) || 0 })) : [],
      eta: eta || '24-48 hours',
      descriptionEn: descriptionEn || '', descriptionAr: descriptionAr || '',
      images: Array.isArray(images) ? images : [],
      status: 'active',
      createdAt: new Date().toISOString(), discordMessageIds: []
    };
    store.boostSlots.push(service);
    saveStore();
    const channelId = store.settings.boostSlotChannelId || store.settings.accountsChannelId;
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) await postBoostSlotToDiscord(channel, service).catch(e => addLog('ERROR', 'Boost Slot post failed: ' + e.message));
    }
    addLog('INFO', `Boosting Slot service created: ${titleEn}`);
    res.json(service);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/boost-slots/:id', (req, res) => {
  try {
    const s = store.boostSlots.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    const body = { ...req.body };
    if (Array.isArray(body.slots)) body.slots = body.slots.filter(sl => sl.name).map(sl => ({ name: sl.name, price: parseFloat(sl.price) || 0 }));
    Object.assign(s, body, { id: s.id });
    saveStore(); res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/boost-slots/:id', async (req, res) => {
  try {
    const s = store.boostSlots.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.discordMessageIds && s.discordMessageIds.length && client.isReady()) {
      const channelId = store.settings.boostSlotChannelId || store.settings.accountsChannelId;
      const ch = client.channels.cache.get(channelId);
      if (ch) for (const mid of s.discordMessageIds) { try { await ch.messages.delete(mid); } catch(e){} }
    }
    store.boostSlots = store.boostSlots.filter(x => x.id !== parseInt(req.params.id));
    saveStore(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/boost-slots/:id/repost', async (req, res) => {
  try {
    const s = store.boostSlots.find(x => x.id === parseInt(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    const channelId = store.settings.boostSlotChannelId || store.settings.accountsChannelId;
    if (!channelId || !client.isReady()) return res.status(400).json({ error: 'Bot not ready or channel not set' });
    const ch = client.channels.cache.get(channelId);
    if (!ch) return res.status(400).json({ error: 'Channel not found' });
    for (const mid of s.discordMessageIds) { try { await ch.messages.delete(mid); } catch(e){} }
    s.discordMessageIds = [];
    await postBoostSlotToDiscord(ch, s);
    saveStore();
    addLog('INFO', `Boost Slot service ${s.id} re-posted to Discord`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function postBoostSlotToDiscord(channel, service) {
  const brandColor = store.settings.color || 0x9b59ff;
  const cur = store.settings.currency;
  const allImages = service.images || [];
  const mainEmbed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('⚡ ' + service.titleEn)
    .setDescription(
      (service.titleAr ? '**' + service.titleAr + '**\n' : '') +
      '```yaml\n' + service.game + ' • boosting```\n' +
      (service.descriptionEn ? '📋 ' + service.descriptionEn + '\n' : '') +
      (service.descriptionAr ? '📋 ' + service.descriptionAr + '\n' : '')
    )
    .addFields(
      { name: '🎮 Game', value: service.game, inline: true },
      { name: '⏱️ ETA', value: service.eta, inline: true },
      { name: '💰 Starting from', value: '```fix\n' + cur + service.price.toFixed(2) + '```', inline: false }
    );
  // Show slots
  if (service.slots && service.slots.length > 0) {
    const slotsText = service.slots.map(s => '`' + s.name + '` (' + cur + s.price.toFixed(2) + ')').join('\n');
    mainEmbed.addFields({ name: '⚡ Available Options', value: slotsText, inline: false });
  }
  mainEmbed.setFooter({ text: store.settings.storeName + ' • Boosting • ID: ' + service.id });
  mainEmbed.setTimestamp();

  const files = [];
  const embeds = [mainEmbed];
  let imgCount = 0;

  if (allImages.length === 0) {
    const imgPath = path.join(__dirname, 'images', 'boosting.png');
    if (fs.existsSync(imgPath)) {
      const fileName = 'boost_' + service.id + '_default.png';
      files.push(new AttachmentBuilder(fs.readFileSync(imgPath), { name: fileName }));
      mainEmbed.setImage('attachment://' + fileName);
      imgCount = 1;
    }
  }

  for (let i = 0; i < allImages.length; i++) {
    const parsed = base64ToBuffer(allImages[i]);
    if (!parsed) continue;
    const fileName = 'boost_' + service.id + '_' + (i + 1) + '.jpg';
    files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
    imgCount++;
    if (imgCount === 1) mainEmbed.setImage('attachment://' + fileName);
    else embeds.push(new EmbedBuilder().setColor(brandColor).setImage('attachment://' + fileName));
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('orderboostslot_' + service.id).setLabel('اطلب الآن / Order Boosting').setStyle(ButtonStyle.Success).setEmoji('⚡')
  );
  const msg = await channel.send({ embeds, components: [row], files });
  service.discordMessageIds.push(msg.id);
  saveStore();
}

// ===== COUPONS =====
app.get('/api/coupons', (req, res) => { try { res.json(store.coupons); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/coupons', (req, res) => {
  try {
    const { code, type, value, maxUses, expiresAt, active } = req.body;
    if (!code || !type || value === undefined) return res.status(400).json({ error: 'code, type, value required' });
    if (store.coupons.find(c => c.code.toUpperCase() === code.toUpperCase())) return res.status(400).json({ error: 'Coupon code already exists' });
    const coupon = {
      id: genId(),
      code: code.toUpperCase(),
      type: type === 'percent' ? 'percent' : 'fixed', // percent | fixed
      value: parseFloat(value),
      maxUses: parseInt(maxUses) || 999999,
      uses: 0,
      expiresAt: expiresAt || null,
      active: active !== false,
      createdAt: new Date().toISOString()
    };
    store.coupons.push(coupon);
    saveStore();
    addLog('INFO', `Coupon created: ${coupon.code}`);
    res.json(coupon);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/coupons/:id', (req, res) => {
  try {
    const c = store.coupons.find(x => x.id === parseInt(req.params.id));
    if (!c) return res.status(404).json({ error: 'Not found' });
    Object.assign(c, req.body, { id: c.id });
    saveStore();
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/coupons/:id', (req, res) => {
  try {
    store.coupons = store.coupons.filter(c => c.id !== parseInt(req.params.id));
    saveStore();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SETTINGS =====
app.get('/api/settings', (req, res) => { try { res.json(store.settings); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/settings', (req, res) => { try { Object.assign(store.settings, req.body); saveStore(); addLog('INFO', 'Settings updated'); res.json(store.settings); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== LOGS =====
app.get('/api/logs', (req, res) => { try { res.json(store.logs); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/logs', (req, res) => { try { store.logs = []; saveStore(); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== BACKUP / RESTORE =====
app.get('/api/backup', (req, res) => {
  try {
    // Allow auth via query param (for download links) or header
    const sid = req.query.session || req.headers['x-session'];
    if (!isValidSession(sid)) return res.status(401).json({ error: 'Unauthorized' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="isiam-store-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.send(JSON.stringify(store, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', (req, res) => {
  try {
    if (!req.body || !req.body.accounts) return res.status(400).json({ error: 'Invalid backup format' });
    store = { ...DEFAULT_STORE, ...req.body, settings: { ...DEFAULT_STORE.settings, ...(req.body.settings || {}) } };
    saveStore();
    addLog('WARN', 'Store restored from backup');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== BROADCAST (announcement to log channel) =====
app.post('/api/broadcast', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    let sent = 0, failed = 0;
    if (client.isReady()) {
      for (const c of store.customers) {
        if (c.trust === 'Blacklisted') continue;
        try {
          const user = await client.users.fetch(c.discordId);
          await user.send(`📢 **${store.settings.storeName} — إعلان / Announcement**\n\n${message}`);
          sent++;
        } catch (e) { failed++; }
        // Discord rate limit safety
        await new Promise(r => setTimeout(r, 800));
      }
    }
    addLog('INFO', `Broadcast sent to ${sent} customers (${failed} failed)`);
    res.json({ sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on('ready', () => {
  console.log(`[${STORE_NAME}] Bot online as ${client.user.tag}`);
  // Try to set the bot's avatar to logo.png
  try {
    const logoPath = path.join(__dirname, 'logo.png');
    if (fs.existsSync(logoPath) && !client.user.avatar) {
      const avatarBuf = fs.readFileSync(logoPath);
      client.user.setAvatar(avatarBuf).then(() => {
        client.user.setActivity('isiam store', { type: 3 /* Watching */ });
        console.log('[isiam store] Avatar + activity set');
      }).catch(e => console.warn('Avatar set failed:', e.message));
    } else {
      client.user.setActivity('isiam store', { type: 3 });
    }
  } catch (e) {}
  addLog('INFO', 'Bot connected to Discord as ' + client.user.tag);
  sendLogToDiscord(`🟢 **${STORE_NAME}** — Bot Online`);
});

// ===== INTERACTION HANDLER =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  try {
    // ---- BUY BUTTON → Create Private Ticket ----
    if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc || acc.status !== 'available') {
        return interaction.reply({ content: '❌ هذا المنتج لم يعد متوفرًا / This product is no longer available.', ephemeral: true });
      }

      const existing = store.tickets.find(t =>
        t.userId === interaction.user.id && t.accountId === accId && t.status !== 'closed'
      );
      if (existing) {
        const ch = client.channels.cache.get(existing.channelId);
        if (ch) return interaction.reply({ content: `🎫 لديك تذكرة مفتوحة بالفعل لهذا المنتج: <#${existing.channelId}>`, ephemeral: true });
      }

      const categoryId = store.settings.ticketCategoryId;
      if (!categoryId) return interaction.reply({ content: '❌ النظام غير جاهز حالياً / System not ready.', ephemeral: true });
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ يعمل فقط داخل السيرفر / Works inside server only.', ephemeral: true });
      const category = guild.channels.cache.get(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ خطأ في إعدادات التذاكر / Ticket misconfigured.', ephemeral: true });

      acc.status = 'reserved';
      saveStore();

      const ticketChannel = await guild.channels.create({
        name: `🎫-${interaction.user.username}-${accId}`,
        type: ChannelType.GuildText,
        parent: category,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
        ]
      });

      if (store.settings.ownerId) {
        await ticketChannel.permissionOverwrites.create(store.settings.ownerId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true
        }).catch(() => {});
      }
      // Staff role access
      if (Array.isArray(store.settings.staffRoleIds)) {
        for (const rid of store.settings.staffRoleIds) {
          if (rid) await ticketChannel.permissionOverwrites.create(rid, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true
          }).catch(() => {});
        }
      }

      const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(4, '0');
      const ticket = {
        id: ticketId, userId: interaction.user.id, userName: interaction.user.username,
        accountId: accId, accountTitle: acc.titleEn, amount: acc.price,
        channelId: ticketChannel.id, paymentId: null, paymentMethod: null,
        status: 'open', createdAt: new Date().toISOString()
      };
      store.tickets.unshift(ticket);
      saveStore();

      // Payment method select
      const pay = store.settings;
      const options = [];
      if (pay.stcPay && pay.stcPay.number) options.push({ label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + pay.stcPay.number, emoji: '📱' });
      if (pay.alrajhi && pay.alrajhi.iban) options.push({ label: 'AlRajhi Bank', value: 'alrajhi', description: 'تحويل بنكي الراجحي', emoji: '🏦' });
      if (pay.paypal && pay.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal Link', emoji: '💳' });
      if (options.length === 0) options.push({ label: 'No payment methods', value: 'none', description: 'Contact admin' });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('paymethod_' + accId + '_' + ticketId)
        .setPlaceholder('اختر طريقة الدفع / Choose payment method')
        .addOptions(options);

      // Coupon input button
      const welcomeEmbed = new EmbedBuilder()
        .setColor(store.settings.color || 0x9b59ff)
        .setTitle('🛒 طلب شراء جديد / New Purchase Request')
        .setDescription(
          `**${store.settings.storeName}**\n\n` +
          `👤 العميل / Customer: **${interaction.user.username}**\n` +
          `📦 المنتج / Product: **${acc.titleEn}**\n` +
          `💰 السعر / Price: \`${pay.currency}${acc.price.toFixed(2)}\`\n` +
          `🎫 رقم التذكرة / Ticket: \`${ticketId}\`\n\n` +
          (pay.welcomeAr || '') + '\n' + (pay.welcomeEn || '')
        )
        .setThumbnail('attachment://logo.png')
        .addFields(
          { name: '📋 الخطوات / Steps', value: '1️⃣ اختر طريقة الدفع\n2️⃣ حول المبلغ المطلوب\n3️⃣ ارفع صورة الإيصال هنا\n4️⃣ انتظر التأكيد واستلم الحساب', inline: false }
        )
        .setFooter({ text: store.settings.storeName + ' • ' + ticketId })
        .setTimestamp();

      const files = [];
      try {
        const logoPath = path.join(__dirname, 'logo.png');
        if (fs.existsSync(logoPath)) files.push(new AttachmentBuilder(fs.readFileSync(logoPath), { name: 'logo.png' }));
      } catch (e) {}

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket_' + ticketId).setLabel('إغلاق / Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('coupon_' + ticketId).setLabel('كود خصم / Coupon').setStyle(ButtonStyle.Secondary).setEmoji('🎁')
      );

      await ticketChannel.send({
        content: '👤 <@' + interaction.user.id + '> | 🎫 تذكرة شراء خاصة / Private Purchase Ticket',
        embeds: [welcomeEmbed],
        components: [new ActionRowBuilder().addComponents(selectMenu), closeRow],
        files
      });

      await interaction.reply({ content: '🎫 تم إنشاء تذكرة خاصة بك: <#' + ticketChannel.id + '>', ephemeral: true });
      addLog('INFO', `Ticket ${ticketId} created for ${interaction.user.username} → ${acc.titleEn}`);
      sendLogToDiscord(`🎫 New ticket \`${ticketId}\` by **${interaction.user.username}** for **${acc.titleEn}** ($${acc.price})`);
      notifyOwner("🛒 طلب جديد!", `العميل: **${interaction.user.username}**\nالمنتج: **${acc.titleEn}**\nالسعر: \`$${acc.price}\`\nرقم التذكرة: \`${ticketId}\``);
      return;
    }

    // ---- BUY POOL BUTTON (Auto-Delivery) ----
    if (interaction.isButton() && interaction.customId.startsWith('buypool_')) {
      const poolId = parseInt(interaction.customId.split('_')[1]);
      const pool = store.pools.find(p => p.id === poolId);
      if (!pool || !pool.stock || pool.stock.length === 0) {
        return interaction.reply({ content: '❌ هذا المنتج غير متوفر حالياً / Out of stock.', ephemeral: true });
      }
      const existing = store.tickets.find(t =>
        t.userId === interaction.user.id && t.poolId === poolId && t.status !== 'closed'
      );
      if (existing) {
        const ch = client.channels.cache.get(existing.channelId);
        if (ch) return interaction.reply({ content: `🎫 لديك تذكرة مفتوحة: <#${existing.channelId}>`, ephemeral: true });
      }
      const categoryId = store.settings.ticketCategoryId;
      if (!categoryId) return interaction.reply({ content: '❌ النظام غير جاهز / System not ready.', ephemeral: true });
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ داخل السيرفر فقط / Inside server only.', ephemeral: true });
      const category = guild.channels.cache.get(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ خطأ / Misconfigured.', ephemeral: true });

      const ticketChannel = await guild.channels.create({
        name: `⚡-${interaction.user.username}-pool${poolId}`,
        type: ChannelType.GuildText,
        parent: category,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
        ]
      });
      if (store.settings.ownerId) {
        await ticketChannel.permissionOverwrites.create(store.settings.ownerId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true
        }).catch(() => {});
      }

      const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(4, '0');
      const ticket = {
        id: ticketId, userId: interaction.user.id, userName: interaction.user.username,
        accountId: null, poolId: poolId, accountTitle: pool.name + ' (Auto-Delivery)', amount: pool.price,
        channelId: ticketChannel.id, paymentId: null, paymentMethod: null,
        status: 'open', createdAt: new Date().toISOString()
      };
      store.tickets.unshift(ticket);
      saveStore();

      const pay = store.settings;
      const options = [];
      if (pay.stcPay && pay.stcPay.number) options.push({ label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + pay.stcPay.number, emoji: '📱' });
      if (pay.alrajhi && pay.alrajhi.iban) options.push({ label: 'AlRajhi Bank', value: 'alrajhi', description: 'الراجحي', emoji: '🏦' });
      if (pay.paypal && pay.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal Link', emoji: '💳' });
      if (options.length === 0) options.push({ label: 'No payment methods', value: 'none', description: 'Contact admin' });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('paymethodpool_' + poolId + '_' + ticketId)
        .setPlaceholder('اختر طريقة الدفع / Choose payment')
        .addOptions(options);

      const embed = new EmbedBuilder()
        .setColor(store.settings.color || 0x9b59ff)
        .setTitle('⚡ طلب شراء فوري / Instant Purchase Request')
        .setDescription(
          `**${store.settings.storeName}**\n\n` +
          `👤 العميل: **${interaction.user.username}**\n` +
          `📦 المنتج: **${pool.name}** (تسليم فوري / Auto-Delivery)\n` +
          `💰 السعر: \`${pay.currency}${pool.price.toFixed(2)}\`\n` +
          `🎫 التذكرة: \`${ticketId}\`\n\n` +
          `بعد تأكيد الدفع، سيتم تسليم الحساب فوراً وإغلاق التذكرة تلقائياً.\n` +
          `After payment confirmation, account is delivered instantly & ticket auto-closes.`
        )
        .setFooter({ text: store.settings.storeName + ' • ' + ticketId })
        .setTimestamp();

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket_' + ticketId).setLabel('إغلاق / Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('coupon_' + ticketId).setLabel('كود خصم / Coupon').setStyle(ButtonStyle.Secondary).setEmoji('🎁')
      );

      await ticketChannel.send({
        content: '👤 <@' + interaction.user.id + '> | ⚡ تذكرة شراء فوري / Instant Purchase Ticket',
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(selectMenu), closeRow]
      });

      await interaction.reply({ content: '🎫 تم إنشاء تذكرة: <#' + ticketChannel.id + '>', ephemeral: true });
      addLog('INFO', `Pool ticket ${ticketId} for ${interaction.user.username} → ${pool.name}`);
      sendLogToDiscord(`⚡ Pool ticket \`${ticketId}\` by **${interaction.user.username}** for **${pool.name}** ($${pool.price})`);
      notifyOwner("⚡ طلب جديد!", `العميل: **${interaction.user.username}**\nالمنتج: **${pool.name}**\nالسعر: \`$${pool.price}\`\nرقم التذكرة: \`${ticketId}\``);
      return;
    }

    // ---- BUY DIGITAL BUTTON (instant code delivery) ----
    if (interaction.isButton() && interaction.customId.startsWith('buydig_')) {
      const digId = parseInt(interaction.customId.split('_')[1]);
      const dig = store.digitalProducts.find(d => d.id === digId);
      if (!dig || !dig.stock || dig.stock.length === 0) {
        return interaction.reply({ content: '❌ نفدت الكمية / Out of stock.', ephemeral: true });
      }
      const existing = store.tickets.find(t =>
        t.userId === interaction.user.id && t.digitalProductId === digId && t.status !== 'closed'
      );
      if (existing) {
        const ch = client.channels.cache.get(existing.channelId);
        if (ch) return interaction.reply({ content: `🎫 لديك تذكرة مفتوحة: <#${existing.channelId}>`, ephemeral: true });
      }
      const categoryId = store.settings.ticketCategoryId;
      if (!categoryId) return interaction.reply({ content: '❌ النظام غير جاهز / System not ready.', ephemeral: true });
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ داخل السيرفر فقط / Inside server only.', ephemeral: true });
      const category = guild.channels.cache.get(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ خطأ / Misconfigured.', ephemeral: true });

      const ticketChannel = await guild.channels.create({
        name: `🎫-${interaction.user.username}-dig${digId}`,
        type: ChannelType.GuildText,
        parent: category,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
        ]
      });
      if (store.settings.ownerId) {
        await ticketChannel.permissionOverwrites.create(store.settings.ownerId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true
        }).catch(() => {});
      }

      const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(4, '0');
      const ticket = {
        id: ticketId, userId: interaction.user.id, userName: interaction.user.username,
        accountId: null, poolId: null, digitalProductId: digId, boostingServiceId: null,
        accountTitle: dig.titleEn + ' (Digital)', amount: dig.price,
        channelId: ticketChannel.id, paymentId: null, paymentMethod: null,
        status: 'open', createdAt: new Date().toISOString()
      };
      store.tickets.unshift(ticket);
      saveStore();

      const pay = store.settings;
      const options = [];
      if (pay.stcPay && pay.stcPay.number) options.push({ label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + pay.stcPay.number, emoji: '📱' });
      if (pay.alrajhi && pay.alrajhi.iban) options.push({ label: 'AlRajhi Bank', value: 'alrajhi', description: 'الراجحي', emoji: '🏦' });
      if (pay.paypal && pay.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal Link', emoji: '💳' });
      if (options.length === 0) options.push({ label: 'No payment methods', value: 'none', description: 'Contact admin' });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('paymethoddig_' + digId + '_' + ticketId)
        .setPlaceholder('اختر طريقة الدفع / Choose payment')
        .addOptions(options);

      const embed = new EmbedBuilder()
        .setColor(store.settings.color || 0x9b59ff)
        .setTitle('🎫 طلب منتج رقمي / Digital Purchase Request')
        .setDescription(
          `**${store.settings.storeName}**\n\n` +
          `👤 العميل: **${interaction.user.username}**\n` +
          `📦 المنتج: **${dig.titleEn}** (${dig.platform})\n` +
          `💰 السعر: \`${pay.currency}${dig.price.toFixed(2)}\`\n` +
          `🎫 التذكرة: \`${ticketId}\`\n\n` +
          `بعد تأكيد الدفع، سيتم تسليم الكود فوراً وإغلاق التذكرة.\n` +
          `After payment confirmation, code is delivered instantly & ticket auto-closes.`
        )
        .setFooter({ text: store.settings.storeName + ' • ' + ticketId })
        .setTimestamp();

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket_' + ticketId).setLabel('إغلاق / Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('coupon_' + ticketId).setLabel('كود خصم / Coupon').setStyle(ButtonStyle.Secondary).setEmoji('🎁')
      );

      await ticketChannel.send({
        content: '👤 <@' + interaction.user.id + '> | 🎫 تذكرة منتج رقمي / Digital Purchase Ticket',
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(selectMenu), closeRow]
      });

      await interaction.reply({ content: '🎫 تم إنشاء تذكرة: <#' + ticketChannel.id + '>', ephemeral: true });
      addLog('INFO', `Digital ticket ${ticketId} for ${interaction.user.username} → ${dig.titleEn}`);
      sendLogToDiscord(`🎫 Digital ticket \`${ticketId}\` by **${interaction.user.username}** for **${dig.titleEn}** ($${dig.price})`);
      notifyOwner("🎫 طلب جديد!", `العميل: **${interaction.user.username}**\nالمنتج: **${dig.titleEn}**\nالسعر: \`$${dig.price}\`\nرقم التذكرة: \`${ticketId}\``);
      return;
    }

    // ---- ORDER BOOST BUTTON → customer choice flow ----
    if (interaction.isButton() && interaction.customId.startsWith('orderboost_')) {
      const boostId = parseInt(interaction.customId.split('_')[1]);
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ الخدمة غير موجودة / Service missing.', ephemeral: true });

      const existing = store.tickets.find(t => t.userId === interaction.user.id && t.boostingServiceId === boostId && t.status !== 'closed');
      if (existing) {
        const ch = client.channels.cache.get(existing.channelId);
        if (ch) return interaction.reply({ content: `🎫 لديك تذكرة مفتوحة: <#${existing.channelId}>`, ephemeral: true });
      }

      const brandColor = store.settings.color || 0x9b59ff;
      const cur = store.settings.currency;

      // ===== RANK BOOST with customer choice (uses expanded ranks with emojis) =====
      if (boost.serviceType === 'rank' && boost.rankList && boost.rankList.length >= 2 && boost.pricePerRank > 0) {
        const expanded = getExpandedRanks(boost);
        // Discord select menu max 25 options
        const options = expanded.slice(0, 25).map(r => ({
          label: r.label.slice(0, 100), value: String(r.globalIdx),
          description: 'Select if your current rank is ' + r.label,
          emoji: r.emoji || undefined
        }));
        const select = new StringSelectMenuBuilder().setCustomId('bstrf_' + boostId).setPlaceholder('اختر رتبتك الحالية / Select your CURRENT rank').addOptions(options);
        const rankSummary = boost.rankList.map(r => (r.emoji ? r.emoji + ' ' : '') + '`' + r.name + '`').join(' → ');
        const embed = new EmbedBuilder().setColor(brandColor).setTitle('🚀 ' + boost.titleEn).setDescription(`**Choose your current rank to start.**\n📋 Available ranks: ${rankSummary}\n📊 ${(boost.rankTiers||3)} tiers each (I, II, III)\n💰 Price: \`${cur}${boost.pricePerRank} per tier\``).setFooter({ text: store.settings.storeName + ' • Step 1 of 2' });
        return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
      // ===== PRESTIGE with customer choice =====
      if (boost.serviceType === 'prestige' && boost.maxPrestige > 0 && boost.pricePerPrestige > 0) {
        const pem = boost.prestigeEmoji || '🎖️';
        const options = [];
        for (let lvl = 1; lvl <= Math.min(boost.maxPrestige, 25); lvl++) {
          options.push({ label: 'Prestige ' + lvl, value: String(lvl), description: cur + (boost.pricePerPrestige * lvl).toFixed(2), emoji: pem });
        }
        const select = new StringSelectMenuBuilder().setCustomId('bstp_' + boostId).setPlaceholder('اختر مستوى البريستيج / Select target prestige').addOptions(options);
        const embed = new EmbedBuilder().setColor(brandColor).setTitle('🚀 ' + boost.titleEn).setDescription(`**Choose your target prestige level.**\n💰 Price: \`${cur}${boost.pricePerPrestige} × level\`\n📊 Available: ${pem} 1 to ${boost.maxPrestige}`).setFooter({ text: store.settings.storeName });
        return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
      // ===== GUN LEVEL with customer choice (2-step: category → gun → modal) =====
      if (boost.serviceType === 'gun_level' && boost.gunList && boost.gunList.length > 0) {
        const categories = getGunCategories(boost);
        // If multiple categories → show category select first
        if (categories.length > 1) {
          const catOptions = categories.slice(0, 25).map((c, i) => ({
            label: c.name.slice(0, 100),
            value: String(i),
            description: c.guns.length + ' guns available',
            emoji: c.emoji || undefined
          }));
          const select = new StringSelectMenuBuilder()
            .setCustomId('bstcat_' + boostId)
            .setPlaceholder('اختر فئة السلاح / Select gun category')
            .addOptions(catOptions);
          const embed = new EmbedBuilder()
            .setColor(brandColor)
            .setTitle('🚀 ' + boost.titleEn)
            .setDescription(
              `**اختر فئة السلاح أولاً / Choose a gun category first.**\n\n` +
              `📋 الفئات المتاحة: ${categories.length}\n` +
              `🔫 إجمالي الأسلحة: ${boost.gunList.length}\n` +
              `💰 السعر: \`$${(boost.gunList[0]?.pricePerLevel > 0 ? boost.gunList[0].pricePerLevel : 13)} لكل سلاح للمستوى الأقصى\`\n` +
              `📊 الحد الأقصى للمستوى: ${boost.maxGunLevel}`
            )
            .setFooter({ text: store.settings.storeName + ' • الخطوة 1 من 3' });
          return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
        }
        // Single category (or flat list) → go straight to gun select
        return await showGunSelectForBoost(interaction, boost, 0);
      }

      // ===== FALLBACK: no customer-choice config → create ticket directly with fixed price =====
      return await createBoostingTicket(interaction, boost, {}, boost.price);
    }

    // ---- ORDER CAMO BUTTON → customer choice flow (pick gun → multi-select camos → confirm) ----
    if (interaction.isButton() && interaction.customId.startsWith('ordercamo_')) {
      const camoId = parseInt(interaction.customId.split('_')[1]);
      const camo = store.camoServices.find(s => s.id === camoId);
      if (!camo) return interaction.reply({ content: '❌ الخدمة غير موجودة / Service missing.', ephemeral: true });
      const existing = store.tickets.find(t => t.userId === interaction.user.id && t.camoServiceId === camoId && t.status !== 'closed');
      if (existing) {
        const ch = client.channels.cache.get(existing.channelId);
        if (ch) return interaction.reply({ content: `🎫 لديك تذكرة مفتوحة: <#${existing.channelId}>`, ephemeral: true });
      }
      const brandColor = store.settings.color || 0x9b59ff;
      const cur = store.settings.currency;
      // If gunList exists → customer picks gun first
      if (camo.gunList && camo.gunList.length > 0) {
        const options = camo.gunList.slice(0, 25).map((g, i) => ({ label: g.name.slice(0, 100), value: String(i), description: 'Select this gun', emoji: g.emoji || undefined }));
        const select = new StringSelectMenuBuilder().setCustomId('camogun_' + camoId).setPlaceholder('اختر السلاح / Select your gun').addOptions(options);
        const embed = new EmbedBuilder().setColor(brandColor).setTitle('🎨 ' + camo.titleEn).setDescription(`**Choose which gun to unlock camos for.**\n💰 Price: \`${cur}${camo.pricePerCamo} per camo\``).setFooter({ text: store.settings.storeName + ' • Step 1 of 2' });
        return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
      // No gunList → go straight to camo multi-select
      return await showCamoMultiSelect(interaction, camo, null);
    }

    // ---- CAMO: customer selected gun → show camo multi-select ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('camogun_')) {
      const camoId = parseInt(interaction.customId.split('_')[1]);
      const camo = store.camoServices.find(s => s.id === camoId);
      if (!camo) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const gunIdx = parseInt(interaction.values[0]);
      const gun = camo.gunList[gunIdx];
      if (!gun) return interaction.reply({ content: '❌ Invalid gun.', ephemeral: true });
      await interaction.deferUpdate();
      return await showCamoMultiSelect(interaction, camo, gunIdx);
    }

    // ---- CAMO: customer selected camos → show confirm with total price ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('camocamos_')) {
      const parts = interaction.customId.split('_');
      const camoId = parseInt(parts[1]);
      const gunIdx = parts[2] === 'null' ? null : parseInt(parts[2]);
      const camo = store.camoServices.find(s => s.id === camoId);
      if (!camo) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const selectedIndices = interaction.values.map(v => parseInt(v));
      const selectedCamos = selectedIndices.map(i => camo.camoList[i]).filter(Boolean);
      if (selectedCamos.length === 0) return interaction.reply({ content: '❌ اختر كامو واحد على الأقل / Select at least 1 camo.', ephemeral: true });
      const totalPrice = selectedCamos.reduce((sum, c) => {
        const p = (c.price !== null && c.price !== undefined) ? c.price : camo.pricePerCamo;
        return sum + p;
      }, 0);
      const cur = store.settings.currency;
      const gunName = gunIdx !== null && camo.gunList[gunIdx] ? camo.gunList[gunIdx].name : 'Any gun';
      const camosList = selectedCamos.map(c => (c.emoji ? (typeof c.emoji === 'object' ? '<:'+c.emoji.name+':'+c.emoji.id+'>' : c.emoji) + ' ' : '') + c.name).join(', ');
      const embed = new EmbedBuilder().setColor(store.settings.color || 0x9b59ff).setTitle('✅ Confirm Your Camo Unlock').setDescription(`**${camo.titleEn}**\n🔫 Gun: \`${gunName}\`\n🎨 Camos: ${camosList}\n📊 Count: ${selectedCamos.length}\n💰 Total Price: \`${cur}${totalPrice.toFixed(2)}\`\n⏱️ ETA: \`${camo.eta}\`\n\nClick **Confirm** to create a ticket.`).setFooter({ text: store.settings.storeName });
      // Encode selected camo indices in the button customId (comma-separated)
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('camocamoc_' + camoId + '_' + gunIdx + '_' + selectedIndices.join(',')).setLabel('✅ تأكيد / Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bstcancel').setLabel('❌ إلغاء / Cancel').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({ embeds: [embed], components: [row] });
    }

    // ---- CAMO: confirm → create ticket ----
    if (interaction.isButton() && interaction.customId.startsWith('camocamoc_')) {
      const parts = interaction.customId.split('_');
      const camoId = parseInt(parts[1]);
      const gunIdx = parts[2] === 'null' ? null : parseInt(parts[2]);
      const selectedIndices = parts[3].split(',').map(s => parseInt(s)).filter(n => !isNaN(n));
      const camo = store.camoServices.find(s => s.id === camoId);
      if (!camo) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const selectedCamos = selectedIndices.map(i => camo.camoList[i]).filter(Boolean);
      const totalPrice = selectedCamos.reduce((sum, c) => {
        const p = (c.price !== null && c.price !== undefined) ? c.price : camo.pricePerCamo;
        return sum + p;
      }, 0);
      await interaction.deferUpdate();
      return await createCamoTicket(interaction, camo, gunIdx, selectedCamos, totalPrice);
    }

    // ---- RANK: customer selected CURRENT rank → show TARGET rank select (uses expanded ranks) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bstrf_')) {
      const boostId = parseInt(interaction.customId.split('_')[1]);
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const expanded = getExpandedRanks(boost);
      const fromIdx = parseInt(interaction.values[0]);
      const fromRank = expanded[fromIdx];
      if (!fromRank) return interaction.reply({ content: '❌ Invalid rank.', ephemeral: true });
      // Target options = ranks above current
      const targetOptions = [];
      for (let i = fromIdx + 1; i < expanded.length; i++) {
        const tiers = i - fromIdx;
        const price = boost.pricePerRank * tiers;
        targetOptions.push({ label: (fromRank.emoji ? fromRank.emoji + ' ' : '') + fromRank.label + ' → ' + (expanded[i].emoji ? expanded[i].emoji + ' ' : '') + expanded[i].label, value: String(i), description: store.settings.currency + price.toFixed(2) + ' (' + tiers + ' tier' + (tiers>1?'s':'') + ')', emoji: expanded[i].emoji || undefined });
      }
      if (targetOptions.length === 0) return interaction.reply({ content: '❌ لا توجد رتب أعلى من رتبتك الحالية / No higher ranks available.', ephemeral: true });
      const select = new StringSelectMenuBuilder().setCustomId('bstrt_' + boostId + '_' + fromIdx).setPlaceholder('اختر الرتبة المستهدفة / Select TARGET rank').addOptions(targetOptions.slice(0, 25));
      const embed = new EmbedBuilder().setColor(store.settings.color || 0x9b59ff).setTitle('📈 Current: ' + (fromRank.emoji ? fromRank.emoji + ' ' : '') + fromRank.label).setDescription('**Now select your target rank.**').setFooter({ text: store.settings.storeName + ' • Step 2 of 2' });
      return interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
    }

    // ---- RANK: customer selected TARGET rank → show confirm with price ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bstrt_')) {
      const parts = interaction.customId.split('_');
      const boostId = parseInt(parts[1]);
      const fromIdx = parseInt(parts[2]);
      const toIdx = parseInt(interaction.values[0]);
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const expanded = getExpandedRanks(boost);
      const fromRank = expanded[fromIdx];
      const toRank = expanded[toIdx];
      if (!fromRank || !toRank) return interaction.reply({ content: '❌ Invalid ranks.', ephemeral: true });
      const tiers = toIdx - fromIdx;
      const price = boost.pricePerRank * tiers;
      const cur = store.settings.currency;
      const fromLabel = (fromRank.emoji ? fromRank.emoji + ' ' : '') + fromRank.label;
      const toLabel = (toRank.emoji ? toRank.emoji + ' ' : '') + toRank.label;
      const embed = new EmbedBuilder().setColor(store.settings.color || 0x9b59ff).setTitle('✅ Confirm Your Boost').setDescription(`**${boost.titleEn}**\n📈 Rank: \`${fromLabel}\` → \`${toLabel}\`\n📊 Tiers: ${tiers}\n💰 Price: \`${cur}${price.toFixed(2)}\`\n⏱️ ETA: \`${boost.eta}\`\n\nClick **Confirm** to create a ticket.`).setFooter({ text: store.settings.storeName });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bstrc_' + boostId + '_' + fromIdx + '_' + toIdx).setLabel('✅ تأكيد / Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bstcancel').setLabel('❌ إلغاء / Cancel').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({ embeds: [embed], components: [row] });
    }

    // ---- RANK: confirm → create ticket ----
    if (interaction.isButton() && interaction.customId.startsWith('bstrc_')) {
      const parts = interaction.customId.split('_');
      const boostId = parseInt(parts[1]);
      const fromIdx = parseInt(parts[2]);
      const toIdx = parseInt(parts[3]);
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const expanded = getExpandedRanks(boost);
      const fromRank = expanded[fromIdx];
      const toRank = expanded[toIdx];
      if (!fromRank || !toRank) return interaction.reply({ content: '❌ Invalid ranks.', ephemeral: true });
      const tiers = toIdx - fromIdx;
      const price = boost.pricePerRank * tiers;
      const fromLabel = (fromRank.emoji ? fromRank.emoji + ' ' : '') + fromRank.label;
      const toLabel = (toRank.emoji ? toRank.emoji + ' ' : '') + toRank.label;
      await interaction.deferUpdate();
      return await createBoostingTicket(interaction, boost, { type: 'rank', fromRank: fromLabel, toRank: toLabel, tiers }, price);
    }

    // ---- PRESTIGE: customer selected target level → show confirm ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bstp_')) {
      const boostId = parseInt(interaction.customId.split('_')[1]);
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const level = parseInt(interaction.values[0]);
      const price = boost.pricePerPrestige * level;
      const cur = store.settings.currency;
      const pem = boost.prestigeEmoji || '🎖️';
      const embed = new EmbedBuilder().setColor(store.settings.color || 0x9b59ff).setTitle('✅ Confirm Your Boost').setDescription(`**${boost.titleEn}**\n${pem} Target Prestige: \`${level}\`\n💰 Price: \`${cur}${price.toFixed(2)}\`\n⏱️ ETA: \`${boost.eta}\`\n\nClick **Confirm** to create a ticket.`).setFooter({ text: store.settings.storeName });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bstpc_' + boostId + '_' + level).setLabel('✅ تأكيد / Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bstcancel').setLabel('❌ إلغاء / Cancel').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({ embeds: [embed], components: [row] });
    }

    // ---- PRESTIGE: confirm → create ticket ----
    if (interaction.isButton() && interaction.customId.startsWith('bstpc_')) {
      const parts = interaction.customId.split('_');
      const boostId = parseInt(parts[1]);
      const level = parseInt(parts[2]);
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const price = boost.pricePerPrestige * level;
      await interaction.deferUpdate();
      return await createBoostingTicket(interaction, boost, { type: 'prestige', targetLevel: level }, price);
    }

    // ---- GUN: customer selected CATEGORY → show gun select from that category ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bstcat_')) {
      const boostId = parseInt(interaction.customId.split('_')[1]);
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const catIdx = parseInt(interaction.values[0]);
      // Use update() to replace the category select with the gun select (no defer needed)
      return await showGunSelectForBoost(interaction, boost, catIdx);
    }

    // ---- GUN: customer selected gun → show confirm with $13 flat price ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bstg_')) {
      const parts = interaction.customId.split('_');
      const boostId = parseInt(parts[1]);
      const catIdx = parseInt(parts[2] || '0');
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const categories = getGunCategories(boost);
      const cat = categories[catIdx] || categories[0];
      if (!cat) return interaction.reply({ content: '❌ Category missing.', ephemeral: true });
      const gunLocalIdx = parseInt(interaction.values[0]);
      const gun = cat.guns[gunLocalIdx];
      if (!gun) return interaction.reply({ content: '❌ Gun missing.', ephemeral: true });
      // Find global gun index in flat gunList
      const globalGunIdx = boost.gunList.findIndex(g => g.name === gun.name && g.emoji === gun.emoji);
      const gunEmoji = gun.emoji ? (typeof gun.emoji === 'object' ? '<:'+gun.emoji.name+':'+gun.emoji.id+'>' : gun.emoji) + ' ' : '🔫 ';
      const gunLabel = gunEmoji + gun.name;
      // $13 flat per gun to max out — no level entry needed
      const price = gun.pricePerLevel > 0 ? gun.pricePerLevel : 13;
      const cur = store.settings.currency;
      const embed = new EmbedBuilder()
        .setColor(store.settings.color || 0x9b59ff)
        .setTitle('✅ تأكيد الطلب')
        .setDescription(
          `**${boost.titleEn}**\n\n` +
          `🔫 السلاح: \`${gunLabel}\`\n` +
          `📊 الخدمة: رفع السلاح للمستوى الأقصى\n` +
          `💰 السعر: \`${cur}${price.toFixed(2)}\`\n` +
          `⏱️ المدة: \`${boost.eta}\`\n\n` +
          `اضغط **تأكيد** لإنشاء التذكرة`
        )
        .setFooter({ text: store.settings.storeName })
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bstgunconfirm_' + boostId + '_' + globalGunIdx + '_' + price).setLabel('✅ تأكيد').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bstcancel').setLabel('❌ إلغاء').setStyle(ButtonStyle.Danger)
      );
      return interaction.update({ embeds: [embed], components: [row] });
    }

    // ---- GUN: confirm → create ticket with flat $13 price ----
    if (interaction.isButton() && interaction.customId.startsWith('bstgunconfirm_')) {
      const parts = interaction.customId.split('_');
      const boostId = parseInt(parts[1]);
      const gunIdx = parseInt(parts[2]);
      const price = parseFloat(parts[3]) || 13;
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Service missing.', ephemeral: true });
      const gun = boost.gunList[gunIdx];
      if (!gun) return interaction.reply({ content: '❌ Gun missing.', ephemeral: true });
      const gunLabel = (gun.emoji ? (typeof gun.emoji === 'object' ? '<:'+gun.emoji.name+':'+gun.emoji.id+'>' : gun.emoji) + ' ' : '') + gun.name;
      await interaction.deferUpdate();
      return await createBoostingTicket(interaction, boost, { type: 'gun_level', gunName: gunLabel, fromLevel: 'current', toLevel: 'MAX', levels: 'MAX' }, price);
    }

    // ---- Cancel button for boost choice flow ----
    if (interaction.isButton() && interaction.customId === 'bstcancel') {
      return interaction.update({ content: '❌ تم الإلغاء / Cancelled.', embeds: [], components: [] });
    }

    // ---- PAYMENT METHOD SELECT (account ticket) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_') && !interaction.customId.startsWith('paymethodpool_') && !interaction.customId.startsWith('paymethoddig_') && !interaction.customId.startsWith('paymethodboost_') && !interaction.customId.startsWith('paymethodcamo_')) {
      const parts = interaction.customId.split('_');
      const accId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc) return interaction.reply({ content: '❌ المنتج غير موجود / Product missing.', ephemeral: true });
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ التذكرة غير موجودة / Ticket missing.', ephemeral: true });

      const method = interaction.values[0];
      const payId = createPaymentRequest(interaction, acc.id, acc.titleEn, acc.price, method, ticketId, null, null, null, null);
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal') textInfo = `💳 **PayPal**\nرابط: ${pay.paypal.email}`;

      const payEmbed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('💳 بيانات الدفع / Payment Instructions')
        .setDescription(
          `**المنتج:** ${acc.titleEn}\n` +
          `**المبلغ:** \`${pay.currency}${acc.price.toFixed(2)}\`\n` +
          `**رقم العملية:** \`${payId}\`\n\n` +
          textInfo + '\n\n' +
          '⚠️ **الخطوة التالية:**\nحوّل المبلغ ثم ارفع صورة الإيصال **هنا في التذكرة**.\nTransfer the amount then upload the receipt screenshot here.'
        )
        .setFooter({ text: store.settings.storeName + ' • Awaiting payment proof' })
        .setTimestamp();

      await interaction.reply({ embeds: [payEmbed] });
      addLog('INFO', `${interaction.user.username} selected ${method.toUpperCase()} for ${payId}`);
      return;
    }

    // ---- PAYMENT METHOD SELECT (pool ticket) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethodpool_')) {
      const parts = interaction.customId.split('_');
      const poolId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const pool = store.pools.find(p => p.id === poolId);
      if (!pool) return interaction.reply({ content: '❌ Pool missing.', ephemeral: true });
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket missing.', ephemeral: true });

      const method = interaction.values[0];
      const payId = createPaymentRequest(interaction, null, pool.name + ' (Auto-Delivery)', pool.price, method, ticketId, poolId, null, null, null);
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal') textInfo = `💳 **PayPal**\nرابط: ${pay.paypal.email}`;

      const payEmbed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('💳 بيانات الدفع / Payment Instructions')
        .setDescription(
          `**المنتج:** ${pool.name} (Auto-Delivery)\n` +
          `**المبلغ:** \`${pay.currency}${pool.price.toFixed(2)}\`\n` +
          `**رقم العملية:** \`${payId}\`\n\n` +
          textInfo + '\n\n' +
          '⚠️ حوّل المبلغ ثم ارفع صورة الإيصال. التسليم فوري بعد التأكيد.\nTransfer the amount then upload the receipt. Instant delivery after confirmation.'
        )
        .setFooter({ text: store.settings.storeName + ' • Awaiting payment proof' })
        .setTimestamp();

      await interaction.reply({ embeds: [payEmbed] });
      addLog('INFO', `${interaction.user.username} selected ${method.toUpperCase()} for ${payId} (pool)`);
      return;
    }

    // ---- PAYMENT METHOD SELECT (digital ticket) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethoddig_')) {
      const parts = interaction.customId.split('_');
      const digId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const dig = store.digitalProducts.find(d => d.id === digId);
      if (!dig) return interaction.reply({ content: '❌ Digital product missing.', ephemeral: true });
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket missing.', ephemeral: true });

      const method = interaction.values[0];
      // Use createPaymentRequest with digitalProductId via 8th arg
      const payId = createPaymentRequest(interaction, null, dig.titleEn + ' (Digital)', dig.price, method, ticketId, null, digId, null, null);
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal') textInfo = `💳 **PayPal**\nرابط: ${pay.paypal.email}`;

      const payEmbed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('💳 بيانات الدفع / Payment Instructions')
        .setDescription(
          `**المنتج:** ${dig.titleEn} (${dig.platform})\n` +
          `**المبلغ:** \`${pay.currency}${dig.price.toFixed(2)}\`\n` +
          `**رقم العملية:** \`${payId}\`\n\n` +
          textInfo + '\n\n' +
          '⚠️ حوّل المبلغ ثم ارفع صورة الإيصال. الكود يسلم فوراً بعد التأكيد.\nTransfer the amount then upload the receipt. Code delivered instantly after confirmation.'
        )
        .setFooter({ text: store.settings.storeName + ' • Awaiting payment proof' })
        .setTimestamp();

      await interaction.reply({ embeds: [payEmbed] });
      addLog('INFO', `${interaction.user.username} selected ${method.toUpperCase()} for ${payId} (digital)`);
      return;
    }

    // ---- PAYMENT METHOD SELECT (boosting ticket) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethodboost_')) {
      const parts = interaction.customId.split('_');
      const boostId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const boost = store.boostingServices.find(s => s.id === boostId);
      if (!boost) return interaction.reply({ content: '❌ Boosting service missing.', ephemeral: true });
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket missing.', ephemeral: true });

      const method = interaction.values[0];
      // Use the ticket's stored amount (which has the customer's calculated price based on their choices)
      const boostPrice = ticket.amount || boost.price;
      const payId = createPaymentRequest(interaction, null, ticket.accountTitle || (boost.titleEn + ' (Boosting)'), boostPrice, method, ticketId, null, null, boostId, null);
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal') textInfo = `💳 **PayPal**\nرابط: ${pay.paypal.email}`;

      const payEmbed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('💳 بيانات الدفع / Payment Instructions')
        .setDescription(
          `**الخدمة:** ${ticket.accountTitle || boost.titleEn} (${boost.game})\n` +
          `**المبلغ:** \`${pay.currency}${boostPrice.toFixed(2)}\`\n` +
          `**ETA:** \`${boost.eta}\`\n` +
          `**رقم العملية:** \`${payId}\`\n\n` +
          textInfo + '\n\n' +
          '⚠️ حوّل المبلغ ثم ارفع صورة الإيصال. بعد التأكيد، أرسل بيانات حسابك لبدء البوست.\nTransfer the amount then upload the receipt. After confirmation, send your account credentials to start the boost.'
        )
        .setFooter({ text: store.settings.storeName + ' • Awaiting payment proof' })
        .setTimestamp();

      await interaction.reply({ embeds: [payEmbed] });
      addLog('INFO', `${interaction.user.username} selected ${method.toUpperCase()} for ${payId} (boosting)`);
      return;
    }

    // ---- PAYMENT METHOD SELECT (camo ticket) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethodcamo_')) {
      const parts = interaction.customId.split('_');
      const camoId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const camo = store.camoServices.find(s => s.id === camoId);
      if (!camo) return interaction.reply({ content: '❌ Camo service missing.', ephemeral: true });
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket missing.', ephemeral: true });

      const method = interaction.values[0];
      const camoPrice = ticket.amount || camo.pricePerCamo;
      // createPaymentRequest signature: (interaction, accountId, accountTitle, amount, method, ticketId, poolId, digitalProductId, boostingServiceId, camoServiceId)
      const payId = createPaymentRequest(interaction, null, ticket.accountTitle || (camo.titleEn + ' (Camo Unlock)'), camoPrice, method, ticketId, null, null, null, camoId);
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal') textInfo = `💳 **PayPal**\nرابط: ${pay.paypal.email}`;

      const payEmbed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('💳 بيانات الدفع / Payment Instructions')
        .setDescription(
          `**الخدمة:** ${ticket.accountTitle || camo.titleEn} (${camo.game})\n` +
          `**المبلغ:** \`${pay.currency}${camoPrice.toFixed(2)}\`\n` +
          `**ETA:** \`${camo.eta}\`\n` +
          `**رقم العملية:** \`${payId}\`\n\n` +
          textInfo + '\n\n' +
          '⚠️ حوّل المبلغ ثم ارفع صورة الإيصال. بعد التأكيد، أرسل بيانات حسابك لبدء فتح الكاموهات.\nTransfer the amount then upload the receipt. After confirmation, send your account credentials to start camo unlock.'
        )
        .setFooter({ text: store.settings.storeName + ' • Awaiting payment proof' })
        .setTimestamp();

      await interaction.reply({ embeds: [payEmbed] });
      addLog('INFO', `${interaction.user.username} selected ${method.toUpperCase()} for ${payId} (camo)`);
      return;
    }

    // ---- COUPON BUTTON (opens modal) ----
    if (interaction.isButton() && interaction.customId.startsWith('coupon_')) {
      const ticketId = interaction.customId.replace('coupon_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found', ephemeral: true });
      if (ticket.couponCode) return interaction.reply({ content: '✅ تم تطبيق كود خصم بالفعل: `' + ticket.couponCode + '`', ephemeral: true });

      const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
      const modal = new ModalBuilder()
        .setCustomId('couponmodal_' + ticketId)
        .setTitle('🎁 كود الخصم / Coupon Code');
      const input = new TextInputBuilder()
        .setCustomId('coupon_code')
        .setLabel('أدخل كود الخصم / Enter coupon code')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. SUMMER20')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    // ---- COUPON MODAL SUBMIT ----
    if (interaction.isModalSubmit() && interaction.customId.startsWith('couponmodal_')) {
      const ticketId = interaction.customId.replace('couponmodal_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found', ephemeral: true });
      const code = interaction.fields.getTextInputValue('coupon_code').trim().toUpperCase();
      const coupon = store.coupons.find(c => c.code === code);
      if (!coupon) return interaction.reply({ content: '❌ كود غير صالح / Invalid coupon code.', ephemeral: true });
      if (!coupon.active) return interaction.reply({ content: '❌ هذا الكود غير نشط / This coupon is inactive.', ephemeral: true });
      if (coupon.uses >= coupon.maxUses) return interaction.reply({ content: '❌ تم استخدام هذا الكود لحد أقصى / Coupon usage limit reached.', ephemeral: true });
      if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return interaction.reply({ content: '❌ انتهت صلاحية الكود / Coupon expired.', ephemeral: true });

      ticket.couponCode = code;
      let discounted = ticket.amount;
      if (coupon.type === 'percent') {
        discounted = ticket.amount * (1 - coupon.value / 100);
      } else {
        discounted = Math.max(0, ticket.amount - coupon.value);
      }
      ticket.discountedAmount = parseFloat(discounted.toFixed(2));
      saveStore();

      const embed = new EmbedBuilder()
        .setColor(0x23a55a)
        .setTitle('✅ تم تطبيق الكود / Coupon Applied!')
        .setDescription(
          `🎁 الكود: \`${code}\`\n` +
          `💰 الخصم: ${coupon.type === 'percent' ? coupon.value + '%' : store.settings.currency + coupon.value.toFixed(2)}\n` +
          `💵 السعر الأصلي: ~~${store.settings.currency}${ticket.amount.toFixed(2)}~~\n` +
          `✨ السعر بعد الخصم: \`${store.settings.currency}${ticket.discountedAmount.toFixed(2)}\``
        )
        .setFooter({ text: store.settings.storeName })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      addLog('INFO', `Coupon ${code} applied to ticket ${ticketId}`);
      return;
    }

    // ---- CLOSE TICKET BUTTON ----
    if (interaction.isButton() && interaction.customId.startsWith('close_ticket_')) {
      const ticketId = interaction.customId.replace('close_ticket_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ تذكرة غير موجودة / Ticket missing.', ephemeral: true });
      if (interaction.user.id !== ticket.userId && interaction.user.id !== store.settings.ownerId) {
        // also allow staff roles
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const isStaff = member && Array.isArray(store.settings.staffRoleIds) && store.settings.staffRoleIds.some(rid => member.roles.cache.has(rid));
        if (!isStaff) return interaction.reply({ content: '❌ لا يمكنك إغلاق هذه التذكرة / Not allowed.', ephemeral: true });
      }
      ticket.status = 'closed';
      ticket.closedAt = new Date().toISOString();
      const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
      if (pr && (pr.status === 'Pending' || pr.status === 'Rejected')) {
        const acc = store.accounts.find(a => a.id === ticket.accountId);
        if (acc && acc.status === 'reserved') { acc.status = 'available'; acc.soldTo = null; }
      }
      saveStore();
      await interaction.reply({ content: '🔒 **تم إغلاق التذكرة / Ticket Closed** — سيتم حذفها خلال 5 ثوانٍ.' });
      addLog('INFO', `Ticket ${ticketId} closed by ${interaction.user.username}`);
      setTimeout(async () => { try { await interaction.channel.delete('Ticket closed'); } catch (e) {} }, 5000);
      return;
    }

    // ---- VERIFY BUTTON ----
    if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc) return interaction.reply({ content: '❌ لا توجد معلومات / No info.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setColor(store.settings.color || 0x9b59ff)
        .setTitle('🔍 ' + acc.titleEn)
        .setDescription(acc.titleAr || '')
        .addFields(
          { name: 'Status', value: '`' + acc.status + '`', inline: true },
          { name: 'Rank', value: '`' + (acc.prestige || '-') + '`', inline: true },
          { name: 'Warranty', value: '`' + (acc.warranty > 0 ? acc.warranty + 'd' : 'None') + '`', inline: true },
          { name: 'Price', value: '`' + store.settings.currency + acc.price.toFixed(2) + '`', inline: true },
          { name: 'Images', value: '`' + acc.images.length + '`', inline: true }
        )
        .setFooter({ text: store.settings.storeName + ' • ID ' + acc.id })
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

  } catch (err) {
    console.error('Interaction error:', err);
    const msg = '❌ حدث خطأ / An error occurred.';
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    } catch (e) {}
  }
});

// Helper: show gun select for a specific category (boosting gun_level flow)
async function showGunSelectForBoost(interaction, boost, catIdx) {
  const brandColor = store.settings.color || 0x9b59ff;
  const cur = store.settings.currency;
  const categories = getGunCategories(boost);
  const cat = categories[catIdx] || categories[0];
  if (!cat || !cat.guns || cat.guns.length === 0) {
    return interaction.reply({ content: '❌ لا توجد أسلحة في هذه الفئة / No guns in this category.', ephemeral: true }).catch(()=>{});
  }
  const options = cat.guns.slice(0, 25).map((g, i) => ({
    label: g.name.slice(0, 100),
    value: String(i),
    description: '$' + (g.pricePerLevel > 0 ? g.pricePerLevel : 13) + ' للمستوى الأقصى',
    emoji: g.emoji || undefined
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId('bstg_' + boost.id + '_' + catIdx)
    .setPlaceholder('اختر السلاح / Select your gun')
    .addOptions(options);
  const catName = (cat.emoji ? cat.emoji + ' ' : '') + cat.name;
  const embed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🚀 ' + boost.titleEn)
    .setDescription(
      `**الفئة: ${catName}**\n\n` +
      `🔫 الأسلحة المتاحة: ${cat.guns.length}\n` +
      `💰 السعر: \`$${(cat.guns[0]?.pricePerLevel > 0 ? cat.guns[0].pricePerLevel : 13)} لكل سلاح للمستوى الأقصى\`\n` +
      `📊 الحد الأقصى للمستوى: ${boost.maxGunLevel}\n\n` +
      `اختر السلاح 👇`
    )
    .setFooter({ text: store.settings.storeName + ' • الخطوة 2 من 3' });
  // Use update() to replace the previous select menu (works for select menu interactions)
  return interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] }).catch(()=>{});
}

// Helper: show camo multi-select menu (called from ordercamo_ and camogun_ handlers)
async function showCamoMultiSelect(interaction, camo, gunIdx) {
  const brandColor = store.settings.color || 0x9b59ff;
  const cur = store.settings.currency;
  if (!camo.camoList || camo.camoList.length === 0) {
    return interaction.reply({ content: '❌ لا توجد كاموهات مضافة / No camos configured.', ephemeral: true }).catch(()=>{});
  }
  const options = camo.camoList.slice(0, 25).map((c, i) => {
    const p = (c.price !== null && c.price !== undefined) ? c.price : camo.pricePerCamo;
    return { label: c.name.slice(0, 100), value: String(i), description: cur + p.toFixed(2), emoji: c.emoji || undefined };
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId('camocamos_' + camo.id + '_' + (gunIdx === null ? 'null' : gunIdx))
    .setPlaceholder('اختر الكاموهات / Select camos (multi-select)')
    .setMinValues(1)
    .setMaxValues(Math.min(options.length, 25))
    .addOptions(options);
  const gunName = gunIdx !== null && camo.gunList[gunIdx] ? (camo.gunList[gunIdx].emoji ? camo.gunList[gunIdx].emoji + ' ' : '') + camo.gunList[gunIdx].name : '';
  const embed = new EmbedBuilder()
    .setColor(brandColor)
    .setTitle('🎨 ' + camo.titleEn)
    .setDescription(
      `**Select which camos to unlock${gunName ? ' for ' + gunName : ''}.**\n` +
      `💰 Price: \`${cur}${camo.pricePerCamo} per camo\` (or custom price per camo)\n` +
      `📋 You can select multiple camos.`
    )
    .setFooter({ text: store.settings.storeName + (gunName ? ' • Step 2 of 2' : ' • Step 1 of 1') });
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] }).catch(()=>{});
  }
  return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(()=>{});
}

// Helper: create camo unlock ticket (used by camocamoc_ handler)
async function createCamoTicket(interaction, camo, gunIdx, selectedCamos, price) {
  const categoryId = store.settings.ticketCategoryId;
  if (!categoryId) return interaction.reply({ content: '❌ النظام غير جاهز / System not ready.', ephemeral: true }).catch(()=>{});
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: '❌ داخل السيرفر فقط / Inside server only.', ephemeral: true }).catch(()=>{});
  const category = guild.channels.cache.get(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ خطأ / Misconfigured.', ephemeral: true }).catch(()=>{});

  const gunName = gunIdx !== null && camo.gunList[gunIdx] ? camo.gunList[gunIdx].name : 'Any gun';
  const camosList = selectedCamos.map(c => c.name).join(', ');
  const choiceText = gunName + ' — ' + camosList + ' (' + selectedCamos.length + ' camos)';

  const ticketChannel = await guild.channels.create({
    name: `🎨-${interaction.user.username}-camo${camo.id}`,
    type: ChannelType.GuildText,
    parent: category,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
    ]
  });
  if (store.settings.ownerId) {
    await ticketChannel.permissionOverwrites.create(store.settings.ownerId, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true
    }).catch(() => {});
  }

  const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(4, '0');
  const ticket = {
    id: ticketId, userId: interaction.user.id, userName: interaction.user.username,
    accountId: null, poolId: null, digitalProductId: null, boostingServiceId: null, camoServiceId: camo.id,
    accountTitle: camo.titleEn + ' — ' + choiceText, amount: parseFloat(price.toFixed(2)),
    camoChoices: { gun: gunName, camos: selectedCamos.map(c => c.name) },
    channelId: ticketChannel.id, paymentId: null, paymentMethod: null,
    status: 'open', createdAt: new Date().toISOString()
  };
  store.tickets.unshift(ticket);
  saveStore();

  const pay = store.settings;
  const options = [];
  if (pay.stcPay && pay.stcPay.number) options.push({ label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + pay.stcPay.number, emoji: '📱' });
  if (pay.alrajhi && pay.alrajhi.iban) options.push({ label: 'AlRajhi Bank', value: 'alrajhi', description: 'الراجحي', emoji: '🏦' });
  if (pay.paypal && pay.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal Link', emoji: '💳' });
  if (options.length === 0) options.push({ label: 'No payment methods', value: 'none', description: 'Contact admin' });

  const selectMenu = new StringSelectMenuBuilder().setCustomId('paymethodcamo_' + camo.id + '_' + ticketId).setPlaceholder('اختر طريقة الدفع / Choose payment').addOptions(options);

  const embed = new EmbedBuilder()
    .setColor(store.settings.color || 0x9b59ff)
    .setTitle('🎨 طلب فتح كاموهات — ' + camo.titleEn)
    .setDescription(
      `**مرحباً ${interaction.user.username}! 👋**\n\n` +
      `تم إنشاء تذكرة خاصة بك. اتبع الخطوات أدناه لإكمال طلبك:\n\n` +
      `**📋 تفاصيل الطلب:**\n` +
      `👤 العميل: **${interaction.user.username}**\n` +
      `📦 الخدمة: **${camo.titleEn}** (${camo.game})\n` +
      `🔫 السلاح: **${gunName}**\n` +
      `🎨 الكاموهات: **${camosList}**\n` +
      `📊 العدد: **${selectedCamos.length}** كامو\n` +
      `💰 السعر: \`${pay.currency}${price.toFixed(2)}\`\n` +
      `⏱️ المدة المتوقعة: \`${camo.eta}\`\n` +
      `🎫 رقم التذكرة: \`${ticketId}\`\n\n` +
      `**📋 خطوات إكمال الطلب:**\n` +
      `1️⃣ اختر طريقة الدفع من القائمة بالأسفل\n` +
      `2️⃣ حوّل المبلغ المطلوب\n` +
      `3️⃣ ارفع صورة الإيصال هنا في التذكرة\n` +
      `4️⃣ انتظر تأكيد الإدارة (يصلك إشعار في DM)\n` +
      `5️⃣ أرسل بيانات حسابك لبدء فتح الكاموهات\n` +
      `6️⃣ سيتم إشعارك فور الاكتمال ✅`
    )
    .setFooter({ text: store.settings.storeName + ' • ' + ticketId })
    .setTimestamp();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket_' + ticketId).setLabel('إغلاق / Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('coupon_' + ticketId).setLabel('كود خصم / Coupon').setStyle(ButtonStyle.Secondary).setEmoji('🎁')
  );

  await ticketChannel.send({
    content: '👤 <@' + interaction.user.id + '> | 🎨 تذكرة فتح كاموهات / Camo Unlock Ticket',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(selectMenu), closeRow]
  });

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: '🎫 تم إنشاء تذكرة: <#' + ticketChannel.id + '>', ephemeral: true }).catch(()=>{});
  } else {
    await interaction.reply({ content: '🎫 تم إنشاء تذكرة: <#' + ticketChannel.id + '>', ephemeral: true }).catch(()=>{});
  }
  addLog('INFO', `Camo ticket ${ticketId} for ${interaction.user.username} → ${camo.titleEn} (${choiceText}) $${price}`);
  sendLogToDiscord(`🎨 Camo ticket \`${ticketId}\` by **${interaction.user.username}** for **${camo.titleEn}** (${choiceText}) — $${price}`);
  notifyOwner("🎨 طلب كاموهات!", `العميل: **${interaction.user.username}**\nالخدمة: **${camo.titleEn}**\nالتفاصيل: ${choiceText}\nالسعر: \`$${price}\`\nرقم التذكرة: \`${ticketId}\``);
}

// Helper: create boosting ticket (used by all boosting choice flows)
async function createBoostingTicket(interaction, boost, choices, price) {
  const categoryId = store.settings.ticketCategoryId;
  if (!categoryId) return interaction.reply({ content: '❌ النظام غير جاهز / System not ready.', ephemeral: true }).catch(()=>{});
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: '❌ داخل السيرفر فقط / Inside server only.', ephemeral: true }).catch(()=>{});
  const category = guild.channels.cache.get(categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ خطأ / Misconfigured.', ephemeral: true }).catch(()=>{});

  // Build choice description for ticket title/embed
  let choiceText = '';
  if (choices.type === 'rank') choiceText = choices.fromRank + ' → ' + choices.toRank;
  else if (choices.type === 'prestige') choiceText = 'Prestige ' + choices.targetLevel;
  else if (choices.type === 'gun_level') choiceText = choices.gunName + ' ' + choices.fromLevel + '→' + choices.toLevel;
  else choiceText = 'Fixed price';

  const ticketChannel = await guild.channels.create({
    name: `🚀-${interaction.user.username}-${boost.id}`,
    type: ChannelType.GuildText,
    parent: category,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
    ]
  });
  if (store.settings.ownerId) {
    await ticketChannel.permissionOverwrites.create(store.settings.ownerId, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true
    }).catch(() => {});
  }

  const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(4, '0');
  const ticket = {
    id: ticketId, userId: interaction.user.id, userName: interaction.user.username,
    accountId: null, poolId: null, digitalProductId: null, boostingServiceId: boost.id,
    accountTitle: boost.titleEn + ' — ' + choiceText, amount: parseFloat(price.toFixed(2)),
    boostingEta: boost.eta, boostingChoices: choices,
    channelId: ticketChannel.id, paymentId: null, paymentMethod: null,
    status: 'open', createdAt: new Date().toISOString()
  };
  store.tickets.unshift(ticket);
  saveStore();

  const pay = store.settings;
  const options = [];
  if (pay.stcPay && pay.stcPay.number) options.push({ label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + pay.stcPay.number, emoji: '📱' });
  if (pay.alrajhi && pay.alrajhi.iban) options.push({ label: 'AlRajhi Bank', value: 'alrajhi', description: 'الراجحي', emoji: '🏦' });
  if (pay.paypal && pay.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal Link', emoji: '💳' });
  if (options.length === 0) options.push({ label: 'No payment methods', value: 'none', description: 'Contact admin' });

  const selectMenu = new StringSelectMenuBuilder().setCustomId('paymethodboost_' + boost.id + '_' + ticketId).setPlaceholder('اختر طريقة الدفع / Choose payment').addOptions(options);

  const embed = new EmbedBuilder()
    .setColor(store.settings.color || 0x9b59ff)
    .setTitle('🚀 طلب خدمة بوست — ' + boost.titleEn)
    .setDescription(
      `**مرحباً ${interaction.user.username}! 👋**\n\n` +
      `تم إنشاء تذكرة خاصة بك. اتبع الخطوات أدناه لإكمال طلبك:\n\n` +
      `**📋 تفاصيل الطلب:**\n` +
      `👤 العميل: **${interaction.user.username}**\n` +
      `📦 الخدمة: **${boost.titleEn}** (${boost.game})\n` +
      `⚙️ التفاصيل: **${choiceText}**\n` +
      `💰 السعر: \`${pay.currency}${price.toFixed(2)}\`\n` +
      `⏱️ المدة المتوقعة: \`${boost.eta}\`\n` +
      `🎫 رقم التذكرة: \`${ticketId}\`\n\n` +
      `**📋 خطوات إكمال الطلب:**\n` +
      `1️⃣ اختر طريقة الدفع من القائمة بالأسفل\n` +
      `2️⃣ حوّل المبلغ المطلوب\n` +
      `3️⃣ ارفع صورة الإيصال هنا في التذكرة\n` +
      `4️⃣ انتظر تأكيد الإدارة (يصلك إشعار في DM)\n` +
      `5️⃣ أرسل بيانات حسابك لبدء البوست\n` +
      `6️⃣ سيتم إشعارك فور الاكتمال ✅`
    )
    .setFooter({ text: store.settings.storeName + ' • ' + ticketId })
    .setTimestamp();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket_' + ticketId).setLabel('إغلاق / Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('coupon_' + ticketId).setLabel('كود خصم / Coupon').setStyle(ButtonStyle.Secondary).setEmoji('🎁')
  );

  await ticketChannel.send({
    content: '👤 <@' + interaction.user.id + '> | 🚀 تذكرة خدمة بوست / Boosting Service Ticket',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(selectMenu), closeRow]
  });

  // Reply to the interaction (ephemeral) with ticket link
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: '🎫 تم إنشاء تذكرة: <#' + ticketChannel.id + '>', ephemeral: true }).catch(()=>{});
  } else {
    await interaction.reply({ content: '🎫 تم إنشاء تذكرة: <#' + ticketChannel.id + '>', ephemeral: true }).catch(()=>{});
  }
  addLog('INFO', `Boosting ticket ${ticketId} for ${interaction.user.username} → ${boost.titleEn} (${choiceText}) $${price}`);
  sendLogToDiscord(`🚀 Boosting ticket \`${ticketId}\` by **${interaction.user.username}** for **${boost.titleEn}** (${choiceText}) — $${price}`);
  notifyOwner("🚀 طلب بوست!", `العميل: **${interaction.user.username}**\nالخدمة: **${boost.titleEn}**\nالتفاصيل: ${choiceText}\nالسعر: \`$${price}\`\nرقم التذكرة: \`${ticketId}\``);
}

// Helper: create payment request record
function createPaymentRequest(interaction, accountId, accountTitle, amount, method, ticketId, poolId, digitalProductId, boostingServiceId, camoServiceId) {
  const payId = 'PAY-' + String(100 + store.paymentRequests.length + 1);
  const ticket = store.tickets.find(t => t.id === ticketId);
  let finalAmount = amount;
  let couponCode = null;
  if (ticket && ticket.couponCode) {
    couponCode = ticket.couponCode;
    finalAmount = ticket.discountedAmount || amount;
  }
  store.paymentRequests.unshift({
    id: payId, userId: interaction.user.id, userName: interaction.user.username,
    accountId, poolId, digitalProductId, boostingServiceId, camoServiceId, accountTitle, amount, discountedAmount: finalAmount, couponCode,
    method: method.toUpperCase(), status: 'Pending',
    date: new Date().toISOString().slice(0, 16).replace('T', ' ')
  });
  if (ticket) {
    ticket.paymentId = payId;
    ticket.paymentMethod = method.toUpperCase();
    ticket.status = 'waiting_payment';
  }
  saveStore();
  return payId;
}

// ===== MESSAGE HANDLER (receipt upload) =====
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Handle DM payment proof (legacy fallback)
  if (message.channel.type === 1) {
    const pending = store.paymentRequests.find(p => p.userId === message.author.id && p.status === 'Pending');
    if (pending && message.attachments.size > 0) {
      pending.status = 'Waiting Review';
      pending.proofUrl = message.attachments.first().url;
      saveStore();
      addLog('WARN', `${message.author.username} uploaded proof for ${pending.id} (DM)`);
      message.reply('✅ **تم استلام صورة الإيصال!**\nجاري مراجعة طلبك رقم `' + pending.id + '` للمنتج (**' + pending.accountTitle + '**).').catch(() => {});
    }
    return;
  }

  // Handle receipt upload in ticket channels
  const ticket = store.tickets.find(t =>
    t.channelId === message.channel.id && t.status !== 'closed'
  );

  if (ticket && message.attachments.size > 0) {
    const imgAttachment = message.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
    if (imgAttachment) {
      const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
      if (pr && (pr.status === 'Pending' || pr.status === 'Rejected')) {
        pr.status = 'Waiting Review';
        pr.proofUrl = imgAttachment.url;
        ticket.status = 'waiting_review';
        saveStore();

        const embed = new EmbedBuilder()
          .setColor(0xf0b232)
          .setTitle('⏳ تم استلام الإيصال — تحت المراجعة')
          .setDescription(
            `**شكراً ${message.author.username}! 👋**\n\n` +
            `تم استلام إيصال الدفع بنجاح ✅\n\n` +
            `**📋 تفاصيل العملية:**\n` +
            `🎫 رقم العملية: \`${pr.id}\`\n` +
            `💰 المبلغ: \`${store.settings.currency}${(pr.discountedAmount || pr.amount).toFixed(2)}\`\n` +
            `💳 طريقة الدفع: \`${pr.method}\`\n\n` +
            `⏳ **جاري مراجعة الإيصال من قبل الإدارة...**\n` +
            `سيتم إرسال التسليم أو طلب الحساب هنا فور التأكيد.\n` +
            `📩 سيصلك إشعار في رسائلك الخاصة (DM) عند التأكيد.`
          )
          .setImage(imgAttachment.url)
          .setFooter({ text: store.settings.storeName + ' • يرجى الانتظار' })
          .setTimestamp();
        await message.reply({ embeds: [embed] });

        addLog('INFO', `Receipt uploaded in ticket ${ticket.id} by ${message.author.username} for ${pr.id}`);
        sendLogToDiscord(`📨 Receipt uploaded in \`${ticket.id}\` for \`${pr.id}\` — **${ticket.accountTitle}** ($${pr.discountedAmount || pr.amount})`);
        notifyOwner("📨 إيصال جديد!", `العميل: **${message.author.username}**\nالمنتج: **${ticket.accountTitle}**\nالمبلغ: \`$${pr.discountedAmount || pr.amount}\`\nرقم العملية: \`${pr.id}\`\nرقم التذكرة: \`${ticket.id}\``);
      }
    }
  }
});

// ===== SERVER START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${STORE_NAME}] Panel server running on port ${PORT}`);
  console.log(`[${STORE_NAME}] Default panel password: ${PANEL_PASSWORD === 'admin123' ? 'admin123 (CHANGE IT!)' : '(set via env)'}`);
});

if (!process.env.DISCORD_TOKEN) {
  console.error(`[${STORE_NAME}] ERROR: DISCORD_TOKEN env var not set! Bot will not connect.`);
} else {
  client.login(process.env.DISCORD_TOKEN).catch(err => console.error(`[${STORE_NAME}] Discord login failed:`, err.message));
}

// Save store every 60 seconds as safety net
setInterval(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } catch (e) {} }, 60000);
