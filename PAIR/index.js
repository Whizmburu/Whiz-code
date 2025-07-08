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
let currentSessionPhoneNumberForSocket = null; // Tracks the phone number associated with the CURRENT sockInstance
let pairingCodePromise = null; // To handle async pairing code retrieval

const SESSIONS_DIR = path.join(__dirname, 'sessions_WHIZ-MD');
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// This function cleans up a specific session path and the global sockInstance IF it's tied to that session.
async function cleanupSpecificSession(sessionPathToClean, associatedPhoneNumber) {
    console.log(chalk.yellow(`Attempting cleanup for session path: ${sessionPathToClean} (associated with ${associatedPhoneNumber || 'unknown'})`));

    if (sockInstance && currentSessionPhoneNumberForSocket === associatedPhoneNumber) {
        console.log(chalk.yellow(`Closing and nullifying active sockInstance for ${associatedPhoneNumber}.`));
        try {
            await sockInstance.logout();
            sockInstance.ws.close();
        } catch (e) {
            console.error(chalk.red('Error during sock logout/close:'), e);
        }
        sockInstance = null;
        pairingCodePromise = null;
        currentSessionPhoneNumberForSocket = null;
    } else if (sockInstance && !associatedPhoneNumber && !sessionPathToClean) {
        // Generic cleanup of a lingering sockInstance if no specific session is targeted
        console.log(chalk.yellow(`Closing and nullifying lingering sockInstance (number unknown).`));
         try {
            await sockInstance.logout();
            sockInstance.ws.close();
        } catch (e) { /* Ignore */ }
        sockInstance = null;
        pairingCodePromise = null;
        currentSessionPhoneNumberForSocket = null;
    }

    if (sessionPathToClean && fs.existsSync(sessionPathToClean)) {
        try {
            await fs.remove(sessionPathToClean);
            console.log(chalk.yellow(`Session folder '${sessionPathToClean}' deleted.`));
        } catch (rmError) {
            console.error(chalk.red(`Error deleting session folder '${sessionPathToClean}':`), rmError);
        }
    }
}


async function connectToWhatsApp(phoneNumber, res) { // phoneNumber is the number for THIS specific attempt
    const sessionID = `session-${phoneNumber}`;
    const currentAttemptSessionPath = path.join(SESSIONS_DIR, sessionID);

    // Pre-cleanup for the current attempt's path, in case of retries for the exact same number
    if (fs.existsSync(currentAttemptSessionPath)) {
        console.log(chalk.yellow(`Pre-cleaning session path for current attempt: ${currentAttemptSessionPath}`));
        await fs.remove(currentAttemptSessionPath);
    }
    fs.mkdirSync(currentAttemptSessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(currentAttemptSessionPath);

    // Assign to global sockInstance and track its associated number
    sockInstance = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["WHIZ-MD-WEBPAIR", "Chrome", "1.0.0"],
        auth: state,
    });
    currentSessionPhoneNumberForSocket = phoneNumber; // Track which number this sockInstance is for

    pairingCodePromise = new Promise(async (resolve, reject) => {
        if (!sockInstance.authState.creds.registered) {
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
            console.log(chalk.yellow(`Requesting pairing code for: ${formattedNumber}`));
            try {
                const code = await sockInstance.requestPairingCode(formattedNumber);
                console.log(chalk.green(`Pairing Code for ${formattedNumber}: ${code}`));
                resolve(code);
            } catch (error) {
                console.error(chalk.red(`Failed to request pairing code for ${formattedNumber}:`), error);
                reject(new Error('Failed to request pairing code.'));
            }
        } else {
            console.log(chalk.yellow(`Socket for ${phoneNumber} is already registered (unexpected).`));
            reject(new Error('Device already registered or session issue. Please try /reset-pairing.'));
        }
    });

    sockInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const logIdentifier = `Socket for ${phoneNumber}`; // Use the number this socket was created for

        if (connection === 'open') {
            console.log(chalk.green(`WhatsApp connection opened for ${logIdentifier}!`));
        } else if (connection === 'close') {
            console.log(
                chalk.red(`Connection closed for ${logIdentifier} due to:`),
                lastDisconnect?.error,
                chalk.yellow(', Status Code:'), lastDisconnect?.error?.output?.statusCode
            );

            // If this specific socket's pairing promise is still pending and connection closed, reject it.
            if (pairingCodePromise && sockInstance && currentSessionPhoneNumberForSocket === phoneNumber && !res.headersSent) {
                try {
                    const pairingPromiseRef = pairingCodePromise; // Avoid race condition if it gets nulled
                    pairingCodePromise = null; // Nullify to prevent re-rejection
                    pairingPromiseRef.reject(new Error(`Connection closed: ${lastDisconnect?.error?.message || 'Unknown reason'}`));
                    console.log(chalk.yellow(`Pairing promise rejected for ${logIdentifier} due to connection close.`));
                } catch(e) { console.warn("Error rejecting pairing code promise on close:", e)}
            }

            // Clean up the session for THIS specific socket instance if it's the one that closed
            if (currentSessionPhoneNumberForSocket === phoneNumber) {
                 await cleanupSpecificSession(currentAttemptSessionPath, phoneNumber);
            }
        }
    });

    sockInstance.ev.on('creds.update', saveCreds);
    return sockInstance; // Though the global sockInstance is now set
}

app.post('/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }
    console.log(chalk.blue(`Received pairing request for: ${phoneNumber}`));

    // Force cleanup of any existing global sockInstance and its *tracked* session folder.
    // This ensures we are starting fresh for any new /pair request.
    if (sockInstance) {
        const pathToDelete = currentSessionPhoneNumberForSocket ? path.join(SESSIONS_DIR, `session-${currentSessionPhoneNumberForSocket}`) : null;
        console.log(chalk.yellow(`New pairing request. Cleaning up previous sockInstance (if any) for ${currentSessionPhoneNumberForSocket || 'unknown'}...`));
        await cleanupSpecificSession(pathToDelete, currentSessionPhoneNumberForSocket);
    }
    // At this point, global sockInstance, currentSessionPhoneNumberForSocket, and pairingCodePromise are null.

    try {
        await connectToWhatsApp(phoneNumber, res); // This will set the global sockInstance and currentSessionPhoneNumberForSocket

        if (pairingCodePromise) {
            const code = await pairingCodePromise;
            if (!res.headersSent) {
                res.json({ pairingCode: code });
            }
        } else {
            if (!res.headersSent) { // Should have been rejected by connectToWhatsApp if error occurred
                res.status(500).json({ error: 'Pairing code promise not resolved or initialized.' });
            }
        }
    } catch (error) { // Catch errors from connectToWhatsApp or pairingCodePromise rejection
        console.error(chalk.red(`Error in /pair processing for ${phoneNumber}:`), error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'Failed to initiate pairing.' });
        }
        // Ensure cleanup for the number that just failed, if a session path was being set up for it
        const sessionPathForFailedAttempt = path.join(SESSIONS_DIR, `session-${phoneNumber}`);
        await cleanupSpecificSession(sessionPathForFailedAttempt, phoneNumber);
    }
});

app.post('/session-info', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!sockInstance) {
         return res.status(400).json({ error: 'No active WhatsApp connection instance. Please try pairing again.' });
    }
    // Check against the number associated with the current sockInstance
    if (currentSessionPhoneNumberForSocket !== phoneNumber) {
        console.warn(chalk.yellow(`Session info request for ${phoneNumber}, but current active socket is for ${currentSessionPhoneNumberForSocket}.`));
        return res.status(400).json({ error: 'Session mismatch or old request. Please try pairing again.' });
    }
     if (!sockInstance.user || !sockInstance.user.id) {
        return res.status(400).json({ error: 'WhatsApp connection not fully established (user info not available). Ensure pairing was successful on your phone.' });
    }

    console.log(chalk.blue(`Request to send session info for ${currentSessionPhoneNumberForSocket}`));

    try {
        const selfJid = jidNormalizedUser(sockInstance.user.id);
        const sessionID = `session-${currentSessionPhoneNumberForSocket}`;
        const credsPath = path.join(SESSIONS_DIR, sessionID, 'creds.json');

        let sessionIdContent = "Error reading session data";
        if (fs.existsSync(credsPath)) {
            sessionIdContent = await fs.readFile(credsPath, 'utf-8');
        } else {
            console.error(chalk.red(`creds.json not found at ${credsPath} for ${currentSessionPhoneNumberForSocket}`));
            return res.status(500).json({ error: 'Session file not found. Pairing might not have completed correctly on the device, or was cleaned up.' });
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
