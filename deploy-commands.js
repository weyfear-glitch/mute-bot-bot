// deploy-commands.js
// Lance ce script UNE FOIS pour enregistrer les commandes slash sur Discord.
// node deploy-commands.js

const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const commands = [
  new SlashCommandBuilder()
    .setName('muteinfo')
    .setDescription('Affiche les informations de mute d\'un membre')
    .addUserOption(opt =>
      opt.setName('membre')
         .setDescription('Le membre dont vous voulez voir le statut de mute')
         .setRequired(true)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    console.log('📡 Enregistrement des commandes slash...');
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    console.log('✅ Commandes enregistrées avec succès.');
  } catch (err) {
    console.error('❌ Erreur:', err);
  }
})();
