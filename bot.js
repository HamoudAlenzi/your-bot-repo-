// =============================================
// ACC STORE BOT — With Payment Methods
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, StringSelectMenuBuilder, ComponentType } = require('discord.js');

// ===== EXPRESS SERVER =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ===== FIND panel.html =====
function findPanelHtml() {
  const paths = [
    path.join(__dirname, 'panel.html'),
    path.join(__dirname, 'public', 'panel.html'),
    path.join(__dirname, 'public', 'public', 'panel.html'),
    path.join('/app', 'panel.html'),
    path.join('/app', 'public', 'panel.html'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) { console.log('panel.html found at: ' + p); return p; }
  }
  console.log('panel.html NOT FOUND. Searched:'); paths.forEach(p => console.log('  - ' + p));
  return null;
}
const panelPath = findPanelHtml();
if (panelPath) {
  app.get('/panel.html', (req, res) => res.sendFile(panelPath));
  app.get('/', (req, res) => res.redirect('/panel.html'));
} else {
  app.get('/', (req, res) => {
    let html = '<h1>Debug: Files on server</h1><pre>';
    try { fs.readdirSync(__dirname).forEach(f => { html += f + ' (' + Math.round(fs.statSync(path.join(__dirname, f)).size/1024) + 'KB)\n'; }); } catch(e) { html += e.message; }
    html += '</pre>'; res.send(html);
  });
}

// ===== DATA STORE =====
let store = {
  accounts: [],
  orders: [],
  customers: [],
  pools: [],
  paymentRequests: [],
  logs: [],
  settings: {
    prefix: '!',
    currency: '$',
    accountsChannelId: '',
    logChannelId: '',
    termsAr: 'الشروط العامة\n━━━━━━━━━━━━━━━\n▪️ يتم تسليم الحساب فور تأكيد الدفع\n▪️ الضمان يبدأ من تاريخ الشراء\n▪️ لا يوجد استرداد بعد تسليم الحساب\n▪️ في حالة وجود مشكلة في الحساب خلال فترة الضمان، سيتم استبداله\n▪️ يمنع تغيير البريد الإلكتروني للحساب\n▪️ يمنع بيع الحساب لطرف ثالث\n▪️ المخالفة تلغي الضمان فوراً',
    termsEn: 'General Terms\n━━━━━━━━━━━━━━━\n▪️ Account delivered immediately after payment\n▪️ Warranty starts from purchase date\n▪️ No refunds after delivery\n▪️ Issues during warranty = replacement\n▪️ Email change prohibited\n▪️ Reselling prohibited\n▪️ Violation voids warranty',
    stcPay: { number: '05XXXXXXXX', name: '' },
    alrajhi: { iban: 'SA0000000000000000000', name: '' },
    paypal: { email: 'pay@example.com', name: '' }
  },
  nextId: 1
};

function genId() { return store.nextId++; }
function addLog(level, msg) {
  store.logs.unshift({ time: new Date().toTimeString().slice(0, 8), level, msg });
  if (store.logs.length > 500) store.logs.length = 500;
}

// ===== API ROUTES =====

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
    pendingPayments: store.paymentRequests.filter(p => p.status === 'Pending').length,
    totalCustomers: store.customers.length,
    botOnline: client.isReady()
  });
});

// --- Accounts ---
app.get('/api/accounts', (req, res) => {
  let { search, game, status } = req.query;
  let filtered = store.accounts;
  if (search) { const s = search.toLowerCase(); filtered = filtered.filter(a => a.titleEn.toLowerCase().includes(s) || (a.titleAr && a.titleAr.includes(s))); }
  if (game) filtered = filtered.filter(a => a.game === game);
  if (status) filtered = filtered.filter(a => a.status === status);
  res.json(filtered);
});

app.post('/api/accounts', (req, res) => {
  const { titleEn, titleAr, game, price, prestige, stats, warranty, detailsEn, detailsAr, email, pass, extra, image, images } = req.body;
  if (!titleEn || !price) return res.status(400).json({ error: 'Title and price required' });
  const allImages = images && images.length ? images : (image ? [image] : []);
  const acc = { id: genId(), titleEn, titleAr: titleAr || '', game: game || 'Other', price: parseFloat(price), prestige: prestige || '', stats: stats || '', warranty: parseInt(warranty) || 0, detailsEn: detailsEn || '', detailsAr: detailsAr || '', email: email || '', pass: pass || '', extra: extra || '', images: allImages, status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString() };
  store.accounts.unshift(acc);

  const channelId = store.settings.accountsChannelId;
  if (channelId && client.isReady()) {
    const channel = client.channels.cache.get(channelId);
    if (channel) {
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(acc.titleEn)
        .setImage(allImages[0] || null)
        .addFields(
          { name: 'الاسم', value: acc.titleAr || '-', inline: false },
          { name: 'Rank / Level', value: acc.prestige || '-', inline: true },
          { name: 'Total Stats', value: acc.stats || '-', inline: true },
          { name: 'Warranty', value: acc.warranty > 0 ? acc.warranty + ' Days' : 'None', inline: true },
          { name: 'Details', value: acc.detailsEn || '-', inline: false },
          { name: 'التفاصيل', value: acc.detailsAr || '-', inline: false },
          { name: 'Price', value: '$' + acc.price.toFixed(2), inline: false }
        ).setFooter({ text: 'Acc. APP' });
      if (allImages.length > 1) {
        embed.addFields({ name: 'Images', value: allImages.length + ' photos available', inline: true });
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء المنتج / Buy').setStyle(ButtonStyle.Success).setEmoji('💰'),
        new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('التحقق / Verify').setStyle(ButtonStyle.Secondary).setEmoji('🔍')
      );
      channel.send({ embeds: [embed], components: [row] }).then(msg => {
        acc.discordMessageIds.push(msg.id);
        // Send additional images as separate messages
        if (allImages.length > 1) {
          allImages.slice(1, 10).forEach((img, i) => {
            channel.send({ files: [{ attachment: Buffer.from(img, 'base64'), name: 'image' + (i+2) + '.jpg' }] }).then(imgMsg => {
              acc.discordMessageIds.push(imgMsg.id);
            }).catch(() => {});
          });
        }
      }).catch(() => {});
    }
  }

  addLog('INFO', 'Account created: ' + titleEn + ' with ' + allImages.length + ' image(s)');
  res.json(acc);
});

app.put('/api/accounts/:id', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  const { image, images, ...rest } = req.body;
  if (images && images.length) rest.images = images;
  else if (image) rest.images = [image];
  Object.assign(acc, rest, { id: acc.id });
  addLog('INFO', 'Account updated: ' + acc.titleEn);
  res.json(acc);
});

app.delete('/api/accounts/:id', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  if (acc.discordMessageIds.length && client.isReady()) {
    const channel = client.channels.cache.get(store.settings.accountsChannelId);
    if (channel) acc.discordMessageIds.forEach(mid => channel.messages.delete(mid).catch(() => {}));
  }
  store.accounts = store.accounts.filter(a => a.id !== acc.id);
  addLog('WARN', 'Account deleted: ' + acc.titleEn);
  res.json({ success: true });
});

app.post('/api/accounts/:id/sold', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  acc.status = 'sold';
  addLog('INFO', 'Account marked sold: ' + acc.titleEn);
  res.json(acc);
});

app.post('/api/accounts/bulk', (req, res) => {
  const { game, price, warranty, credentials } = req.body;
  if (!credentials || !credentials.length) return res.status(400).json({ error: 'No credentials' });
  let count = 0;
  credentials.forEach(line => {
    let email = '', pass = line;
    const sep = line.match(/[:|]/);
    if (sep) { const idx = line.indexOf(sep[0]); email = line.slice(0, idx).trim(); pass = line.slice(idx + 1).trim(); }
    store.accounts.unshift({ id: genId(), titleEn: game + ' Account', titleAr: 'حساب ' + game, game, price: parseFloat(price) || 0, prestige: '-', stats: '-', warranty: parseInt(warranty) || 0, detailsEn: 'Bulk imported', detailsAr: 'مستورد بالجملة', email, pass, extra: 'Bulk', images: [], status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString() });
    count++;
  });
  addLog('INFO', 'Bulk import: ' + count + ' ' + game + ' accounts');
  res.json({ imported: count });
});

// --- Orders ---
app.get('/api/orders', (req, res) => {
  let { search, status } = req.query;
  let filtered = store.orders;
  if (search) { const s = search.toLowerCase(); filtered = filtered.filter(o => o.id.toLowerCase().includes(s) || o.cust.toLowerCase().includes(s) || o.item.toLowerCase().includes(s)); }
  if (status) filtered = filtered.filter(o => o.status === status);
  res.json(filtered);
});

app.post('/api/orders', (req, res) => {
  const { cust, custId, item, itemId, amount, paymentMethod } = req.body;
  const order = { id: 'ORD-' + String(1000 + store.orders.length + 1), cust, custId: custId || '', item, itemId: itemId || '', amount: parseFloat(amount) || 0, status: 'Pending', paymentMethod: paymentMethod || 'None', date: new Date().toISOString().slice(0, 16).replace('T', ' '), email: '', pass: '' };
  store.orders.unshift(order);
  addLog('INFO', 'New order: ' + order.id + ' — ' + item + ' via ' + order.paymentMethod);
  res.json(order);
});

app.post('/api/orders/:id/deliver', (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const acc = store.accounts.find(a => a.titleEn === order.item && a.status === 'available');
  if (acc) { order.email = acc.email; order.pass = acc.pass; acc.status = 'sold'; acc.soldTo = order.custId; }
  order.status = 'Delivered';
  if (order.custId && order.email && client.isReady()) {
    client.users.fetch(order.custId).then(user => {
      let msg = '**' + order.item + '**\n\nEmail: `' + order.email + '`\nPassword: `' + order.pass + '`';
      if (acc) msg += '\n\nWarranty: ' + (acc.warranty > 0 ? acc.warranty + ' days' : 'None');
      user.send(msg).catch(() => {});
    }).catch(() => {});
  }
  addLog('INFO', 'Delivered ' + order.id + ' to ' + order.cust);
  res.json(order);
});

app.post('/api/orders/:id/status', (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order.status = req.body.status;
  addLog('INFO', 'Order ' + order.id + ': ' + order.status);
  res.json(order);
});

// --- Payment Requests ---
app.get('/api/payments', (req, res) => {
  let filtered = store.paymentRequests;
  if (req.query.status) filtered = filtered.filter(p => p.status === req.query.status);
  res.json(filtered);
});

app.post('/api/payments', (req, res) => {
  const { userId, userName, accountId, accountTitle, amount, method } = req.body;
  const pr = { id: 'PAY-' + String(100 + store.paymentRequests.length + 1), userId: userId || '', userName: userName || 'Unknown', accountId: parseInt(accountId), accountTitle: accountTitle || '', amount: parseFloat(amount) || 0, method: method || 'Unknown', status: 'Pending', date: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  store.paymentRequests.unshift(pr);
  addLog('INFO', 'Payment request: ' + pr.id + ' — ' + pr.userName + ' wants ' + pr.accountTitle + ' via ' + pr.method);
  res.json(pr);
});

app.post('/api/payments/:id/approve', (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  pr.status = 'Approved';
  const acc = store.accounts.find(a => a.id === pr.accountId);
  if (acc) {
    acc.status = 'sold';
    const order = { id: 'ORD-' + String(1000 + store.orders.length + 1), cust: pr.userName, custId: pr.userId, item: pr.accountTitle, itemId: String(pr.accountId), amount: pr.amount, status: 'Delivered', paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' '), email: acc.email, pass: acc.pass };
    store.orders.unshift(order);
    if (pr.userId && acc.email && client.isReady()) {
      client.users.fetch(pr.userId).then(user => {
        user.send('✅ **Payment Approved!**\n\n**' + pr.accountTitle + '**\n\nEmail: `' + acc.email + '`\nPassword: `' + acc.pass + '`\n\nWarranty: ' + (acc.warranty > 0 ? acc.warranty + ' days' : 'None')).catch(() => {});
      }).catch(() => {});
    }
  }
  addLog('INFO', 'Payment approved: ' + pr.id);
  res.json(pr);
});

app.post('/api/payments/:id/reject', (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  pr.status = 'Rejected';
  addLog('INFO', 'Payment rejected: ' + pr.id);
  res.json(pr);
});

// --- Customers ---
app.get('/api/customers', (req, res) => {
  let { search, trust } = req.query;
  let filtered = store.customers;
  if (search) filtered = filtered.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  if (trust) filtered = filtered.filter(c => c.trust === trust);
  res.json(filtered);
});

app.post('/api/customers', (req, res) => {
  const { name, discordId, trust, notes } = req.body;
  const cust = { id: 'u' + genId(), name, discordId: discordId || '', trust: trust || 'New', spent: 0, purchases: 0, notes: notes || '', joined: new Date().toISOString().slice(0, 10) };
  store.customers.push(cust);
  addLog('INFO', 'Customer added: ' + name);
  res.json(cust);
});

app.post('/api/customers/:id/blacklist', (req, res) => { const c = store.customers.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Not found' }); c.trust = 'Blacklisted'; addLog('WARN', 'Blacklisted: ' + c.name); res.json(c); });
app.post('/api/customers/:id/unblacklist', (req, res) => { const c = store.customers.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Not found' }); c.trust = 'Verified'; addLog('INFO', 'Unblacklisted: ' + c.name); res.json(c); });

// --- Pools ---
app.get('/api/pools', (req, res) => { res.json(store.pools); });
app.post('/api/pools', (req, res) => { const { name, price } = req.body; const pool = { id: genId(), name: name || 'New Pool', price: parseFloat(price) || 0, stock: [] }; store.pools.push(pool); addLog('INFO', 'Pool created: ' + pool.name); res.json(pool); });
app.post('/api/pools/:id/stock', (req, res) => { const p = store.pools.find(x => x.id === parseInt(req.params.id)); if (!p) return res.status(404).json({ error: 'Not found' }); p.stock.push(...(req.body.entries || [])); addLog('INFO', 'Added entries to ' + p.name); res.json(p); });
app.delete('/api/pools/:id', (req, res) => { store.pools = store.pools.filter(x => x.id !== parseInt(req.params.id)); res.json({ success: true }); });

// --- Settings ---
app.get('/api/settings', (req, res) => { res.json(store.settings); });
app.post('/api/settings', (req, res) => { Object.assign(store.settings, req.body); addLog('INFO', 'Settings updated'); res.json(store.settings); });

// --- Logs ---
app.get('/api/logs', (req, res) => {
  let { level, search } = req.query;
  let filtered = store.logs;
  if (level) filtered = filtered.filter(l => l.level === level);
  if (search) filtered = filtered.filter(l => l.msg.toLowerCase().includes(search.toLowerCase()));
  res.json(filtered);
});
app.delete('/api/logs', (req, res) => { store.logs = []; res.json({ success: true }); });

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log('Panel running on port ' + PORT); });

// ===== DISCORD BOT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on('ready', () => {
  console.log('Bot online as ' + client.user.tag);
  addLog('INFO', 'Bot connected to Discord');
});

// ===== PAYMENT METHOD SELECTION =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  // BUY button clicked — show payment method selection
  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc || acc.status !== 'available') {
      return interaction.reply({ content: '❌ This account is no longer available.', ephemeral: true });
    }

    const pay = store.settings;
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('paymethod_' + accId)
      .setPlaceholder('اختر طريقة الدفع / Choose payment method')
      .setMinValues(1).setMaxValues(1)
      .addOptions(
        { label: 'STC Pay', value: 'stcpay', description: 'STC Pay — ' + (pay.stcPay.number || 'Not configured'), emoji: '📱' },
        { label: 'AlRajhi Bank', value: 'alrajhi', description: 'AlRajhi Bank Transfer — ' + (pay.alrajhi.iban ? pay.alrajhi.iban.slice(-4) + '...' : 'Not configured'), emoji: '🏦' },
        { label: 'PayPal', value: 'paypal', description: 'PayPal — ' + (pay.paypal.email || 'Not configured'), emoji: '💳' }
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embed = new EmbedBuilder()
      .setColor(0xf0b232)
      .setTitle('💰 Choose Payment Method')
      .setDescription('**' + acc.titleEn + '** — $' + acc.price.toFixed(2) + '\n\nSelect your payment method below:')
      .setFooter({ text: 'Acc. APP — Payment' });

    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // Payment method selected — show payment details
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc || acc.status !== 'available') {
      return interaction.reply({ content: '❌ This account is no longer available.', ephemeral: true });
    }

    const method = interaction.values[0];
    const pay = store.settings;
    let payInfo = '';
    let payEmoji = '';

    if (method === 'stcpay') {
      payEmoji = '📱';
      payInfo = '**STC Pay**\nNumber: `' + (pay.stcPay.number || 'Not configured') + '`' + (pay.stcPay.name ? '\nName: ' + pay.stcPay.name : '');
    } else if (method === 'alrajhi') {
      payEmoji = '🏦';
      payInfo = '**AlRajhi Bank Transfer**\nIBAN: `' + (pay.alrajhi.iban || 'Not configured') + '`' + (pay.alrajhi.name ? '\nName: ' + pay.alrajhi.name : '');
    } else if (method === 'paypal') {
      payEmoji = '💳';
      payInfo = '**PayPal**\nEmail: `' + (pay.paypal.email || 'Not configured') + '`' + (pay.paypal.name ? '\nName: ' + pay.paypal.name : '');
    }

    const embed = new EmbedBuilder()
      .setColor(0x23a55a)
      .setTitle(payEmoji + ' Send Payment')
      .setDescription('**' + acc.titleEn + '** — $' + acc.price.toFixed(2) + '\n\n' + payInfo + '\n\n**After sending payment:**\n1. Take a screenshot of the payment receipt\n2. Send the screenshot in a DM to this bot\n3. Wait for admin to confirm')
      .setFooter({ text: 'Account will be delivered after payment confirmation' });

    // Create payment request
    store.paymentRequests.unshift({
      id: 'PAY-' + String(100 + store.paymentRequests.length + 1),
      userId: interaction.user.id,
      userName: interaction.user.username,
      accountId: accId,
      accountTitle: acc.titleEn,
      amount: acc.price,
      method: method === 'stcpay' ? 'STC Pay' : method === 'alrajhi' ? 'AlRajhi Bank' : 'PayPal',
      status: 'Pending',
      date: new Date().toISOString().slice(0, 16).replace('T', ' ')
    });

    addLog('INFO', interaction.user.username + ' selected ' + (method === 'stcpay' ? 'STC Pay' : method === 'alrajhi' ? 'AlRajhi Bank' : 'PayPal') + ' for ' + acc.titleEn);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // VERIFY button
  if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc) return interaction.reply({ content: '❌ Account not found.', ephemeral: true });
    return interaction.reply({
      content: '🔍 **Verification for ' + acc.titleEn + '**\n- Status: ' + acc.status + '\n- Rank: ' + acc.prestige + '\n- Stats: ' + acc.stats + '\n- Warranty: ' + (acc.warranty > 0 ? acc.warranty + ' days' : 'None') + '\n- Images: ' + acc.images.length,
      ephemeral: true
    });
  }
});

// Handle payment screenshot uploads in DM
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== 1) return; // DMs only

  if (message.attachments.size > 0) {
    const pending = store.paymentRequests.find(p => p.userId === message.author.id && p.status === 'Pending');
    if (pending) {
      pending.status = 'Waiting Review';
      addLog('INFO', 'Payment screenshot received from ' + message.author.username + ' for ' + pending.id);
      message.reply('✅ **Payment screenshot received!**\n\nYour payment for **' + pending.accountTitle + '** ($' + pending.amount.toFixed(2) + ') via **' + pending.method + '** is being reviewed.\n\nYou will receive your account once confirmed.').catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch(err => { console.error('Login failed:', err.message); });
