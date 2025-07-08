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
// The `isRetry` parameter is removed as its specific logic path was too similar to general cleanup.
async function cleanupSpecificSession(sessionPathToClean, associatedPhoneNumber) {
    const logPrefix = `[Cleanup for ${associatedPhoneNumber || 'unknown'}]`;
    console.log(chalk.yellow(`${logPrefix} Attempting cleanup. Session path: ${sessionPathToClean}`));

    // Only attempt to close sockInstance if it's associated with the provided phoneNumber
    if (sockInstance && currentSessionPhoneNumberForSocket === associatedPhoneNumber) {
        console.log(chalk.yellow(`${logPrefix} Closing and nullifying active sockInstance for ${associatedPhoneNumber}.`));
        try {
            await sockInstance.logout(); // logout will also close the ws
        } catch (e) {
            // Log error but continue, as we still want to clean files and reset globals.
            console.error(chalk.red(`${logPrefix} Error during sockInstance.logout():`), e);
        }
        // Check if ws is still open and try to close if necessary (logout should handle this)
        if (sockInstance && sockInstance.ws && sockInstance.ws.readyState !== sockInstance.ws.CLOSED) {
            try {
                sockInstance.ws.close();
                 console.log(chalk.yellow(`${logPrefix} WebSocket explicitly closed.`));
            } catch (wsCloseError) {
                console.error(chalk.red(`${logPrefix} Error during sockInstance.ws.close():`), wsCloseError);
            }
        }
        sockInstance = null;
        // pairingCodePromise is now managed more locally within connectToWhatsApp's scope for resolution/rejection.
        // Setting it to null here ensures that if a cleanup happens due to an external factor (like /reset-pairing),
        // any lingering global promise is cleared.
        pairingCodePromise = null;
        currentSessionPhoneNumberForSocket = null;
        console.log(chalk.yellow(`${logPrefix} Global sockInstance variables reset.`));
    } else if (sockInstance && currentSessionPhoneNumberForSocket !== associatedPhoneNumber) {
        console.log(chalk.yellow(`${logPrefix} Skipping sockInstance closure: current instance is for ${currentSessionPhoneNumberForSocket}, not ${associatedPhoneNumber}.`));
    } else if (!sockInstance) {
        console.log(chalk.yellow(`${logPrefix} No active sockInstance to close.`));
    }

    if (sessionPathToClean && fs.existsSync(sessionPathToClean)) {
        try {
            await fs.remove(sessionPathToClean);
            console.log(chalk.yellow(`${logPrefix} Session folder '${sessionPathToClean}' deleted.`));
        } catch (rmError) {
            console.error(chalk.red(`${logPrefix} Error deleting session folder '${sessionPathToClean}':`), rmError);
        }
    } else if (sessionPathToClean) {
        console.log(chalk.yellow(`${logPrefix} Session folder '${sessionPathToClean}' not found, skipping delete.`));
    }
}


async function connectToWhatsApp(phoneNumber, res) { // `res` is passed for early exit on header sent, not ideal but part of existing structure
    const phoneNumberForThisAttempt = phoneNumber;
    console.log(chalk.cyan(`[${new Date().toISOString()}] connectToWhatsApp: Starting for ${phoneNumberForThisAttempt}`));

    const sessionID = `session-${phoneNumberForThisAttempt}`;
    const currentAttemptSessionPath = path.join(SESSIONS_DIR, sessionID);

    // If a sockInstance for the *same* number is active, clean it up first.
    if (sockInstance && currentSessionPhoneNumberForSocket === phoneNumberForThisAttempt) {
        console.log(chalk.yellow(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Found existing sockInstance for the same number. Cleaning it up first.`));
        await cleanupSpecificSession(currentAttemptSessionPath, phoneNumberForThisAttempt);
    } else if (sockInstance && currentSessionPhoneNumberForSocket !== phoneNumberForThisAttempt) {
        console.log(chalk.yellow(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] An active sockInstance exists for a different number (${currentSessionPhoneNumberForSocket}). It will be replaced.`));
        // The old sockInstance for the *different* number will be effectively orphaned when `sockInstance` is reassigned.
        // We are primarily concerned with cleaning up session files and socket for the *current* number.
    }

    // Clean or create the session directory for the current attempt.
    if (fs.existsSync(currentAttemptSessionPath)) {
        console.log(chalk.yellow(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Removing existing session directory: ${currentAttemptSessionPath}`));
        await fs.remove(currentAttemptSessionPath);
    }
    fs.mkdirSync(currentAttemptSessionPath, { recursive: true });
    console.log(chalk.cyan(`[${new Date().toISOString()}] connectToWhatsApp: Session directory prepared for ${phoneNumberForThisAttempt}`));

    const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(currentAttemptSessionPath);
    console.log(chalk.cyan(`[${new Date().toISOString()}] connectToWhatsApp: Auth state loaded for ${phoneNumberForThisAttempt}`));

    const augmentedSaveCreds = async () => {
        await originalSaveCreds();
        try {
            const lastActiveFilePath = path.join(currentAttemptSessionPath, 'lastActive.json');
            let createdAt = state.creds.registrationTime ? new Date(state.creds.registrationTime).toISOString() : new Date().toISOString();

            // Attempt to read existing createdAt if file exists, to preserve original creation time
            if (fs.existsSync(lastActiveFilePath)) {
                try {
                    const existingData = await fs.readJson(lastActiveFilePath);
                    if (existingData.createdAt) {
                        createdAt = existingData.createdAt;
                    }
                } catch (readErr) {
                    // Ignore if reading fails, will use new/registrationTime
                }
            }

            const activityData = {
                lastActive: new Date().toISOString(),
                createdAt: createdAt // Store or preserve creation time
            };
            await fs.writeJson(lastActiveFilePath, activityData);
            // console.log(chalk.blueBright(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Updated lastActive.json in ${currentAttemptSessionPath}`));
        } catch (err) {
            console.error(chalk.red(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Error writing lastActive.json for path ${currentAttemptSessionPath}:`), err);
        }
    };

    const socketConfig = {
        logger: pino({ level: 'silent' }), // Default to silent, can be overridden for debugging
        printQRInTerminal: false, // Pairing code flow, so no QR needed in terminal
        browser: ["WHIZ-MD-WEBPAIR", "Chrome", "1.0.0"],
        auth: { ...state, saveCreds: augmentedSaveCreds },
        shouldIgnoreJid: jid => jid?.endsWith('@broadcast'),
        // Consider adding defaultQueryTimeoutMs if requests are timing out, e.g.
        // defaultQueryTimeoutMs: 60000, // 60 seconds
    };
    console.log(chalk.blueBright(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Socket config: `, JSON.stringify({
        browser: socketConfig.browser,
        shouldIgnoreJid: "function", // Omit actual function from log
        auth: "object", // Omit sensitive auth details
        logger: "object" // Omit logger object
    })));

    const newSockInstance = makeWASocket(socketConfig);
    console.log(chalk.cyan(`[${new Date().toISOString()}] connectToWhatsApp: Socket created for ${phoneNumberForThisAttempt}`));

    // Critical: Update global instance and associated number *immediately* after creation.
    sockInstance = newSockInstance;
    currentSessionPhoneNumberForSocket = phoneNumberForThisAttempt;

    // This promise is specific to this call of connectToWhatsApp.
    // The global `pairingCodePromise` will point to this new promise.
    const localPairingCodePromise = new Promise(async (resolve, reject) => {
        if (res.headersSent) {
            return reject(new Error("Headers already sent, cannot process pairing code."));
        }
        if (!newSockInstance.authState.creds.registered) {
            const formattedNumber = phoneNumberForThisAttempt.replace(/[^0-9]/g, '');
            console.log(chalk.cyan(`[${new Date().toISOString()}] connectToWhatsApp: Requesting pairing code for ${phoneNumberForThisAttempt} (formatted: ${formattedNumber})`));
            try {
                // Before requesting pairing code, ensure initial lastActive.json is written with createdAt
                await augmentedSaveCreds(); // This will save initial creds and our activity file

                const code = await newSockInstance.requestPairingCode(formattedNumber);
                console.log(chalk.green(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Pairing Code: ${code}`));
                console.log(chalk.cyan(`[${new Date().toISOString()}] connectToWhatsApp: Pairing code ${code} received for ${phoneNumberForThisAttempt}`));
                resolve(code);
            } catch (error) {
                console.error(chalk.red(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Failed to request pairing code:`), error);
                reject(new Error(`Failed to request pairing code for ${phoneNumberForThisAttempt}. ${error.message || ""}`));
            }
        } else {
            console.log(chalk.yellow(`[connectToWhatsApp for ${phoneNumberForThisAttempt}] Socket is already registered (unexpected).`));
            reject(new Error('Device already registered or session issue. Please try /reset-pairing.'));
        }
    });
    pairingCodePromise = localPairingCodePromise;

    newSockInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, receivedPendingNotifications } = update;
        const logIdentifier = `[Socket for ${phoneNumberForThisAttempt}]`;

        if (sockInstance !== newSockInstance) {
            // Event is for an old/orphaned socket
            return;
        }

        console.log(chalk.blueBright(`${logIdentifier} Connection Update:`, JSON.stringify(update)));


        if (connection === 'open') {
            console.log(chalk.green(`${logIdentifier} WhatsApp connection opened! Pending notifications: ${receivedPendingNotifications}`));
            await augmentedSaveCreds(); // Update activity
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error;
            const statusCode = reason?.output?.statusCode;
            let shouldReconnect = true; // Default to true

            console.log(
                chalk.red(`${logIdentifier} Connection closed. Reason: `), reason,
                chalk.yellow(', Status Code:'), statusCode
            );

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(chalk.redBright(`${logIdentifier} Device Logged Out, Do Not Reconnect. Cleaning up.`));
                shouldReconnect = false;
            } else if (statusCode === DisconnectReason.connectionClosed || statusCode === DisconnectReason.connectionLost || statusCode === DisconnectReason.timedOut) {
                console.log(chalk.yellow(`${logIdentifier} Connection closed/lost/timed out. Baileys will attempt to reconnect if not logged out.`));
                // Baileys handles these reconnections automatically if not a terminal state like loggedOut
            } else if (statusCode === DisconnectReason.restartRequired) {
                 console.log(chalk.redBright(`${logIdentifier} Restart Required. Cleaning up as Baileys might not recover this specific instance well for pairing.`));
                 shouldReconnect = false; // For pairing flow, a restart required might mean the current attempt is dead.
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log(chalk.yellow(`${logIdentifier} Connection Replaced. Another connection was made. Cleaning up this instance.`));
                shouldReconnect = false;
            } else {
                console.log(chalk.yellow(`${logIdentifier} Connection closed with unhandled status code ${statusCode}. Assuming Baileys will attempt reconnect or it's a terminal error.`));
                // If it's an error that Baileys won't auto-retry from, and not loggedOut, it might be a problem.
                // For pairing, most close events that aren't 'open' mean the pairing attempt for *this code* might be over.
            }

            // If the pairing promise for this attempt is still pending, reject it.
            if (currentSessionPhoneNumberForSocket === phoneNumberForThisAttempt) {
                if (pairingCodePromise === localPairingCodePromise && !res.headersSent) {
                    try {
                        console.log(chalk.yellow(`${logIdentifier} Connection closed, attempting to reject its pairing promise (if not already settled).`));
                        localPairingCodePromise.reject(new Error(`Connection closed: ${reason?.message || 'Unknown reason'}`));
                        console.log(chalk.yellow(`${logIdentifier} Pairing promise rejected due to connection close.`));
                        if (pairingCodePromise === localPairingCodePromise) { // Defensive nullification
                            pairingCodePromise = null;
                        }
                    } catch (e) {
                        console.warn(`${logIdentifier} Error rejecting pairing code promise on close (possibly already settled):`, e.message);
                    }
                }

                // If the connection closure is definitive (like loggedOut, restartRequired for this flow, or replaced), clean up.
                // For other transient errors, Baileys might be attempting reconnection.
                // However, for a pairing code flow, any 'close' before pairing success usually means that attempt is over.
                if (!shouldReconnect || (reason && reason.isBoom && reason.output.statusCode !== 428 && reason.output.statusCode !== DisconnectReason.timedOut) ) {
                     console.log(chalk.yellow(`${logIdentifier} Definitive connection close or unrecoverable error for pairing. Triggering cleanup for this session.`));
                    await cleanupSpecificSession(currentAttemptSessionPath, phoneNumberForThisAttempt);
                } else {
                    console.log(chalk.yellow(`${logIdentifier} Connection closed, but might be a temporary issue or Baileys is reconnecting. Cleanup might be handled by a new request or subsequent definitive closure.`));
                }
            } else {
                console.log(chalk.yellow(`${logIdentifier} Connection closed, but current global context is for ${currentSessionPhoneNumberForSocket}. This instance (${phoneNumberForThisAttempt}) is likely orphaned. Its cleanup might have been handled or will be handled by session manager.`));
            }
        }
    });

    // The 'creds.update' event will now trigger our augmentedSaveCreds
    newSockInstance.ev.on('creds.update', augmentedSaveCreds);
    return localPairingCodePromise;
}

app.post('/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }
    console.log(chalk.cyan(`[${new Date().toISOString()}] /pair: Request for ${phoneNumber} received`));

    // Logging existing socket state. Aggressive cleanup before connectToWhatsApp is removed.
    // connectToWhatsApp will handle cleanup if it finds an existing session for the *same* number.
    if (sockInstance && currentSessionPhoneNumberForSocket && currentSessionPhoneNumberForSocket !== phoneNumber) {
        console.log(chalk.yellow(`[${new Date().toISOString()}] /pair: An active sockInstance for a different number (${currentSessionPhoneNumberForSocket}) exists. A new instance for ${phoneNumber} will be created.`));
    } else if (sockInstance && currentSessionPhoneNumberForSocket === phoneNumber) {
        console.log(chalk.yellow(`[${new Date().toISOString()}] /pair: An active sockInstance for the same number (${phoneNumber}) exists. connectToWhatsApp will handle its cleanup and re-creation.`));
    }

    try {
        console.log(chalk.cyan(`[${new Date().toISOString()}] /pair: Calling connectToWhatsApp for ${phoneNumber}`));
        const code = await connectToWhatsApp(phoneNumber, res); // This now returns the pairing code promise
        console.log(chalk.cyan(`[${new Date().toISOString()}] /pair: connectToWhatsApp call returned for ${phoneNumber}`));

        if (!res.headersSent) {
            console.log(chalk.cyan(`[${new Date().toISOString()}] /pair: Sending pairing code ${code} to client for ${phoneNumber}`));
            res.json({ pairingCode: code });
        } else {
            console.log(chalk.yellow(`[${new Date().toISOString()}] /pair: Headers already sent for ${phoneNumber}, cannot send pairing code.`));
        }
        console.log(chalk.cyan(`[${new Date().toISOString()}] /pair: Request for ${phoneNumber} completed successfully.`));

    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] /pair: Error processing for ${phoneNumber}:`), error.message);
        if (!res.headersSent) {
            console.log(chalk.red(`[${new Date().toISOString()}] /pair: Sending error response to client for ${phoneNumber}.`));
            res.status(500).json({ error: error.message || 'Failed to initiate pairing.' });
        } else {
            console.log(chalk.yellow(`[${new Date().toISOString()}] /pair: Headers already sent for ${phoneNumber}, cannot send error response.`));
        }
        // Cleanup for the failed attempt.
        const sessionPathForFailedAttempt = path.join(SESSIONS_DIR, `session-${phoneNumber}`);
        console.log(chalk.red(`[${new Date().toISOString()}] /pair: Triggering cleanup for failed attempt with ${phoneNumber}.`));
        // cleanupSpecificSession will only kill the socket if currentSessionPhoneNumberForSocket matches phoneNumber.
        await cleanupSpecificSession(sessionPathForFailedAttempt, phoneNumber);
        console.log(chalk.cyan(`[${new Date().toISOString()}] /pair: Request for ${phoneNumber} failed and cleanup attempted.`));
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
    // Use currentSessionPhoneNumberForSocket for checking active session
    if (phoneNumber && currentSessionPhoneNumberForSocket === phoneNumber) {
        console.log(chalk.yellow(`[Reset] Request to reset specific pairing for: ${phoneNumber}`));
        const sessionPath = path.join(SESSIONS_DIR, `session-${phoneNumber}`);
        await cleanupSpecificSession(sessionPath, phoneNumber); // This will also handle the sockInstance
        res.json({ message: `Pairing session for ${phoneNumber} reset successfully.` });
    } else if (phoneNumber && currentSessionPhoneNumberForSocket !== phoneNumber) {
        // A specific number is requested for reset, but it's not the currently active one (if any)
        console.log(chalk.yellow(`[Reset] Request to reset session files for: ${phoneNumber} (not the active socket session).`));
        const sessionPath = path.join(SESSIONS_DIR, `session-${phoneNumber}`);
        await cleanupSpecificSession(sessionPath, phoneNumber); // Cleans files; won't kill current sockInstance if numbers differ
        res.json({ message: `Session files for ${phoneNumber} (if any) reset. Active session for ${currentSessionPhoneNumberForSocket || 'none'} was not affected.` });
    } else if (!phoneNumber && currentSessionPhoneNumberForSocket) {
        // No specific number, reset the currently active session
        console.log(chalk.yellow(`[Reset] Request to reset the current active pairing session for: ${currentSessionPhoneNumberForSocket}`));
        const sessionPath = path.join(SESSIONS_DIR, `session-${currentSessionPhoneNumberForSocket}`);
        await cleanupSpecificSession(sessionPath, currentSessionPhoneNumberForSocket);
        res.json({ message: `Active pairing session for ${currentSessionPhoneNumberForSocket} reset successfully.` });
    } else {
        console.log(chalk.yellow('[Reset] No active session to reset, or no specific number provided for inactive session cleanup.'));
        res.json({ message: 'No active pairing session to reset, or no specific number provided that matches an active session or existing files.' });
    }
});

// --- Session Cleanup Logic ---
// Read from config or use sensible defaults
const sessionMinRetentionDays = config.sessionMinRetentionDays || 14;
const sessionInactivityCleanupDays = config.sessionInactivityCleanupDays || 3;
const sessionCleanupCheckIntervalHours = config.sessionCleanupCheckIntervalHours || 6;

const MIN_RETENTION_MILLISECONDS = sessionMinRetentionDays * 24 * 60 * 60 * 1000;
const INACTIVITY_MILLISECONDS = sessionInactivityCleanupDays * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MILLISECONDS = sessionCleanupCheckIntervalHours * 60 * 60 * 1000;

// For quick testing, uncomment these lines to override config:
// const MIN_RETENTION_MILLISECONDS = 5 * 60 * 1000; // For testing: 5 minutes
// const INACTIVITY_MILLISECONDS = 1 * 60 * 1000; // For testing: 1 minute
// const CLEANUP_INTERVAL_MILLISECONDS = 2 * 60 * 1000; // For testing: 2 minutes


async function checkAndCleanupOldSessions() {
    console.log(chalk.magentaBright('[SessionManager] Running startup/periodic session cleanup...'));
    if (!fs.existsSync(SESSIONS_DIR)) {
        console.log(chalk.magentaBright('[SessionManager] Sessions directory does not exist. Nothing to clean.'));
        return;
    }

    const sessionFolders = await fs.readdir(SESSIONS_DIR);
    const now = new Date();

    for (const folderName of sessionFolders) {
        if (!folderName.startsWith('session-')) {
            continue; // Skip non-session folders like .DS_Store or other files
        }

        const sessionPath = path.join(SESSIONS_DIR, folderName);
        const lastActivePath = path.join(sessionPath, 'lastActive.json');
        const phoneNumber = folderName.substring('session-'.length); // Extract phone number

        // Safety check: do not delete the session of the currently active socket
        if (sockInstance && currentSessionPhoneNumberForSocket === phoneNumber) {
            console.log(chalk.magentaBright(`[SessionManager] Session for ${phoneNumber} is currently active. Skipping cleanup check for it.`));
            continue;
        }

        try {
            const stats = await fs.stat(sessionPath); // Get directory stats for a fallback creation time
            let createdAt, lastActive;

            if (fs.existsSync(lastActivePath)) {
                const activityData = await fs.readJson(lastActivePath);
                createdAt = new Date(activityData.createdAt || stats.birthtimeMs); // Prefer createdAt from json, fallback to dir birthtime
                lastActive = new Date(activityData.lastActive);
            } else {
                // If lastActive.json is missing, use directory modification time as last active and birthtime as created.
                // This session might be very old or partially formed.
                console.warn(chalk.yellow(`[SessionManager] lastActive.json missing for session ${folderName}. Using directory timestamps.`));
                createdAt = new Date(stats.birthtimeMs);
                lastActive = new Date(stats.mtimeMs);
            }

            const retentionEndTime = new Date(createdAt.getTime() + MIN_RETENTION_MILLISECONDS);
            const inactivityDeadline = new Date(lastActive.getTime() + INACTIVITY_MILLISECONDS);

            // console.log(chalk.gray(`[SessionManager] Checking ${folderName}: Created: ${createdAt.toISOString()}, LastActive: ${lastActive.toISOString()}, RetentionEnds: ${retentionEndTime.toISOString()}, InactivityDeadline: ${inactivityDeadline.toISOString()}`));

            if (now > retentionEndTime && now > inactivityDeadline) {
                console.log(chalk.magentaBright(`[SessionManager] Deleting stale session ${folderName}: Exceeded retention and inactivity period.`));
                // cleanupSpecificSession also handles potential socket instance, though we explicitly skip active ones above.
                await cleanupSpecificSession(sessionPath, phoneNumber);
            } else if (now <= retentionEndTime) {
                // console.log(chalk.gray(`[SessionManager] Session ${folderName} is within minimum retention period.`));
            } else if (now <= inactivityDeadline) {
                // console.log(chalk.gray(`[SessionManager] Session ${folderName} is within inactivity grace period.`));
            }

        } catch (err) {
            console.error(chalk.red(`[SessionManager] Error processing session ${folderName}:`), err);
            // Optionally, decide if a malformed session folder should be deleted
            // For now, just log and continue.
        }
    }
    console.log(chalk.magentaBright('[SessionManager] Session cleanup check complete.'));
}


// --- Server Initialization ---
async function initializeServer() {
    // Perform initial session cleanup on startup
    await checkAndCleanupOldSessions();

    // Setup periodic cleanup
    console.log(chalk.magentaBright(`[SessionManager] Scheduling periodic session cleanup every ${sessionCleanupCheckIntervalHours} hours (${CLEANUP_INTERVAL_MILLISECONDS} ms).`));
    setInterval(checkAndCleanupOldSessions, CLEANUP_INTERVAL_MILLISECONDS);

    app.listen(PORT, () => {
        console.log(chalk.bgGreen.black(`WHIZ-MD Pairing Server listening on port ${PORT}`));
        console.log(chalk.blue(`Open http://localhost:${PORT} in your browser.`));
    });
}

initializeServer().catch(err => {
    console.error(chalk.redBright("Failed to initialize server:"), err);
    process.exit(1);
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
