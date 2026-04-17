BigInt.prototype.toJSON = function() { return this.toString() }
const express = require('express');
const maxmind = require('maxmind');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { LRUCache } = require('lru-cache');

// --- CUSTOM MODULES ---
const getReputation = require('./src/reputation');
const getWhois = require('./src/whois');
const { initGeoDb, getGeoData } = require('./src/geoip');

const app = express();

// --- CONFIGURATION ---
app.set('json spaces', 2);
app.set('trust proxy', true);
app.use(cors()); // Enable CORS for v4.ip... and v6.ip

app.use(express.static(path.join(__dirname, 'views'), { index: false }));
app.use(express.static(path.join(__dirname, 'public')));

// --- CACHE SETUP ---
const geoCache = new LRUCache({
    max: 2000,
    ttl: 5 * 60 * 1000,
});

// --- HELPERS ---
function getClientIp(req) {
    let ip = req.headers['cf-connecting-ip'] ||
             req.headers['x-real-ip'] ||
             (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress);
    if (ip && ip.startsWith("::ffff:")) ip = ip.substr(7);
    return ip;
}

function isCli(userAgent) {
    const ua = (userAgent || '').toLowerCase();
    return ua.includes('curl') || ua.includes('wget') || ua.includes('httpie') ||
           ua.includes('python') || ua.includes('powershell') || ua.includes('aiohttp') || ua.includes('go-http-client');
}

// GeoJS Fallback Helper
async function getGeoJS(ip) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout

        const res = await fetch(`https://get.geojs.io/v1/ip/geo/${ip}.json`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) return null;

        const data = await res.json();
        return {
            city: data.city || 'Unknown',
            country: data.country || 'Unknown',
            country_code: data.country_code || 'XX',
            region: data.region || '',
            latitude: parseFloat(data.latitude) || 0,
            longitude: parseFloat(data.longitude) || 0,
            isp: data.organization_name || 'Unknown',
            timezone: data.timezone || 'UTC'
        };
    } catch (err) {
        return null;
    }
}

// RATE LIMITER
const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // Limit each IP to 100 requests per 5 minutes
    standardHeaders: true,
    legacyHeaders: false,

    skip: (req) => {
        const ip = getClientIp(req);
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('172.');
    },

    keyGenerator: (req) => {
        return getClientIp(req);
    },

    handler: (req, res, next, options) => {
        const ua = req.headers['user-agent'];
        if (isCli(ua)) {
            res.status(options.statusCode).send(`Error: Too many requests. Please try again in 5 minutes.\n`);
        } else {
            res.status(options.statusCode).json({ error: 'Too many requests, please try again later.' });
        }
    }
});

app.use(globalLimiter);

// Expose dynamic frontend configuration from environment variables set in docker-compose
app.get('/api/config', (req, res) => {
    res.json({
        v4_url: process.env.V4_API_URL || 'https://v4-ip.wiredalter.com/api/info',
        v6_url: process.env.V6_API_URL || 'https://v6-ip.wiredalter.com/api/info'
    });
});

// --- ROUTES ---

// 1. Root Endpoint
app.get('/', (req, res) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'];

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');

    if (isCli(ua)) {
        return res.send(ip + '\n');
    }
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// 2. API Endpoint
app.get(['/api/info', '/json'], async (req, res) => {
    const targetIp = req.query.ip || getClientIp(req);
    const ua = req.headers['user-agent'];
    if (!maxmind.validate(targetIp)) return res.status(400).json({ error: 'Invalid IP' });

    // --- CACHE CHECK ---
    if (geoCache.has(targetIp)) {
        const cachedData = geoCache.get(targetIp);
        if (isCli(ua)) {
            res.header('Content-Type', 'application/json');
            return res.send(JSON.stringify(cachedData, null, 2) + '\n');
        }
        return res.json(cachedData);
    }

    // --- GENERATE DATA (Cache Miss) ---
    let data = getGeoData(targetIp);

    // Fallback
    if (!data.city || data.city === 'Unknown' || !data.country || data.country === 'Unknown') {
        const fallback = await getGeoJS(targetIp);
        if (fallback) {
            data = { ...data, ...fallback };
            data.is_fallback = true;
            data.coordinates = `${data.latitude}, ${data.longitude}`;
        }
    }

    // --- SAVE TO CACHE ---
    geoCache.set(targetIp, data);

    if (isCli(ua)) {
        res.header('Content-Type', 'application/json');
        return res.send(JSON.stringify(data, null, 2) + '\n');
    }
    res.json(data);
});

// 3. Text Helpers
app.get('/ip', (req, res) => res.send(getClientIp(req) + '\n'));
app.get('/city', (req, res) => res.send(getGeoData(getClientIp(req)).city + '\n'));
app.get('/country', (req, res) => res.send(getGeoData(getClientIp(req)).country + '\n'));

// 4. Human-Readable CLI Dashboard
app.get('/cli', (req, res) => {
    const ip = getClientIp(req);
    const data = getGeoData(ip);

    const show = (val) => (val && val !== 'N/A' && val !== 'Unknown') ? val : '-';

    const output = `
 ----------------------------------------
  WIREDALTER IP INTELLIGENCE
 ----------------------------------------
  IP           : ${data.ip}
  Location     : ${show(data.city)}, ${show(data.region)}, ${show(data.country)}
  Zip Code     : ${show(data.zip)}
  Coordinates  : ${show(data.coordinates)}
  Timezone     : ${show(data.timezone)}

  Organization : ${show(data.org)}
  ASN          : ${show(data.asn)}

  Connection   : ${show(data.usage_type)}
  Risk Status  : ${show(data.proxy_type)}
  Provider     : ${show(data.provider)}
  Threat       : ${show(data.threat)}
 ----------------------------------------
`;
    res.send(output);
});

// IP Reputation logic
app.get('/api/reputation', async (req, res) => {
    const ip = req.query.ip || getClientIp(req);
    if (!maxmind.validate(ip)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }
    const result = await getReputation(ip);
    res.json(result);
});

// WHOIS / RDAP logic
app.get('/api/whois', async (req, res) => {
    const ip = req.query.ip || getClientIp(req);
    if (!maxmind.validate(ip)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }
    const result = await getWhois(ip);
    res.json(result);
});

// --- abuseipdb badge proxy ---
app.get('/abuseip-badge.svg', async (req, res) => {
    try {
        const response = await axios.get('https://www.abuseipdb.com/contributor/259750.svg', { timeout: 2000, responseType: 'text' });
        let svg = response.data;
        svg = svg.replace( '<g style="font-weight: bold;', '<g fill="#cbd5e1" style="font-weight: bold;' );
        res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=10800'); res.send(svg);
    } catch (err) { console.error('Badge Fetch Error:', err.message); res.status(500).send(''); }
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'terms.html'));
});

// --- Health Check ---
app.get('/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    const rssMB = Math.round(memoryUsage.rss / 1024 / 1024);
    const MAX_MEMORY_MB = process.env.MAX_MEMORY_MB || 1024;
    if (rssMB > MAX_MEMORY_MB) {
        console.error(`🚨 Health Check Failed: Memory usage (${rssMB}MB) exceeded limit (${MAX_MEMORY_MB}MB)`);
        return res.status(503).json({ status: 'unhealthy', reason: 'Memory limit exceeded', memory_mb: rssMB, limit_mb: MAX_MEMORY_MB });
    }
    res.status(200).json({ status: 'healthy', memory_mb: rssMB, limit_mb: MAX_MEMORY_MB });
});

const PORT = process.env.PORT || 4040;

initGeoDb().then(() => {
    app.listen(PORT, () => console.log(`🚀 IP-Echo Service running on ${PORT}`));
}).catch(err => {
    console.error("Failed to initialize databases:", err);
});
