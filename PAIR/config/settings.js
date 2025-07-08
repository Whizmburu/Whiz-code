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
  },

  // Session Lifecycle Management (values in days)
  // How long to keep sessions at a minimum, regardless of activity.
  sessionMinRetentionDays: 14,
  // After the minimum retention period, how many days of inactivity before a session is cleaned up.
  sessionInactivityCleanupDays: 3,
  // Interval for periodic cleanup check in hours (e.g., 6 means every 6 hours)
  // For testing, you might temporarily set this to a much smaller value in index.js (e.g., for minutes)
  sessionCleanupCheckIntervalHours: 6

  // Other settings from the original file have been removed as they are not
  // directly used by the current pairing-focused web application in index.js.
  // If you re-introduce features like message handling, MongoDB, cron jobs, etc.,
  // you may need to add their respective configurations back.
};