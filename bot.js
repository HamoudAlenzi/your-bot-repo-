// ====================================================================
// ISIAM STORE: ADVANCED DIGITAL E-COMMERCE ENGINE
// ====================================================================

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits 
} = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Panel Security Setup
app.use(session({
  secret: 'isiam-super-secret-key-2026',
  resave: false,
  saveUninitialized: true
}));

// ====================================================================
// DATABASE: PERSISTENT SQLITE FOR RAILWAY
// Note: In Railway, mount a Volume to /app/data to prevent wipes!
// ====================================================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'store.db') 
  : './store.db';

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("Database Error:", err.message);
  else console.log("Connected to persistent SQLite database.");
});

// Initialize Tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, title TEXT, price REAL, details TEXT, images TEXT, type TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS stock_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT, payload TEXT, status TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS coupons (code TEXT PRIMARY KEY, discount_pct INTEGER, max_uses INTEGER, used INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
});

// Helper functions for DB
const runDb = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); }));
const getDb = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); }));
const allDb = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); }));

// ====================================================================
// EXPRESS API & DASHBOARD SECURITY
// ====================================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'isiamadmin123';

const requireAuth = (req, res, next) => {
  if (req.session.loggedIn) return next();
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
};

app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Get Products
app.get('/api/products', requireAuth, async (req, res) => {
  const products = await allDb('SELECT * FROM products');
  res.json(products);
});

// Create Product & Post to Discord
app.post('/api/products', requireAuth, async (req, res) => {
  const { title, price, details, images, type, stockPayloads } = req.body;
  const id = 'PROD-' + Date.now();
  
  await runDb(`INSERT INTO products (id, title, price, details, images, type) VALUES (?, ?, ?, ?, ?, ?)`, 
    [id, title, parseFloat(price), details, JSON.stringify(images), type]);

  // If digital keys are provided, load them into the auto-delivery pool
  if (stockPayloads && stockPayloads.length > 0) {
    for (const payload of stockPayloads) {
      await runDb(`INSERT INTO stock_pool (product_id, payload, status) VALUES (?, ?, 'available')`, [id, payload]);
    }
  }

  // Discord Post Logic (Multi-Image Workaround)
  const settings = await allDb('SELECT * FROM settings');
  const config = settings.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
  
  if (config.accountsChannelId && client.isReady()) {
    try {
      const channel = await client.channels.fetch(config.accountsChannelId);
      const embeds = [];
      const dummyUrl = 'https://isiam-store.app'; // Critical: Same URL groups images together

      const mainEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🎮 ${title}`)
        .setURL(dummyUrl)
        .addFields(
          { name: '💰 Price / السعر', value: `${price} SAR`, inline: true },
          { name: '📋 Details', value: details || 'No details provided.', inline: false }
        )
        .setFooter({ text: `isiam store • ID: ${id}` });

      if (images && images.length > 0) {
        mainEmbed.setImage(images[0]);
        embeds.push(mainEmbed);
        // Append up to 3 more images to the same embed gallery
        for (let i = 1; i < images.length && i < 4; i++) {
          embeds.push(new EmbedBuilder().setURL(dummyUrl).setImage(images[i]));
        }
      } else {
        embeds.push(mainEmbed);
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`buy_${id}`).setLabel('شراء / Buy Now').setStyle(ButtonStyle.Success).setEmoji('🛒')
      );

      await channel.send({ embeds, components: [row] });
    } catch (err) { console.error("Failed to post:", err); }
  }
  res.json({ success: true });
});

// Broadcast Announcer
app.post('/api/broadcast', requireAuth, async (req, res) => {
  const { channelId, messageAr, messageEn, image } = req.body;
  if (client.isReady()) {
    try {
      const channel = await client.channels.fetch(channelId);
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('📢 Store Announcement / إعلان المتجر')
        .setDescription(`**${messageAr}**\n\n*${messageEn}*`)
        .setTimestamp();
      if (image) embed.setImage(image);
      
      await channel.send({ embeds: [embed] });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
});

// ====================================================================
// DISCORD BOT BOT INTERACTION WORKFLOW
// ====================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on('interactionCreate', async (interaction) => {
  // 1. Checkout Initiation
  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    await interaction.deferReply({ ephemeral: true });
    
    const productId = interaction.customId.replace('buy_', '');
    const product = await getDb('SELECT * FROM products WHERE id = ?', [productId]);
    
    // Check auto-delivery stock pool
    const availableStock = await getDb(`SELECT count(*) as count FROM stock_pool WHERE product_id = ? AND status = 'available'`, [productId]);

    if (!product || (product.type === 'digital_key' && availableStock.count === 0)) {
      return interaction.editReply({ content: '❌ Out of stock / نفدت الكمية.' });
    }

    const guild = interaction.guild;
    const ticketChannel = await guild.channels.create({
      name: `🛒ـ${interaction.user.username}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
      ]
    });

    const entryEmbed = new EmbedBuilder()
      .setColor(0x23a55a)
      .setTitle('Secure Checkout / الدفع الآمن')
      .setDescription(`مرحباً **${interaction.user.username}**.\n**Product:** ${product.title}\n**Price:** ${product.price} SAR`);

    const paymentDropdown = new StringSelectMenuBuilder()
      .setCustomId(`pay_${product.id}`)
      .setPlaceholder('💳 Select Payment / اختر طريقة الدفع')
      .addOptions([
        { label: 'Al Rajhi Bank', value: 'alrajhi', emoji: '🏦' },
        { label: 'STC Pay', value: 'stcpay', emoji: '📱' },
        { label: 'PayPal', value: 'paypal', emoji: '💳' },
        { label: 'Crypto (USDT)', value: 'crypto', emoji: '🪙' }
      ]);

    const row = new ActionRowBuilder().addComponents(paymentDropdown);
    const couponBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`coupon_${product.id}`).setLabel('إدخال كوبون / Enter Coupon').setStyle(ButtonStyle.Secondary)
    );

    await ticketChannel.send({ content: `${interaction.user} | 🔔`, embeds: [entryEmbed], components: [row, couponBtn] });
    return interaction.editReply({ content: `✅ Ticket created: ${ticketChannel}` });
  }

  // 2. Admin Approval & Auto-Delivery from Pool
  if (interaction.isButton() && interaction.customId.startsWith('approve_buy_')) {
    await interaction.deferReply();
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.editReply({ content: '❌ Admins only.' });

    const productId = interaction.customId.replace('approve_buy_', '');
    const product = await getDb('SELECT * FROM products WHERE id = ?', [productId]);
    
    let deliveryData = "Data will be provided manually by admin.";

    if (product.type === 'digital_key') {
      const stock = await getDb(`SELECT id, payload FROM stock_pool WHERE product_id = ? AND status = 'available' LIMIT 1`, [productId]);
      if (stock) {
        await runDb(`UPDATE stock_pool SET status = 'sold' WHERE id = ?`, [stock.id]);
        deliveryData = stock.payload;
      } else {
        return interaction.editReply('❌ Critical Error: Stock pool empty during delivery.');
      }
    }

    const deliveryEmbed = new EmbedBuilder()
      .setColor(0x23a55a)
      .setTitle('🎉 Order Delivered / تم التسليم')
      .setDescription(`**بياناتك / Your Data:**\n\`\`\`${deliveryData}\`\`\``);

    await interaction.channel.send({ content: `📦 **تسليم فوري / Instant Delivery:**`, embeds: [deliveryEmbed] });
    await interaction.editReply({ content: '✅ Delivered. Ticket closing in 10s.' });

    // Request Rating in DM before closing
    try {
      const ratingRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rate_5_${productId}`).setLabel('⭐⭐⭐⭐⭐').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`rate_1_${productId}`).setLabel('⭐').setStyle(ButtonStyle.Danger)
      );
      await interaction.user.send({ 
        content: `شكراً لشرائك من **isiam store**! كيف تقيم تجربتك؟\nThanks for buying **${product.title}**! Please rate us.`, 
        components: [ratingRow] 
      });
    } catch (e) { /* User DMs off */ }

    setTimeout(async () => { try { await interaction.channel.delete(); } catch(e){} }, 10000);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Store running'));
client.login(process.env.DISCORD_TOKEN);
