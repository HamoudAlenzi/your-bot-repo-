// =============================================
// ACC STORE BOT — With Private Ticket System, Payment Flow & Multi-Image Upload
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, Partials, StringSelectMenuBuilder, AttachmentBuilder,
  PermissionFlagsBits, ChannelType, OverwriteType
} = require('discord.js');

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
    try { fs.readdirSync(__dirname).forEach(f => { html += f + ' (' + Math.round(fs.statSync(path.join(__dirname, f)).size / 1024) + 'KB)\n'; }); } catch (e) { html += e.message; }
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
  tickets: [],
  logs: [],
  settings: {
    prefix: '!',
    currency: '$',
    accountsChannelId: '',
    ticketCategoryId: '',    // Category where ticket channels are created
    logChannelId: '',
    ownerId: '',             // Bot owner Discord ID (gets access to all tickets)
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

// Helper: convert base64 data URI to Buffer
function base64ToBuffer(dataUri) {
  const matches = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) return null;
  return { buffer: Buffer.from(matches[2], 'base64'), ext: matches[1] === 'jpeg' ? 'jpg' : matches[1] };
}

// Helper: send log to Discord log channel
function sendLogToDiscord(msg) {
  const chId = store.settings.logChannelId;
  if (chId && client.isReady()) {
    const ch = client.channels.cache.get(chId);
    if (ch) ch.send(msg).catch(() => {});
  }
}

// ===== API ROUTES =====

// --- Stats ---
app.get('/api/stats', (req, res) => {
  try {
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
      openTickets: store.tickets.filter(t => t.status === 'open' || t.status === 'waiting_payment' || t.status === 'waiting_review').length,
      totalCustomers: store.customers.length,
      botOnline: client.isReady()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Accounts ---
app.get('/api/accounts', (req, res) => {
  try {
    let { search, game, status } = req.query;
    let filtered = store.accounts;
    if (search) { const s = search.toLowerCase(); filtered = filtered.filter(a => a.titleEn.toLowerCase().includes(s) || (a.titleAr && a.titleAr.includes(s))); }
    if (game) filtered = filtered.filter(a => a.game === game);
    if (status) filtered = filtered.filter(a => a.status === status);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts', (req, res) => {
  try {
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

    // Post to Discord channel with proper attachment handling
    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) {
        postAccountToDiscord(channel, acc, allImages).catch(err => {
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

// Separate function to handle Discord posting with proper attachments
async function postAccountToDiscord(channel, acc, allImages) {
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

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء المنتج / Buy').setStyle(ButtonStyle.Success).setEmoji('💰'),
    new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('التحقق / Verify').setStyle(ButtonStyle.Secondary).setEmoji('🔍')
  );

  // Build attachments from base64 images
  const files = [];
  let mainAttachmentName = null;

  for (let i = 0; i < allImages.length; i++) {
    const parsed = base64ToBuffer(allImages[i]);
    if (parsed) {
      const fileName = i === 0 ? 'cover.jpg' : `extra_${i}.jpg`;
      files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
      if (i === 0) mainAttachmentName = fileName;
    }
  }

  // Set embed image using attachment URL for the main image
  if (mainAttachmentName) {
    embed.setImage('attachment://' + mainAttachmentName);
  }

  const msg = await channel.send({ embeds: [embed], components: [row], files: files });
  acc.discordMessageIds.push(msg.id);
  addLog('INFO', `Posted ${acc.titleEn} to Discord with ${files.length} attachment(s)`);
}

app.put('/api/accounts/:id', (req, res) => {
  try {
    const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const { images, ...rest } = req.body;
    if (images) rest.images = images;
    Object.assign(acc, rest, { id: acc.id });
    addLog('INFO', 'Account updated: ' + acc.titleEn);
    res.json(acc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Not found' });
    if (acc.discordMessageIds.length && client.isReady()) {
      const channel = client.channels.cache.get(store.settings.accountsChannelId);
      if (channel) acc.discordMessageIds.forEach(mid => channel.messages.delete(mid).catch(() => {}));
    }
    store.accounts = store.accounts.filter(a => a.id !== acc.id);
    addLog('WARN', 'Account deleted: ' + acc.titleEn);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts/:id/sold', (req, res) => {
  try {
    const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
    if (!acc) return res.status(404).json({ error: 'Not found' });
    acc.status = 'sold';
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
        images: [], status: 'available', soldTo: null, discordMessageIds: [], createdAt: new Date().toISOString()
      });
      count++;
    });
    addLog('INFO', `Bulk imported ${count} accounts for ${game}`);
    res.json({ imported: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Orders ---
app.get('/api/orders', (req, res) => {
  try {
    let { search, status } = req.query;
    let filtered = store.orders;
    if (search) { const s = search.toLowerCase(); filtered = filtered.filter(o => o.id.toLowerCase().includes(s) || o.cust.toLowerCase().includes(s)); }
    if (status) filtered = filtered.filter(o => o.status === status);
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

    if (order.custId && client.isReady()) {
      client.users.fetch(order.custId).then(user => {
        user.send(`✅ **تمت عملية الشراء بنجاح / Purchase Successful!**\n\n**${order.item}**\n📧 Email: \`${order.email}\`\n🔑 Password: \`${order.pass}\``).catch(() => {});
      }).catch(() => {});
    }
    addLog('INFO', `Delivered ${order.id} manually via panel.`);
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Payments ---
app.get('/api/payments', (req, res) => {
  try {
    if (req.query.status) return res.json(store.paymentRequests.filter(p => p.status === req.query.status));
    res.json(store.paymentRequests);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Request missing' });
    pr.status = 'Approved';

    const acc = store.accounts.find(a => a.id === pr.accountId);
    if (acc) {
      acc.status = 'sold';
      acc.soldTo = pr.userId;
      const order = {
        id: 'ORD-' + String(1000 + store.orders.length + 1),
        cust: pr.userName, custId: pr.userId,
        item: pr.accountTitle, itemId: String(pr.accountId),
        amount: pr.amount, status: 'Delivered',
        paymentMethod: pr.method, date: new Date().toISOString().slice(0, 16).replace('T', ' '),
        email: acc.email, pass: acc.pass
      };
      store.orders.unshift(order);

      // Sync customer data
      let customer = store.customers.find(c => c.discordId === pr.userId);
      if (!customer) {
        customer = { id: 'u' + genId(), name: pr.userName, discordId: pr.userId, trust: 'Verified', spent: 0, purchases: 0, notes: '', joined: new Date().toISOString().slice(0, 10) };
        store.customers.push(customer);
      }
      customer.purchases += 1;
      customer.spent += pr.amount;

      // Find associated ticket and deliver credentials there, then close it
      const ticket = store.tickets.find(t => t.paymentId === pr.id);
      if (ticket && ticket.channelId && client.isReady()) {
        const ticketChannel = client.channels.cache.get(ticket.channelId);
        if (ticketChannel) {
          // Send credentials in the ticket
          await ticketChannel.send({
            content: `✅ **تم تأكيد الدفع بنجاح! / Payment Confirmed!**\n\n` +
              `**${pr.accountTitle}**\n` +
              `📧 Email: \`${acc.email}\`\n` +
              `🔑 Password: \`${acc.pass}\`\n\n` +
              `شكرًا لشرائك منا! / Thank you for your purchase!\n\n` +
              `⏳ هذا التذكرة سيتم إغلاقها تلقائياً بعد 10 ثوانٍ... / This ticket will auto-close in 10 seconds...`
          });

          ticket.status = 'closed';
          addLog('INFO', `Ticket ${ticket.id} delivered and closing for ${pr.userName}`);

          // Auto-close ticket after 10 seconds
          setTimeout(async () => {
            try {
              await ticketChannel.delete('Purchase completed - ticket auto-closed');
              addLog('INFO', `Ticket channel ${ticket.channelId} deleted after delivery`);
            } catch (err) {
              addLog('WARN', `Failed to delete ticket channel: ${err.message}`);
            }
          }, 10000);
        }
      } else {
        // No ticket — send via DM as fallback
        if (pr.userId && client.isReady()) {
          client.users.fetch(pr.userId).then(user => {
            user.send(`✅ **تم تأكيد الدفع بنجاح! / Payment Confirmed!**\n\n**${pr.accountTitle}**\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\`\n\nشكرًا لشرائك منا!`).catch(() => {});
          }).catch(() => {});
        }
      }
    }

    sendLogToDiscord(`✅ Payment approved: \`${pr.id}\` for **${pr.accountTitle}** ($${pr.amount}) by ${pr.userName}`);
    addLog('INFO', `Payment approved & delivered: ${pr.id}`);
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
    pr.status = 'Rejected';

    // Find associated ticket and send rejection message
    const ticket = store.tickets.find(t => t.paymentId === pr.id);
    if (ticket && ticket.channelId && client.isReady()) {
      const ticketChannel = client.channels.cache.get(ticket.channelId);
      if (ticketChannel) {
        await ticketChannel.send({
          content: `❌ **تم رفض عملية الدفع / Payment Rejected**\n\n` +
            `طلب رقم: \`${pr.id}\` الخاص بـ **${pr.accountTitle}** تم رفضه من قبل الإدارة.\n` +
            `يرجى مراجعة الدعم الفني أو محاولة الدفع مرة أخرى.\n\n` +
            `⚠️ يمكنك رفع إيصال جديد إذا كان هناك خطأ.`
        });
        ticket.status = 'open';
        // Reset payment to allow re-upload
        pr.status = 'Pending';
      }
    } else {
      // Fallback DM
      if (pr.userId && client.isReady()) {
        client.users.fetch(pr.userId).then(user => {
          user.send(`❌ **تم رفض عملية الدفع / Payment Rejected**\n\nطلب رقم: \`${pr.id}\` الخاص بـ **${pr.accountTitle}** تم رفضه من قبل الإدارة. يرجى مراجعة الدعم الفني.`).catch(() => {});
        }).catch(() => {});
      }
    }

    sendLogToDiscord(`❌ Payment rejected: \`${pr.id}\` for **${pr.accountTitle}**`);
    addLog('WARN', `Payment rejected: ${pr.id}`);
    res.json(pr);
  } catch (e) {
    console.error('Reject payment error:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- Tickets API ---
app.get('/api/tickets', (req, res) => {
  try {
    let filtered = store.tickets;
    if (req.query.status) filtered = filtered.filter(t => t.status === req.query.status);
    res.json(filtered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:id/close', async (req, res) => {
  try {
    const ticket = store.tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    ticket.status = 'closed';

    if (ticket.channelId && client.isReady()) {
      const ch = client.channels.cache.get(ticket.channelId);
      if (ch) {
        await ch.send('🔒 **تم إغلاق التذكرة / Ticket Closed**');
        setTimeout(async () => {
          try { await ch.delete('Ticket manually closed by admin'); } catch (e) { }
        }, 5000);
      }
    }

    // Release the account back to available if payment wasn't completed
    const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
    if (pr && (pr.status === 'Pending' || pr.status === 'Rejected')) {
      const acc = store.accounts.find(a => a.id === pr.accountId);
      if (acc && acc.status === 'reserved') {
        acc.status = 'available';
        acc.soldTo = null;
        addLog('INFO', `Account ${acc.id} released back to available (ticket ${ticket.id} closed)`);
      }
    }

    addLog('INFO', `Ticket ${ticket.id} closed manually`);
    res.json(ticket);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Customers, Pools, Settings, Logs ---
app.get('/api/customers', (req, res) => { try { res.json(store.customers); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers', (req, res) => { try { store.customers.push(req.body); res.json(req.body); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/blacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Blacklisted'; res.json(c); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/customers/:id/unblacklist', (req, res) => { try { const c = store.customers.find(x => x.id === req.params.id); if (c) c.trust = 'Verified'; res.json(c); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/pools', (req, res) => { try { res.json(store.pools); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/pools', (req, res) => { try { const pool = { id: genId(), name: req.body.name, price: parseFloat(req.body.price), stock: [] }; store.pools.push(pool); res.json(pool); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/pools/:id', (req, res) => { try { store.pools = store.pools.filter(x => x.id !== parseInt(req.params.id)); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/settings', (req, res) => { try { res.json(store.settings); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/settings', (req, res) => { try { Object.assign(store.settings, req.body); res.json(store.settings); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/logs', (req, res) => { try { res.json(store.logs); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/logs', (req, res) => { try { store.logs = []; res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });


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
  console.log('Bot logged into Discord as ' + client.user.tag);
  addLog('INFO', 'Bot connected to Discord.');
  sendLogToDiscord('🟢 **Bot Online** — Store bot is now running.');
});

// ===== INTERACTION HANDLER =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  try {
    // ---- BUY BUTTON → Create Private Ticket ----
    if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc || acc.status !== 'available') {
        return interaction.reply({ content: '❌ هذا المنتج لم يعد متوفرًا / This product is no longer available.', ephemeral: true });
      }

      // Check if user already has an open ticket for this account
      const existingTicket = store.tickets.find(t =>
        t.userId === interaction.user.id && t.accountId === accId &&
        (t.status === 'open' || t.status === 'waiting_payment' || t.status === 'waiting_review')
      );
      if (existingTicket) {
        const ch = client.channels.cache.get(existingTicket.channelId);
        if (ch) {
          return interaction.reply({ content: `🎫 لديك تذكرة مفتوحة بالفعل لهذا المنتج: <#${existingTicket.channelId}>`, ephemeral: true });
        }
      }

      // Check if ticket category is set
      const categoryId = store.settings.ticketCategoryId;
      if (!categoryId) {
        return interaction.reply({ content: '❌ النظام غير جاهز حالياً. يرجى المحاولة لاحقاً. / System not ready. Please try later.', ephemeral: true });
      }

      const guild = interaction.guild;
      if (!guild) {
        return interaction.reply({ content: '❌ هذا الأمر يعمل فقط داخل السيرفر. / This only works inside the server.', ephemeral: true });
      }

      const category = guild.channels.cache.get(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        return interaction.reply({ content: '❌ خطأ في إعدادات التذاكر. / Ticket system misconfigured.', ephemeral: true });
      }

      // Reserve the account
      acc.status = 'reserved';

      // Create the ticket channel
      const ticketChannel = await guild.channels.create({
        name: `ticket-${interaction.user.username}-${accId}`,
        type: ChannelType.GuildText,
        parent: category,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: interaction.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles]
          }
        ]
      });

      // Also give owner access
      if (store.settings.ownerId) {
        await ticketChannel.permissionOverwrites.create(store.settings.ownerId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, ManageChannels: true
        }).catch(() => {});
      }

      // Create ticket record
      const ticketId = 'TKT-' + String(store.tickets.length + 1).padStart(3, '0');
      const ticket = {
        id: ticketId,
        userId: interaction.user.id,
        userName: interaction.user.username,
        accountId: accId,
        accountTitle: acc.titleEn,
        amount: acc.price,
        channelId: ticketChannel.id,
        paymentId: null,
        paymentMethod: null,
        status: 'open',
        createdAt: new Date().toISOString()
      };
      store.tickets.unshift(ticket);

      // Send welcome message with payment method selection
      const pay = store.settings;
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('paymethod_' + accId + '_' + ticketId)
        .setPlaceholder('اختر طريقة الدفع / Choose payment method')
        .addOptions(
          { label: 'STC Pay', value: 'stcpay', description: 'STC Pay: ' + (pay.stcPay.number || 'Not Setup'), emoji: '📱' },
          { label: 'AlRajhi Bank', value: 'alrajhi', description: 'التحويل البنكي الراجحي', emoji: '🏦' },
          { label: 'PayPal', value: 'paypal', description: 'PayPal: ' + (pay.paypal.email || 'Not Setup'), emoji: '💳' }
        );

      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🛒 طلب شراء جديد / New Purchase Request')
        .setDescription(
          'مرحباً **' + interaction.user.username + '**!\n\n' +
          '**المنتج / Product:** ' + acc.titleEn + '\n' +
          '**السعر / Price:** ' + pay.currency + acc.price.toFixed(2) + '\n' +
          '**رقم التذكرة / Ticket:** `' + ticketId + '`\n\n' +
          'الرجاء اختيار طريقة الدفع من القائمة أدناه:\n' +
          'Please select a payment method below:'
        )
        .setFooter({ text: 'Acc. Store Bot — Ticket System' })
        .setTimestamp();

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket_' + ticketId).setLabel('إغلاق التذكرة / Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
      );

      await ticketChannel.send({
        content: '👤 <@' + interaction.user.id + '> | 🎫 تذكرة شراء خاصة / Private Purchase Ticket',
        embeds: [welcomeEmbed],
        components: [new ActionRowBuilder().addComponents(selectMenu), closeRow]
      });

      await interaction.reply({ content: '🎫 تم إنشاء تذكرة خاصة بك: <#' + ticketChannel.id + '>', ephemeral: true });
      addLog('INFO', `Ticket ${ticketId} created for ${interaction.user.username} -> ${acc.titleEn}`);
      sendLogToDiscord('🎫 New ticket `' + ticketId + '` created by **' + interaction.user.username + '** for **' + acc.titleEn + '** ($' + acc.price + ')');
      return;
    }

    // ---- PAYMENT METHOD SELECT (in ticket channel) ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_')) {
      const parts = interaction.customId.split('_');
      const accId = parseInt(parts[1]);
      const ticketId = parts.slice(2).join('_');
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc) return interaction.reply({ content: '❌ خطأ: المنتج غير موجود.', ephemeral: true });

      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ خطأ: التذكرة غير موجودة.', ephemeral: true });

      const method = interaction.values[0];
      const pay = store.settings;
      let textInfo = '';

      if (method === 'stcpay') textInfo = '📱 **STC Pay**\nالرقم: `' + pay.stcPay.number + '`\nالاسم: *' + (pay.stcPay.name || '-') + '*';
      if (method === 'alrajhi') textInfo = '🏦 **AlRajhi Bank Transfer**\nIBAN: `' + pay.alrajhi.iban + '`\nالاسم: *' + (pay.alrajhi.name || '-') + '*';
      if (method === 'paypal') textInfo = '💳 **PayPal**\nEmail: `' + pay.paypal.email + '`';

      // Create payment request
      const payId = 'PAY-' + String(100 + store.paymentRequests.length + 1);
      store.paymentRequests.unshift({
        id: payId, userId: interaction.user.id, userName: interaction.user.username,
        accountId: accId, accountTitle: acc.titleEn, amount: acc.price,
        method: method.toUpperCase(), status: 'Pending',
        date: new Date().toISOString().slice(0, 16).replace('T', ' ')
      });

      // Update ticket
      ticket.paymentId = payId;
      ticket.paymentMethod = method.toUpperCase();
      ticket.status = 'waiting_payment';

      const payEmbed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('💳 بيانات الدفع / Payment Instructions')
        .setDescription(
          '**المنتج / Product:** ' + acc.titleEn + '\n' +
          '**المبلغ / Amount:** ' + pay.currency + acc.price.toFixed(2) + '\n' +
          '**رقم العملية / Ref:** `' + payId + '`\n\n' +
          textInfo + '\n\n' +
          '⚠️ **الخطوة التالية / Next Step:**\n' +
          'قم بتحويل المبلغ المطلوب، ثم **أرسل صورة الإيصال هنا في التذكرة**.\n' +
          'Transfer the amount, then **upload the receipt screenshot here in this ticket**.'
        )
        .setFooter({ text: 'Awaiting payment proof...' })
        .setTimestamp();

      await interaction.reply({ embeds: [payEmbed] });
      addLog('INFO', interaction.user.username + ' selected ' + method.toUpperCase() + ' payment for ' + payId);
      return;
    }

    // ---- CLOSE TICKET BUTTON ----
    if (interaction.isButton() && interaction.customId.startsWith('close_ticket_')) {
      const ticketId = interaction.customId.replace('close_ticket_', '');
      const ticket = store.tickets.find(t => t.id === ticketId);
      if (!ticket) return interaction.reply({ content: '❌ تذكرة غير موجودة.', ephemeral: true });

      if (interaction.user.id !== ticket.userId && interaction.user.id !== store.settings.ownerId) {
        return interaction.reply({ content: '❌ لا يمكنك إغلاق هذه التذكرة.', ephemeral: true });
      }

      ticket.status = 'closed';

      // Release account if not sold
      const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
      if (pr && (pr.status === 'Pending' || pr.status === 'Rejected')) {
        const acc = store.accounts.find(a => a.id === ticket.accountId);
        if (acc && acc.status === 'reserved') {
          acc.status = 'available';
          acc.soldTo = null;
        }
      }

      await interaction.reply({ content: '🔒 **تم إغلاق التذكرة / Ticket Closed** — سيتم حذفها خلال 5 ثوانٍ.' });
      addLog('INFO', `Ticket ${ticketId} closed by ${interaction.user.username}`);

      setTimeout(async () => {
        try { await interaction.channel.delete('Ticket closed by user'); } catch (e) { }
      }, 5000);
      return;
    }

    // ---- VERIFY BUTTON ----
    if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc) return interaction.reply({ content: '❌ لا توجد معلومات.', ephemeral: true });
      return interaction.reply({
        content: '🔍 **التحقق من حالة الحساب:**\n• الحالة: `' + acc.status + '`\n• الرتبة/المستوى: `' + (acc.prestige || '-') + '`\n• صور المنتج المتوفرة: `' + acc.images.length + '` فيديو/صورة',
        ephemeral: true
      });
    }

  } catch (err) {
    console.error('Interaction error:', err);
    const msg = '❌ حدث خطأ أثناء المعالجة. / An error occurred.';
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
      }
    } catch (e) { }
  }
});

// ===== MESSAGE HANDLER =====
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Handle DM payment proof (legacy fallback)
  if (message.channel.type === 1) {
    const pending = store.paymentRequests.find(p => p.userId === message.author.id && p.status === 'Pending');
    if (pending && message.attachments.size > 0) {
      pending.status = 'Waiting Review';
      addLog('WARN', `User ${message.author.username} uploaded proof for ${pending.id} (DM)`);
      message.reply('✅ **تم استلام صورة الإيصال بنجاح!**\n\nجاري مراجعة طلبك ذو الرقم `' + pending.id + '` للمنتج (**' + pending.accountTitle + '**) من قبل الإدارة.').catch(() => {});
    }
    return;
  }

  // Handle receipt upload in ticket channels
  const ticket = store.tickets.find(t =>
    t.channelId === message.channel.id &&
    (t.status === 'waiting_payment' || t.status === 'waiting_review')
  );

  if (ticket && message.attachments.size > 0) {
    const imgAttachment = message.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
    if (imgAttachment) {
      const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
      if (pr && pr.status === 'Pending') {
        pr.status = 'Waiting Review';
        ticket.status = 'waiting_review';

        await message.reply({
          content: '✅ **تم استلام إيصال الدفع! / Payment Proof Received!**\n\n' +
            'رقم العملية: `' + pr.id + '`\n' +
            'جاري مراجعة الإيصال من قبل الإدارة...\n' +
            'Admin is reviewing your receipt...\n\n' +
            '⏳ يرجى الانتظار. سيتم تسليم الحساب هنا فور التأكيد.'
        });

        addLog('INFO', `Receipt uploaded in ticket ${ticket.id} by ${message.author.username} for ${pr.id}`);
        sendLogToDiscord('📨 Receipt uploaded in ticket `' + ticket.id + '` for `' + pr.id + '` — **' + ticket.accountTitle + '** ($' + ticket.amount + ')');
      }
    }
  }
});

// ===== SERVER START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log('Panel Server running on port ' + PORT); });
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Discord Auth Token Failure:', err.message));
