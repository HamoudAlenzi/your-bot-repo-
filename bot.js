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
  paymentRequests: [],
  tickets: [],
  logs: [],
  settings: {
    storeName: STORE_NAME,
    currency: '$',
    accountsChannelId: '',
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
    autoCloseSeconds: 15
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
  // Auth endpoints
  if (req.path === '/api/login' || req.path === '/api/check-auth') return next();
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

    // Check if this is a pool purchase — pull from pool stock if so
    if (pr.poolId) {
      const pool = store.pools.find(p => p.id === pr.poolId);
      if (pool && pool.stock && pool.stock.length > 0) {
        const item = pool.stock.shift();
        deliveredEmail = item.email;
        deliveredPass = item.pass;
        saveStore();
      }
    } else if (acc) {
      acc.status = 'sold';
      acc.soldTo = pr.userId;
    }

    const finalAmount = pr.discountedAmount || pr.amount;

    const order = {
      id: 'ORD-' + String(1000 + store.orders.length + 1),
      cust: pr.userName, custId: pr.userId,
      item: pr.accountTitle, itemId: String(pr.accountId), poolId: pr.poolId || null,
      amount: finalAmount, originalAmount: pr.amount, couponCode: pr.couponCode || null,
      status: 'Delivered',
      paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      email: deliveredEmail, pass: deliveredPass
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

    // Deliver in ticket & auto-close
    const ticket = store.tickets.find(t => t.paymentId === pr.id);
    if (ticket && ticket.channelId && client.isReady()) {
      const ticketChannel = client.channels.cache.get(ticket.channelId);
      if (ticketChannel) {
        const deliverEmbed = new EmbedBuilder()
          .setColor(store.settings.color || 0x9b59ff)
          .setTitle('✅ تم تأكيد الدفع / Payment Confirmed!')
          .setDescription(
            `**${pr.accountTitle}**\n` +
            `💰 المبلغ المدفوع: \`${store.settings.currency}${finalAmount.toFixed(2)}\`\n` +
            `💳 طريقة الدفع: \`${pr.method}\`\n` +
            `🎫 رقم العملية: \`${pr.id}\`\n\n` +
            `**📋 بيانات الحساب / Account Credentials:**\n` +
            `📧 Email: \`${deliveredEmail}\`\n` +
            `🔑 Password: \`${deliveredPass}\`\n\n` +
            `🙏 شكراً لشرائك من **${store.settings.storeName}**!\n` +
            `Thank you for your purchase!`
          )
          .setFooter({ text: store.settings.storeName + ' • Auto-closing ticket in ' + (store.settings.autoCloseSeconds || 15) + 's' })
          .setTimestamp();

        await ticketChannel.send({ embeds: [deliverEmbed] });

        ticket.status = 'closed';
        ticket.closedAt = new Date().toISOString();
        saveStore();
        addLog('INFO', `Ticket ${ticket.id} delivered and closing for ${pr.userName}`);

        setTimeout(async () => {
          try {
            await ticketChannel.delete('Purchase completed — ticket auto-closed');
            addLog('INFO', `Ticket channel ${ticket.channelId} deleted after delivery`);
          } catch (err) {
            addLog('WARN', `Failed to delete ticket channel: ${err.message}`);
          }
        }, (store.settings.autoCloseSeconds || 15) * 1000);
      }
    } else {
      // DM fallback
      if (pr.userId && client.isReady()) {
        client.users.fetch(pr.userId).then(user => {
          user.send(`✅ **${store.settings.storeName} — تم التسليم / Delivered!**\n\n**${pr.accountTitle}**\n📧 Email: \`${deliveredEmail}\`\n🔑 Password: \`${deliveredPass}\`\n\nشكراً لشرائك منا!`).catch(() => {});
        }).catch(() => {});
      }
    }

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
      if (pay.paypal && pay.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal: ' + pay.paypal.email, emoji: '💳' });
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
      if (pay.paypal && pay.paypal.email) options.push({ label: 'PayPal', value: 'paypal', description: 'PayPal: ' + pay.paypal.email, emoji: '💳' });
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
      return;
    }

    // ---- PAYMENT METHOD SELECT (account ticket) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_') && !interaction.customId.startsWith('paymethodpool_')) {
      const parts = interaction.customId.split('_');
      const accId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc) return interaction.reply({ content: '❌ المنتج غير موجود / Product missing.', ephemeral: true });
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ التذكرة غير موجودة / Ticket missing.', ephemeral: true });

      const method = interaction.values[0];
      const payId = createPaymentRequest(interaction, acc.id, acc.titleEn, acc.price, method, ticketId, null);
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal') textInfo = `💳 **PayPal**\nEmail: \`${pay.paypal.email}\``;

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
      const payId = createPaymentRequest(interaction, null, pool.name + ' (Auto-Delivery)', pool.price, method, ticketId, poolId);
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal') textInfo = `💳 **PayPal**\nEmail: \`${pay.paypal.email}\``;

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

// Helper: create payment request record
function createPaymentRequest(interaction, accountId, accountTitle, amount, method, ticketId, poolId) {
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
    accountId, poolId, accountTitle, amount, discountedAmount: finalAmount, couponCode,
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
          .setTitle('✅ تم استلام إيصال الدفع / Payment Proof Received!')
          .setDescription(
            ` رقم العملية: \`${pr.id}\`\n` +
            `💰 المبلغ: \`${store.settings.currency}${(pr.discountedAmount || pr.amount).toFixed(2)}\`\n` +
            `💳 طريقة الدفع: \`${pr.method}\`\n\n` +
            `⏳ جاري مراجعة الإيصال من قبل الإدارة...\nAdmin is reviewing your receipt.\nسيتم تسليم الحساب هنا فور التأكيد.`
          )
          .setImage(imgAttachment.url)
          .setFooter({ text: store.settings.storeName })
          .setTimestamp();
        await message.reply({ embeds: [embed] });

        addLog('INFO', `Receipt uploaded in ticket ${ticket.id} by ${message.author.username} for ${pr.id}`);
        sendLogToDiscord(`📨 Receipt uploaded in \`${ticket.id}\` for \`${pr.id}\` — **${ticket.accountTitle}** ($${pr.discountedAmount || pr.amount})`);
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
