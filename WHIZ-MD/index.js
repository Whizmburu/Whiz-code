const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const fs = require('fs-extra'); // Using fs-extra for easier directory removal
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const express = require('express');

const config = require('./config/settings.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let sockInstance = null; // To hold the current Baileys socket instance
let currentSessionPhoneNumber = null; // To track the number for the active pairing attempt
let pairingCodePromise = null; // To handle async pairing code retrieval

const SESSIONS_DIR = path.join(__dirname, 'sessions_WHIZ-MD'); // Main directory for all sessions
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

async function cleanupSession(sessionPath) {
    console.log(chalk.yellow(`Cleaning up session: ${sessionPath}`));
    try {
        if (sockInstance) {
            await sockInstance.logout(); // Gracefully logout
            sockInstance.ws.close();
        }
    } catch (e) {
        console.error(chalk.red('Error during sock logout/close:'), e);
    }
    sockInstance = null;
    currentSessionPhoneNumber = null;
    pairingCodePromise = null;
    if (fs.existsSync(sessionPath)) {
        try {
            await fs.remove(sessionPath); // fs-extra's remove is like rm -rf
            console.log(chalk.yellow(`Session folder '${sessionPath}' deleted.`));
        } catch (rmError) {
            console.error(chalk.red('Error deleting session folder:'), rmError);
        }
    }
}

async function connectToWhatsApp(phoneNumber, res) {
    currentSessionPhoneNumber = phoneNumber;
    const sessionID = `session-${phoneNumber}`; // Unique session ID based on phone number
    const currentSessionPath = path.join(SESSIONS_DIR, sessionID);

    // Clean up any previous session for this specific number or any lingering global session
    await cleanupSession(currentSessionPath);
    // Also clean up the default session folder if it exists from previous versions
    const oldDefaultSessionPath = path.join(__dirname, config.session_folder_name);
    if (fs.existsSync(oldDefaultSessionPath) && oldDefaultSessionPath !== SESSIONS_DIR) { // ensure not deleting parent
      await fs.remove(oldDefaultSessionPath).catch(e => console.error("Error removing old default session:", e));
    }


    if (!fs.existsSync(currentSessionPath)) {
        fs.mkdirSync(currentSessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(currentSessionPath);

    sockInstance = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["WHIZ-MD-WEBPAIR", "Chrome", "1.0.0"],
        auth: state,
    });

    pairingCodePromise = new Promise(async (resolve, reject) => {
        if (!sockInstance.authState.creds.registered) {
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
            console.log(chalk.yellow(`Requesting pairing code for: ${formattedNumber}`));
            try {
                // Wait a bit for the socket to be ready before requesting pairing code
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay
                const code = await sockInstance.requestPairingCode(formattedNumber);
                console.log(chalk.green(`Pairing Code for ${formattedNumber}: ${code}`));
                resolve(code); // Resolve promise with the pairing code
            } catch (error) {
                console.error(chalk.red(`Failed to request pairing code for ${formattedNumber}:`), error);
                reject(new Error('Failed to request pairing code.'));
            }
        } else {
            // Already paired, perhaps an old session reconnected. This shouldn't happen with cleanup.
            console.log(chalk.yellow(`Socket for ${phoneNumber} is already registered.`));
            reject(new Error('Device already registered or session issue. Please try /reset-pairing.'));
        }
    });


    sockInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(chalk.green(`WhatsApp connection opened for ${currentSessionPhoneNumber}!`));
            // The pairing code was already sent via the /pair endpoint's promise.
            // Now we wait for the /session-info call from the client.
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.connectionClosed && statusCode !== DisconnectReason.connectionReplaced;

            console.log(
                chalk.red(`Connection closed for ${currentSessionPhoneNumber} due to:`),
                lastDisconnect?.error,
                chalk.yellow(', reconnecting:'),
                shouldReconnect
            );

            if (pairingCodePromise && !res.headersSent && statusCode !== DisconnectReason.loggedOut) {
                 // If connection closes before pairing code is obtained and response sent, reject the promise.
                try {
                    if(pairingCodePromise.reject) pairingCodePromise.reject(new Error(`Connection closed: ${lastDisconnect?.error?.message || 'Unknown reason'}`));
                } catch(e) { console.warn("Error rejecting pairing code promise on close:", e)}
            }

            if (shouldReconnect) {
                // For web pairing, we don't auto-reconnect here. A new /pair request will initiate.
                console.log(chalk.yellow(`Not auto-reconnecting for ${currentSessionPhoneNumber}. User needs to initiate a new pairing if needed.`));
                 await cleanupSession(currentSessionPath);
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log(chalk.red(`Logged out for ${currentSessionPhoneNumber}. Session will be cleaned up.`));
                await cleanupSession(currentSessionPath);
            } else {
                // For other "final" close reasons, also cleanup.
                await cleanupSession(currentSessionPath);
            }
        }
    });

    sockInstance.ev.on('creds.update', saveCreds);
    return sockInstance;
}

app.post('/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }

    console.log(chalk.blue(`Received pairing request for: ${phoneNumber}`));

    try {
        // If there's an existing session, clean it up first
        if (currentSessionPhoneNumber) {
            const oldSessionPath = path.join(SESSIONS_DIR, `session-${currentSessionPhoneNumber}`);
            console.log(chalk.yellow(`New pairing request received. Cleaning up previous session for ${currentSessionPhoneNumber}...`));
            await cleanupSession(oldSessionPath); // Pass the correct old session path
        } else if (sockInstance) { // Case where currentSessionPhoneNumber might be null but sockInstance exists
             console.log(chalk.yellow(`New pairing request received. Cleaning up lingering socket instance...`));
             await cleanupSession(null); // cleanupSession can handle null path for sockInstance only
        }


        // connectToWhatsApp will now store the promise for pairing code
        // It also handles creation of the new session path
        await connectToWhatsApp(phoneNumber, res);

        if (pairingCodePromise) {
            const code = await pairingCodePromise; // Wait for the pairing code
            if (!res.headersSent) {
                res.json({ pairingCode: code });
            }
        } else {
            if (!res.headersSent) {
                res.status(500).json({ error: 'Pairing code promise not initialized.' });
            }
        }
    } catch (error) {
        console.error(chalk.red(`Error in /pair for ${phoneNumber}:`), error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'Failed to initiate pairing.' });
        }
        // Cleanup the session for the number that failed, if it was set
        if(phoneNumber) {
            const sessionPath = path.join(SESSIONS_DIR, `session-${phoneNumber}`);
            await cleanupSession(sessionPath);
        } else if (currentSessionPhoneNumber) { // Fallback to current if phoneNumber was not set before error
            const sessionPath = path.join(SESSIONS_DIR, `session-${currentSessionPhoneNumber}`);
            await cleanupSession(sessionPath);
        }
    }
});

app.post('/session-info', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!sockInstance) {
         return res.status(400).json({ error: 'No active WhatsApp connection instance.' });
    }
    if (currentSessionPhoneNumber !== phoneNumber) {
        // This could happen if a new /pair request came in before /session-info for the old one
        console.warn(chalk.yellow(`Session info request for ${phoneNumber}, but current session is for ${currentSessionPhoneNumber}.`));
        return res.status(400).json({ error: 'Session mismatch. The server might be processing another pairing. Please try pairing again.' });
    }
     if (!sockInstance.user || !sockInstance.user.id) {
        return res.status(400).json({ error: 'WhatsApp connection not fully established yet (user info not available). Please ensure you have scanned the code and WhatsApp is connected on your phone.' });
    }


    console.log(chalk.blue(`Request to send session info for ${currentSessionPhoneNumber}`));

    try {
        const selfJid = jidNormalizedUser(sockInstance.user.id);
        const sessionID = `session-${currentSessionPhoneNumber}`; // Use the tracked phone number
        const credsPath = path.join(SESSIONS_DIR, sessionID, 'creds.json');

        let sessionIdContent = "Error reading session data";
        if (fs.existsSync(credsPath)) {
            sessionIdContent = await fs.readFile(credsPath, 'utf-8');
        } else {
            console.error(chalk.red(`creds.json not found at ${credsPath}`));
            return res.status(500).json({ error: 'Session file not found. Pairing might not have completed correctly on the device.' });
        }

        const sessionIdMessage = `WHIZMD_${sessionIdContent}`;

        const sentSessionMsg = await sockInstance.sendMessage(selfJid, { text: sessionIdMessage });
        console.log(chalk.green(`Session ID sent to ${selfJid}`));

        const successMessage = `✅ Pairing Successful with 𝐖𝐇𝐈𝐙-𝐌𝐃
╔══════════════════════╗
║ 🔗 Repo     : github.com/whizmburu/WHIZ-MD
║ 👑 Owner    : @WHIZ
║ 💡 Tip      : Use .menu to explore features
║ 💻 Status   : Connected
╚══════════════════════╝
_Keep the Session Id Safe to protect your Account_
📌 Support Group: https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM
📞 Hotline: +254754783683 [WhatsApp]`;

        if (sentSessionMsg && sentSessionMsg.key) {
            await sockInstance.sendMessage(selfJid, { text: successMessage }, { quoted: sentSessionMsg });
            console.log(chalk.green('Success message sent as a reply.'));
        } else {
            await sockInstance.sendMessage(selfJid, { text: successMessage });
            console.log(chalk.yellow('Success message sent (not as a reply).'));
        }

        res.json({ message: 'Session ID and success message sent to your WhatsApp.' });

        // Clean up after successful sending for this user, ready for next.
        // await cleanupSession(path.join(SESSIONS_DIR, sessionID)); // Commented out to keep session active for user

    } catch (error) {
        console.error(chalk.red('Error in /session-info:'), error);
        res.status(500).json({ error: 'Failed to send session information.' });
    }
});

app.post('/reset-pairing', async (req, res) => {
    const { phoneNumber } = req.body;
    if (phoneNumber && currentSessionPhoneNumber === phoneNumber) {
        const sessionPath = path.join(SESSIONS_DIR, `session-${phoneNumber}`);
        await cleanupSession(sessionPath);
        res.json({ message: `Pairing session for ${phoneNumber} reset.` });
    } else if (currentSessionPhoneNumber) {
        // Reset any active session if phone number doesn't match or not provided
        const sessionPath = path.join(SESSIONS_DIR, `session-${currentSessionPhoneNumber}`);
        await cleanupSession(sessionPath);
        res.json({ message: `Active pairing session for ${currentSessionPhoneNumber} reset.` });
    } else {
        res.json({ message: 'No active pairing session to reset.' });
    }
});


app.listen(PORT, () => {
  console.log(chalk.bgGreen.black(`WHIZ-MD Pairing Server listening on port ${PORT}`));
  console.log(chalk.blue(`Open http://localhost:${PORT} in your browser.`));
});

let shuttingDown = false;
const cleanupAndExit = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(chalk.yellow('\nGracefully shutting down server...'));
  if (sockInstance) {
    console.log(chalk.yellow('Closing WhatsApp connection...'));
    await sockInstance.logout().catch(e => console.error("Error on logout:", e));
  }
  // Clean up all session folders on server exit
  if (fs.existsSync(SESSIONS_DIR)) {
      console.log(chalk.yellow('Cleaning up all session data...'));
      await fs.remove(SESSIONS_DIR).catch(e => console.error("Error removing sessions directory:", e));
  }
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
