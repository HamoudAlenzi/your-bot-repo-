require('dotenv').config();
const express = require('express');
const { 
    Client, 
    GatewayIntentBits, 
    ChannelType, 
    PermissionFlagsBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Fixes Server Error 500 by allowing large image arrays/base64 payloads up to 50MB
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize Discord Client with necessary gateway intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Memory cache to keep track of open tickets mapping to customers
const activeTickets = new Map();

// =========================================================================
// EXPRESS API ENDPOINTS (Frontend Management Panel Integration)
// =========================================================================

// Health check route to verify Railway deployment status
app.get('/', (req, res) => {
    res.status(200).json({ status: "online", message: "Backend and Discord bot are operating normally." });
});

/**
 * Handles product listing posts from your Management Panel.
 * Strict try/catch implementation avoids throwing generic 500 unhandled exceptions.
 */
app.post('/api/listings', async (req, res) => {
    try {
        const listingData = req.body;
        
        // Outputs incoming form data straight to your Railway dashboard console logs
        console.log("=== NEW LISTING SUBMISSION ===");
        console.log("Payload Received:", JSON.stringify(listingData, null, 2));

        // Fallback validation to protect your database models
        if (!listingData.gameTitleEnglish || !listingData.price) {
            return res.status(400).json({ 
                success: false, 
                message: "Validation Error: Game Title (English) and Price are mandatory fields." 
            });
        }

        // -----------------------------------------------------------------
        // INSERT YOUR DATABASE PERSISTENCE CODE HERE (e.g., MongoDB / MySQL)
        // Example: const safeSavedProduct = await Product.create(listingData);
        // -----------------------------------------------------------------

        // Return a structural true layout response to eliminate UI dashboard errors
        return res.status(200).json({ 
            success: true, 
            message: "Listing successfully processed and published." 
        });

    } catch (error) {
        console.error("CRITICAL EXCEPTION OCCURRED AT /api/listings:", error);
        return res.status(500).json({ 
            success: false, 
            message: "An internal server error occurred while rendering the data packet.",
            error: error.message 
        });
    }
});

/**
 * Webhook consumer listening to completed sales events from your payment gateways.
 * Drops the item credentials into the designated Discord ticket channel and closes it.
 */
app.post('/api/webhook/payment-success', async (req, res) => {
    try {
        const { ticketChannelId, accountCredentials } = req.body;

        if (!ticketChannelId) {
            return res.status(400).json({ success: false, message: "Missing ticketChannelId identity reference." });
        }

        // Search for the open text ticket within the Discord server
        const targetChannel = await client.channels.fetch(ticketChannelId).catch(() => null);
        
        if (!targetChannel) {
            return res.status(404).json({ success: false, message: "The specified checkout ticket channel was not found." });
        }

        // 1. Send confirmation message to the buyer
        await targetChannel.send("✨ **Payment Status: Completed & Verified Successfully!**");
        
        // 2. Transmit the purchased contents into the secure chat
        await targetChannel.send(`📦 **Your Account Credentials:**\n\`\`\`text\n${accountCredentials || "No automatic credential block attached."}\n\`\`\``);
        
        await targetChannel.send("⚠️ **Attention:** This transaction has concluded. This ticket will automatically close in **20 seconds**. Please copy your login information immediately.");

        // Wipe the ticket record out of memory cache tracking
        activeTickets.delete(ticketChannelId);

        // 3. Initiate the automated channel self-destruct cycle
        setTimeout(async () => {
            try {
                await targetChannel.delete("Automated checkout finalized; channel purged.");
                console.log(`Successfully closed completed checkout channel: ${ticketChannelId}`);
            } catch (err) {
                console.error("Failed to execute automatic channel cleanup deletion:", err);
            }
        }, 20000); // 20-second delay countdown

        return res.status(200).json({ success: true, message: "Credentials dropped. Channel closure execution scheduled." });

    } catch (error) {
        console.error("WEBHOOK TRANSACTION FAILURE EXCEPTION:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================================
// DISCORD BOT INFRASTRUCTURE
// =========================================================================

client.on('ready', () => {
    console.log(`Bot initialized! Running on Discord as user account: ${client.user.tag}`);
});

/**
 * Interaction listener watching for customers clicking the storefront purchase button.
 */
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    // Checks if the interactive button key matches your shop setup pattern
    if (interaction.customId.startsWith('buy_item_')) {
        try {
            const guild = interaction.guild;
            if (!guild) return;

            const customerUser = interaction.user;
            const targetListingId = interaction.customId.replace('buy_item_', '');

            // Restrict base channel permission states to exclude public traffic
            const channelPermissions = [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: customerUser.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
                }
            ];

            // If an Admin Role ID exists in your environment, grant them visibility permissions
            if (process.env.ADMIN_ROLE_ID) {
                channelPermissions.push({
                    id: process.env.ADMIN_ROLE_ID,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                });
            }

            // Create the isolated private transaction text room
            const ticketChannel = await guild.channels.create({
                name: `🛒-${customerUser.username}`,
                type: ChannelType.GuildText,
                permissionOverwrites: channelPermissions,
            });

            activeTickets.set(ticketChannel.id, customerUser.id);

            // Appends the specific ticket channel ID parameters onto your web store URL for the webhook tracking step
            const paymentCheckoutLink = `https://yourstore.com/checkout?listing=${targetListingId}&ticket=${ticketChannel.id}`;

            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Proceed to Secure Payment')
                    .setStyle(ButtonStyle.Link)
                    .setURL(paymentCheckoutLink)
            );

            await ticketChannel.send({
                content: `Welcome ${customerUser}! You have initialized a private purchase request for Listing ID: **${targetListingId}**.\n\nPlease follow the link below to process your payment method. Once confirmed, your account information will drop inside this chat automatically.`,
                components: [actionRow]
            });

            await interaction.reply({ 
                content: `Your secure checkout channel has been configured: ${ticketChannel}`, 
                ephemeral: true 
            });

        } catch (error) {
            console.error("Critical failure during private ticket execution lifecycle:", error);
            await interaction.reply({ 
                content: "An internal issue prevented the automated setup of your private checkout workspace. Please loop in store management.", 
                ephemeral: true 
            });
        }
    }
});

// Global runtime protection catchments to intercept edge-case unhandled failures
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Detected Unhandled Rejection at Promise structure:', promise, 'Reason trace:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: System intercepted an Uncaught Exception event line:', err);
});

// Boot servers simultaneously
client.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () => {
    console.log(`Production API microservice listening natively on Port: ${PORT}`);
});
