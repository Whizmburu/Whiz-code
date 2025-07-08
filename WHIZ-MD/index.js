/*
 * Information
 * Creator / Developer: WHIZ - FullStack Engineer
 * Contact creator / Developer: +254754783683 (WhatsApp), jaysimburun@gmail.com (Email)
*/

/* Thanks to
 * WHIZ - FullStack Engineer (Creator / Developer)
 * daniapi.biz.id (API provider)
 * api.caliph.biz.id (API provider)
 * @danitech/scraper (Scraper provider)
 * @whiskeysockets/baileys (Library "Baileys" provider)
 * @adiwajshing/keyed-db
 * @hapi/boom
 * pino
 * qrcode-terminal
 * chalk
 * mongoose
 * node-cron
 * nodemon
 * other
*/

const {
  makeWASocket,
  useMultiFileAuthState,
  // makeInMemoryStore, // commented out to avoid TypeError
  PHONENUMBER_MCC,
  makeCacheableSignalKeyStore,
  jidDecode,
  downloadContentFromMessage,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const {
  Boom
} = require('@hapi/boom');
const pino = require('pino');
const readLine = require('readline');
const qrCodeTerminal = require('qrcode-terminal');
const chalk = require('chalk');
const fs = require('fs');
const mongoose = require('mongoose');
const cron = require('node-cron');
const FileType = require('file-type');

const config = require('./config/settings.js');
const db = require('./models/connectionModel.js');
const userSchema = require('./models/schemaModel.js');

const {
  smsg,
  fetchJson,
  fetchBuffer,
  writeExifImage,
  writeExifVideo,
  imageToWebp,
  videoToWebp
} = require('./utils/functionsUtils.js');

// let store = makeInMemoryStore({ // REMOVED due to TypeError
//   logger: pino().child({ level: 'silent', stream: 'store' })
// });
let store = undefined; // console.warn("makeInMemoryStore call has been bypassed as it was causing a TypeError. Store-dependent features might be affected.");

async function startServer() {
  try {

    // Apa? mau marah?
    // Script no encrypt dijual,
    // harga? langsung tanya ke:
    // +254754783683 (WhatsApp only)
    // atau jaysimburun@gmail.com (Email)

    // MakeWASocket (Pairing Code)
    function _0x353be0(_0x120494,_0x3713de,_0x123a10,_0x15ebba,_0x450305){return _0x512a(_0x120494- -0x23b,_0x3713de);}
    (function(_0x3b5fbd,_0x553751){
      ...
    }(_0x19f7,-0x46cef+-0x72407+0x120885));

    const _0x24b688=(function(){
      const _0x13d204={};
      ...
      return function(_0x2541ee,_0x5543ad){
        ...
      };
    })();

  } else if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.timedOut) {

          console.log('Perlu me-restart, Merestart...');
          startServer();
        } else if (reason === DisconnectReason.Multidevicemismatch) {
          console.log('Pencocokan perangkat ganda, silakan lakukan pemindaian kembali.');
          sock.logout();
        } else {
          sock.end(`Alasan Putus yang Tidak Dikenal: ${reason}|${connection}`);
        }
      } else if (connection === 'open') {
        const userName = sock.user.name ? sock.user.name : config.bot.name;

        console.log(chalk.bold(chalk.cyan.blue('• User Info')));
        console.log(chalk.cyan(`- Name     : ${userName}`));
        console.log(chalk.cyan(`- Number   : ${sock.user.id.split(':')[0]}`));
        console.log(chalk.cyan(`- Status   : Connected`));

        db.once('connected', () => {
          console.log(chalk.greenBright('Connected to MongoDB'));
        });

        cron.schedule(config.cron_jobs.time, async () => {
          try {
            await userSchema.updateMany({
              accountType: 'Free'
            }, {
              dailyLimit: config.daily_limit.free
            });
            console.log('Limit harian telah direset untuk pengguna tipe "Free".');
          } catch (error) {
            console.error('Gagal mereset limit harian:', error.message);
          }
        }, {
          timezone: config.cron_jobs.timezone
        });

        try {
          const currentDate = new Date();

          const users = await userSchema.find({
            expirationDate: {
              $lte: currentDate
            },
            accountType: 'Premium'
          });

          for (const user of users) {
            try {
              await userSchema.findByIdAndUpdate(user._id, {
                accountType: 'Free',
                dailyLimit: config.daily_limit.free,
                expirationDate: null
              });

              console.log(`User ${user.username} has been reset to Free with a usage limit of ${config.daily_limit.free}.`);
            } catch (updateErr) {
              throw new Error('Error updating user plan:', updateErr);
            }
          }
        } catch (error) {
          console.error('An error occurred:', error.message);
        }
      }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const mek = chatUpdate.messages[0];
        if (!mek.message) return;
        mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;
        if (mek.key && mek.key.remoteJid === 'status@broadcast') return;
        if (!sock.public && !mek.key.fromMe && chatUpdate.type === 'notify') return;
        if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;
        const messages = smsg(sock, mek, store);
        const client = sock;
        require('./includes/client.js')({
          client,
          messages
        });
      } catch (error) {
        console.error(error.message);
      }
    });

    sock.ev.on('contacts.update', (update) => {
      for (let contact of update) {
        let id = sock.decodeJid(contact.id);

        if (store && store.contacts) store.contacts[id] = {
          id,
          name: contact.notify
        }
      }
    });

    sock.decodeJid = (jid) => {
      if (!jid) return jid;
      if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {};
        return decode.user && decode.server && decode.user + '@' + decode.server || jid;
      } else return jid;
    };

    sock.public = config.public_mode;

    sock.serializeM = (m) => smsg(sock, m, store);

    sock.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
      let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?base64,/i.test(path) ? Buffer.from(path.split`,` [1], 'base64') : /^https?:\/\//.test(path) ? await (await fetchBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
      let buffer;

      if (options && (options.packname || options.author)) {
        buffer = await writeExifImage(buff, options);
      } else {
        buffer = await imageToWebp(buff);
      };

      await sock.sendMessage(jid, {
        sticker: {
          url: buffer
        },
        ...options
      }, {
        quoted
      });
      return buffer;
    };

    sock.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
      let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?base64,/i.test(path) ? Buffer.from(path.split`,` [1], 'base64') : /^https?:\/\//.test(path) ? await (await fetchBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
      let buffer;

      if (options && (options.packname || options.author)) {
        buffer = await writeExifVideo(buff, options);
      } else {
        buffer = await videoToWebp(buff);
      };

      await sock.sendMessage(jid, {
        sticker: {
          url: buffer
        },
        ...options
      }, {
        quoted
      });

      return buffer;
    };

    sock.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
      let quoted = message.msg ? message.msg : message;
      let mime = (message.msg || message).mimetype || '';
      let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
      const stream = await downloadContentFromMessage(quoted, messageType);
      let buffer = Buffer.from([]);

      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      };

      let type = await FileType.fromBuffer(buffer);
      trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;

      await fs.writeFileSync(trueFileName, buffer);
      return trueFileName;
    };

    sock.downloadMediaMessage = async (message) => {
      let mime = (message.msg || message).mimetype || '';
      let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
      const stream = await downloadContentFromMessage(message, messageType);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      };

      return buffer;
    };

    sock.sendTextMessage = (jid, text, quoted) => {
      return sock.sendMessage(jid, {
        text: text,
      }, {
        quoted: quoted
      })
    };

    sock.sendImageMessage = (jid, title, description, sourceUrl, thumbnailUrl, caption, renderLargerThumbnail, showAdAttribution, quoted) => {
      return sock.sendMessage(jid, {
        text: caption,
        contextInfo: {
          externalAdReply: {
            title: title,
            body: description,
            sourceUrl: sourceUrl,
            thumbnailUrl: thumbnailUrl,
            mediaType: 1,
            renderLargerThumbnail: renderLargerThumbnail,
            showAdAttribution: showAdAttribution
          }
        }
      }, {
        quoted: quoted
      })
    };

    return sock;
  } catch (error) {
    console.error(error);
  }
};

startServer();
