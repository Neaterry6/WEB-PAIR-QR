import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import archiver from 'archiver';
import { Readable } from 'stream';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, Browsers, jidNormalizedUser,
    fetchLatestBaileysVersion, DisconnectReason
} from '@whiskeysockets/baileys';
import { upload as megaUpload } from './mega.js';

const router = express.Router();
const MAX_RECONNECT_ATTEMPTS = 3;
const SESSION_TIMEOUT = 5 * 60 * 1000;
const CLEANUP_DELAY = 5000;

// 🔥 Session ID format
function generateSessionId() {
    const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    return `ilombot--${hex}`;
}

async function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        await fs.remove(FilePath);
        return true;
    } catch (e) {
        console.error('Error removing file:', e);
        return false;
    }
}

// ✅ Zip entire auth directory (creds.json + keys/) into a Buffer
async function zipAuthDir(dirPath) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('data', chunk => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', err => reject(err));

        // Add the entire auth directory contents into the zip
        archive.directory(dirPath, false);
        archive.finalize();
    });
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).send({ code: 'Phone number is required' });

    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) return res.status(400).send({ code: 'Invalid phone number.' });
    num = phone.getNumber('e164').replace('+', '');

    const sessionId = generateSessionId();
    const dirs = `./auth_info_baileys/session_${sessionId}`;

    let pairingCodeSent = false, sessionCompleted = false, isCleaningUp = false;
    let responseSent = false, reconnectAttempts = 0, currentSocket = null, timeoutHandle = null;

    async function cleanup(reason = 'unknown') {
        if (isCleaningUp) return;
        isCleaningUp = true;

        console.log(`🧹 Cleanup ${sessionId} (${num}) - ${reason}`);

        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }

        if (currentSocket) {
            try {
                currentSocket.ev.removeAllListeners();
                await currentSocket.end();
            } catch {}
            currentSocket = null;
        }

        setTimeout(async () => {
            await removeFile(dirs);
        }, CLEANUP_DELAY);
    }

    async function initiateSession() {
        if (sessionCompleted || isCleaningUp) return;

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).send({ code: 'Connection failed' });
            }
            await cleanup('max_reconnects');
            return;
        }

        try {
            if (!fs.existsSync(dirs)) await fs.mkdir(dirs, { recursive: true });

            const { state, saveCreds } = await useMultiFileAuthState(dirs);
            const { version } = await fetchLatestBaileysVersion();

            if (currentSocket) {
                try {
                    currentSocket.ev.removeAllListeners();
                    await currentSocket.end();
                } catch {}
                currentSocket = null;
            }

            currentSocket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" })
                    )
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 3,
            });

            const sock = currentSocket;

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    if (sessionCompleted) return;
                    sessionCompleted = true;

                    console.log(`✅ Connected for ${num} — saving keys then uploading session`);

                    try {
                        // ✅ Wait a moment so Baileys can flush all signal keys to disk
                        // Without this, the keys/ folder may be incomplete/empty
                        await delay(3000);

                        const credsFile = `${dirs}/creds.json`;
                        if (!fs.existsSync(credsFile)) {
                            console.error('creds.json not found after connection');
                            return;
                        }

                        // ✅ Zip entire auth dir: creds.json + keys/*.json
                        // This is CRITICAL — creds.json alone cannot decrypt WA messages.
                        // The signal pre-keys in keys/ are required for message decryption.
                        console.log(`📦 Zipping auth directory: ${dirs}`);
                        const zipBuffer = await zipAuthDir(dirs);
                        console.log(`📦 Zip size: ${zipBuffer.length} bytes`);

                        // Upload the zip to Mega — returns full URL with #decryption key
                        const megaLink = await megaUpload(zipBuffer, `${sessionId}.zip`);
                        console.log(`📦 Mega link: ${megaLink}`);

                        // ✅ Encode the FULL Mega URL as base64 (preserves the #key fragment)
                        const encodedUrl = Buffer.from(megaLink).toString('base64');
                        const botSessionId = `ilombot--${encodedUrl}`;

                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');

                        console.log(`📤 Sending session to ${num}...`);

                        // Send session ID as plain text so user can copy it easily
                        const sessionMsg = await sock.sendMessage(userJid, {
                            text: botSessionId
                        });

                        await delay(2000);

                        // Send notification image with instructions
                        const caption =
                            `✅ *ILom Bot Session Generated*\n\n` +
                            `🔑 *Your Session ID is above — copy and paste it into your bot's SESSION_ID env variable.*\n\n` +
                            `📢 *Channel:*\nhttps://whatsapp.com/channel/0029VagJIAr3bbVBCpEkAM07\n\n` +
                            `💻 *GitHub:*\nhttps://github.com/GlobalTechInfo/WEB-PAIR-QR`;

                        await sock.sendMessage(userJid, {
                            image: { url: "https://files.catbox.moe/ne3i3i.jpeg" },
                            caption: caption
                        }, { quoted: sessionMsg });

                        console.log(`✅ Session sent to ${num} successfully`);

                        // Wait for both messages to fully deliver before socket closes
                        await delay(7000);

                    } catch (err) {
                        console.error('❌ Error sending session message:', err);
                    } finally {
                        await cleanup('session_complete');
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`🔌 Connection closed for ${num} — code: ${statusCode}`);

                    if (sessionCompleted || isCleaningUp) {
                        await cleanup('already_complete');
                        return;
                    }

                    if (
                        statusCode === DisconnectReason.loggedOut ||
                        statusCode === 401 ||
                        statusCode === DisconnectReason.badSession
                    ) {
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(401).send({ code: 'Session expired or invalid' });
                        }
                        await cleanup('logged_out');
                        return;
                    }

                    if (pairingCodeSent && !sessionCompleted) {
                        reconnectAttempts++;
                        console.log(`🔄 Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                        await delay(2000);
                        await initiateSession();
                    } else {
                        await cleanup('connection_closed');
                    }
                }
            });

            if (!sock.authState.creds.registered && !pairingCodeSent && !isCleaningUp) {
                await delay(1500);

                try {
                    pairingCodeSent = true;
                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;

                    console.log(`🔑 Pairing code for ${num}: ${code}`);

                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.send({ code });
                    }

                } catch (err) {
                    console.error('❌ Failed to get pairing code:', err);
                    pairingCodeSent = false;

                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(503).send({ code: 'Failed to get pairing code' });
                    }
                    await cleanup('pairing_error');
                }
            }

            sock.ev.on('creds.update', saveCreds);

            timeoutHandle = setTimeout(async () => {
                if (!sessionCompleted && !isCleaningUp) {
                    console.log(`⏰ Session timeout for ${num}`);
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(408).send({ code: 'Pairing timeout — please try again' });
                    }
                    await cleanup('timeout');
                }
            }, SESSION_TIMEOUT);

        } catch (err) {
            console.error(`❌ Error initializing session for ${num}:`, err);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).send({ code: 'Service Unavailable' });
            }
            await cleanup('init_error');
        }
    }

    await initiateSession();
});

export default router;