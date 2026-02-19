import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import qrRouter from './qr.js';
import pairRouter from './pair.js';

import fs from 'fs';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;

// Increase default max listeners
import('events').then(events => {
    events.EventEmitter.defaultMaxListeners = 500;
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- API routes ---
app.use('/qr', qrRouter);      // QR generation API
app.use('/code', pairRouter);   // Pair code API

// --- HTML pages ---
app.get('/pair', (req, res) => {
    const filePath = path.join(__dirname, 'pair.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('pair.html not found');
    }
});

app.get('/qrpage', (req, res) => {
    const filePath = path.join(__dirname, 'qr.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('qr.html not found');
    }
});

app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'main.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('main.html not found');
    }
});

// --- Test route to confirm server is up ---
app.get('/test', (req, res) => res.send('Server is running!'));

// --- Start server ---
app.listen(PORT, () => {
    console.log(`YouTube: @brokenvzn-s7s`);
    console.log(`GitHub: @Neaterry6`);
    console.log(`Server running on http://localhost:${PORT}`);
});

// --- Global error catcher ---
process.on('uncaughtException', (err) => {
    const e = String(err);
    const ignore = [
        "conflict", "not-authorized", "Socket connection timeout",
        "rate-overlimit", "Connection Closed", "Timed Out",
        "Value not found", "Stream Errored", "Stream Errored (restart required)",
        "statusCode: 515", "statusCode: 503"
    ];
    if (!ignore.some(x => e.includes(x))) {
        console.error('Caught exception:', err);
    }
});

export default app;