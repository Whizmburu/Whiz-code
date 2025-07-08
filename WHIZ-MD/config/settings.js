/*
 * Information
 * Creator / Developer: Dani Ramdani (Dani Techno.) - FullStack Engineer
 * Contact creator / Developer: 0895 1254 5999 (WhatsApp), contact@danitechno.com (Email)
*/

/*
WHIZ-MD Configuration File
*/

module.exports = {
  // Core Settings for Pairing App
  pairing_mode: true, // Should be true for this application's purpose
  session_folder_name: 'sessions_WHIZ-MD', // Base directory for storing session files (index.js will create subfolders)

  // Owner details (first number might be used for initial console-based pairing if implemented, but web UI flow takes precedence)
  owner: {
    name: ["@WHIZ"], // Owner's name/alias
    number: ["254754783683"] // Owner's WhatsApp number for notifications or direct interactions (currently not used by the web pairing flow in index.js for pairing requests)
  },

  // Bot display name (can be used for general identification if needed elsewhere)
  bot: {
    name: '𝐖𝐇𝐈𝐙-𝐌𝐃'
  }

  // Other settings from the original file have been removed as they are not
  // directly used by the current pairing-focused web application in index.js.
  // If you re-introduce features like message handling, MongoDB, cron jobs, etc.,
  // you may need to add their respective configurations back.
};