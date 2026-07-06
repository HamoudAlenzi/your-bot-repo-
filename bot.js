// =============================================
// ACC STORE BOT — With Advanced Payment & Multi-Image Upload
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');

// ===== EXPRESS SERVER =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

// ===== FIND panel.html =====
function findPanelHtml() {
  const paths = [
    path.join(__dirname, 'panel.html'),
    path.join(__dirname, 'public', 'panel.html'),
    path.join('/app', 'panel.html'),
    path.join('/app', 'public', 'panel.html'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) { console.log('panel.html found at: ' + p); return p; }
  }
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
    termsAr: 'الشروط العامة\n━━━━━━━━━━━━━━━\n▪️ يتم تسليم الحساب فور تأكيد الدفع\n▪️ الضمان يبدأ من تاريخ الشراء\n▪️ لا يوجد استرداد بعد تسليم الحساب',
    termsEn: 'General Terms\n━━━━━━━━━━━━━━━\n▪️ Account delivered immediately after payment\n▪️ Warranty starts from purchase date',
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
    pendingPayments: store.paymentRequests.filter(p => p.status === 'Pending' || p.status === 'Waiting Review').length,
    totalCustomers: store.customers.length,
    botOnline: client.isReady()
  });
});

app.get('/api/accounts', (req, res) => {
  let { search, game, status } = req.query;
  let filtered = store.accounts;
  if (search) { const s = search.toLowerCase(); filtered = filtered.filter(a => a.titleEn.toLowerCase().includes(s) || (a.titleAr && a.titleAr.includes(s))); }
  if (game) filtered = filtered.filter(a => a.game === game);
  if (status) filtered = filtered.filter(a => a.status === status);
  res.json(filtered);
});

app.post('/api/accounts', (req, res) => {
  const { titleEn, titleAr, game, price, prestige, stats, warranty, detailsEn, detailsAr, email, pass, extra, images } = req.body;
  if (!titleEn || !price) return res.status(400).json({ error: 'Title and price required' });
  
  const allImages = images && Array.isArray(images) ? images : [];
  const acc = { 
    id: genId(), titleEn, titleAr: titleAr || '', game: game || 'Other', 
    price: parseFloat(price), prestige: prestige || '', stats: stats || '', 
    warranty: parseInt(warranty) || 0, detailsEn: detailsEn || '', detailsAr: detailsAr || '', 
    email: email || '', pass: pass || '', extra: extra || '', images: allImages, 
    status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString() 
  };
  
  store.accounts.unshift(acc);
  const channelId = store.settings.accountsChannelId;

  if (channelId && client.isReady()) {
    const channel = client.channels.cache.get(channelId);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(acc.titleEn)
        .addFields(
          { name: 'الاسم', value: acc.titleAr || '-', inline: false },
          { name: 'Rank / Level', value: acc.prestige || '-', inline: true },
          { name: 'Total Stats', value: acc.stats || '-', inline: true },
          { name: 'Warranty', value: acc.warranty > 0 ? acc.warranty + ' Days' : 'None', inline: true },
          { name: 'Details', value: acc.detailsEn || '-', inline: false },
          { name: 'التفاصيل', value: acc.detailsAr || '-', inline: false },
          { name: 'Price', value: store.settings.currency + acc.price.toFixed(2), inline: false }
        )
        .setFooter({ text: 'Product ID: ' + acc.id });

      if (allImages.length > 0) {
        embed.setImage(allImages[0]); 
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء المنتج / Buy').setStyle(ButtonStyle.Success).setEmoji('💰'),
        new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('التحقق / Verify').setStyle(ButtonStyle.Secondary).setEmoji('🔍')
      );

      channel.send({ embeds: [embed], components: [row] }).then(async (msg) => {
        acc.discordMessageIds.push(msg.id);
        
        // Handle secondary images safely as attachments
        if (allImages.length > 1) {
          for (let i = 1; i < allImages.length; i++) {
            try {
              const base64Data = allImages[i].replace(/^data:image\/\w+;base64,/, "");
              const buffer = Buffer.from(base64Data, 'base64');
              const attachment = new AttachmentBuilder(buffer, { name: `extra_${i}.jpg` });
              const imgMsg = await channel.send({ files: [attachment] });
              acc.discordMessageIds.push(imgMsg.id);
            } catch (err) {
              console.error('Failed to attach extra image:', err.message);
            }
          }
        }
      }).catch(err => console.error('Discord post error:', err));
    }
  }

  addLog('INFO', `Account created: ${titleEn} with ${allImages.length} image(s)`);
  res.json(acc);
});

app.put('/api/accounts/:id', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  const { images, ...rest } = req.body;
  if (images) rest.images = images;
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
  if (!credentials || !credentials.length) return res.status(400).json({ error: 'No credentials provided' });
  let count = 0;
  credentials.forEach(line => {
    let email = '', pass = line;
    const sep = line.match(/[:|]/);
    if (sep) { const idx = line.indexOf(sep[0]); email = line.slice(0, idx).trim(); pass = line.slice(idx + 1).trim(); }
    store.accounts.unshift({ id: genId(), titleEn: game + ' Account', titleAr: 'حساب ' + game, game, price: parseFloat(price) || 0, prestige: '-', stats: '-', warranty: parseInt(warranty) || 0, detailsEn: 'Bulk imported', detailsAr: 'مستورد بالجملة', email, pass, extra: 'Bulk', images: [], status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString() });
    count++;
  });
  addLog('INFO', `Bulk imported ${count} accounts for ${game}`);
  res.json({ imported: count });
});

// --- Orders & Payments Channels ---
app.get('/api/orders', (req, res) => {
  let { search, status } = req.query;
  let filtered = store.orders;
  if (search) { const s = search.toLowerCase(); filtered = filtered.filter(o => o.id.toLowerCase().includes(s) || o.cust.toLowerCase().includes(s)); }
  if (status) filtered = filtered.filter(o => o.status === status);
  res.json(filtered);
});

app.post('/api/orders/:id/deliver', (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const acc = store.accounts.find(a => a.id === parseInt(order.itemId));
  if (acc) { order.email = acc.email; order.pass = acc.pass; acc.status = 'sold'; acc.soldTo = order.custId; }
  order.status = 'Delivered';
  
  if (order.custId && client.isReady()) {
    client.users.fetch(order.custId).then(user => {
      user.send(`✅ **تمت عملية الشراء بنجاح / Purchase Successful!**\n\n**${order.item}**\n📧 Email: \`${order.email}\`\n🔑 Password: \`${order.pass}\``).catch(() => {});
    }).catch(() => {});
  }
  addLog('INFO', `Delivered ${order.id} manually via panel.`);
  res.json(order);
});

app.get('/api/payments', (req, res) => {
  if (req.query.status) return res.json(store.paymentRequests.filter(p => p.status === req.query.status));
  res.json(store.paymentRequests);
});

app.post('/api/payments/:id/approve', (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Request missing' });
  pr.status = 'Approved';
  
  const acc = store.accounts.find(a => a.id === pr.accountId);
  if (acc) {
    acc.status = 'sold';
    const order = { id: 'ORD-' + String(1000 + store.orders.length + 1), cust: pr.userName, custId: pr.userId, item: pr.accountTitle, itemId: String(pr.accountId), amount: pr.amount, status: 'Delivered', paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' '), email: acc.email, pass: acc.pass };
    store.orders.unshift(order);
    
    // Log user sync down to internal customers tracking data
    let customer = store.customers.find(c => c.discordId === pr.userId);
    if (!customer) {
      customer = { id: 'u' + genId(), name: pr.userName, discordId: pr.userId, trust: 'Verified', spent: 0, purchases: 0, notes: '', joined: new Date().toISOString().slice(0,10) };
      store.customers.push(customer);
    }
    customer.purchases += 1;
    customer.spent += pr.amount;

    if (pr.userId && client.isReady()) {
      client.users.fetch(pr.userId).then(user => {
        user.send(`✅ **تم تأكيد الدفع بنجاح! / Payment Confirmed!**\n\n**${pr.accountTitle}**\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\`\n\nشكرًا لشرائك منا!`).catch(() => {});
      }).catch(() => {});
    }
  }
  addLog('INFO', `Payment approved & delivered: ${pr.id}`);
  res.json(pr);
});

app.post('/api/payments/:id/reject', (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  pr.status = 'Rejected';
  if (pr.userId && client.isReady()) {
    client.users.fetch(pr.userId).then(user => {
      user.send(`❌ **تم رفض عملية الدفع / Payment Rejected**\n\nطلب رقم: \`${pr.id}\` الخاص بـ **${pr.accountTitle}** تم رفضه من قبل الإدارة. يرجى مراجعة الدعم الفني.`).catch(() => {});
    }).catch(() => {});
  }
  addLog('WARN', `Payment rejected: ${pr.id}`);
  res.json(pr);
});

// --- Simple Setup Passthroughs ---
app.get('/api/customers', (req, res) => res.json(store.customers));
app.post('/api/customers', (req, res) => { store.customers.push(req.body); res.json(req.body); });
app.post('/api/customers/:id/blacklist', (req, res) => { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Blacklisted'; res.json(c); });
app.post('/api/customers/:id/unblacklist', (req, res) => { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Verified'; res.json(c); });
app.get('/api/pools', (req, res) => res.json(store.pools));
app.post('/api/pools', (req, res) => { const pool = { id: genId(), name: req.body.name, price: parseFloat(req.body.price), stock: [] }; store.pools.push(pool); res.json(pool); });
app.delete('/api/pools/:id', (req, res) => { store.pools = store.pools.filter(x => x.id !== parseInt(req.params.id)); res.json({ success: true }); });
app.get('/api/settings', (req, res) => res.json(store.settings));
app.post('/api/settings', (req, res) => { Object.assign(store.settings, req.body); res.json(store.settings); });
app.get('/api/logs', (req, res) => res.json(store.logs));
app.delete('/api/logs', (req, res) => { store.logs = []; res.json({ success: true }); });

// ===== DISCORD CLIENT LIFE CYCLE =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on('ready', () => { console.log('Bot logged into Discord as ' + client.user.tag); addLog('INFO', 'Bot connected to Discord channels.'); });

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc || acc.status !== 'available') return interaction.reply({ content: '❌ هذا المنتج لم يعد متوفرًا / Out of stock.', ephemeral: true });

    const pay = store.settings;
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('paymethod_' + accId)
      .setPlaceholder('اختر طريقة الدفع / Choose payment method')
      .addOptions(
        { label: 'STC Pay', value: 'stcpay', description: `STC Pay: ${pay.stcPay.number || 'Not Setup'}`, emoji: '📱' },
        { label: 'AlRajhi Bank', value: 'alrajhi', description: 'التحويل البنكي الراجحي', emoji: '🏦' },
        { label: 'PayPal', value: 'paypal', description: `PayPal: ${pay.paypal.email || 'Not Setup'}`, emoji: '💳' }
      );

    const embed = new EmbedBuilder()
      .setColor(0xf0b232)
      .setTitle('🛒 اختيار طريقة الدفع / Payment Selection')
      .setDescription(`المنتج: **${acc.titleEn}**\nالسعر: **${pay.currency}${acc.price.toFixed(2)}**\n\nالرجاء اختيار طريقة الدفع المناسبة لك من القائمة أدناه:`);

    return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc || acc.status !== 'available') return interaction.reply({ content: '❌ خطأ: لم يعد الحساب متاحًا.', ephemeral: true });

    const method = interaction.values[0];
    const pay = store.settings;
    let textInfo = '';

    if (method === 'stcpay') textInfo = `📱 **STC Pay**\nالرقم: \`${pay.stcPay.number}\`\nالاسم: *${pay.stcPay.name || '-'}*`;
    if (method === 'alrajhi') textInfo = `🏦 **AlRajhi Bank Transfer**\nIBAN: \`${pay.alrajhi.iban}\`\nالاسم: *${pay.alrajhi.name || '-'}*`;
    if (method === 'paypal') textInfo = `💳 **PayPal**\nEmail: \`${pay.paypal.email}\``;

    const payId = 'PAY-' + String(100 + store.paymentRequests.length + 1);
    store.paymentRequests.unshift({
      id: payId, userId: interaction.user.id, userName: interaction.user.username,
      accountId: accId, accountTitle: acc.titleEn, amount: acc.price,
      method: method.toUpperCase(), status: 'Pending', date: new Date().toISOString().slice(0, 16).replace('T', ' ')
    });

    const embed = new EmbedBuilder()
      .setColor(0x23a55a)
      .setTitle('بيانات الدفع / Instructions')
      .setDescription(`إليك تفاصيل الدفع لـ **${acc.titleEn}**:\n\n${textInfo}\n\n⚠️ **المرحلة القادمة:**\nقم بتحويل المبلغ المطلق (**${pay.currency}${acc.price.toFixed(2)}**).\nبعد التحويل، **قم بإرسال صورة الإيصال (اللقطة) هنا في الخاص مباشرة للبوت** ليتم تسليمك التلقائي بعد تأكيد المسؤولين لرقم العملية الخاص بك \`[ ${payId} ]\`.`);

    addLog('INFO', `${interaction.user.username} generated checkout receipt invoice: ${payId}`);
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc) return interaction.reply({ content: '❌ لا توجد معلومات.', ephemeral: true });
    return interaction.reply({ content: `🔍 **التحقق من حالة الحساب:**\n• الحالة: \`${acc.status}\`\n• الرتبة/المستوى: \`${acc.prestige || '-'}\`\n• صور المنتج المتوفرة: \`${acc.images.length}\` فيديو/صورة`, ephemeral: true });
  }
});

// Capture DM payment verification screenshots automatically
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.channel.type !== 1) return; // DMs Only (Type 1 = DM)
  
  const pending = store.paymentRequests.find(p => p.userId === message.author.id && p.status === 'Pending');
  if (pending && message.attachments.size > 0) {
    pending.status = 'Waiting Review';
    addLog('WARN', `User ${message.author.username} uploaded proof of transfer receipt for calculation processing allocation ${pending.id}`);
    message.reply(`✅ **تم استلام صورة الإيصال بنجاح!**\n\nجاري مراجعة طلبك ذو الرقم \`${pending.id}\` للمنتج (**${pending.accountTitle}**) من قبل الإدارة وسيتم إرسال بيانات الحساب هنا فورًا عند الإنتهاء.`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log('Panel Server running smoothly on port ' + PORT); });
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Discord Auth Token Failure:', err.message));
