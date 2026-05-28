import os from 'os';
import path from 'path';
import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const DEFAULT_BAILEYS_VERSION = [2, 3000, 1023223821];

export function sessionDirectory(...parts) {
    return path.join(os.tmpdir(), 'web-pair-qr', ...parts);
}

export async function getBaileysVersion() {
    const envVersion = process.env.BAILEYS_VERSION;
    if (envVersion) {
        const parsed = envVersion.split(',').map((part) => Number.parseInt(part.trim(), 10));
        if (parsed.length === 3 && parsed.every(Number.isInteger)) return parsed;
        console.warn(`Invalid BAILEYS_VERSION "${envVersion}". Expected format: 2,3000,1023223821`);
    }

    try {
        const { version } = await fetchLatestBaileysVersion();
        return version;
    } catch (error) {
        console.warn('Unable to fetch latest Baileys version. Using fallback version.', error?.message || error);
        return DEFAULT_BAILEYS_VERSION;
    }
}
