import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import QRCode from 'qrcode';
import {
    makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore,
    Browsers, jidNormalizedUser, fetchLatestBaileysVersion, delay, DisconnectReason
} from '@whiskeysockets/baileys';
import { upload as megaUpload } from './mega.js';

const router = express.Router();
const MAX_RECONNECT_ATTEMPTS = 3;
const SESSION_TIMEOUT = 60000;

// Custom message template
function formatMessage(sessionId, number) {
    return `*SESSION GENERATED SUCCESSFULLY* ✅

Session ID: ${sessionId}
Linked to number: ${number}

*Give a ⭐ to the repo for courage* 🌟
https://github.com/Neaterry6/X5-MD

*Support Group for Queries* 💭
https://t.me/Broken_vzn
https://chat.whatsapp.com/FEcIqQ8blnR7sr1oZ3Nqh6

*YouTube Tutorials* 🪄
https://youtube.com/@brokenvzn-s7s

*X5-MD • WhatsApp Bot* 🥀`;
}

// Random session hash
function randomSessionHash(len = 32) {
    const chars = 'abcdef0123456789';
    let hash = '';
    for (let i = 0; i < len; i++) hash += chars.charAt(Math.floor(Math.random() * chars.length));
    return hash;
}

// Remove folder/file safely
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

// Pair code endpoint
router.get('/', async (req, res) => {
    const number = req.query.number?.replace(/\D/g, '');
    if (!number) return res.status(400).send({ code: 'Please provide a valid phone number!' });

    const sessionId = `BrokenVzn/X5-MD_${randomSessionHash(16)}`;
    const dirs = `./pair_sessions/session_${Date.now().toString()}_${Math.random().toString(36).substring(2, 9)}`;
    if (!fs.existsSync('./pair_sessions')) await fs.mkdir('./pair_sessions', { recursive: true });

    let sessionCompleted = false;
    let reconnectAttempts = 0;
    let currentSocket = null;
    let timeoutHandle = null;
    let isCleaningUp = false;

    async function cleanup(reason = 'unknown') {
        if (isCleaningUp) return;
        isCleaningUp = true;
        console.log(`🧹 Cleaning up pair session - Reason: ${reason}`);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (currentSocket) {
            try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch {}
            currentSocket = null;
        }
        setTimeout(async () => { await removeFile(dirs); }, 5000);
    }

    async function initiateSession() {
        if (sessionCompleted || isCleaningUp) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            return res.status(503).send({ code: 'Connection failed after multiple attempts' });
        }

        if (!fs.existsSync(dirs)) await fs.mkdir(dirs, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();
            if (currentSocket) {
                try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch {}
            }

            currentSocket = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                browser: Browsers.macOS('Chrome'),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
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
                if (isCleaningUp) return;
                const { connection, lastDisconnect, isNewLogin } = update;

                if (connection === 'open' && !sessionCompleted) {
                    sessionCompleted = true;
                    try {
                        const credsFile = `${dirs}/creds.json`;
                        if (fs.existsSync(credsFile)) {
                            console.log('📄 Uploading creds.json to MEGA...');
                            const megaLink = await megaUpload(await fs.readFile(credsFile), `${sessionId}.json`);
                            const megaSessionId = megaLink.replace('https://mega.nz/file/', '');
                            console.log('✅ Session uploaded to MEGA, ID:', megaSessionId);

                            const userJid = Object.keys(sock.authState.creds.me || {}).length > 0
                                ? jidNormalizedUser(sock.authState.creds.me.id)
                                : null;

                            if (userJid) {
                                const msg = await sock.sendMessage(userJid, { text: megaSessionId });
                                await sock.sendMessage(userJid, { text: formatMessage(sessionId, number), quoted: msg });
                            }
                            await delay(1000);
                        }
                    } catch (err) {
                        console.error('Error sending session:', err);
                    } finally {
                        await cleanup('session_complete');
                    }
                }

                if (isNewLogin) console.log('🔐 New login via QR code');

                if (connection === 'close') {
                    if (sessionCompleted || isCleaningUp) { await cleanup('already_complete'); return; }
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        res.status(401).send({ code: 'Invalid scan or session expired' });
                        await cleanup('logged_out');
                    } else if (!sessionCompleted) {
                        reconnectAttempts++;
                        await delay(2000);
                        await initiateSession();
                    } else {
                        await cleanup('connection_closed');
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            timeoutHandle = setTimeout(async () => {
                if (!sessionCompleted && !isCleaningUp) {
                    res.status(408).send({ code: 'Session timeout' });
                    await cleanup('timeout');
                }
            }, SESSION_TIMEOUT);

        } catch (err) {
            res.status(503).send({ code: 'Service Unavailable' });
            await cleanup('init_error');
        }
    }

    await initiateSession();
});

export default router;