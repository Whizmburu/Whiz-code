const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');

const config = require('./config/settings.js');

async function connectToWhatsApp() {
  const sessionDir = path.join(__dirname, config.session_folder_name);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // QR not needed
    browser: ["WHIZ-MD-PAIRCODE", "Chrome", "1.0.0"], // Override browser name
    auth: state,
  });

  // Request pairing code if not already paired
  if (!sock.authState.creds.registered) {
    const ownerNumber = config.owner.number[0];
    if (ownerNumber) {
      const formattedNumber = ownerNumber.replace(/[^0-9]/g, ''); // Ensure only digits
      console.log(chalk.yellow(`Requesting pairing code for: ${formattedNumber}`));
      try {
        const code = await sock.requestPairingCode(formattedNumber);
        console.log(chalk.green(`Your Pairing Code: ${code}`));
        console.log(chalk.yellow("Please enter this code in WhatsApp on the linked devices screen."));
      } catch (error) {
        console.error(chalk.red('Failed to request pairing code: '), error);
        console.log(chalk.yellow("Make sure your phone number is correctly set in config/settings.js and includes the country code without '+' or spaces."));
        process.exit(1); // Exit if pairing code request fails
      }
    } else {
      console.log(chalk.red('Pairing mode is enabled, but no owner phone number is set in config/settings.js for pairing.'));
      process.exit(1); // Exit if no owner number for pairing
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(chalk.green('WhatsApp connection opened!'));
      console.log(chalk.blue('Pairing successful. Attempting to send session ID.'));

      try {
        // Ensure `me` object and `id` are available
        if (sock.user && sock.user.id) {
          const selfJid = jidNormalizedUser(sock.user.id);

          // Construct Session ID
          // The session ID is essentially the content of creds.json
          const credsPath = path.join(sessionDir, 'creds.json');
          let sessionIdContent = "Error reading session data";
          if (fs.existsSync(credsPath)) {
            sessionIdContent = fs.readFileSync(credsPath, 'utf-8');
          }

          const sessionIdMessage = `WHIZMD_${sessionIdContent}`;

          // Send Session ID to self
          const sentSessionMsg = await sock.sendMessage(selfJid, { text: sessionIdMessage });
          console.log(chalk.green(`Session ID sent to ${selfJid}`));

          // Send success message as a reply
          const successMessage = `✅ Pairing Successful with 𝐖𝐇𝐈𝐙-𝐌𝐃
╔══════════════════════╗
║ 🔗 Repo     : github.com/whizmburu/WHIZ-MD
║ 👑 Owner    : @WHIZ
║ 💡 Tip      : Use .menu to explore features
║ 💻 Status   : Connected but pending deployment
╚══════════════════════╝
_Keep the Session Id Safe to protect your Account_
📌 Support Group: https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM
📞 Hotline: +254754783683 [WhatsApp]`;

          if (sentSessionMsg && sentSessionMsg.key) {
            await sock.sendMessage(selfJid, { text: successMessage }, { quoted: sentSessionMsg });
            console.log(chalk.green('Success message sent as a reply.'));
          } else {
            // Fallback if sending session ID didn't return a message key (should not happen with text messages)
            await sock.sendMessage(selfJid, { text: successMessage });
             console.log(chalk.yellow('Success message sent (not as a reply, as original session ID message key was not available).'));
          }
          console.log(chalk.blue('Setup complete. You can now close this process if the bot is deployed elsewhere or keep it running.'));

        } else {
          console.log(chalk.red('User ID not available from sock.user.id, cannot send session ID.'));
        }
      } catch (error) {
        console.error(chalk.red('Error sending session ID or success message:'), error);
      }

    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        chalk.red('Connection closed due to:'),
        lastDisconnect?.error,
        chalk.yellow(', reconnecting:'),
        shouldReconnect
      );
      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log(chalk.red('Logged out. If you want to pair again, delete the session folder and restart.'));
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(chalk.yellow(`Session folder '${config.session_folder_name}' deleted.`));
        } catch (rmError) {
            console.error(chalk.red('Error deleting session folder:'), rmError);
        }
        process.exit(0);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // No general message handling needed for pairing-only mode
  // sock.ev.on('messages.upsert', ...) is removed
}


connectToWhatsApp().catch(err => console.error(chalk.red('Unhandled error in connectToWhatsApp:'), err));

let shuttingDown = false;
const cleanupAndExit = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(chalk.yellow('\nGracefully shutting down...'));
  // No MongoDB connection to close
  console.log(chalk.blue('Exiting process.'));
  process.exit(0);
};

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
process.on('uncaughtException', (err) => {
  console.error(chalk.red('Uncaught Exception:'), err);
  cleanupAndExit();
});
process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('Unhandled Rejection at:'), promise, chalk.red('reason:'), reason);
  cleanupAndExit();
});
