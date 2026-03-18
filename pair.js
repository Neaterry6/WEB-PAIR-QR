import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
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

        if (timeoutHandle) clearTimeout(timeoutHandle);

        if (currentSocket) {
            try {
                currentSocket.ev.removeAllListeners();
                await currentSocket.end();
            } catch {}
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

            currentSocket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
                },
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS('Chrome'),
                connectTimeoutMs: 60000
            });

            const sock = currentSocket;

            sock.ev.on('connection.update', async (update) => {
                if (isCleaningUp) return;

                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    if (sessionCompleted) return;
                    sessionCompleted = true;

                    try {
                        const credsFile = `${dirs}/creds.json`;

                        if (fs.existsSync(credsFile)) {
                            const megaLink = await megaUpload(
                                await fs.readFile(credsFile),
                                `${sessionId}.json`
                            );

                            const megaFileId = megaLink.replace('https://mega.nz/file/', '');
                            const botSessionId = `ilombot--${megaFileId}`;

                            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');

                            // 🔥 CLEAN MINIMAL MESSAGE WITH IMAGE
                            const caption = `
✅ *ILom Bot Connected*

🔑 ${botSessionId}

📢 Channel:
https://whatsapp.com/channel/0029VagJIAr3bbVBCpEkAM07

💻 GitHub:
https://github.com/GlobalTechInfo/WEB-PAIR-QR
`;

                            await sock.sendMessage(userJid, {
                                image: { url: "https://files.catbox.moe/ne3i3i.jpeg" },
                                caption: caption.trim()
                            });

                            // ⏳ ensure delivery
                            await delay(6000);
                        }

                    } catch (err) {
                        console.error('Error sending session:', err);
                    } finally {
                        await cleanup('session_complete');
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === DisconnectReason.loggedOut) {
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(401).send({ code: 'Session expired' });
                        }
                        await cleanup('logged_out');
                    } else {
                        reconnectAttempts++;
                        await delay(2000);
                        await initiateSession();
                    }
                }
            });

            if (!sock.authState.creds.registered && !pairingCodeSent) {
                await delay(1500);

                try {
                    pairingCodeSent = true;

                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;

                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.send({ code });
                    }

                } catch {
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(503).send({ code: 'Failed to get pairing code' });
                    }
                    await cleanup('pairing_error');
                }
            }

            sock.ev.on('creds.update', saveCreds);

            timeoutHandle = setTimeout(async () => {
                if (!sessionCompleted) {
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(408).send({ code: 'Timeout' });
                    }
                    await cleanup('timeout');
                }
            }, SESSION_TIMEOUT);

        } catch (err) {
            console.error(err);
            await cleanup('init_error');
        }
    }

    await initiateSession();
});

export default router;
