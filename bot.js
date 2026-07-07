const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, Partials, StringSelectMenuBuilder, AttachmentBuilder,
  PermissionFlagsBits, ChannelType
} = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

function findPanelHtml() {
  const paths = [path.join(__dirname, 'panel.html'), path.join(__dirname, 'public', 'panel.html'), path.join('/app', 'panel.html'), path.join('/app', 'public', 'panel.html')];
  for (const p of paths) { if (fs.existsSync(p)) { console.log('panel.html found at: ' + p); return p; } }
  return null;
}
const panelPath = findPanelHtml();
if (panelPath) { app.get('/panel.html', (req, res) => res.sendFile(panelPath)); app.get('/', (req, res) => res.redirect('/panel.html')); }
else { app.get('/', (req, res) => { let h = '<h1>Debug:</h1><pre>'; try { fs.readdirSync(__dirname).forEach(f => { h += f + '\n'; }); } catch(e) { h += e.message; } res.send(h + '</pre>'); }); }

let store = {
  accounts: [], orders: [], customers: [], pools: [], paymentRequests: [], tickets: [], logs: [],
  settings: {
    prefix: '!', currency: '$', accountsChannelId: '', ticketCategoryId: '', logChannelId: '', ownerId: '',
    termsAr: 'الشروط العامة\n━━━━━━━━━━━━━━━\n▪️ يتم تسليم الحساب فور تأكيد الدفع\n▪️ الضمان يبدأ من تاريخ الشراء\n▪️ لا يوجد استرداد بعد تسليم الحساب',
    termsEn: 'General Terms\n━━━━━━━━━━━━━━━\n▪️ Account delivered immediately after payment\n▪️ Warranty starts from purchase date',
    stcPay: { number: '05XXXXXXXX', name: '' }, alrajhi: { iban: 'SA0000000000000000000', name: '' }, paypal: { email: 'pay@example.com', name: '' }
  },
  nextId: 1
};

function genId() { return store.nextId++; }
function addLog(level, msg) { store.logs.unshift({ time: new Date().toTimeString().slice(0, 8), level, msg }); if (store.logs.length > 500) store.logs.length = 500; }

function base64ToBuffer(dataUri) {
  const m = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  return Buffer.from(m[2], 'base64');
}

// COMBINE all images into ONE vertical strip so it fits inside the embed
async function combineImages(allImages) {
  if (!allImages.length) return null;
  if (allImages.length === 1) return base64ToBuffer(allImages[0]);
  
  const buffers = allImages.map(b64 => base64ToBuffer(b64)).filter(Boolean);
  if (!buffers.length) return null;
  
  const images = await Promise.all(buffers.map(buf => sharp(buf).resize(800, null, { withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()));
  
  if (images.length === 1) return images[0];
  
  const metadatas = await Promise.all(images.map(buf => sharp(buf).metadata()));
  const totalHeight = metadatas.reduce((s, m) => s + m.height, 0);
  const maxWidth = Math.max(...metadatas.map(m => m.width));
  
  const composite = await sharp({
    create: { width: maxWidth, height: totalHeight, channels: 3, background: { r: 0, g: 0, b: 0 } }
  }).composite(images.map((buf, i) => ({ input: buf, top: metadatas.slice(0, i).reduce((s, m) => s + m.height, 0), left: 0 })))
    .jpeg({ quality: 85 }).toBuffer();
  
  return composite;
}

function sendLogToDiscord(msg) {
  const chId = store.settings.logChannelId;
  if (chId && client.isReady()) { const ch = client.channels.cache.get(chId); if (ch) ch.send(msg).catch(() => {}); }
}

// ===== API ROUTES =====
app.get('/api/stats', (req, res) => { try { res.json({ totalAccounts: store.accounts.length, available: store.accounts.filter(a => a.status === 'available').length, reserved: store.accounts.filter(a => a.status === 'reserved').length, sold: store.accounts.filter(a => a.status === 'sold').length, dead: store.accounts.filter(a => a.status === 'dead').length, totalRevenue: store.orders.filter(o => o.status === 'Delivered').reduce((s, o) => s + o.amount, 0), totalOrders: store.orders.length, pendingOrders: store.orders.filter(o => o.status === 'Pending').length, pendingPayments: store.paymentRequests.filter(p => p.status === 'Pending' || p.status === 'Waiting Review').length, openTickets: store.tickets.filter(t => t.status !== 'closed').length, totalCustomers: store.customers.length, botOnline: client.isReady() }); } catch(e) { res.status(500).json({ error: e.message }); } });

app.get('/api/accounts', (req, res) => { try { let { search, game, status } = req.query; let f = store.accounts; if (search) { const s = search.toLowerCase(); f = f.filter(a => a.titleEn.toLowerCase().includes(s) || (a.titleAr && a.titleAr.includes(s))); } if (game) f = f.filter(a => a.game === game); if (status) f = f.filter(a => a.status === status); res.json(f); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/accounts', async (req, res) => {
  try {
    const { titleEn, titleAr, game, price, prestige, stats, warranty, detailsEn, detailsAr, email, pass, extra, images } = req.body;
    if (!titleEn || !price) return res.status(400).json({ error: 'Title and price required' });
    const allImages = images && Array.isArray(images) ? images : [];
    const acc = { id: genId(), titleEn, titleAr: titleAr || '', game: game || 'Other', price: parseFloat(price), prestige: prestige || '', stats: stats || '', warranty: parseInt(warranty) || 0, detailsEn: detailsEn || '', detailsAr: detailsAr || '', email: email || '', pass: pass || '', extra: extra || '', images: allImages, status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString() };
    store.accounts.unshift(acc);
    const channelId = store.settings.accountsChannelId;
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) postAccountToDiscord(channel, acc, allImages).catch(err => { console.error('Discord post error:', err.message); addLog('ERROR', 'Discord post failed: ' + err.message); });
    }
    addLog('INFO', 'Account created: ' + titleEn + ' with ' + allImages.length + ' image(s)');
    res.json(acc);
  } catch(e) { console.error('POST /api/accounts error:', e); res.status(500).json({ error: e.message }); }
});

async function postAccountToDiscord(channel, acc, allImages) {
  const combined = await combineImages(allImages);
  const files = [];
  if (combined) {
    files.push(new AttachmentBuilder(combined, { name: 'cover.jpg' }));
  }
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(acc.titleEn)
    .addFields(
      { name: 'الاسم', value: acc.titleAr || '-', inline: false },
      { name: 'Rank / Level', value: acc.prestige || '-', inline: true },
      { name: 'Total Stats', value: acc.stats || '-', inline: true },
      { name: 'Warranty', value: acc.warranty > 0 ? acc.warranty + ' Days' : 'None', inline: true },
      { name: 'Details', value: acc.detailsEn || '-', inline: false },
      { name: 'التفاصيل', value: acc.detailsAr || '-', inline: false },
      { name: 'Price', value: store.settings.currency + acc.price.toFixed(2), inline: false }
    ).setFooter({ text: 'Product ID: ' + acc.id });
  if (files.length) embed.setImage('attachment://cover.jpg');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء المنتج / Buy').setStyle(ButtonStyle.Success).setEmoji('💰'),
    new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('التحقق / Verify').setStyle(ButtonStyle.Secondary).setEmoji('🔍')
  );
  const msg = await channel.send({ embeds: [embed], components: [row], files });
  acc.discordMessageIds.push(msg.id);
  addLog('INFO', 'Posted ' + acc.titleEn + ' to Discord (' + allImages.length + ' images combined into 1)');
}

app.put('/api/accounts/:id', (req, res) => { try { const a = store.accounts.find(x => x.id === parseInt(req.params.id)); if (!a) return res.status(404).json({ error: 'Not found' }); const { images, ...r } = req.body; if (images) r.images = images; Object.assign(a, r, { id: a.id }); addLog('INFO', 'Account updated: ' + a.titleEn); res.json(a); } catch(e) { res.status(500).json({ error: e.message }); } });

app.delete('/api/accounts/:id', (req, res) => { try { const a = store.accounts.find(x => x.id === parseInt(req.params.id)); if (!a) return res.status(404).json({ error: 'Not found' }); if (a.discordMessageIds.length && client.isReady()) { const ch = client.channels.cache.get(store.settings.accountsChannelId); if (ch) a.discordMessageIds.forEach(mid => ch.messages.delete(mid).catch(() => {})); } store.accounts = store.accounts.filter(x => x.id !== a.id); addLog('WARN', 'Account deleted: ' + a.titleEn); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/accounts/:id/sold', (req, res) => { try { const a = store.accounts.find(x => x.id === parseInt(req.params.id)); if (!a) return res.status(404).json({ error: 'Not found' }); a.status = 'sold'; addLog('INFO', 'Account marked sold: ' + a.titleEn); res.json(a); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/accounts/bulk', (req, res) => { try { const { game, price, warranty, credentials } = req.body; if (!credentials || !credentials.length) return res.status(400).json({ error: 'No credentials' }); let c = 0; credentials.forEach(line => { let email = '', pass = line; const sep = line.match(/[:|]/); if (sep) { const i = line.indexOf(sep[0]); email = line.slice(0, i).trim(); pass = line.slice(i + 1).trim(); } store.accounts.unshift({ id: genId(), titleEn: game + ' Account', titleAr: 'حساب ' + game, game, price: parseFloat(price) || 0, prestige: '-', stats: '-', warranty: parseInt(warranty) || 0, detailsEn: 'Bulk', detailsAr: 'جملة', email, pass, extra: 'Bulk', images: [], status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString() }); c++; }); addLog('INFO', 'Bulk imported ' + c + ' accounts'); res.json({ imported: c }); } catch(e) { res.status(500).json({ error: e.message }); } });

app.get('/api/orders', (req, res) => { try { let f = store.orders; if (req.query.status) f = f.filter(o => o.status === req.query.status); res.json(f); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/orders/:id/deliver', (req, res) => { try { const o = store.orders.find(x => x.id === req.params.id); if (!o) return res.status(404).json({ error: 'Not found' }); const a = store.accounts.find(x => x.id === parseInt(o.itemId)); if (a) { o.email = a.email; o.pass = a.pass; a.status = 'sold'; a.soldTo = o.custId; } o.status = 'Delivered'; if (o.custId && client.isReady()) client.users.fetch(o.custId).then(u => u.send('✅ **تم التسليم!**\n\n' + o.item + '\n📧 `' + o.email + '`\n🔑 `' + o.pass + '`').catch(() => {})).catch(() => {}); addLog('INFO', 'Delivered ' + o.id); res.json(o); } catch(e) { res.status(500).json({ error: e.message }); } });

app.get('/api/payments', (req, res) => { try { res.json(req.query.status ? store.paymentRequests.filter(p => p.status === req.query.status) : store.paymentRequests); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    pr.status = 'Approved';
    const acc = store.accounts.find(a => a.id === pr.accountId);
    if (acc) {
      acc.status = 'sold'; acc.soldTo = pr.userId;
      store.orders.unshift({ id: 'ORD-' + String(1000 + store.orders.length + 1), cust: pr.userName, custId: pr.userId, item: pr.accountTitle, itemId: String(pr.accountId), amount: pr.amount, status: 'Delivered', paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' '), email: acc.email, pass: acc.pass });
      let cust = store.customers.find(c => c.discordId === pr.userId);
      if (!cust) { cust = { id: 'u' + genId(), name: pr.userName, discordId: pr.userId, trust: 'Verified', spent: 0, purchases: 0, notes: '', joined: new Date().toISOString().slice(0, 10) }; store.customers.push(cust); }
      cust.purchases++; cust.spent += pr.amount;

      // Deliver in ticket and auto-close
      const ticket = store.tickets.find(t => t.paymentId === pr.id);
      if (ticket && ticket.channelId && client.isReady()) {
        const tch = client.channels.cache.get(ticket.channelId);
        if (tch) {
          await tch.send('✅ **تم تأكيد الدفع! / Payment Confirmed!**\n\n**' + pr.accountTitle + '**\n📧 Email: `' + acc.email + '`\n🔑 Password: `' + acc.pass + '`\n\nشكرًا لشرائك! / Thank you!\n\n⏳ Ticket auto-closing in 10 seconds...');
          ticket.status = 'closed';
          setTimeout(() => { tch.delete('Purchase completed').catch(() => {}); }, 10000);
        }
      } else if (pr.userId && client.isReady()) {
        client.users.fetch(pr.userId).then(u => u.send('✅ **تم التسليم!**\n' + pr.accountTitle + '\n📧 `' + acc.email + '`\n🔑 `' + acc.pass + '`').catch(() => {})).catch(() => {});
      }
    }
    sendLogToDiscord('✅ Payment approved: `' + pr.id + '` — **' + pr.accountTitle + '** ($' + pr.amount + ')');
    addLog('INFO', 'Payment approved: ' + pr.id);
    res.json(pr);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments/:id/reject', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    pr.status = 'Rejected';
    const ticket = store.tickets.find(t => t.paymentId === pr.id);
    if (ticket && ticket.channelId && client.isReady()) {
      const tch = client.channels.cache.get(ticket.channelId);
      if (tch) { await tch.send('❌ **Payment Rejected**\n`' + pr.id + '` — You can re-upload a receipt.'); ticket.status = 'open'; pr.status = 'Pending'; }
    }
    addLog('WARN', 'Payment rejected: ' + pr.id);
    res.json(pr);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets', (req, res) => { try { res.json(req.query.status ? store.tickets.filter(t => t.status === req.query.status) : store.tickets); } catch(e) { res.status(500).json({ error: e.message }); } });

app.post('/api/tickets/:id/close', async (req, res) => {
  try {
    const t = store.tickets.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    t.status = 'closed';
    if (t.channelId && client.isReady()) { const ch = client.channels.cache.get(t.channelId); if (ch) { await ch.send('🔒 Ticket closed'); setTimeout(() => ch.delete('Closed by admin').catch(() => {}), 5000); } }
    const pr = store.paymentRequests.find(p => p.id === t.paymentId);
    if (pr && (pr.status === 'Pending' || pr.status === 'Rejected')) { const a = store.accounts.find(x => x.id === pr.accountId); if (a && a.status === 'reserved') { a.status = 'available'; a.soldTo = null; } }
    addLog('INFO', 'Ticket ' + t.id + ' closed');
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/customers', (req, res) => { try { res.json(store.customers); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers', (req, res) => { try { store.customers.push(req.body); res.json(req.body); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/blacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Blacklisted'; res.json(c); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/unblacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Verified'; res.json(c); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/pools', (req, res) => { try { res.json(store.pools); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/pools', (req, res) => { try { const p = { id: genId(), name: req.body.name, price: parseFloat(req.body.price), stock: [] }; store.pools.push(p); res.json(p); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/pools/:id', (req, res) => { try { store.pools = store.pools.filter(x => x.id !== parseInt(req.params.id)); res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/settings', (req, res) => { try { res.json(store.settings); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/settings', (req, res) => { try { Object.assign(store.settings, req.body); res.json(store.settings); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/logs', (req, res) => { try { res.json(store.logs); } catch(e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/logs', (req, res) => { try { store.logs = []; res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });

// ===== DISCORD BOT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages], partials: [Partials.Message, Partials.Channel, Partials.Reaction] });

client.on('ready', () => { console.log('Bot online: ' + client.user.tag); addLog('INFO', 'Bot connected'); sendLogToDiscord('🟢 **Bot Online**'); });

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  try {
    // BUY → Create Ticket
    if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc || acc.status !== 'available') return interaction.reply({ content: '❌ غير متوفر / Not available.', ephemeral: true });
      const existing = store.tickets.find(t => t.userId === interaction.user.id && t.accountId === accId && t.status !== 'closed');
      if (existing) return interaction.reply({ content: '🎫 لديك تذكرة مفتوحة: <#' + existing.channelId + '>', ephemeral: true });
      const catId = store.settings.ticketCategoryId;
      if (!catId) return interaction.reply({ content: '❌ النظام غير جاهز / System not ready.', ephemeral: true });
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ يعمل داخل السيرفر فقط.', ephemeral: true });
      const category = guild.channels.cache.get(catId);
      if (!category || category.type !== ChannelType.GuildCategory) return interaction.reply({ content: '❌ إعدادات التذاكر خاطئة.', ephemeral: true });
      acc.status = 'reserved';
      const ticketChannel = await guild.channels.create({
        name: 'ticket-' + interaction.user.username + '-' + accId, type: ChannelType.GuildText, parent: category,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
        ]
      });
      if (store.settings.ownerId) await ticketChannel.permissionOverwrites.create(store.settings.ownerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true }).catch(() => {});
      const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(3, '0');
      store.tickets.unshift({ id: ticketId, userId: interaction.user.id, userName: interaction.user.username, accountId: accId, accountTitle: acc.titleEn, amount: acc.price, channelId: ticketChannel.id, paymentId: null, paymentMethod: null, status: 'open', createdAt: new Date().toISOString() });
      const pay = store.settings;
      const select = new StringSelectMenuBuilder().setCustomId('paymethod_' + accId + '_' + ticketId).setPlaceholder('اختر طريقة الدفع / Choose payment').addOptions(
        { label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + (pay.stcPay.number || 'N/A'), emoji: '📱' },
        { label: 'AlRajhi Bank', value: 'alrajhi', description: 'تحويل راجحي', emoji: '🏦' },
        { label: 'PayPal', value: 'paypal', description: 'PayPal: ' + (pay.paypal.email || 'N/A'), emoji: '💳' }
      );
      const welcomeEmbed = new EmbedBuilder().setColor(0x5865f2).setTitle('🛒 طلب شراء / Purchase Request')
        .setDescription('مرحباً **' + interaction.user.username + '**!\n\n**المنتج:** ' + acc.titleEn + '\n**السعر:** ' + pay.currency + acc.price.toFixed(2) + '\n**التذكرة:** `' + ticketId + '`\n\nاختر طريقة الدفع / Select payment method:')
        .setFooter({ text: 'Acc. Store Bot' }).setTimestamp();
      const closeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_' + ticketId).setLabel('إغلاق / Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'));
      await ticketChannel.send({ content: '👤 <@' + interaction.user.id + '> | 🎫 Private Purchase Ticket', embeds: [welcomeEmbed], components: [new ActionRowBuilder().addComponents(select), closeRow] });
      await interaction.reply({ content: '🎫 تم إنشاء تذكرة: <#' + ticketChannel.id + '>', ephemeral: true });
      addLog('INFO', 'Ticket ' + ticketId + ' created for ' + interaction.user.username);
      sendLogToDiscord('🎫 Ticket `' + ticketId + '` by **' + interaction.user.username + '** → **' + acc.titleEn + '** ($' + acc.price + ')');
      return;
    }

    // PAYMENT METHOD SELECT
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_')) {
      const parts = interaction.customId.split('_');
      const accId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc) return interaction.reply({ content: '❌ المنتج غير موجود.', ephemeral: true });
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ التذكرة غير موجودة.', ephemeral: true });
      const method = interaction.values[0];
      const pay = store.settings;
      let info = '';
      if (method === 'stcpay') info = '📱 **STC Pay**\nالرقم: `' + pay.stcPay.number + '`\nالاسم: *' + (pay.stcPay.name || '-') + '*';
      if (method === 'alrajhi') info = '🏦 **AlRajhi**\nIBAN: `' + pay.alrajhi.iban + '`\nالاسم: *' + (pay.alrajhi.name || '-') + '*';
      if (method === 'paypal') info = '💳 **PayPal**\nEmail: `' + pay.paypal.email + '`';
      const payId = 'PAY-' + String(100 + store.paymentRequests.length + 1);
      store.paymentRequests.unshift({ id: payId, userId: interaction.user.id, userName: interaction.user.username, accountId: accId, accountTitle: acc.titleEn, amount: acc.price, method: method.toUpperCase(), status: 'Pending', date: new Date().toISOString().slice(0, 16).replace('T', ' ') });
      ticket.paymentId = payId; ticket.paymentMethod = method.toUpperCase(); ticket.status = 'waiting_payment';
      const payEmbed = new EmbedBuilder().setColor(0xf0b232).setTitle('💳 بيانات الدفع / Payment Info')
        .setDescription('**المنتج:** ' + acc.titleEn + '\n**المبلغ:** ' + pay.currency + acc.price.toFixed(2) + '\n**رقم العملية:** `' + payId + '`\n\n' + info + '\n\n⚠️ **الخطوة التالية:**\nحول المبلغ ثم **ارفع صورة الإيصال هنا**.\nTransfer amount then **upload receipt here**.')
        .setFooter({ text: 'Awaiting payment proof...' }).setTimestamp();
      await interaction.reply({ embeds: [payEmbed] });
      addLog('INFO', interaction.user.username + ' selected ' + method.toUpperCase() + ' for ' + payId);
      return;
    }

    // CLOSE TICKET
    if (interaction.isButton() && interaction.customId.startsWith('close_ticket_')) {
      const ticketId = interaction.customId.replace('close_ticket_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌', ephemeral: true });
      if (interaction.user.id !== ticket.userId && interaction.user.id !== store.settings.ownerId) return interaction.reply({ content: '❌ لا يمكنك الإغلاق.', ephemeral: true });
      ticket.status = 'closed';
      const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
      if (pr && (pr.status === 'Pending' || pr.status === 'Rejected')) { const a = store.accounts.find(x => x.id === ticket.accountId); if (a && a.status === 'reserved') { a.status = 'available'; a.soldTo = null; } }
      await interaction.reply({ content: '🔒 Ticket closing in 5 seconds...' });
      addLog('INFO', 'Ticket ' + ticketId + ' closed by ' + interaction.user.username);
      setTimeout(() => { interaction.channel.delete('Closed').catch(() => {}); }, 5000);
      return;
    }

    // VERIFY
    if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
      const acc = store.accounts.find(a => a.id === parseInt(interaction.customId.split('_')[1]));
      if (!acc) return interaction.reply({ content: '❌', ephemeral: true });
      return interaction.reply({ content: '🔍 **Account Status:**\n• Status: `' + acc.status + '`\n• Rank: `' + (acc.prestige || '-') + '`\n• Images: `' + acc.images.length + '`', ephemeral: true });
    }
  } catch(err) {
    console.error('Interaction error:', err);
    try { if (interaction.replied || interaction.deferred) await interaction.followUp({ content: '❌ Error occurred.', ephemeral: true }); else await interaction.reply({ content: '❌ Error occurred.', ephemeral: true }); } catch(e) {}
  }
});

// Capture receipt in ticket channels
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  // DM fallback
  if (message.channel.type === 1) {
    const p = store.paymentRequests.find(x => x.userId === message.author.id && x.status === 'Pending');
    if (p && message.attachments.size > 0) { p.status = 'Waiting Review'; addLog('INFO', 'Receipt via DM for ' + p.id); message.reply('✅ Receipt received for `' + p.id + '`. Awaiting admin review.').catch(() => {}); }
    return;
  }
  // Ticket channel receipt
  const ticket = store.tickets.find(t => t.channelId === message.channel.id && (t.status === 'waiting_payment' || t.status === 'waiting_review'));
  if (ticket && message.attachments.size > 0) {
    const img = message.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
    if (img) {
      const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
      if (pr && pr.status === 'Pending') {
        pr.status = 'Waiting Review'; ticket.status = 'waiting_review';
        await message.reply('✅ **تم استلام الإيصال! / Receipt Received!**\n\nRef: `' + pr.id + '`\n⏳ Admin is reviewing...');
        addLog('INFO', 'Receipt in ticket ' + ticket.id + ' for ' + pr.id);
        sendLogToDiscord('📨 Receipt in ticket `' + ticket.id + '` for `' + pr.id + '` — **' + ticket.accountTitle + '**');
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log('Server on port ' + PORT); });
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Discord login failed:', err.message));
