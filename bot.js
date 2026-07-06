// =============================================================================
//  ACC STORE BOT  —  Premium Edition
//  Features:
//   • Multi-image product posts (all images embedded in ONE message)
//   • Buy button → Payment method picker → PRIVATE TICKET channel
//   • Admin Approve / Reject buttons INSIDE the ticket
//   • On Approve: auto-deliver credentials + auto-close ticket (configurable delay)
//   • Full HTTP control panel API (panel.html drives everything)
//   • Persistent JSON storage (auto-saves to store.json)
//   • Bulk import, customers, pools, orders, payment requests, logs
// =============================================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, Partials, StringSelectMenuBuilder, AttachmentBuilder,
  ChannelType, PermissionFlagsBuilder, TextInputBuilder, TextInputStyle,
  ModalBuilder
} = require('discord.js');

// =============================================================================
//  PERSISTENT STORAGE
// =============================================================================
const STORE_FILE = path.join(__dirname, 'store.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function defaultStore() {
  return {
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
      storeName: 'Acc Store',
      adminIds: [],            // array of Discord user IDs who can approve payments
      adminRoleId: '',         // Discord role ID granted ticket access
      ticketCategoryId: '',    // category where tickets are created
      accountsChannelId: '',   // channel where products are posted
      logChannelId: '',        // bot log channel
      closeDelaySeconds: 10,   // auto-close delay after delivery
      termsAr: 'الشروط العامة\n━━━━━━━━━━━━━━━\n▪️ يتم تسليم الحساب فور تأكيد الدفع\n▪️ الضمان يبدأ من تاريخ الشراء\n▪️ لا يوجد استرداد بعد تسليم الحساب',
      termsEn: 'General Terms\n━━━━━━━━━━━━━━━\n▪️ Account delivered immediately after payment\n▪️ Warranty starts from purchase date\n▪️ No refunds after delivery',
      stcPay:  { number: '05XXXXXXXX', name: '' },
      alrajhi: { iban: 'SA0000000000000000000000', name: '' },
      paypal:  { email: 'pay@example.com', name: '' },
      crypto:  { address: '', network: 'TRC20' }
    },
    nextId: 1
  };
}

let store;
try {
  if (fs.existsSync(STORE_FILE)) {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    // make sure all keys exist after upgrades
    store = Object.assign(defaultStore(), store);
    store.settings = Object.assign(defaultStore().settings, store.settings);
    if (!store.tickets) store.tickets = [];
  } else {
    store = defaultStore();
  }
} catch (e) {
  console.error('store.json parse error, starting fresh:', e.message);
  store = defaultStore();
}

let saveTimer = null;
function saveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2)); }
    catch (e) { console.error('save failed:', e.message); }
  }, 600);
}

function genId() { const id = store.nextId++; saveStore(); return id; }
function addLog(level, msg) {
  store.logs.unshift({ time: new Date().toISOString().slice(0,19).replace('T',' '), level, msg });
  if (store.logs.length > 500) store.logs.length = 500;
  saveStore();
}
function isAdmin(userId) {
  if (store.settings.adminIds.includes(userId)) return true;
  return false;
}

// =============================================================================
//  EXPRESS SERVER
// =============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

// ---- serve panel ----
function findPanel() {
  const candidates = [
    path.join(__dirname, 'panel.html'),
    path.join(__dirname, 'public', 'panel.html'),
    path.join('/app', 'panel.html'),
    path.join('/app', 'public', 'panel.html'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}
const panelPath = findPanel();
if (panelPath) {
  app.get('/panel.html', (req, res) => res.sendFile(panelPath));
  app.get('/', (req, res) => res.redirect('/panel.html'));
} else {
  app.get('/', (req, res) => {
    let html = '<h1>panel.html not found</h1><pre>';
    try { fs.readdirSync(__dirname).forEach(f => html += f + '\n'); } catch(e){ html += e.message; }
    html += '</pre>'; res.send(html);
  });
}

// =============================================================================
//  STATS
// =============================================================================
app.get('/api/stats', (req, res) => {
  res.json({
    totalAccounts: store.accounts.length,
    available: store.accounts.filter(a => a.status === 'available').length,
    reserved:   store.accounts.filter(a => a.status === 'reserved').length,
    sold:       store.accounts.filter(a => a.status === 'sold').length,
    dead:       store.accounts.filter(a => a.status === 'dead').length,
    totalRevenue: store.orders.filter(o => o.status === 'Delivered').reduce((s,o)=>s+o.amount,0),
    totalOrders: store.orders.length,
    pendingOrders: store.orders.filter(o => o.status === 'Pending').length,
    pendingPayments: store.paymentRequests.filter(p => p.status === 'Pending' || p.status === 'Waiting Review').length,
    totalCustomers: store.customers.length,
    openTickets: store.tickets.filter(t => t.status === 'open').length,
    botOnline: client.isReady(),
    botTag: client.user ? client.user.tag : 'offline',
    uptime: client.uptime || 0
  });
});

// =============================================================================
//  ACCOUNTS (PRODUCTS) — with proper multi-image upload
// =============================================================================
app.get('/api/accounts', (req, res) => {
  let { search, game, status } = req.query;
  let list = store.accounts;
  if (search) { const s = String(search).toLowerCase(); list = list.filter(a => a.titleEn.toLowerCase().includes(s) || (a.titleAr||'').toLowerCase().includes(s)); }
  if (game)   list = list.filter(a => a.game === game);
  if (status) list = list.filter(a => a.status === status);
  // strip credentials for public listing? Keep them — panel is admin-only.
  res.json(list);
});

// Save base64 image to disk and return URL path
function saveImageFromBase64(b64, name) {
  try {
    const m = b64.match(/^data:image\/(\w+);base64,/);
    if (!m) return null;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const data = b64.replace(/^data:image\/\w+;base64,/, '');
    const filename = `${name}_${Date.now()}_${Math.floor(Math.random()*10000)}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(data, 'base64'));
    return `/uploads/${filename}`;
  } catch (e) { console.error('img save err', e.message); return null; }
}

app.post('/api/accounts', async (req, res) => {
  const { titleEn, titleAr, game, price, prestige, stats, warranty, detailsEn, detailsAr, email, pass, extra, images } = req.body;
  if (!titleEn || price === undefined) return res.status(400).json({ error: 'Title and price required' });

  const rawImages = Array.isArray(images) ? images : [];
  // Persist base64 images to disk so we can attach them as files to Discord
  const savedPaths = [];
  for (let i = 0; i < rawImages.length; i++) {
    const img = rawImages[i];
    if (img.startsWith('data:image')) {
      const p = saveImageFromBase64(img, `acc_${Date.now()}_${i}`);
      if (p) savedPaths.push(p);
    } else if (img.startsWith('/uploads/') || img.startsWith('http')) {
      savedPaths.push(img);
    }
  }

  const acc = {
    id: genId(),
    titleEn, titleAr: titleAr || '',
    game: game || 'Other',
    price: parseFloat(price),
    prestige: prestige || '',
    stats: stats || '',
    warranty: parseInt(warranty) || 0,
    detailsEn: detailsEn || '',
    detailsAr: detailsAr || '',
    email: email || '',
    pass: pass || '',
    extra: extra || '',
    images: savedPaths,
    status: 'available',
    soldTo: null,
    discordMessageIds: [],
    createdAt: new Date().toISOString()
  };
  store.accounts.unshift(acc);
  saveStore();

  // Post to Discord
  const channelId = store.settings.accountsChannelId;
  if (channelId && client.isReady()) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) {
        const files = [];
        const embedImageRef = savedPaths.length > 0 ? `attachment://img_0.jpg` : null;

        // Read each image file into a buffer attachment
        for (let i = 0; i < savedPaths.length; i++) {
          const filePath = path.join(__dirname, savedPaths[i].replace(/^\//,''));
          if (fs.existsSync(filePath)) {
            files.push(new AttachmentBuilder(fs.readFileSync(filePath), { name: `img_${i}.jpg` }));
          }
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🛒 ${acc.titleEn}`)
          .setDescription(acc.titleAr ? `**${acc.titleAr}**` : '')
          .addFields(
            { name: '🎮 Game', value: acc.game, inline: true },
            { name: '⭐ Rank / Level', value: acc.prestige || '-', inline: true },
            { name: '📊 Stats', value: acc.stats || '-', inline: true },
            { name: '🛡️ Warranty', value: acc.warranty > 0 ? `${acc.warranty} Days` : 'None', inline: true },
            { name: '💵 Price', value: `${store.settings.currency}${acc.price.toFixed(2)}`, inline: true },
            { name: '🆔 Product ID', value: `#${acc.id}`, inline: true },
            { name: '📝 Details (EN)', value: acc.detailsEn || '-', inline: false },
            { name: '📝 التفاصيل (AR)', value: acc.detailsAr || '-', inline: false }
          )
          .setFooter({ text: `${store.settings.storeName} • Click Buy to purchase` })
          .setTimestamp();

        if (embedImageRef) embed.setImage(embedImageRef);

        // For additional images, add thumbnail if only 1 image, else attach more embeds
        const embeds = [embed];
        if (savedPaths.length > 1) {
          for (let i = 1; i < savedPaths.length && i < 4; i++) {
            embeds.push(new EmbedBuilder().setImage(`attachment://img_${i}.jpg`).setColor(0x5865f2));
          }
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`buy_${acc.id}`).setLabel('شراء / Buy').setStyle(ButtonStyle.Success).setEmoji('💰'),
          new ButtonBuilder().setCustomId(`verify_${acc.id}`).setLabel('تفاصيل / Details').setStyle(ButtonStyle.Secondary).setEmoji('🔍')
        );

        const msg = await channel.send({ embeds, components: [row], files });
        acc.discordMessageIds.push(msg.id);
        saveStore();
      }
    } catch (err) { console.error('post error', err.message); }
  }

  addLog('INFO', `Product created: ${titleEn} with ${savedPaths.length} image(s)`);
  res.json(acc);
});

app.put('/api/accounts/:id', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  const { images, ...rest } = req.body;
  if (Array.isArray(images)) {
    const savedPaths = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (img.startsWith('data:image')) {
        const p = saveImageFromBase64(img, `acc_${acc.id}_${i}`);
        if (p) savedPaths.push(p);
      } else { savedPaths.push(img); }
    }
    rest.images = savedPaths;
  }
  Object.assign(acc, rest, { id: acc.id });
  saveStore();
  addLog('INFO', `Account updated: ${acc.titleEn}`);
  res.json(acc);
});

app.delete('/api/accounts/:id', async (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  if (acc.discordMessageIds.length && client.isReady()) {
    try {
      const channel = await client.channels.fetch(store.settings.accountsChannelId);
      if (channel) for (const mid of acc.discordMessageIds) await channel.messages.delete(mid).catch(()=>{});
    } catch(e){}
  }
  store.accounts = store.accounts.filter(a => a.id !== acc.id);
  saveStore();
  addLog('WARN', `Account deleted: ${acc.titleEn}`);
  res.json({ success: true });
});

app.post('/api/accounts/:id/sold', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  acc.status = 'sold';
  saveStore();
  addLog('INFO', `Marked sold: ${acc.titleEn}`);
  res.json(acc);
});

app.post('/api/accounts/:id/dead', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  acc.status = 'dead';
  saveStore();
  addLog('WARN', `Marked dead: ${acc.titleEn}`);
  res.json(acc);
});

app.post('/api/accounts/bulk', (req, res) => {
  const { game, price, warranty, credentials } = req.body;
  if (!credentials || !credentials.length) return res.status(400).json({ error: 'No credentials provided' });
  const lines = Array.isArray(credentials) ? credentials : String(credentials).split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let email = '', pass = line.trim();
    const m = line.match(/[:|]/);
    if (m) { const idx = line.indexOf(m[0]); email = line.slice(0, idx).trim(); pass = line.slice(idx+1).trim(); }
    store.accounts.unshift({
      id: genId(), titleEn: `${game} Account`, titleAr: `حساب ${game}`, game,
      price: parseFloat(price) || 0, prestige: '-', stats: '-',
      warranty: parseInt(warranty) || 0, detailsEn: 'Bulk import', detailsAr: 'استيراد جماعي',
      email, pass, extra: 'Bulk', images: [], status: 'available', soldTo: null,
      discordMessageIds: [], createdAt: new Date().toISOString()
    });
    count++;
  }
  saveStore();
  addLog('INFO', `Bulk imported ${count} accounts for ${game}`);
  res.json({ imported: count });
});

// =============================================================================
//  TICKETS — admin management via panel
// =============================================================================
app.get('/api/tickets', (req, res) => {
  let list = store.tickets;
  if (req.query.status === 'open') list = list.filter(t => t.status === 'open');
  if (req.query.status === 'closed') list = list.filter(t => t.status === 'closed');
  res.json(list);
});

app.post('/api/tickets/:id/close', async (req, res) => {
  const t = store.tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  try {
    if (client.isReady() && t.channelId) {
      const ch = await client.channels.fetch(t.channelId).catch(()=>null);
      if (ch) {
        await ch.send({ embeds: [new EmbedBuilder().setColor(0xf0b232).setDescription(`🔒 **Ticket closed by admin via panel.**`)] }).catch(()=>{});
        await ch.delete().catch(()=>{});
      }
    }
  } catch(e){}
  t.status = 'closed';
  t.closedAt = new Date().toISOString();
  saveStore();
  addLog('INFO', `Ticket ${t.id} closed from panel`);
  res.json(t);
});

app.post('/api/tickets/:id/message', async (req, res) => {
  const t = store.tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  try {
    if (client.isReady() && t.channelId) {
      const ch = await client.channels.fetch(t.channelId).catch(()=>null);
      if (ch) {
        await ch.send({ embeds: [new EmbedBuilder().setColor(0x5865f2)
          .setAuthor({ name: 'Admin (Panel)', iconURL: client.user.displayAvatarURL() })
          .setDescription(message)
          .setTimestamp()] });
      }
    }
  } catch(e){}
  res.json({ success: true });
});

// =============================================================================
//  ORDERS & PAYMENTS
// =============================================================================
app.get('/api/orders', (req, res) => {
  let list = store.orders;
  if (req.query.search) { const s = String(req.query.search).toLowerCase(); list = list.filter(o => o.id.toLowerCase().includes(s) || (o.cust||'').toLowerCase().includes(s)); }
  if (req.query.status) list = list.filter(o => o.status === req.query.status);
  res.json(list);
});

app.post('/api/orders/:id/deliver', (req, res) => {
  const order = store.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const acc = store.accounts.find(a => a.id === parseInt(order.itemId));
  if (acc) { order.email = acc.email; order.pass = acc.pass; acc.status = 'sold'; acc.soldTo = order.custId; }
  order.status = 'Delivered';
  saveStore();
  addLog('INFO', `Manual delivery: ${order.id}`);
  res.json(order);
});

app.get('/api/payments', (req, res) => {
  let list = store.paymentRequests;
  if (req.query.status) list = list.filter(p => p.status === req.query.status);
  res.json(list);
});

app.post('/api/payments/:id/approve', async (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Request missing' });
  pr.status = 'Approved';

  const acc = store.accounts.find(a => a.id === pr.accountId);
  if (acc) {
    acc.status = 'sold';
    acc.soldTo = pr.userId;
    const order = {
      id: 'ORD-' + String(2000 + store.orders.length + 1),
      cust: pr.userName, custId: pr.userId,
      item: pr.accountTitle, itemId: String(pr.accountId),
      amount: pr.amount, status: 'Delivered',
      paymentMethod: pr.method,
      date: new Date().toISOString().slice(0,16).replace('T',' '),
      email: acc.email, pass: acc.pass,
      ticketId: pr.ticketId || null
    };
    store.orders.unshift(order);

    let customer = store.customers.find(c => c.discordId === pr.userId);
    if (!customer) {
      customer = {
        id: 'u' + genId(), name: pr.userName, discordId: pr.userId,
        trust: 'Verified', spent: 0, purchases: 0, notes: '',
        joined: new Date().toISOString().slice(0,10)
      };
      store.customers.push(customer);
    }
    customer.purchases += 1;
    customer.spent += pr.amount;

    // Deliver in DM AND in ticket
    if (pr.userId && client.isReady()) {
      client.users.fetch(pr.userId).then(u => {
        u.send({ embeds: [new EmbedBuilder().setColor(0x23a55a)
          .setTitle('✅ Payment Confirmed — Account Delivered')
          .setDescription(`**${pr.accountTitle}**\n\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\`\n\nThank you for your purchase!`)
          .setTimestamp()] }).catch(()=>{});
      }).catch(()=>{});
    }

    if (pr.ticketId && client.isReady()) {
      const t = store.tickets.find(x => x.id === pr.ticketId);
      if (t) {
        try {
          const ch = await client.channels.fetch(t.channelId).catch(()=>null);
          if (ch) {
            await ch.send({ embeds: [new EmbedBuilder().setColor(0x23a55a)
              .setTitle('✅ Payment Approved — Account Delivered')
              .setDescription(`**${pr.accountTitle}**\n\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\`\n\n🔒 This ticket will auto-close in **${store.settings.closeDelaySeconds}s**.`)
              .setTimestamp()] });

            // Update ticket
            t.status = 'closing';
            t.paymentApproved = true;
            saveStore();

            // Auto close after delay
            const delay = (store.settings.closeDelaySeconds || 10) * 1000;
            setTimeout(async () => {
              try {
                const ch2 = await client.channels.fetch(t.channelId).catch(()=>null);
                if (ch2) {
                  await ch2.send({ content: `🔒 Ticket closed automatically. Thank you <@${t.userId}>!` }).catch(()=>{});
                  await ch2.delete().catch(()=>{});
                }
                t.status = 'closed';
                t.closedAt = new Date().toISOString();
                saveStore();
                addLog('INFO', `Ticket ${t.id} auto-closed after delivery`);
              } catch(e){ console.error('auto close', e.message); }
            }, delay);
          }
        } catch(e) { console.error('ticket delivery', e.message); }
      }
    }
  }
  saveStore();
  addLog('INFO', `Payment approved & delivered: ${pr.id}`);
  res.json(pr);
});

app.post('/api/payments/:id/reject', async (req, res) => {
  const pr = store.paymentRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Not found' });
  pr.status = 'Rejected';
  const { reason } = req.body || {};
  if (pr.userId && client.isReady()) {
    client.users.fetch(pr.userId).then(u => {
      u.send({ embeds: [new EmbedBuilder().setColor(0xda373c)
        .setTitle('❌ Payment Rejected')
        .setDescription(`Request \`${pr.id}\` for **${pr.accountTitle}** was rejected.\n${reason ? `Reason: ${reason}` : 'Please contact support.'}`)
        .setTimestamp()] }).catch(()=>{});
    }).catch(()=>{});
  }
  if (pr.ticketId && client.isReady()) {
    const t = store.tickets.find(x => x.id === pr.ticketId);
    if (t) {
      try {
        const ch = await client.channels.fetch(t.channelId).catch(()=>null);
        if (ch) await ch.send({ embeds: [new EmbedBuilder().setColor(0xda373c)
          .setTitle('❌ Payment Rejected by Admin')
          .setDescription(`Request \`${pr.id}\` was rejected. ${reason ? `Reason: ${reason}` : ''}\n\nPlease send a new receipt or contact admin.`)] });
      } catch(e){}
    }
  }
  saveStore();
  addLog('WARN', `Payment rejected: ${pr.id}`);
  res.json(pr);
});

// =============================================================================
//  CUSTOMERS / POOLS / SETTINGS / LOGS
// =============================================================================
app.get('/api/customers', (req, res) => res.json(store.customers));
app.post('/api/customers', (req, res) => { store.customers.push(req.body); saveStore(); res.json(req.body); });
app.post('/api/customers/:id/blacklist', (req, res) => { const c = store.customers.find(x=>x.id===req.params.id); if(c) c.trust='Blacklisted'; saveStore(); res.json(c); });
app.post('/api/customers/:id/unblacklist', (req, res) => { const c = store.customers.find(x=>x.id===req.params.id); if(c) c.trust='Verified'; saveStore(); res.json(c); });
app.delete('/api/customers/:id', (req, res) => { store.customers = store.customers.filter(x=>x.id!==req.params.id); saveStore(); res.json({success:true}); });

app.get('/api/pools', (req, res) => res.json(store.pools));
app.post('/api/pools', (req, res) => { const pool = { id: genId(), name: req.body.name, price: parseFloat(req.body.price), stock: [] }; store.pools.push(pool); saveStore(); res.json(pool); });
app.delete('/api/pools/:id', (req, res) => { store.pools = store.pools.filter(x=>x.id!==parseInt(req.params.id)); saveStore(); res.json({ success: true }); });

app.get('/api/settings', (req, res) => res.json(store.settings));
app.post('/api/settings', (req, res) => {
  Object.assign(store.settings, req.body);
  saveStore();
  addLog('INFO', 'Settings updated');
  res.json(store.settings);
});

app.get('/api/logs', (req, res) => res.json(store.logs));
app.delete('/api/logs', (req, res) => { store.logs = []; saveStore(); res.json({ success: true }); });

// Diagnostic — list guilds/channels/roles the bot can see (helps panel config)
app.get('/api/guilds', async (req, res) => {
  if (!client.isReady()) return res.json({ guilds: [], channels: [], roles: [] });
  const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  const firstGuild = client.guilds.cache.first();
  let channels = [], roles = [], categories = [];
  if (firstGuild) {
    channels = firstGuild.channels.cache.filter(c => c.type === ChannelType.GuildText).map(c => ({ id: c.id, name: c.name }));
    categories = firstGuild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).map(c => ({ id: c.id, name: c.name }));
    roles = firstGuild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
  }
  res.json({ guilds, channels, categories, roles });
});

// =============================================================================
//  DISCORD CLIENT
// =============================================================================
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

client.once('ready', () => {
  console.log('✅ Bot online as ' + client.user.tag);
  addLog('INFO', `Bot connected as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: `${store.settings.storeName} • /panel`, type: 3 }], status: 'online' });
});

// =============================================================================
//  INTERACTIONS — Buy flow, Payment picker, Ticket approve/reject
// =============================================================================
client.on('interactionCreate', async (interaction) => {
  try {
    // ---- BUY BUTTON ----
    if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc || acc.status !== 'available') {
        return interaction.reply({ content: '❌ هذا المنتج لم يعد متوفرًا / Out of stock.', ephemeral: true });
      }

      const pay = store.settings;
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('paymethod_' + accId)
        .setPlaceholder('اختر طريقة الدفع / Choose payment method')
        .addOptions(
          { label: 'STC Pay', value: 'stcpay', description: `STC Pay: ${pay.stcPay.number || 'Not setup'}`, emoji: '📱' },
          { label: 'Al Rajhi Bank', value: 'alrajhi', description: 'Bank transfer', emoji: '🏦' },
          { label: 'PayPal', value: 'paypal', description: `PayPal: ${pay.paypal.email || 'Not setup'}`, emoji: '💳' },
          { label: 'Crypto', value: 'crypto', description: `USDT ${pay.crypto.network || ''}`, emoji: '₿' }
        );

      const embed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('🛒 Payment Method Selection')
        .setDescription(`**Product:** ${acc.titleEn}\n**Price:** ${pay.currency}${acc.price.toFixed(2)}\n\nSelect your preferred payment method below. A private ticket will be created between you and the admin.`);

      return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
    }

    // ---- PAYMENT METHOD SELECTED → CREATE TICKET ----
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc || acc.status !== 'available') {
        return interaction.reply({ content: '❌ Account no longer available.', ephemeral: true });
      }

      const method = interaction.values[0];
      const pay = store.settings;
      let textInfo = '';
      if (method === 'stcpay')  textInfo = `📱 **STC Pay**\nNumber: \`${pay.stcPay.number}\`\nName: *${pay.stcPay.name || '-'}*`;
      if (method === 'alrajhi') textInfo = `🏦 **Al Rajhi Bank Transfer**\nIBAN: \`${pay.alrajhi.iban}\`\nName: *${pay.alrajhi.name || '-'}*`;
      if (method === 'paypal')  textInfo = `💳 **PayPal**\nEmail: \`${pay.paypal.email}\`\nName: *${pay.paypal.name || '-'}*`;
      if (method === 'crypto')  textInfo = `₿ **Crypto (USDT)**\nNetwork: \`${pay.crypto.network}\`\nAddress: \`${pay.crypto.address || 'Not set'}\``;

      // Check that admin role / category is set
      const guild = interaction.guild;
      if (!guild) return interaction.reply({ content: '❌ Tickets can only be created in a server.', ephemeral: true });

      const categoryId = store.settings.ticketCategoryId;
      const adminRoleId = store.settings.adminRoleId;
      const adminIds = store.settings.adminIds || [];

      if (!categoryId) {
        return interaction.reply({ content: '❌ Ticket category not configured. Ask admin to set `ticketCategoryId` in panel settings.', ephemeral: true });
      }

      // Build permission overwrites — only customer + admins can see
      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
      ];
      if (adminRoleId) {
        overwrites.push({ id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] });
      }
      for (const aid of adminIds) {
        try { overwrites.push({ id: aid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] }); } catch(e){}
      }
      // Make sure the bot itself can manage the channel
      overwrites.push({ id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] });

      const ticketId = 'TK-' + String(3000 + store.tickets.length + 1);
      const channelName = `ticket-${interaction.user.username}-${accId}`.toLowerCase().slice(0, 50);

      let ticketChannel;
      try {
        ticketChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: categoryId,
          permissionOverwrites: overwrites,
          topic: `Ticket ${ticketId} • ${acc.titleEn} • ${interaction.user.tag}`
        });
      } catch (e) {
        return interaction.reply({ content: `❌ Failed to create ticket: ${e.message}`, ephemeral: true });
      }

      // Record ticket
      const ticket = {
        id: ticketId,
        channelId: ticketChannel.id,
        userId: interaction.user.id,
        userName: interaction.user.username,
        accountId: accId,
        accountTitle: acc.titleEn,
        amount: acc.price,
        method: method.toUpperCase(),
        status: 'open',
        createdAt: new Date().toISOString()
      };
      store.tickets.unshift(ticket);
      saveStore();

      // Payment request record (waiting for receipt)
      const payId = 'PAY-' + String(100 + store.paymentRequests.length + 1);
      store.paymentRequests.unshift({
        id: payId, userId: interaction.user.id, userName: interaction.user.username,
        accountId: accId, accountTitle: acc.titleEn, amount: acc.price,
        method: method.toUpperCase(), status: 'Pending',
        ticketId: ticketId, channelId: ticketChannel.id,
        date: new Date().toISOString().slice(0,16).replace('T',' ')
      });
      saveStore();

      // Send greeting in the ticket channel
      const greetEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🎫 Ticket ${ticketId}`)
        .setDescription(`Welcome <@${interaction.user.id}>!\n\n**Product:** ${acc.titleEn}\n**Price:** ${pay.currency}${acc.price.toFixed(2)}\n**Payment Method:** ${method.toUpperCase()}\n\n${textInfo}\n\n📦 **Next step:**\nTransfer the amount, then **upload your receipt screenshot here**. An admin will review and deliver your account.`)
        .setFooter({ text: `Ticket ID: ${ticketId}` })
        .setTimestamp();
      await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [greetEmbed] });

      addLog('INFO', `Ticket ${ticketId} created by ${interaction.user.username} for ${acc.titleEn}`);
      return interaction.reply({ content: `✅ Private ticket created! Check <#${ticketChannel.id}> to upload your receipt.`, ephemeral: true });
    }

    // ---- VERIFY BUTTON ----
    if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
      const accId = parseInt(interaction.customId.split('_')[1]);
      const acc = store.accounts.find(a => a.id === accId);
      if (!acc) return interaction.reply({ content: '❌ No info.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🔍 Product Details — ${acc.titleEn}`)
        .addFields(
          { name: 'Status', value: acc.status, inline: true },
          { name: 'Rank/Level', value: acc.prestige || '-', inline: true },
          { name: 'Stats', value: acc.stats || '-', inline: true },
          { name: 'Warranty', value: acc.warranty > 0 ? `${acc.warranty} days` : 'None', inline: true },
          { name: 'Images', value: `${acc.images.length}`, inline: true },
          { name: 'Posted', value: new Date(acc.createdAt).toLocaleDateString(), inline: true }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ---- ADMIN APPROVE / REJECT BUTTONS INSIDE TICKET ----
    if (interaction.isButton() && (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('reject_'))) {
      const action = interaction.customId.split('_')[0];
      const payId = interaction.customId.split('_').slice(1).join('_');
      const pr = store.paymentRequests.find(p => p.id === payId);

      if (!pr) return interaction.reply({ content: '❌ Payment request not found.', ephemeral: true });
      if (!isAdmin(interaction.user.id) && store.settings.adminRoleId && !interaction.member.roles.cache.has(store.settings.adminRoleId)) {
        return interaction.reply({ content: '❌ You are not authorized.', ephemeral: true });
      }

      if (action === 'approve') {
        pr.status = 'Approved';
        const acc = store.accounts.find(a => a.id === pr.accountId);
        if (acc) {
          acc.status = 'sold';
          acc.soldTo = pr.userId;
          const order = {
            id: 'ORD-' + String(2000 + store.orders.length + 1),
            cust: pr.userName, custId: pr.userId,
            item: pr.accountTitle, itemId: String(pr.accountId),
            amount: pr.amount, status: 'Delivered',
            paymentMethod: pr.method,
            date: new Date().toISOString().slice(0,16).replace('T',' '),
            email: acc.email, pass: acc.pass, ticketId: pr.ticketId
          };
          store.orders.unshift(order);

          let customer = store.customers.find(c => c.discordId === pr.userId);
          if (!customer) {
            customer = { id: 'u' + genId(), name: pr.userName, discordId: pr.userId, trust: 'Verified', spent: 0, purchases: 0, notes: '', joined: new Date().toISOString().slice(0,10) };
            store.customers.push(customer);
          }
          customer.purchases += 1;
          customer.spent += pr.amount;

          // Deliver credentials
          await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x23a55a)
            .setTitle('✅ Payment Approved')
            .setDescription(`Admin <@${interaction.user.id}> approved payment \`${pr.id}\`.`)
            .setTimestamp()] });

          await interaction.channel.send({ embeds: [new EmbedBuilder().setColor(0x23a55a)
            .setTitle('📦 Account Delivered')
            .setDescription(`**${pr.accountTitle}**\n\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\``)
            .setFooter({ text: 'Ticket will auto-close shortly' })
            .setTimestamp()] });

          // DM too
          if (client.isReady()) {
            client.users.fetch(pr.userId).then(u => u.send({ embeds: [new EmbedBuilder().setColor(0x23a55a)
              .setTitle('✅ Payment Confirmed — Account Delivered')
              .setDescription(`**${pr.accountTitle}**\n\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\`\n\nThank you for your purchase!`)] }).catch(()=>{}));
          }

          // Update ticket
          const t = store.tickets.find(x => x.id === pr.ticketId);
          if (t) { t.status = 'closing'; t.paymentApproved = true; }

          // Auto-close
          const delay = (store.settings.closeDelaySeconds || 10) * 1000;
          setTimeout(async () => {
            try {
              await interaction.channel.send({ content: `🔒 Ticket closed automatically. Thank you <@${pr.userId}>!` }).catch(()=>{});
              await interaction.channel.delete().catch(()=>{});
              if (t) { t.status = 'closed'; t.closedAt = new Date().toISOString(); saveStore(); }
              addLog('INFO', `Ticket ${t ? t.id : '?'} auto-closed after delivery`);
            } catch(e){}
          }, delay);

          saveStore();
          addLog('INFO', `Payment ${pr.id} approved by ${interaction.user.username} — delivered`);
        }
      } else if (action === 'reject') {
        pr.status = 'Rejected';
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xda373c)
          .setTitle('❌ Payment Rejected')
          .setDescription(`Admin <@${interaction.user.id}> rejected payment \`${pr.id}\`. Customer may upload a new receipt.`)
          .setTimestamp()] });
        // DM customer
        if (client.isReady()) {
          client.users.fetch(pr.userId).then(u => u.send({ embeds: [new EmbedBuilder().setColor(0xda373c)
            .setTitle('❌ Payment Rejected')
            .setDescription(`Your payment \`${pr.id}\` for **${pr.accountTitle}** was rejected. Please check the ticket and try again.`)] }).catch(()=>{}));
        }
        saveStore();
        addLog('WARN', `Payment ${pr.id} rejected by ${interaction.user.username}`);
      }
    }

    // ---- CLOSE TICKET BUTTON ----
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
      if (!isAdmin(interaction.user.id) && store.settings.adminRoleId && !interaction.member.roles.cache.has(store.settings.adminRoleId)) {
        return interaction.reply({ content: '❌ Not authorized.', ephemeral: true });
      }
      const t = store.tickets.find(x => x.channelId === interaction.channelId);
      await interaction.reply({ content: '🔒 Closing ticket...' });
      await interaction.channel.delete().catch(()=>{});
      if (t) { t.status = 'closed'; t.closedAt = new Date().toISOString(); saveStore(); }
      addLog('INFO', `Ticket closed by ${interaction.user.username}`);
    }
  } catch (err) {
    console.error('interaction error', err);
    try { if (interaction.deferred || interaction.replied) interaction.followUp({ content: '❌ Error: ' + err.message, ephemeral: true }); else interaction.reply({ content: '❌ Error: ' + err.message, ephemeral: true }); } catch(_){}
  }
});

// =============================================================================
//  MESSAGE — capture receipt screenshots uploaded inside tickets
// =============================================================================
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    // Find open ticket for this channel
    const t = store.tickets.find(x => x.channelId === message.channelId && x.status === 'open');
    if (t && message.attachments.size > 0) {
      // Find the pending payment request for this ticket
      const pr = store.paymentRequests.find(p => p.ticketId === t.id && (p.status === 'Pending' || p.status === 'Waiting Review'));
      if (pr) {
        pr.status = 'Waiting Review';
        saveStore();

        const embed = new EmbedBuilder()
          .setColor(0xf0b232)
          .setTitle('⏳ Receipt Uploaded — Awaiting Admin Review')
          .setDescription(`Customer <@${message.author.id}> uploaded a receipt for **${pr.accountTitle}**.\nAmount: ${store.settings.currency}${pr.amount.toFixed(2)} • Method: ${pr.method}\n\nAdmin: review and approve/reject below.`)
          .setImage(message.attachments.first().url)
          .setFooter({ text: `Payment ID: ${pr.id}` })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`approve_${pr.id}`).setLabel('Approve & Deliver').setStyle(ButtonStyle.Success).setEmoji('✅'),
          new ButtonBuilder().setCustomId(`reject_${pr.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger).setEmoji('❌'),
          new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Secondary).setEmoji('🔒')
        );

        await message.channel.send({ embeds: [embed], components: [row] });
        addLog('INFO', `Receipt uploaded in ${t.id} by ${message.author.username}`);
      }
    }
  } catch (e) { console.error('msg err', e.message); }
});

// =============================================================================
//  START
// =============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('🌐 Panel server running on port ' + PORT);
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN).catch(err => console.error('Discord login failed:', err.message));
} else {
  console.warn('⚠️  DISCORD_TOKEN not set — panel only mode (bot offline).');
  addLog('WARN', 'No DISCORD_TOKEN — running panel-only mode');
}
