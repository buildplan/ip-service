const dns = require('dns').promises;
const axios = require('axios');
const net = require('net');

// --- 1. IN-MEMORY BLOCKLIST CACHE ---
let maliciousIpSet = new Set();

const BLOCKLIST_SOURCES = [
    'https://blocklist.greensnow.co/greensnow.txt',
    'https://lists.blocklist.de/lists/all.txt',
    'https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset'
];

async function updateBlocklists() {
    console.log('🔄 Updating Threat Intelligence Feeds...');
    const newSet = new Set();

    for (const source of BLOCKLIST_SOURCES) {
        try {
            const response = await axios.get(source, { timeout: 10000 });
            const lines = response.data.split('\n');
            for (const line of lines) {
                const cleanLine = line.split('#')[0].trim();
                if (!cleanLine) continue;
                // Extract IP (handles CIDR /32)
                const ipPart = cleanLine.split('/')[0];
                if (net.isIP(ipPart)) {
                    newSet.add(ipPart);
                }
            }
            console.log(`   ✅ Fetched ${source}`);
        } catch (err) {
            console.error(`   ⚠️ Failed to fetch ${source}: ${err.message}`);
        }
    }

    if (newSet.size > 0) {
        maliciousIpSet = newSet;
        console.log(`🛡️ Threat Intel Updated: ${newSet.size} IPs loaded.`);
    }
}

// Initial load & Schedule
updateBlocklists();
setInterval(updateBlocklists, 12 * 60 * 60 * 1000);


// --- 2. CHECKERS ---

function checkPublicBlocklists(ip) {
    if (maliciousIpSet.has(ip)) {
        return {
            source: 'Threat Feed',
            status: 'LISTED',
            reason: 'Known Attacker (GreenSnow/FireHOL)'
        };
    }
    return null;
}

async function checkDNSBL(ip) {
    // SpamCop/DroneBL do not support IPv6
    if (net.isIPv6(ip)) return [];

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

async function checkCrowdSec(ip) {
    try {
        const apiKey = process.env.CROWDSEC_API_KEY;
        const apiUrl = process.env.CROWDSEC_URL || 'http://crowdsec:8080';

        if (!apiKey) return null;

        // Encode IP properly for URL
        const encodedIp = encodeURIComponent(ip);

        const res = await axios.get(`${apiUrl}/v1/decisions?ip=${encodedIp}`, {
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
    if (!net.isIP(ip)) return { ip, error: "Invalid IP" };

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
