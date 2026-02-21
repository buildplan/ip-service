BigInt.prototype.toJSON = function() { return this.toString() }
const express = require('express');
const maxmind = require('maxmind');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { IP2Proxy } = require('ip2proxy-nodejs');
const { IP2Location } = require('ip2location-nodejs');
const app = express();
const getReputation = require('./src/reputation');
const { vpnHostingProviders, vpnASNs } = require('./src/providers.js');
const getWhois = require('./src/whois');

// --- CONFIGURATION ---
app.set('json spaces', 2);
app.set('trust proxy', true);
app.use(cors()); // Enable CORS for v4.ip... and v6.ip

app.use(express.static(path.join(__dirname, 'views'), { index: false }));

// --- DATABASE PATHS ---
const cityDbPath = process.env.CITY_DB_PATH || path.join(__dirname, 'db', 'GeoLite2-City.mmdb');
const asnDbPath = process.env.ASN_DB_PATH || path.join(__dirname, 'db', 'GeoLite2-ASN.mmdb');
const proxyDbPath = process.env.PROXY_DB_PATH || path.join(__dirname, 'db', 'IP2PROXY-LITE-PX11.BIN');
const db11Path = process.env.DB11_PATH || path.join(__dirname, 'db', 'IP2LOCATION-LITE-DB11.IPV6.BIN');

let cityLookup;
let asnLookup;
let proxyLookup;
let db11Lookup;

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

function getGeoData(ip) {
    // 1. Reserved / Local IP Checks
    if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
        return { ip, country: 'Reserved', city: 'Local Network', asn: 'N/A', org: 'Localhost', is_proxy: false, proxy_type: 'Local', usage_type: 'RES', threat: 'None', provider: 'N/A' };
    }

    try {
        // --- DATA LOOKUPS ---
        const cityData = cityLookup ? cityLookup.get(ip) : null;
        const asnData = asnLookup ? asnLookup.get(ip) : null;
        const proxyData = proxyLookup ? proxyLookup.getAll(ip) : {};

        // DB11 Fallback
        const db11Data = db11Lookup ? db11Lookup.getAll(ip) : {};

        // Helper: Prioritize MaxMind -> DB11 -> Unknown
        const pick = (primary, secondary) => {
            if (primary && primary !== 'Unknown' && primary !== '') return primary;
            if (secondary && secondary !== '-' && secondary !== 'This parameter is unavailable for selected data file.') return secondary;
            return 'Unknown';
        };

        const orgName = asnData ? asnData.autonomous_system_organization : 'Unknown ISP';
        const asnNumber = asnData ? `AS${asnData.autonomous_system_number}` : 'Unknown';

        // --- USAGE TYPE DETECTION ---
        let rawUsage = proxyData.usageType;
        if (!rawUsage || rawUsage === '-' || rawUsage === 'RP') {
            rawUsage = 'Standard';
        }
        const usageMap = {
            'ISP': 'Residential', 'MOB': 'Mobile Data', 'COM': 'Commercial', 'ORG': 'Organization',
            'EDU': 'University', 'GOV': 'Government', 'DCH': 'Datacenter', 'CDN': 'CDN',
            'SES': 'Search Engine Spider', 'Standard': 'Standard ISP'
        };
        let usageType = usageMap[rawUsage] || rawUsage;

        // If it's a "Standard ISP" (unknown) but matches a Cloud Provider, rename it.
        if (usageType === 'Standard ISP') {
            if (vpnHostingProviders.low.some(p => orgName.toLowerCase().includes(p.toLowerCase()))) {
                usageType = 'Cloud Infrastructure';
            }
        }

        // --- PROXY DETECTION LOGIC ---
        let isProxy = false;
        let riskLabel = "No";

        // A) Check Database First
        if (proxyData && proxyData.isProxy === 1) {
            isProxy = true;
            const typeMap = {
                'VPN': 'VPN Service', 'DCH': 'Datacenter', 'TOR': 'Tor Node',
                'PUB': 'Public Proxy', 'SES': 'Search Engine Spider'
            };
            riskLabel = typeMap[proxyData.proxyType] || proxyData.proxyType;
        }

        // B) Fallback: Check Provider Lists
        if (!isProxy && orgName !== 'Unknown ISP') {
            if (vpnHostingProviders.high.some(p => orgName.toLowerCase().includes(p.toLowerCase()))) {
                isProxy = true; riskLabel = "VPN Hosting (High Confidence)";
            }
            else if (vpnHostingProviders.medium.some(p => orgName.toLowerCase().includes(p.toLowerCase()))) {
                isProxy = true; riskLabel = "VPN Hosting (Medium Confidence)";
            }
            else if (vpnHostingProviders.low.some(p => orgName.toLowerCase().includes(p.toLowerCase()))) {
                if (usageType === 'DCH' || usageType === 'Datacenter') {
                    isProxy = true; riskLabel = "Cloud Hosting (Low Confidence)";
                }
            }
        }

        // C) ASN-based detection (High-Risk Networks ONLY)
        if (!isProxy && vpnASNs.includes(asnNumber)) {
            isProxy = true; riskLabel = "VPN ASN Match";
        }

        // --- THREAT & PROVIDER SANITIZATION ---
        let threat = proxyData.threat || '-';
        let provider = proxyData.provider || '-';

        if (threat === '-') threat = 'None';
        if (provider === '-') provider = 'N/A';

        if (isProxy && riskLabel !== "No") {
            if (usageType === 'Standard ISP' || usageType === 'Standard') usageType = 'Datacenter';
            if (provider === 'N/A') provider = orgName;

            if (threat === 'None') {
                if (riskLabel.includes('High') || riskLabel === 'VPN ASN Match') threat = 'High (VPN Hosting)';
                else if (riskLabel.includes('Medium')) threat = 'Medium (Hosting Provider)';
                else threat = 'Low (Cloud Provider)';
            }
        }

        // --- FINAL MERGE ---
        let lat = cityData?.location?.latitude || 0;
        let long = cityData?.location?.longitude || 0;

        if (lat === 0 && db11Data.latitude && db11Data.latitude !== '0.000000') {
            lat = parseFloat(db11Data.latitude);
            long = parseFloat(db11Data.longitude);
        }

        return {
            ip,
            country: pick(cityData?.country?.names?.en, db11Data.country_long),
            country_code: pick(cityData?.country?.iso_code, db11Data.country_short),
            city: pick(cityData?.city?.names?.en, db11Data.city),
            region: pick(cityData?.subdivisions?.[0]?.names?.en, db11Data.region),
            timezone: pick(cityData?.location?.time_zone, db11Data.time_zone),
            coordinates: `${lat}, ${long}`,
            latitude: lat,
            longitude: long,
            zip: (db11Data.zip_code && db11Data.zip_code !== '-') ? db11Data.zip_code : 'N/A',
            asn: asnNumber,
            org: orgName,
            is_proxy: isProxy,
            proxy_type: riskLabel,
            usage_type: usageType,
            threat: threat,
            provider: provider
        };
    } catch (err) {
        console.error(`Geo lookup failed for ${ip}:`, err);
        return { ip, error: 'Lookup Failed' };
    }
}

// RATE LIMITER
const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // Limit each IP to 100 requests per 5 minutes
    standardHeaders: true,
    legacyHeaders: false,

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

async function loadDbs() {
    try {
        cityLookup = await maxmind.open(cityDbPath);
        console.log(`✅ City DB loaded`);
        try {
            asnLookup = await maxmind.open(asnDbPath);
            console.log(`✅ ASN DB loaded`);
        } catch (e) { console.warn(`⚠️ ASN DB missing`); }

        try {
            db11Lookup = new IP2Location();
            db11Lookup.open(db11Path);
            console.log(`✅ DB11 (Fallback) loaded`);
        } catch (e) { console.warn(`⚠️ DB11 Error: ${e.message}`); }

        try {
            proxyLookup = new IP2Proxy();
            if (proxyLookup.open(proxyDbPath) === 0) {
                 console.log(`✅ Proxy DB loaded`);
            } else {
                 console.warn(`⚠️ Proxy DB failed to open`);
            }
        } catch (e) { console.warn(`⚠️ Proxy DB error: ${e.message}`); }

    } catch (err) { console.error('❌ DB Error:', err); }
}
loadDbs();

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

const PORT = process.env.PORT || 4040;
app.listen(PORT, () => console.log(`🚀 IP-Echo Service running on ${PORT}`));
