import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import qrRouter from './qr.js';
import pairRouter from './pair.js';

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
app.use(express.static(__dirname));

// Routes
app.use('/qr', qrRouter);      // QR generation API
app.use('/code', pairRouter);   // Pair code API

// Serve pages
app.use('/pair', async (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html')); // Pair code page (X5-MD design)
});

app.use('/qrpage', (req, res) => {
    res.sendFile(path.join(__dirname, 'qr.html'));   // QR page (X5-MD design)
});

app.use('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html')); // Home page
});

// Start server
app.listen(PORT, () => {
    console.log(`YouTube: @brokenvzn-s7s`);
    console.log(`GitHub: @Neaterry6`);
    console.log(`Server running on http://localhost:${PORT}`);
});

// Global error catcher
process.on('uncaughtException', (err) => {
    const e = String(err);
    const ignore = [
        "conflict", "not-authorized", "Socket connection timeout",
        "rate-overlimit", "Connection Closed", "Timed Out",
        "Value not found", "Stream Errored", "Stream Errored (restart required)",
        "statusCode: 515", "statusCode: 503"
    ];
    if (!ignore.some(x => e.includes(x))) {
        console.log('Caught exception:', err);
    }
});

export default app;