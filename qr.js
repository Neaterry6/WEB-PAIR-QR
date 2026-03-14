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

const MESSAGE = `
*SESSION GENERATED SUCCESSFULLY* ✅

*Give a ⭐ to our repo for support* 🌟
https://github.com/NexusCoders-cyber/Amazing-Bot-

*Join our WhatsApp Channel* 📢
https://whatsapp.com/channel/0029Vb7MzHT1SWt0T3G06p0M

*ILOM BOT • WhatsApp Bot*
`;

function randomMegaId(len = 6, numLen = 4) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return `${out}${Math.floor(Math.random() * Math.pow(10, numLen))}`;
}

function generateSessionId() {
    const hex = [...Array(32)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('');
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

    const sessionId = generateSessionId();
    const dirs = `./qr_sessions/session_${sessionId}`;

    if (!fs.existsSync('./qr_sessions'))
        await fs.mkdir('./qr_sessions', { recursive: true });

    let qrGenerated = false;
    let sessionCompleted = false;
    let responseSent = false;
    let reconnectAttempts = 0;
    let currentSocket = null;
    let timeoutHandle = null;
    let isCleaningUp = false;

    async function cleanup(reason = 'unknown') {

        if (isCleaningUp) return;
        isCleaningUp = true;

        console.log(`Cleaning session ${sessionId} - Reason: ${reason}`);

        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }

        if (currentSocket) {
            try {
                currentSocket.ev.removeAllListeners();
                await currentSocket.end();
            } catch (e) {}
            currentSocket = null;
        }

        setTimeout(async () => {
            await removeFile(dirs);
        }, 5000);
    }

    async function initiateSession() {

        if (sessionCompleted || isCleaningUp) return;

        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {

            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).send({ code: 'Connection failed after multiple attempts' });
            }

            await cleanup('max_reconnects');
            return;
        }

        if (!fs.existsSync(dirs))
            await fs.mkdir(dirs, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {

            const { version } = await fetchLatestBaileysVersion();

            if (currentSocket) {
                try {
                    currentSocket.ev.removeAllListeners();
                    await currentSocket.end();
                } catch {}
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

            const handleQRCode = async (qr) => {

                if (qrGenerated || responseSent || sessionCompleted || isCleaningUp) return;

                qrGenerated = true;

                try {

                    const qrDataURL = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' });

                    if (!responseSent && !res.headersSent) {

                        responseSent = true;

                        res.send({
                            qr: qrDataURL,
                            message: 'QR Code Generated! Scan with WhatsApp.',
                            instructions: [
                                '1. Open WhatsApp',
                                '2. Go to Linked Devices',
                                '3. Tap Link a Device',
                                '4. Scan this QR code'
                            ],
                            sessionId
                        });

                        console.log('QR Code sent to client');
                    }

                } catch (err) {

                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(500).send({ code: 'Failed to generate QR code' });
                    }

                    await cleanup('qr_error');
                }
            };

            sock.ev.on('connection.update', async (update) => {

                if (isCleaningUp) return;

                const { connection, lastDisconnect, qr } = update;

                if (qr && !qrGenerated && !sessionCompleted)
                    await handleQRCode(qr);

                if (connection === 'open' && !sessionCompleted) {

                    sessionCompleted = true;

                    try {

                        const credsFile = `${dirs}/creds.json`;

                        if (fs.existsSync(credsFile)) {

                            const id = randomMegaId();

                            const megaLink = await megaUpload(
                                await fs.readFile(credsFile),
                                `ILOM BOT/ILOM BOT_${id}.json`
                            );

                            const megaSessionId = megaLink.replace('https://mega.nz/file/', '');

                            const userJid = Object.keys(sock.authState.creds.me || {}).length > 0
                                ? jidNormalizedUser(sock.authState.creds.me.id)
                                : null;

                            if (userJid) {

                                const msg = await sock.sendMessage(userJid, { text: megaSessionId });

                                await sock.sendMessage(
                                    userJid,
                                    { text: MESSAGE },
                                    { quoted: msg }
                                );
                            }

                            await delay(1000);
                        }

                    } catch (err) {
                        console.error('Error sending session:', err);
                    }

                    finally {
                        await cleanup('session_complete');
                    }
                }

                if (connection === 'close') {

                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {

                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(401).send({ code: 'Invalid QR scan or session expired' });
                        }

                        await cleanup('logged_out');

                    } else if (qrGenerated && !sessionCompleted) {

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

                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(408).send({ code: 'QR generation timeout' });
                    }

                    await cleanup('timeout');
                }

            }, SESSION_TIMEOUT);

        } catch {

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
