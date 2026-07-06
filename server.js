const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== IN-MEMORY DATA STORE =====
// Replace with MongoDB/SQLite in production for persistence
let store = {
  accounts: [],
  orders: [],
  customers: [],
  pools: [],
  logs: [],
  settings: {
    prefix: '!',
    currency: '$',
    accountsChannelId: '',
    logChannelId: '',
    termsAr: 'الشروط العامة\n━━━━━━━━━━━━━━━\n▪️ يتم تسليم الحساب فور تأكيد الدفع\n▪️ الضمان يبدأ من تاريخ الشراء\n▪️ لا يوجد استرداد بعد تسليم الحساب\n▪️ في حالة وجود مشكلة في الحساب خلال فترة الضمان، سيتم استبداله\n▪️ يمنع تغيير البريد الإلكتروني للحساب\n▪️ يمنع بيع الحساب لطرف ثالث\n▪️ المخالفة تلغي الضمان فوراً',
    termsEn: 'General Terms\n━━━━━━━━━━━━━━━\n▪️ Account delivered immediately after payment\n▪️ Warranty starts from purchase date\n▪️ No refunds after delivery\n▪️ Issues during warranty = replacement\n▪️ Email change prohibited\n▪️ Reselling prohibited\n▪️ Violation voids warranty'
  },
  nextId: 1
};

function genId() { return store.nextId++; }
function genOrderId() { return 'ORD-' + String(1000 + store.orders.length + 1); }
function addLog(level, msg) {
  store.logs.unshift({ time: new Date().toTimeString().slice(0, 8), level, msg });
  if (store.logs.length > 500) store.logs.length = 500;
}

// ===== DISCORD BOT REFERENCE =====
// We'll set this from bot.js
let bot = null;
let discordJs = null;

app.setBot = function(b, dj) {
  bot = b;
  discordJs = dj;
};

// Helper: post account embed to Discord channel
function postToDiscord(acc) {
  if (!bot || !discordJs) return;
  const channelId = store.settings.accountsChannelId;
  if (!channelId) return;
  const channel = bot.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = discordJs;
    
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(acc.titleEn)
      .setImage(acc.image || null)
      .addFields(
        { name: 'الاسم', value: acc.titleAr || '-', inline: false },
        { name: 'Rank / Level', value: acc.prestige || '-', inline: true },
        { name: 'Total Stats', value: acc.stats || '-', inline: true },
        { name: 'Warranty', value: acc.warranty > 0 ? acc.warranty + ' Days' : 'None', inline: true },
        { name: 'Details', value: acc.detailsEn || '-', inline: false },
        { name: 'التفاصيل', value: acc.detailsAr || '-', inline: false }
      )
      .addFields({ name: 'Price', value: '$' + acc.price.toFixed(2), inline: false })
      .setFooter({ text: 'Acc. APP' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء المنتج / Buy').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('التحقق / Verify').setStyle(ButtonStyle.Secondary)
    );

    channel.send({ embeds: [embed], components: [row] }).catch(() => {});
  } catch (e) {
    console.error('Failed to post embed:', e.message);
  }
}

// Helper: delete message from Discord
function deleteDiscordMessage(channelId, messageId) {
  if (!bot) return;
  const channel = bot.channels.cache.get(channelId);
  if (!channel) return;
  channel.messages.delete(messageId).catch(() => {});
}

// Helper: send DM to user
function sendDM(userId, content) {
  if (!bot) return;
  bot.users.fetch(userId).then(user => {
    user.send(content).catch(() => addLog('WARN', 'DM failed to user ' + userId));
  }).catch(() => {});
}

// ===== API ROUTES =====

// --- Stats ---
app.get('/api/stats', (req, res) => {
  res.json({
    totalAccounts: store.accounts.length,
    available: store.accounts.filter(a => a.status === 'available').length,
    reserved: store.accounts.filter(a => a.status === 'reserved').length,
    sold: store.accounts.filter(a => a.status === 'sold').length,
    dead: store.accounts.filter(a => a.status === 'dead').length,
    totalRevenue: store.orders.filter(o => o.status === 'Delivered').reduce((s, o) => s + o.amount, 0),
    totalOrders: store.orders.length,
    pendingOrders: store.orders.filter(o => o.status === 'Pending').length,
    totalCustomers: store.customers.length,
    botOnline: bot ? bot.isReady() : false
  });
});

// --- Accounts ---
app.get('/api/accounts', (req, res) => {
  let { search, game, status } = req.query;
  let filtered = store.accounts;
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(a => a.titleEn.toLowerCase().includes(s) || (a.titleAr && a.titleAr.includes(s)));
  }
  if (game) filtered = filtered.filter(a => a.game === game);
  if (status) filtered = filtered.filter(a => a.status === status);
  res.json(filtered);
});

app.post('/api/accounts', (req, res) => {
  const { titleEn, titleAr, game, price, prestige, stats, warranty, detailsEn, detailsAr, email, pass, extra, image } = req.body;
  if (!titleEn || !price) return res.status(400).json({ error: 'Title and price required' });

  const acc = {
    id: genId(),
    titleEn, titleAr: titleAr || '', game: game || 'Other',
    price: parseFloat(price), prestige: prestige || '', stats: stats || '',
    warranty: parseInt(warranty) || 0, detailsEn: detailsEn || '', detailsAr: detailsAr || '',
    email: email || '', pass: pass || '', extra: extra || '',
    image: image || '', status: 'available', soldTo: null,
    discordMessageId: null, createdAt: new Date().toISOString()
  };
  store.accounts.unshift(acc);

  // Post to Discord #accounts channel
  postToDiscord(acc).then(msg => {
    if (msg) {
      acc.discordMessageId = msg.id;
      addLog('INFO', `Posted to Discord: ${titleEn} (msg ${msg.id})`);
    }
  }).catch(() => {});

  addLog('INFO', `Account created: ${titleEn} — $${acc.price.toFixed(2)}`);
  res.json(acc);
});

app.put('/api/accounts/:id', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  Object.assign(acc, req.body, { id: acc.id });
  addLog('INFO', `Account updated: ${acc.titleEn}`);
  res.json(acc);
});

app.delete('/api/accounts/:id', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  // Delete from Discord if message ID exists
  if (acc.discordMessageId && store.settings.accountsChannelId) {
    deleteDiscordMessage(store.settings.accountsChannelId, acc.discordMessageId);
  }
  store.accounts = store.accounts.filter(a => a.id !== acc.id);
  addLog('WARN', `Account deleted: ${acc.titleEn}`);
  res.json({ success: true });
});

app.post('/api/accounts/:id/sold', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  acc.status = 'sold';
  addLog('INFO', `Account marked sold: ${acc.titleEn}`);
  res.json(acc);
});

app.post('/api/accounts/:id/dead', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  acc.status = 'dead';
  addLog('WARN', `Account marked dead: ${acc.titleEn}`);
  res.json(acc);
});

// --- Bulk Import ---
app.post('/api/accounts/bulk', (req, res) => {
  const { game, price, warranty, credentials } = req.body;
  if (!credentials || !credentials.length) return res.status(400).json({ error: 'No credentials' });
  let count = 0;
  credentials.forEach(line => {
    let email = '', pass = line;
    const sep = line.match(/[:|]/);
    if (sep) { const idx = line.indexOf(sep[0]); email = line.slice(0, idx).trim(); pass = line.slice(idx + 1).trim(); }
    store.accounts.unshift({
      id: genId(), titleEn: `${game} Account`, titleAr: `حساب ${game}`,
      game, price: parseFloat(price) || 0, prestige: '-', stats: '-',
      warranty: parseInt(warranty) || 0, detailsEn: 'Bulk imported', detailsAr: 'مستورد بالجملة',
      email, pass, extra: 'Bulk', image: '', status: 'available', soldTo: null,
      discordMessageId: null, createdAt: new Date().toISOString()
    });
    count++;
  });
  addLog('INFO', `Bulk import: ${count} ${game} accounts`);
  res.json({ imported: count });
});

// --- Orders ---
app.get('/api/orders', (req, res) => {
  let { search, status } = req.query;
  let filtered = store.orders;
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(o => o.id.toLowerCase().includes(s) || o.cust.toLowerCase().includes(s) || o.item.toLowerCase().includes(s));
  }
  if (status) filtered = filtered.filter(o => o.status === status);
  res.json(filtered);
});

app.post('/api/orders', (req, res) => {
  const { cust, custId, item, itemId, amount } = req.body;
  const order = {
    id: genOrderId(), cust, custId: custId || '', item, itemId: itemId || '',
    amount: parseFloat(amount) || 0, status: 'Pending',
    date: new Date().toISOString().slice(0, 16).replace('T', ' '),
    email: '', pass: ''
  };
  store.orders.unshift(order);
  addLog('INFO', `New order: ${order.id} — ${item} ($${order.amount.toFixed(2)})`);
  res.json(order);
});

app.post('/api/orders/:id/deliver', (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });

  // Find account and get credentials
  const acc = store.accounts.find(a => a.titleEn === order.item && a.status === 'available');
  if (acc) {
    order.email = acc.email;
    order.pass = acc.pass;
    acc.status = 'sold';
    acc.soldTo = order.custId;
  }

  order.status = 'Delivered';

  // Send DM with credentials
  if (order.custId && order.email) {
    sendDM(order.custId, `**${order.item}**\n\nEmail: \`${order.email}\`\nPassword: \`${order.pass}\`\n\nWarranty: ${acc ? acc.warranty + ' days' : 'N/A'}`);
  }

  addLog('INFO', `Delivered ${order.id} to ${order.cust}`);
  res.json(order);
});

app.post('/api/orders/:id/status', (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const old = order.status;
  order.status = req.body.status;
  addLog('INFO', `Order ${order.id}: ${old} → ${order.status}`);
  res.json(order);
});

// --- Customers ---
app.get('/api/customers', (req, res) => {
  let { search, trust } = req.query;
  let filtered = store.customers;
  if (search) { const s = search.toLowerCase(); filtered = filtered.filter(c => c.name.toLowerCase().includes(s)); }
  if (trust) filtered = filtered.filter(c => c.trust === trust);
  res.json(filtered);
});

app.post('/api/customers', (req, res) => {
  const { name, discordId, trust, notes } = req.body;
  const cust = { id: 'u' + genId(), name, discordId: discordId || '', trust: trust || 'New', spent: 0, purchases: 0, notes: notes || '', joined: new Date().toISOString().slice(0, 10) };
  store.customers.push(cust);
  addLog('INFO', `Customer added: ${name}`);
  res.json(cust);
});

app.post('/api/customers/:id/blacklist', (req, res) => {
  const c = store.customers.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.trust = 'Blacklisted';
  addLog('WARN', `Blacklisted: ${c.name}`);
  res.json(c);
});

app.post('/api/customers/:id/unblacklist', (req, res) => {
  const c = store.customers.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.trust = 'Verified';
  addLog('INFO', `Unblacklisted: ${c.name}`);
  res.json(c);
});

// --- Stock Pools ---
app.get('/api/pools', (req, res) => { res.json(store.pools); });
app.post('/api/pools', (req, res) => {
  const { name, price } = req.body;
  const pool = { id: genId(), name: name || 'New Pool', price: parseFloat(price) || 0, stock: [] };
  store.pools.push(pool);
  addLog('INFO', `Pool created: ${pool.name}`);
  res.json(pool);
});
app.post('/api/pools/:id/stock', (req, res) => {
  const p = store.pools.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const entries = req.body.entries || [];
  p.stock.push(...entries);
  addLog('INFO', `Added ${entries.length} entries to ${p.name}`);
  res.json(p);
});
app.delete('/api/pools/:id', (req, res) => {
  store.pools = store.pools.filter(x => x.id !== parseInt(req.params.id));
  res.json({ success: true });
});

// --- Settings ---
app.get('/api/settings', (req, res) => { res.json(store.settings); });
app.post('/api/settings', (req, res) => {
  Object.assign(store.settings, req.body);
  addLog('INFO', 'Settings updated');
  res.json(store.settings);
});

// --- Logs ---
app.get('/api/logs', (req, res) => {
  let { level, search } = req.query;
  let filtered = store.logs;
  if (level) filtered = filtered.filter(l => l.level === level);
  if (search) filtered = filtered.filter(l => l.msg.toLowerCase().includes(search.toLowerCase()));
  res.json(filtered);
});
app.delete('/api/logs', (req, res) => { store.logs = []; res.json({ success: true }); });

// --- Bot Control ---
app.post('/api/bot/restart', (req, res) => {
  addLog('INFO', 'Bot restart requested');
  res.json({ success: true });
  // On Railway, this would trigger a redeploy or process manager restart
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Panel server running on port ${PORT}`);
});

module.exports = { app, setBot: app.setBot, getStore: () => store };
