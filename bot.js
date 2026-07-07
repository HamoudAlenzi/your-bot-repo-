// =============================================
// ISIAM STORE BOT — Private Tickets, Auto-Delivery & Multi-Image Embeds
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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
  const paths = [
    path.join(__dirname, 'panel.html'),
    path.join(__dirname, 'public', 'panel.html'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const panelPath = findPanelHtml();
if (panelPath) {
  app.get('/panel.html', (req, res) => res.sendFile(panelPath));
  app.get('/', (req, res) => res.redirect('/panel.html'));
}

// Data Store
let store = {
  accounts: [], orders: [], customers: [], pools: [],
  paymentRequests: [], tickets: [], logs: [],
  settings: {
    prefix: '!', currency: '$', accountsChannelId: '', ticketCategoryId: '', logChannelId: '', ownerId: '',
    termsAr: 'الشروط العامة\n▪️ يتم تسليم الحساب فور تأكيد الدفع\n▪️ الضمان يبدأ من تاريخ الشراء',
    termsEn: 'General Terms\n▪️ Account delivered immediately after payment\n▪️ Warranty starts from purchase date',
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

// API Routes
app.get('/api/stats', (req, res) => {
  res.json({
    totalAccounts: store.accounts.length,
    available: store.accounts.filter(a => a.status === 'available').length,
    sold: store.accounts.filter(a => a.status === 'sold').length,
    totalOrders: store.orders.length,
    pendingPayments: store.paymentRequests.filter(p => p.status === 'Pending' || p.status === 'Waiting Review').length,
    openTickets: store.tickets.filter(t => t.status !== 'closed').length
  });
});

app.get('/api/accounts', (req, res) => res.json(store.accounts));

app.post('/api/accounts', (req, res) => {
  try {
    const { titleEn, titleAr, game, price, prestige, stats, warranty, detailsEn, detailsAr, email, pass, extra, images } = req.body;
    const allImages = images && Array.isArray(images) ? images : [];
    
    const acc = {
      id: genId(), titleEn, titleAr: titleAr || '', game: game || 'Other',
      price: parseFloat(price), prestige: prestige || '', stats: stats || '',
      warranty: parseInt(warranty) || 0, detailsEn: detailsEn || '', detailsAr: detailsAr || '',
      email: email || '', pass: pass || '', extra: extra || '', images: allImages,
      status: 'available', discordMessageIds: [], createdAt: new Date().toISOString()
    };

    store.accounts.unshift(acc);
    const channelId = store.settings.accountsChannelId;

    if (channelId && client.isReady()) {
      const channel = client.channels.cache.get(channelId);
      if (channel) postAccountToDiscord(channel, acc, allImages);
    }
    res.json(acc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function postAccountToDiscord(channel, acc, allImages) {
  const embeds = [];
  const files = [];
  const dummyUrl = 'https://isiam-store.app'; // Required to merge multiple images into one embed box

  const mainEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎮 ${acc.titleEn}`)
    .setURL(dummyUrl)
    .addFields(
      { name: 'الاسم / Title', value: acc.titleAr || acc.titleEn, inline: false },
      { name: 'Rank / Level', value: acc.prestige || '-', inline: true },
      { name: 'Total Stats', value: acc.stats || '-', inline: true },
      { name: 'Warranty', value: acc.warranty > 0 ? acc.warranty + ' Days' : 'None', inline: true },
      { name: 'Details', value: acc.detailsEn || '-', inline: false },
      { name: 'Price', value: `${store.settings.currency}${acc.price.toFixed(2)}`, inline: false }
    )
    .setFooter({ text: `isiam store • Product ID: ${acc.id}` });

  // Handle Multiple Images in ONE embed box using the Discord URL trick
  for (let i = 0; i < allImages.length; i++) {
    const parsed = base64ToBuffer(allImages[i]);
    if (parsed) {
      const fileName = `img_${i}.jpg`;
      files.push(new AttachmentBuilder(parsed.buffer, { name: fileName }));
      if (i === 0) {
        mainEmbed.setImage(`attachment://${fileName}`);
        embeds.push(mainEmbed);
      } else {
        const extraEmbed = new EmbedBuilder().setURL(dummyUrl).setImage(`attachment://${fileName}`);
        embeds.push(extraEmbed);
      }
    }
  }

  if (embeds.length === 0) embeds.push(mainEmbed);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_' + acc.id).setLabel('شراء / Buy Now').setStyle(ButtonStyle.Success).setEmoji('🛒'),
    new ButtonBuilder().setCustomId('verify_' + acc.id).setLabel('Verify').setStyle(ButtonStyle.Secondary)
  );

  const msg = await channel.send({ embeds, components: [row], files });
  acc.discordMessageIds.push(msg.id);
}

app.delete('/api/accounts/:id', (req, res) => {
  const acc = store.accounts.find(a => a.id === parseInt(req.params.id));
  if (!acc) return res.status(404).json({ error: 'Not found' });
  if (acc.discordMessageIds.length && client.isReady()) {
    const channel = client.channels.cache.get(store.settings.accountsChannelId);
    if (channel) acc.discordMessageIds.forEach(mid => channel.messages.delete(mid).catch(() => {}));
  }
  store.accounts = store.accounts.filter(a => a.id !== acc.id);
  res.json({ success: true });
});

app.get('/api/orders', (req, res) => res.json(store.orders));
app.get('/api/payments', (req, res) => res.json(store.paymentRequests));
app.get('/api/tickets', (req, res) => res.json(store.tickets));
app.get('/api/customers', (req, res) => res.json(store.customers));
app.get('/api/settings', (req, res) => res.json(store.settings));
app.post('/api/settings', (req, res) => Object.assign(store.settings, req.body) && res.json(store.settings));

// Approve Payment & Auto-Close Flow
app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const pr = store.paymentRequests.find(p => p.id === req.params.id);
    if (!pr) return res.status(404).json({ error: 'Request missing' });
    pr.status = 'Approved';

    const acc = store.accounts.find(a => a.id === pr.accountId);
    if (acc) {
      acc.status = 'sold';
      store.orders.unshift({ id: 'ORD-' + genId(), cust: pr.userName, item: pr.accountTitle, amount: pr.amount, status: 'Delivered', paymentMethod: pr.method, date: new Date().toISOString() });

      const ticket = store.tickets.find(t => t.paymentId === pr.id);
      if (ticket && ticket.channelId && client.isReady()) {
        const ticketChannel = client.channels.cache.get(ticket.channelId);
        if (ticketChannel) {
          // Give the account details
          await ticketChannel.send({
            content: `✅ **تم تأكيد الدفع بنجاح! / Payment Confirmed!**\n\n**${pr.accountTitle}**\n📧 Email: \`${acc.email}\`\n🔑 Password: \`${acc.pass}\`\n\n⏳ *This ticket will auto-close in 10 seconds...*`
          });
          ticket.status = 'closed';
          
          // Auto close itself
          setTimeout(async () => {
            try { await ticketChannel.delete('Purchase completed'); } catch(e){}
          }, 10000);
        }
      }
    }
    res.json(pr);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discord Bot Intercepts
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    const accId = parseInt(interaction.customId.split('_')[1]);
    const acc = store.accounts.find(a => a.id === accId);
    if (!acc || acc.status !== 'available') return interaction.reply({ content: '❌ Out of stock.', ephemeral: true });

    const guild = interaction.guild;
    const category = guild.channels.cache.get(store.settings.ticketCategoryId);
    
    // Create Private Ticket
    const ticketChannel = await guild.channels.create({
      name: `buy-${interaction.user.username}`,
      type: ChannelType.GuildText,
      parent: category,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] }
      ]
    });

    const ticketId = 'TKT-' + genId();
    store.tickets.unshift({ id: ticketId, userId: interaction.user.id, userName: interaction.user.username, accountId: accId, accountTitle: acc.titleEn, amount: acc.price, channelId: ticketChannel.id, status: 'open' });
    acc.status = 'reserved';

    // Welcome embed inside private ticket using the specified local image
    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🛒 isiam store - Purchase System')
      .setDescription(`Welcome **${interaction.user.username}**!\n\n**Product:** ${acc.titleEn}\n**Price:** ${store.settings.currency}${acc.price}\n\nPlease select your payment method below.`)
      .setThumbnail('attachment://store_logo.png');

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`paymethod_${accId}_${ticketId}`)
      .setPlaceholder('Choose payment method')
      .addOptions(
        { label: 'STC Pay', value: 'stcpay', emoji: '📱' },
        { label: 'AlRajhi Bank', value: 'alrajhi', emoji: '🏦' }
      );

    const logoFile = new AttachmentBuilder('0e3f41e7-3aa3-40c4-9a1d-e3d05cebe709-profile_image-70x70.png', { name: 'store_logo.png' });

    await ticketChannel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [welcomeEmbed],
      files: [logoFile],
      components: [new ActionRowBuilder().addComponents(selectMenu)]
    });

    return interaction.reply({ content: `🎫 Private ticket created: <#${ticketChannel.id}>`, ephemeral: true });
  }

  // Payment Selection
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('paymethod_')) {
    const parts = interaction.customId.split('_');
    const acc = store.accounts.find(a => a.id === parseInt(parts[1]));
    const ticket = store.tickets.find(t => t.id === parts[2]);
    const method = interaction.values[0];

    const payId = 'PAY-' + genId();
    store.paymentRequests.unshift({ id: payId, userId: interaction.user.id, userName: interaction.user.username, accountId: acc.id, accountTitle: acc.titleEn, amount: acc.price, method: method.toUpperCase(), status: 'Pending' });
    ticket.paymentId = payId; ticket.status = 'waiting_payment';

    let info = method === 'stcpay' ? `📱 **STC Pay:** ${store.settings.stcPay.number}` : `🏦 **AlRajhi:** ${store.settings.alrajhi.iban}`;
    await interaction.reply(`💳 **Payment Instructions:**\nAmount: $${acc.price}\n${info}\n\n⚠️ **Next Step:** Transfer the amount, then **upload a picture of the receipt here.**`);
  }
});

// Image Receipt interception
client.on('messageCreate', async (message) => {
  const ticket = store.tickets.find(t => t.channelId === message.channel.id && t.status === 'waiting_payment');
  if (ticket && message.attachments.size > 0) {
    const pr = store.paymentRequests.find(p => p.id === ticket.paymentId);
    pr.status = 'Waiting Review'; ticket.status = 'waiting_review';
    message.reply(`✅ **Receipt received!** The admin is reviewing it. Your account will be delivered right here once approved.`);
  }
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('isiam store running'));
client.login(process.env.DISCORD_TOKEN);
