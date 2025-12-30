const dns = require('dns').promises;
const axios = require('axios');

// --- IN-MEMORY BLOCKLIST CACHE ---
let maliciousIpSet = new Set();
let lastUpdate = 0;

// Sources for general "Bad IP" lists (SSH Brute force, Web Exploits)
const BLOCKLIST_SOURCES = [
    'https://lists.blocklist.de/lists/all.txt', // Germany's Fail2Ban reporting
    'https://blocklist.greensnow.co/greensnow.txt', // Active attacks
    'https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset' // Top tier bad guys
];

// Function to fetch and parse lists
async function updateBlocklists() {
    console.log('🔄 Updating Threat Intelligence Feeds...');
    const newSet = new Set();

    for (const source of BLOCKLIST_SOURCES) {
        try {
            const response = await axios.get(source, { timeout: 5000 });
            const lines = response.data.split('\n');

            for (const line of lines) {
                // Clean line (remove comments, whitespace)
                const ip = line.trim().split(/\s+/)[0];

                // Basic validation: must look like an IPv4
                if (ip && ip.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)) {
                    newSet.add(ip);
                }
            }
        } catch (err) {
            console.error(`⚠️ Failed to fetch list ${source}: ${err.message}`);
        }
    }

    if (newSet.size > 0) {
        maliciousIpSet = newSet;
        lastUpdate = Date.now();
        console.log(`✅ Threat Intel Updated: ${maliciousIpSet.size} malicious IPs loaded into memory.`);
    }
}

// Initial load (runs immediately when server starts)
updateBlocklists();
// Refresh every 12 hours
setInterval(updateBlocklists, 12 * 60 * 60 * 1000);


// --- 1. DNSBL Checker (Spam/Bots) ---
async function checkDNSBL(ip) {
    const reversed = ip.split('.').reverse().join('.');
    const lists = [
        { zone: 'bl.spamcop.net', name: 'SpamCop' },
        { zone: 'dnsbl.dronebl.org', name: 'DroneBL' },
        { zone: 'b.barracudacentral.org', name: 'Barracuda' }
    ];

    const checks = lists.map(async (list) => {
        try {
            await dns.resolve4(`${reversed}.${list.zone}`);
            return { source: list.name, status: 'LISTED', reason: 'Spam/Bot Reputation' };
        } catch (err) {
            return null;
        }
    });

    const results = await Promise.all(checks);
    return results.filter(r => r !== null);
}

// --- 2. Public Blocklist Checker (Attacks) ---
function checkPublicBlocklists(ip) {
    if (maliciousIpSet.has(ip)) {
        return {
            source: 'Public Blocklist',
            status: 'LISTED',
            reason: 'Known Attacker (Firehol/Greensnow)'
        };
    }
    return null;
}

// --- 3. CrowdSec (Optional Local API) ---
async function checkCrowdSec(ip) {
    try {
        const apiKey = process.env.CROWDSEC_API_KEY;
        const apiUrl = process.env.CROWDSEC_URL || 'http://crowdsec:8080';

        if (!apiKey) return null;

        const res = await axios.get(`${apiUrl}/v1/decisions?ip=${ip}`, {
            headers: { 'X-Api-Key': apiKey },
            timeout: 2000
        });

        if (res.data && res.data.length > 0) {
            const decision = res.data[0];
            return {
                source: 'CrowdSec',
                status: 'BANNED',
                reason: decision.scenario || 'Community Blocklist'
            };
        }
        return null;
    } catch (err) {
        return null;
    }
}

// --- MAIN EXPORT ---
module.exports = async function getReputation(ip) {
    // 1. Check Memory (Instant)
    const blocklistResult = checkPublicBlocklists(ip);

    // 2. Check External (Async)
    const [dnsblMatches, crowdsecMatch] = await Promise.all([
        checkDNSBL(ip),
        checkCrowdSec(ip)
    ]);

    // 3. Combine Results
    const detections = [...dnsblMatches];
    if (blocklistResult) detections.push(blocklistResult);
    if (crowdsecMatch) detections.push(crowdsecMatch);

    return {
        ip,
        is_clean: detections.length === 0,
        detections
    };
};
