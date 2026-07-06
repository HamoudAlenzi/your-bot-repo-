// =============================================
// ACC STORE BOT — Ticket System, Advanced Payment & Multi-Image Upload
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, StringSelectMenuBuilder, AttachmentBuilder, ChannelType } = require('discord.js');

// ===== EXPRESS SERVER =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

function findPanelHtml() {
  const paths = [
    path.join(__dirname, 'panel.html'),
    path.join(__dirname, 'public', 'panel.html'),
    path.join('/app', 'panel.html'),
    path.join('/app', 'public', 'panel.html'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) { return p; }
  }
  return null;
}
const panelPath = findPanelHtml();
if (panelPath) {
  app.get('/panel.html', (req, res) => res.sendFile(panelPath));
  app.get('/', (req, res) => res.redirect('/panel.html'));
} else {
  app.get('/', (req, res) => res.send('Panel not found.'));
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
    ticketCategoryId: '',
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

      if (allImages.length > 0) embed.setImage(allImages[0]); 

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء المنتج / Buy').setStyle(ButtonStyle.Success).setEmoji('💰'),
        new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('التحقق / Verify').setStyle(ButtonStyle.Secondary).setEmoji('🔍')
      );

      channel.send({ embeds: [embed], components: [row] }).then(async (msg) => {
        acc.discordMessageIds.push(msg.id);
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

app.get('/api/orders', (req, res) => res.json(store.orders));

app.get('/api/payments', (req, res) => res.json(store.paymentRequests));

app.post('/api/payments/:id/approve', (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Request missing' });
  pr.status = 'Approved';
  
  const acc = store.accounts.find(a => a.id === pr.accountId);
  if (acc) {
    acc.status = 'sold';
    const order = { id: 'ORD-' + String(1000 + store.orders.length + 1), cust: pr.userName, custId: pr.userId, item: pr.accountTitle, itemId: String(pr.accountId), amount: pr.amount, status: 'Delivered', paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' '), email: acc.email, pass: acc.pass };
    store.orders.unshift(order);
    
    let customer = store.customers.find(c => c.discordId === pr.userId);
    if (!customer) {
      customer = { id: 'u' + genId(), name: pr.userName, discordId: pr.userId, trust: 'Verified', spent: 0, purchases: 0, joined: new Date().toISOString().slice(0,10) };
      store.customers.push(customer);
    }
    customer.purchases += 1; customer.spent += pr.amount;

    // Delivery and auto-close ticket logic
    if (pr.ticketChannelId && client.isReady()) {
      const channel = client.channels.cache.get(pr.ticketChannelId);
      if (channel) {
        channel.send(`✅ **تم تأكيد الدفع بنجاح! / Payment Confirmed!**\n\n**${pr.accountTitle}**\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\`\n\nسيتم إغلاق التذكرة تلقائياً بعد 20 ثانية / Ticket closing in 20 seconds...`).catch(() => {});
        setTimeout(() => channel.delete().catch(() => {}), 20000);
      }
    }
  }
  addLog('INFO', `Payment approved & delivered: ${pr.id}`);
  res.json(pr);
});

app.post('/api/payments/:id/reject', (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  pr.status = 'Rejected';
  
  if (pr.ticketChannelId && client.isReady()) {
    const channel = client.channels.cache.get(pr.ticketChannelId);
    if (channel) {
      channel.send(`❌ **تم رفض عملية الدفع / Payment Rejected**\n\nطلب رقم: \`${pr.id}\` تم رفضه. يرجى التواصل مع الإدارة للتوضيح.`).catch(() => {});
    }
  }
  addLog('WARN', `Payment rejected: ${pr.id}`);
  res.json(pr);
});

app.get('/api/customers', (req, res) => res.json(store.customers));
app.get('/api/settings', (req, res) => res.json(store.settings));
app.post('/api/settings', (req, res) => { Object.assign(store.settings, req.body); res.json(store.settings); });
app.get('/api/logs', (req, res) => res.json(store.logs));
app.delete('/api/logs', (req, res) => { store.logs = []; res.json({ success: true }); });

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.on('ready', () => { console.log('Bot logged into Discord as ' + client.user.tag); addLog('INFO', 'Bot connected to Discord.'); });

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc || acc.status !== 'available') return interaction.reply({ content: '❌ هذا المنتج لم يعد متوفرًا / Out of stock.', ephemeral: true });

    const guild = interaction.guild;
    const set = store.settings;

    try {
      // Create Private Ticket Channel
      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.username}-${accId}`,
        type: ChannelType.GuildText,
        parent: set.ticketCategoryId || null,
        permissionOverwrites: [
          { id: guild.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'AttachFiles', 'ReadMessageHistory'] },
          { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'AttachFiles', 'ReadMessageHistory'] }
        ]
      });

      const pay = store.settings;
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('paymethod_' + accId)
        .setPlaceholder('اختر طريقة الدفع / Choose payment method')
        .addOptions(
          { label: 'STC Pay', value: 'stcpay', description: `STC Pay`, emoji: '📱' },
          { label: 'AlRajhi Bank', value: 'alrajhi', description: 'التحويل البنكي الراجحي', emoji: '🏦' },
          { label: 'PayPal', value: 'paypal', description: `PayPal`, emoji: '💳' }
        );

      const embed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('🛒 اختيار طريقة الدفع / Payment Selection')
        .setDescription(`المنتج: **${acc.titleEn}**\nالسعر: **${pay.currency}${acc.price.toFixed(2)}**\n\nمرحباً بك في تذكرتك الخاصة، الرجاء اختيار طريقة الدفع:`);

      await channel.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)] });
      return interaction.reply({ content: `✅ تم فتح تذكرة الشراء الخاصة بك / Ticket created: <#${channel.id}>`, ephemeral: true });

    } catch (err) {
      addLog('ERROR', `Failed to create ticket channel: ${err.message}`);
      return interaction.reply({ content: '❌ خطأ في إنشاء التذكرة. تأكد من صلاحيات البوت. / Could not create ticket.', ephemeral: true });
    }
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
      method: method.toUpperCase(), status: 'Pending', ticketChannelId: interaction.channelId,
      date: new Date().toISOString().slice(0, 16).replace('T', ' ')
    });

    const embed = new EmbedBuilder()
      .setColor(0x23a55a)
      .setTitle('بيانات الدفع / Instructions')
      .setDescription(`إليك تفاصيل الدفع لـ **${acc.titleEn}**:\n\n${textInfo}\n\n⚠️ **المرحلة القادمة:**\nقم بتحويل المبلغ المطلق (**${pay.currency}${acc.price.toFixed(2)}**).\nبعد التحويل، **قم بإرسال صورة الإيصال هنا في هذه التذكرة** ليتم مراجعتها وتسليمك الحساب تلقائياً \`[ ${payId} ]\`.`);

    addLog('INFO', `${interaction.user.username} generated checkout receipt in ticket: ${payId}`);
    return interaction.update({ embeds: [embed], components: [] }); 
  }

  if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc) return interaction.reply({ content: '❌ لا توجد معلومات.', ephemeral: true });
    return interaction.reply({ content: `🔍 **التحقق من حالة الحساب:**\n• الحالة: \`${acc.status}\`\n• الرتبة/المستوى: \`${acc.prestige || '-'}\`\n• صور المنتج المتوفرة: \`${acc.images.length}\` فيديو/صورة`, ephemeral: true });
  }
});

// Capture Receipt Attachments in Tickets
client.on('messageCreate', async (message) => {
  if (message.author.bot) return; 
  
  const pending = store.paymentRequests.find(p => p.ticketChannelId === message.channel.id && p.userId === message.author.id && p.status === 'Pending');
  if (pending && message.attachments.size > 0) {
    pending.status = 'Waiting Review';
    addLog('WARN', `Proof of transfer uploaded in ticket by ${message.author.username} for ${pending.id}`);
    message.reply(`✅ **تم استلام صورة الإيصال بنجاح!**\n\nجاري مراجعة طلبك ذو الرقم \`${pending.id}\` من قبل الإدارة. سيتم إرسال بيانات الحساب وإغلاق التذكرة فور التأكيد.`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log('Panel Server running smoothly on port ' + PORT); });
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Discord Auth Token Failure:', err.message));
