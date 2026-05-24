const { Client, GatewayIntentBits, Events, PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_PATH   = path.join(__dirname, 'mute_data.json');

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// config.json structure:
// {
//   "token": "BOT_TOKEN",
//   "whitelistedRoleIds": ["ROLE_ID_1", "ROLE_ID_2"]
// }
const config = loadJSON(CONFIG_PATH);

if (!config.token) {
  console.error('❌ Aucun token trouvé dans config.json');
  process.exit(1);
}

// mute_data.json structure:
// {
//   "GUILD_ID": {
//     "MUTED_USER_ID": {
//       "mutedBy": "USER_ID",
//       "muterHighestRolePosition": 5,
//       "mutedAt": "ISO_DATE"
//     }
//   }
// }
let muteData = loadJSON(DATA_PATH);

// ─── Client ──────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
  ],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Retourne la position la plus haute parmi les rôles d'un membre */
function getHighestRolePosition(member) {
  return Math.max(...member.roles.cache.map(r => r.position));
}

/** Vérifie si un membre a un rôle dans la whitelist */
function isWhitelisted(member) {
  const whitelisted = config.whitelistedRoleIds || [];
  return member.roles.cache.some(r => whitelisted.includes(r.id));
}

/** Récupère les données de mute pour un utilisateur dans un serveur */
function getMuteRecord(guildId, userId) {
  return muteData[guildId]?.[userId] ?? null;
}

/** Enregistre un mute */
function saveMuteRecord(guildId, userId, record) {
  if (!muteData[guildId]) muteData[guildId] = {};
  muteData[guildId][userId] = record;
  saveJSON(DATA_PATH, muteData);
}

/** Supprime un enregistrement de mute */
function deleteMuteRecord(guildId, userId) {
  if (muteData[guildId]) {
    delete muteData[guildId][userId];
    saveJSON(DATA_PATH, muteData);
  }
}

// ─── Événement : Voice State Update (mute/unmute vocal) ──────────────────────
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild  = newState.guild;
  const userId = newState.id;

  // Ignorer les actions du bot lui-même
  if (userId === client.user.id) return;

  const wasServerMuted = oldState.serverMute;
  const isServerMuted  = newState.serverMute;

  // ── Cas 1 : Quelqu'un vient d'être MUTE ─────────────────────────────────
  if (!wasServerMuted && isServerMuted) {
    // Lire les audit logs pour savoir qui a fait le mute
    await new Promise(r => setTimeout(r, 600)); // léger délai pour que l'audit log soit dispo
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
      const entry = logs.entries.find(e =>
        e.target?.id === userId &&
        e.changes?.some(c => c.key === 'mute' && c.new === true) &&
        Date.now() - e.createdTimestamp < 5000
      );

      if (!entry) return;

      const muterMember = await guild.members.fetch(entry.executor.id).catch(() => null);
      if (!muterMember) return;

      // Vérifier que la personne qui a muté est dans la whitelist
      if (!isWhitelisted(muterMember)) return;

      const position = getHighestRolePosition(muterMember);

      saveMuteRecord(guild.id, userId, {
        mutedBy:                  muterMember.id,
        muterHighestRolePosition: position,
        mutedAt:                  new Date().toISOString(),
      });

      console.log(`🔇 ${userId} muté par ${muterMember.user.tag} (position rôle: ${position})`);
    } catch (err) {
      console.error('Erreur lecture audit log (mute):', err);
    }
  }

  // ── Cas 2 : Quelqu'un vient d'être DÉMUTE ───────────────────────────────
  if (wasServerMuted && !isServerMuted) {
    const record = getMuteRecord(guild.id, userId);
    if (!record) return; // mute non géré par ce bot

    await new Promise(r => setTimeout(r, 600));
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
      const entry = logs.entries.find(e =>
        e.target?.id === userId &&
        e.changes?.some(c => c.key === 'mute' && c.new === false) &&
        Date.now() - e.createdTimestamp < 5000
      );

      if (!entry) return;

      const unmuterMember = await guild.members.fetch(entry.executor.id).catch(() => null);
      if (!unmuterMember) return;

      // Ignorer si c'est le bot lui-même
      if (unmuterMember.id === client.user.id) return;

      const unmuterPosition = getHighestRolePosition(unmuterMember);

      // Si le démuteur a un rôle INFÉRIEUR → remettre le mute
      if (unmuterPosition < record.muterHighestRolePosition) {
        console.log(`⚠️  ${unmuterMember.user.tag} (pos: ${unmuterPosition}) a tenté de démuter ${userId} (requis: ${record.muterHighestRolePosition}). Remute en cours...`);

        const mutedMember = await guild.members.fetch(userId).catch(() => null);
        if (!mutedMember) return;

        // Si le membre est toujours en vocal, on peut le re-mute
        if (mutedMember.voice?.channel) {
          await mutedMember.voice.setMute(true, 'Remute automatique : rang insuffisant').catch(err => {
            console.error('Impossible de remettre le mute:', err);
          });
          console.log(`🔇 ${userId} re-muté automatiquement.`);
        } else {
          // Pas en vocal : on garde l'enregistrement pour quand il reviendra
          console.log(`ℹ️  ${userId} n'est plus en vocal, mute conservé en base.`);
        }
      } else {
        // Rang suffisant → mute levé définitivement
        deleteMuteRecord(guild.id, userId);
        console.log(`✅ ${userId} démute définitivement par ${unmuterMember.user.tag} (pos: ${unmuterPosition})`);
      }
    } catch (err) {
      console.error('Erreur lecture audit log (unmute):', err);
    }
  }
});

// ─── Re-mute au retour en vocal ───────────────────────────────────────────────
// Si un membre muté rejoint un salon vocal, on s'assure qu'il reste muté.
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild  = newState.guild;
  const userId = newState.id;
  if (userId === client.user.id) return;

  const justJoinedChannel = !oldState.channelId && newState.channelId;
  if (!justJoinedChannel) return;

  const record = getMuteRecord(guild.id, userId);
  if (!record) return;

  // S'il n'est pas encore server-muted, le re-mute
  if (!newState.serverMute) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member?.voice?.channel) {
      await member.voice.setMute(true, 'Membre toujours muté (rejoint un salon)').catch(() => {});
      console.log(`🔇 ${userId} re-muté à son arrivée en salon.`);
    }
  }
});

// ─── Commandes slash (optionnel) ─────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // /muteinfo @membre
  if (interaction.commandName === 'muteinfo') {
    if (!isWhitelisted(interaction.member)) {
      return interaction.reply({ content: '❌ Vous n\'avez pas accès à cette commande.', ephemeral: true });
    }
    const target = interaction.options.getMember('membre');
    const record = getMuteRecord(interaction.guildId, target.id);
    if (!record) {
      return interaction.reply({ content: `ℹ️  <@${target.id}> n'a pas de mute géré par ce bot.`, ephemeral: true });
    }
    return interaction.reply({
      ephemeral: true,
      content:
        `🔇 **Mute de <@${target.id}>**\n` +
        `• Muté par : <@${record.mutedBy}>\n` +
        `• Position de rôle requise pour démuter : **${record.muterHighestRolePosition}**\n` +
        `• Date : ${new Date(record.mutedAt).toLocaleString('fr-FR')}`,
    });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
});

client.login(config.token);
