// ===== CONNECT PANEL TO BOT =====
const { setBot } = require('./server');
const discordJs = require('discord.js');

// Your existing bot.on('ready') callback:
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // ADD THIS LINE inside your ready event:
  setBot(client, discordJs);
});
