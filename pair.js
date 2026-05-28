import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    DisconnectReason
} from '@whiskeysockets/baileys';
import { getBaileysVersion, sessionDirectory } from './baileys-utils.js';

const router = express.Router();
const MAX_RECONNECT_ATTEMPTS = 3;
const SESSION_TIMEOUT = 5 * 60 * 1000;
const CLEANUP_DELAY = 5000;

async function removeFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        await fs.remove(filePath);
        return true;
    } catch (error) {
        console.error('Error removing file:', error);
        return false;
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).send({ ok: false, code: 'Phone number is required' });

    num = String(num).replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) return res.status(400).send({ ok: false, code: 'Invalid phone number.' });
    num = phone.getNumber('e164').replace('+', '');

    const dirs = sessionDirectory('auth_info_baileys', `session_${num}`);

    let pairingCodeSent = false;
    let sessionCompleted = false;
    let isCleaningUp = false;
    let responseSent = false;
    let reconnectAttempts = 0;
    let currentSocket = null;
    let timeoutHandle = null;

    async function cleanup(reason = 'unknown') {
        if (isCleaningUp) return;
        isCleaningUp = true;

        console.log(`🧹 Cleanup (${num}) - ${reason}`);

        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }

        if (currentSocket) {
            try {
                currentSocket.ev.removeAllListeners();
                await currentSocket.end(new Error(`session_cleanup_${reason}`));
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
                res.status(503).send({ ok: false, code: 'Connection failed' });
            }
            await cleanup('max_reconnects');
            return;
        }

        try {
            if (!fs.existsSync(dirs)) await fs.mkdir(dirs, { recursive: true });

            const { state, saveCreds } = await useMultiFileAuthState(dirs);
            const version = await getBaileysVersion();

            if (currentSocket) {
                try {
                    currentSocket.ev.removeAllListeners();
                    await currentSocket.end(new Error('refresh_socket'));
                } catch {}
                currentSocket = null;
            }

            currentSocket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: 'fatal' }).child({ level: 'fatal' })
                    )
                },
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: Browsers.macOS('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 3
            });

            const sock = currentSocket;

            sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                if (connection === 'open') {
                    if (sessionCompleted) return;
                    sessionCompleted = true;

                    console.log(`✅ Connected for ${num} — saving keys then sending creds.json`);

                    try {
                        await delay(3000);
                        await saveCreds();

                        const credsFile = `${dirs}/creds.json`;
                        if (!fs.existsSync(credsFile)) {
                            throw new Error('creds.json not found after connection');
                        }

                        const credsBuffer = await fs.readFile(credsFile);
                        const userJid = jidNormalizedUser(`${num}@s.whatsapp.net`);

                        console.log(`📤 Sending creds.json to ${num}...`);
                        await sock.sendMessage(userJid, {
                            document: credsBuffer,
                            fileName: 'creds.json',
                            mimetype: 'application/json',
                            caption:
                                `✅ *Titans Devs Pair Session Generated*\n\n` +
                                `Your WhatsApp session is attached as *creds.json*.\n` +
                                `Download this file and place it where your bot expects its credentials.\n\n` +
                                `📲 If you do not see it, check archived chats on WhatsApp.`
                        });

                        console.log(`✅ creds.json sent to ${num} successfully`);
                        await delay(4000);
                    } catch (err) {
                        console.error('❌ Error generating or sending creds.json:', err);
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
                            res.status(401).send({ ok: false, code: 'Session expired or invalid' });
                        }
                        await cleanup('logged_out');
                        return;
                    }

                    if (pairingCodeSent && !sessionCompleted) {
                        reconnectAttempts += 1;
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
                        res.send({
                            ok: true,
                            code,
                            message: 'Pair this code in WhatsApp. After linking, your creds.json file will be sent to your WhatsApp DM.'
                        });
                    }
                } catch (err) {
                    console.error('❌ Failed to get pairing code:', err);
                    pairingCodeSent = false;

                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(503).send({ ok: false, code: 'Failed to get pairing code' });
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
                        res.status(408).send({ ok: false, code: 'Pairing timeout — please try again' });
                    }
                    await cleanup('timeout');
                }
            }, SESSION_TIMEOUT);
        } catch (err) {
            console.error(`❌ Error initializing session for ${num}:`, err);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).send({ ok: false, code: 'Service Unavailable' });
            }
            await cleanup('init_error');
        }
    }

    await initiateSession();
});

export default router;
