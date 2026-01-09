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

// --- CONFIGURATION ---
app.set('json spaces', 2);
app.set('trust proxy', true);
app.use(cors()); // Enable CORS for v4.ip... and v6.ip...

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

        // --- DEFINITIONS: KNOWN PROVIDERS ---
        const vpnHostingProviders = {
            // HIGH: Pure VPN/Privacy Networks (Always Flag as High Risk)
            high: [
                'M247', 'Datacamp', 'DataPacket', 'London Trust Media', 'Kape Technologies', '31173 Services', 'Owl Limited', 'PacketHub',
		'Hydra Communications', 'Strong Technology', 'Powerhouse Management', 'Proton', 'Mullvad', 'NordVPN', 'Surfshark', 'ExpressVPN',
		'CyberGhost', 'Windscribe', 'TunnelBear', 'ZenMate', 'Private Internet Access', 'HideMyAss', 'QuadraNet', 'Psychz', 'ColoCrossing',
		'NFOrce', 'i3D.net', 'Melbicom', 'Green Floid', 'LogicWeb', 'Creanova', 'EstNOC', 'Ip-Only', 'GSL Networks', 'Tzulo', 'ReliableSite',
		'Feral Hosting', 'Spine Telecom', 'Anexia', 'HostRoyale', 'Keminet', 'Cablenet Communications', 'NovoServe'
            ],
            // MEDIUM: Budget/Offshore VPS (Often abused for VPNs, but distinct from Major Clouds)
            medium: [
                'Zenlayer', 'Cogent', 'Clouvider', 'Nexeon', 'PONYNET', 'FranTech', 'BuyVM', 'Limestone', 'Hivelocity', 'TerraHost',
                'WebHorizon', 'Nexus Bytes', 'Glesys', 'Host Universal', 'Latitude.sh', 'AEZA', 'XTom', 'Misaka', 'Performive', 'Contabo',
                'Netcup', 'HostHatch', 'HostEONS', 'DataWagon', 'G-Core', 'Gcore', 'Selectel', 'UpCloud', 'Time4VPS'
            ],
            // LOW: Major Clouds & Enterprise Infrastructure (Safe, but definitely NOT "Standard ISPs")
            low: [
                'Amazon', 'AWS', 'Google', 'Google Cloud', 'Microsoft', 'Azure', 'Oracle', 'Oracle Cloud', // Big Cloud
                'Alibaba', 'Aliyun', 'Tencent', 'Tencent Cloud', 'Huawei', 'Huawei Cloud', 'Baidu',
                'IBM', 'IBM Cloud', 'SoftLayer', 'Rackspace', 'Salesforce', 'SAP', // Tier 1 Enterprise
                'Hetzner', 'OVH', 'OVHcloud', 'Linode', 'Akamai', 'DigitalOcean', 'Vultr', 'Scaleway',
                'Equinix', 'Equinix Metal', 'Leaseweb', 'Servers.com', 'Choopa', 'The Constant Company',
                'Cloudflare', 'Fastly', 'Edgio', 'Limelight', 'EdgeCast', 'CDN77', 'BunnyCDN', // CDNs & EDGE Nets
                'Imperva', 'Incapsula', 'Sucuri', 'StackPath', 'KeyCDN', 'CacheFly',
                'Fly.io', 'Heroku', 'Netlify', 'Vercel', 'Render', 'Railway', 'DigitalOcean App Platform', // PAAS & App Hosts
                'WP Engine', 'Kinsta', 'Pantheon',
                'GoDaddy', 'Bluehost', 'HostGator', 'DreamHost', 'IONOS', '1&1', 'Strato', // MASS Web Hosts
                'Hostinger', 'SiteGround', 'Namecheap', 'InMotion', 'A2 Hosting', 'InterServer',
                'Liquid Web',
                // --- REGIONAL ---
                'Sakura Internet', 'GMO Internet', // Japan
                'Naver Cloud', 'Kakao Corp',       // Korea
                'Yandex', 'Selectel', 'VK Cloud', 'Mail.Ru', // Russia/CIS
                'Kingsoft', 'JD Cloud', 'UCloud',  // China (Tier 2)
                'UOL', 'Locaweb',                  // Brazil / LATAM
                'Tata Communications'              // India
            ]
        };

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
        const vpnASNs = [
            'AS60729', 'AS4224', 'AS396507', 'AS200651', 'AS1921', 'AS202425', // Tor
            'AS9009', 'AS39351', 'AS212238', 'AS60068', 'AS216025', 'AS208172', 'AS136787', 'AS147049', 'AS207137', 'AS141039', 'AS204957',  // Major VPN
            'AS53667', 'AS25369', 'AS62651', 'AS22363', 'AS56655', 'AS200019', 'AS11878', 'AS203020', 'AS9009' // Privacy Hosting
        ];

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

// Apply globally to all requests
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

        // Load Proxy DB
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

// --- ROUTES ---

// 1. Root Endpoint
app.get('/', (req, res) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'];

    // Cache Busting Headers
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
app.get(['/api/info', '/json'], (req, res) => {
    const targetIp = req.query.ip || getClientIp(req);
    const ua = req.headers['user-agent'];
    if (!maxmind.validate(targetIp)) return res.status(400).json({ error: 'Invalid IP' });

    const data = getGeoData(targetIp);

    // If the user is using curl/wget, manually stringify and add a newline "\n"
    if (isCli(ua)) {
        res.header('Content-Type', 'application/json');
        return res.send(JSON.stringify(data, null, 2) + '\n');
    }
    // Otherwise, standard JSON response for web apps
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

    // Helper to hide empty fields nicely
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

// --- abuseipdb badge proxy ---
app.get('/abuseip-badge.svg', async (req, res) => {
    try {
        const response = await axios.get('https://www.abuseipdb.com/contributor/259750.svg', { timeout: 2000, responseType: 'text' });
        let svg = response.data;
        svg = svg.replace( '<g style="font-weight: bold;', '<g fill="#cbd5e1" style="font-weight: bold;' );
        res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=10800'); res.send(svg);
    } catch (err) { console.error('Badge Fetch Error:', err.message); res.status(500).send(''); }
});

// --- ROUTE: Terms & Privacy ---
app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'terms.html'));
});

// Use the environment variable PORT, or default to 4040
const PORT = process.env.PORT || 4040;
app.listen(PORT, () => console.log(`🚀 IP-Echo Service running on ${PORT}`));
