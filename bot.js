// ====================================================================
// ISIAM STORE ADVANCED DIGITAL E-COMMERCE ENGINE
// ====================================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits 
} = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Core Database State with local persistent backup
let store = {
  accounts: [],
  settings: {
    currency: 'SAR',
    accountsChannelId: '',
    ticketCategoryId: '',
    alrajhiIBAN: 'SA0000000000000000000000',
    alrajhiName: 'Hamoud Al Enzi',
    paypalEmail: 'paypal@isiam.store',
    stcPayNumber: '0500000000'
  }
};

// Load database safe checks
if (fs.existsSync(DATA_FILE)) {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error("Error reading database file, initializing fresh store:", err);
  }
}

function saveDatabase() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// --------------------------------------------------------------------
// EXPRESS API FOR YOUR WEB PANEL
// --------------------------------------------------------------------
app.get('/api/accounts', (req, res) => res.json(store.accounts));

app.post('/api/accounts', async (req, res) => {
  const { title, price, details, email, password, images } = req.body;
  
  const newProduct = {
    id: 'PROD-' + Date.now(),
    title,
    price: parseFloat(price) || 0.00,
    details: details || '',
    email: email || '',
    password: password || '',
    images: images || [], // Base64 or Image Link Arrays
    status: 'available'
  };

  store.accounts.unshift(newProduct);
  saveDatabase();

  // Cross-post automatically to Discord Catalog Channel
  if (store.settings.accountsChannelId && client.isReady()) {
    try {
      const channel = await client.channels.fetch(store.settings.accountsChannelId);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🎮 ${newProduct.title}`)
          .addFields(
            { name: '💰 Price / السعر', value: `${newProduct.price} ${store.settings.currency}`, inline: true },
            { name: '📋 Description', value: newProduct.details || 'No details provided.', inline: false }
          )
          .setFooter({ text: `isiam store • ID: ${newProduct.id}` });

        if (newProduct.images.length > 0) {
          embed.setImage(newProduct.images[0]); // Sets primary gallery picture
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`buy_${newProduct.id}`)
            .setLabel('شراء / Buy Now')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🛒')
        );

        await channel.send({ embeds: [embed], components: [row] });
      }
    } catch (err) {
      console.error("Failed to post product to Discord channel:", err);
    }
  }

  res.json({ success: true, product: newProduct });
});

app.get('/api/settings', (req, res) => res.json(store.settings));
app.post('/api/settings', (req, res) => {
  store.settings = { ...store.settings, ...req.body };
  saveDatabase();
  res.json({ success: true, settings: store.settings });
});

// --------------------------------------------------------------------
// DISCORD BOT BOT INTERACTION WORKFLOW
// --------------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on('interactionCreate', async (interaction) => {
  // 1. Handle "Buy Now" Catalog Button Click
  if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
    await interaction.deferReply({ ephemeral: true }); // Prevents the 'Interaction Failed' timeout window
    
    const productId = interaction.customId.replace('buy_', '');
    const product = store.accounts.find(p => p.id === productId);

    if (!product || product.status !== 'available') {
      return interaction.editReply({ content: '❌ هذا المنتج غير متوفر حالياً أو تم بيعه / This product is currently out of stock.' });
    }

    const guild = interaction.guild;
    const clientUser = interaction.user;

    // Look for parent ticket category setup
    const parentCategory = store.settings.ticketCategoryId ? guild.channels.cache.get(store.settings.ticketCategoryId) : null;

    // Create Private Ticket Room securely
    const ticketChannel = await guild.channels.create({
      name: `🛒ـ${clientUser.username}`,
      type: ChannelType.GuildText,
      parent: parentCategory ? parentCategory.id : null,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: clientUser.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
      ]
    });

    // Change status to hold item temporarily during checkout
    product.status = 'pending_payment';
    saveDatabase();

    // Populate the ticket with complete order details & dynamic billing selectors
    const entryEmbed = new EmbedBuilder()
      .setColor(0x23a55a)
      .setTitle('فاتورة الشراء وتأكيد الطلب / Secure Checkout Portal')
      .setDescription(`مرحباً بك **${clientUser.username}** في متجر **isiam store**.\nلقد اخترت شراء المنتج التالي:`)
      .addFields(
        { name: '📦 Product / المنتج', value: `**${product.title}**`, inline: true },
        { name: '💵 Total Price / الإجمالي', value: `**${product.price} ${store.settings.currency}**`, inline: true },
        { name: '📌 Product ID', value: `\`${product.id}\``, inline: false }
      )
      .setThumbnail(product.images[0] || null)
      .setFooter({ text: 'الرجاء اختيار طريقة الدفع المناسبة من القائمة أدناه لتلقي البيانات.' });

    const paymentDropdown = new StringSelectMenuBuilder()
      .setCustomId(`select_payment_${product.id}`)
      .setPlaceholder('💳 اختر طريقة الدفع / Select Payment Method')
      .addOptions([
        { label: 'مصرف الراجحي / Al Rajhi Bank', description: 'الدفع عبر تحويل بنكي مباشر المدى', value: 'alrajhi', emoji: '🏦' },
        { label: 'باي بال / PayPal Checkout', description: 'Pay securely using global credit cards or PayPal balance', value: 'paypal', emoji: '💳' },
        { label: 'STC Pay', description: 'التحويل السريع عبر رقم الهاتف الجوال', value: 'stcpay', emoji: '📱' }
      ]);

    const row = new ActionRowBuilder().addComponents(paymentDropdown);

    await ticketChannel.send({
      content: `${clientUser} | 🔔 طلب شراء جديد`,
      embeds: [entryEmbed],
      components: [row]
    });

    return interaction.editReply({ content: `✅ تم فتح تذكرتك الخاصة بنجاح! اذهب هنا لإكمال الدفع: ${ticketChannel}` });
  }

  // 2. Handle Payment Selection Dropdown Menu
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_payment_')) {
    await interaction.deferReply();
    
    const productId = interaction.customId.replace('select_payment_', '');
    const product = store.accounts.find(p => p.id === productId);
    const chosenMethod = interaction.values[0];

    if (!product) {
      return interaction.editReply({ content: 'Error: Product record could not be found.' });
    }

    let paymentDetailsEmbed = new EmbedBuilder().setColor(0x5865f2).setTimestamp();
    const adminActionRow = new ActionRowBuilder();

    // Contextual payment logic based on menu selections
    if (chosenMethod === 'alrajhi') {
      paymentDetailsEmbed
        .setTitle('🏦 معلومات التحويل البنكي — مصرف الراجحي')
        .setDescription('الرجاء تحويل المبلغ المطلوب إلى الحساب التالي، ثم ارفع صورة الإيصال (التحويل كأصل) هنا في الدردشة.')
        .addFields(
          { name: 'اسم الحساب / Account Name', value: store.settings.alrajhiName, inline: true },
          { name: 'رقم الآيبان / IBAN', value: `\`${store.settings.alrajhiIBAN}\``, inline: false },
          { name: 'المبلغ المطلوب / Amount', value: `**${product.price} ${store.settings.currency}**`, inline: true }
        );
    } else if (chosenMethod === 'paypal') {
      paymentDetailsEmbed
        .setTitle('💳 الدفع عبر باي بال / PayPal Information')
        .setDescription('الرجاء إرسال الأموال كـ (Friends and Family) لتفادي التعليق وضمان سرعة التسليم.')
        .addFields(
          { name: 'حساب الباي بال / PayPal Email', value: `\`${store.settings.paypalEmail}\``, inline: false },
          { name: 'المبلغ المطلوب / Amount', value: `**${product.price} USD / ${store.settings.currency}**`, inline: true }
        );
    } else if (chosenMethod === 'stcpay') {
      paymentDetailsEmbed
        .setTitle('📱 الدفع عبر التحويل لـ STC Pay')
        .setDescription('قم بتحويل المبلغ فوراً عبر تطبيق STC Pay إلى الرقم المرفق أدناه.')
        .addFields(
          { name: 'رقم الجوال / Phone Number', value: `\`${store.settings.stcPayNumber}\``, inline: true },
          { name: 'المبلغ المطلوب / Amount', value: `**${product.price} ${store.settings.currency}**`, inline: true }
        );
    }

    // Embed validation keys directly on admin actions so execution data is stateless
    adminActionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_buy_${product.id}`)
        .setLabel('تأكيد الدفع وتسليم الحساب / Approve & Deliver Account')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`cancel_buy_${product.id}`)
        .setLabel('إلغاء الطلب / Cancel Order')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({ 
      content: '⏳ يرجى إتمام عملية التحويل وإرسال صورة واضحة لإيصال التحويل البنكي هنا.',
      embeds: [paymentDetailsEmbed], 
      components: [adminActionRow] 
    });
  }

  // 3. Handle Admin Order Management Approvals & Safe Auto-Deletion Loop
  if (interaction.isButton() && interaction.customId.startsWith('approve_buy_')) {
    await interaction.deferReply();
    
    // Authorization Check: Verify if checking user has Administrator permissions
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.editReply({ content: '❌ عذراً، هذا الإجراء مخصص لإدارة المتجر فقط / Admins only.', ephemeral: true });
    }

    const productId = interaction.customId.replace('approve_buy_', '');
    const product = store.accounts.find(p => p.id === productId);

    if (!product) {
      return interaction.editReply({ content: 'Error: Inventory target entity was moved or already processed.' });
    }

    // Flag item as sold across system indexes
    product.status = 'sold';
    saveDatabase();

    // Delivery Phase: Transmit credentials inside the private secure channel block
    const deliveryEmbed = new EmbedBuilder()
      .setColor(0x23a55a)
      .setTitle('🎉 تم تأكيد الدفع! إليك بيانات حسابك / Order Delivered Successfully')
      .setDescription('شكراً لثقتك بـ **isiam store**! إليك تفاصيل المنتج الرقمي الخاص بك:')
      .addFields(
        { name: '📧 Email / اسم المستخدم', value: `\`${product.email}\``, inline: false },
        { name: '🔑 Password / كلمة المرور', value: `\`${product.password}\``, inline: false }
      )
      .setFooter({ text: '⚠️ احتفظ بالمعلومات وقم بتغيير بيانات الحساب فوراً لسلامتك.' })
      .setTimestamp();

    await interaction.channel.send({ content: `📦 **تسليم فوري للمنتج:**`, embeds: [deliveryEmbed] });

    await interaction.editReply({ content: '✅ تم إرسال البيانات للعميل بنجاح. سيتم إغلاق التذكرة تلقائياً بعد قليل...' });

    // Auto-Close Sequence: Safely delete channel context window after a 10-second buffer delay
    setTimeout(async () => {
      try {
        await interaction.channel.delete('Purchase processing completed successfully.');
      } catch (err) {
        console.error('Failed to auto-delete ticket channel context:', err);
      }
    }, 10000);
  }

  // 4. Handle Order Cancellations / Return stock to inventory pools
  if (interaction.isButton() && interaction.customId.startsWith('cancel_buy_')) {
    await interaction.deferReply();
    
    const productId = interaction.customId.replace('cancel_buy_', '');
    const product = store.accounts.find(p => p.id === productId);

    if (product && product.status === 'pending_payment') {
      product.status = 'available';
      saveDatabase();
    }

    await interaction.editReply({ content: '❌ تم إلغاء الطلب وإرجاع المنتج للمتجر. سيتم تدمير هذه التذكرة الآن...' });
    
    setTimeout(async () => {
      try { await interaction.channel.delete('Order cancellation clean-up.'); } catch(e){}
    }, 4000);
  }
});

// Start application servers synchronously 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`E-commerce Web Server alive on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
