// Builds ./www (the web assets Capacitor packs into the Android app)
const fs = require('fs');
fs.rmSync('www', { recursive: true, force: true });
fs.mkdirSync('www');
const html = fs.readFileSync('index.html', 'utf8');
if (!html.includes('<script>')) throw new Error('index.html: inline <script> not found');
fs.writeFileSync('www/index.html', html.replace('<script>', '<script src="api.js"></script>\n<script>'));
fs.copyFileSync('mobile/api.js', 'www/api.js');
console.log('www/ ready');
