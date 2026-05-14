const dns = require('dns').promises;
const axios = require('axios');
const net = require('net');
const { LRUCache } = require('lru-cache');
const { BlockList } = require('net');

// --- CONFIGURATION ---
// Cache: Max 1000 IPs, 3 hour TTL
const reputationCache = new LRUCache({
    max: 1000,
    ttl: 3 * 60 * 60 * 1000,
});

// --- CIRCUIT BREAKERS ---
let abuseIpdbExhausted = false;
let abuseIpdbResetTime = 0;

let sniffCatExhausted = false;
let sniffCatResetTime = 0;

let spamVerifyExhausted = false;
let spamVerifyResetTime = 0;

// --- 1. IN-MEMORY BLOCKLIST CACHE ---
let globalBlockList = new BlockList();
let blocklistCount = 0;

const BLOCKLIST_SOURCES = [
    'https://blocklist.greensnow.co/greensnow.txt',
    'https://lists.blocklist.de/lists/all.txt',
    'https://raw.githubusercontent.com/sefinek/Malicious-IP-Addresses/main/lists/main.txt',
    'https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset'
];

async function updateBlocklists() {
    console.log('🔄 Updating Threat Intelligence Feeds...');
    const newBlockList = new BlockList();
    let count = 0;

    for (const source of BLOCKLIST_SOURCES) {
        try {
            const response = await axios.get(source, { timeout: 10000 });
            const lines = response.data.split('\n');
            for (const line of lines) {
                const cleanLine = line.split('#')[0].trim();
                if (!cleanLine) continue;
                if (cleanLine.includes('/')) {
                    const [ip, prefix] = cleanLine.split('/');
                    const prefixInt = parseInt(prefix, 10);
                    if (net.isIP(ip) && !isNaN(prefixInt)) {
                        const type = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
                        newBlockList.addSubnet(ip, prefixInt, type);
                        count++;
                    }
                } else {
                    if (net.isIP(cleanLine)) {
                        const type = net.isIPv6(cleanLine) ? 'ipv6' : 'ipv4';
                        newBlockList.addAddress(cleanLine, type);
                        count++;
                    }
                }
            }
            console.log(`   ✅ Fetched ${source}`);
        } catch (err) {
            console.error(`   ⚠️ Failed to fetch ${source}: ${err.message}`);
        }
    }

    if (count > 0) {
        globalBlockList = newBlockList;
        blocklistCount = count;
        console.log(`🛡️ Threat Intel Updated: ${count} rules loaded (supporting CIDR ranges).`);
    }
}

// --- STARTUP CHECKS ---
function checkApiStatus() {
    const apis = [
        { name: 'CrowdSec', key: process.env.CROWDSEC_API_KEY },
        { name: 'AbuseIPDB', key: process.env.ABUSEIPDB_API_KEY },
        { name: 'SniffCat', key: process.env.SNIFFCAT_API_KEY },
        { name: 'SpamVerify', key: process.env.SPAMVERIFY_API_KEY }
    ];

    apis.forEach(api => {
        if (api.key) console.log(`✅ ${api.name} API enabled`);
        else console.log(`⚪ ${api.name} API not configured (Skipping)`);
    });
}

// Initial load & Schedule (Every 3 hours)
checkApiStatus();
updateBlocklists();
setInterval(updateBlocklists, 3 * 60 * 60 * 1000);


// --- 2. CHECKERS ---

function checkPublicBlocklists(ip) {
    const type = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    if (globalBlockList.check(ip, type)) {
        return {
            source: 'Threat Feed',
            status: 'LISTED',
            reason: 'Known Attacker (FireHOL/GreenSnow/etc)'
        };
    }
    return null;
}

async function checkDNSBL(ip) {
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

        const encodedIp = encodeURIComponent(ip);
        const res = await axios.get(`${apiUrl}/v1/decisions?ip=${encodedIp}`, {
            headers: { 'X-Api-Key': apiKey },
            timeout: 10000
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
        console.error("❌ CrowdSec Error:", err.message);
        return null;
    }
}

// --- EXTERNAL API CHECKERS ---

async function checkSniffCat(ip) {
    if (sniffCatExhausted) {
        if (Date.now() > sniffCatResetTime) {
            sniffCatExhausted = false;
            console.log("🟢 SniffCat Circuit Breaker Reset - Trying again.");
        } else {
            return null;
        }
    }

    try {
        const apiKey = process.env.SNIFFCAT_API_KEY;
        if (!apiKey) return null;

        const res = await axios.get(`https://api.sniffcat.com/api/v1/check?ip=${ip}`, {
            headers: { 'X-Secret-Token': apiKey },
            timeout: 10000
        });

        const data = res.data;

        if (data.abuse_score > 0) {
            return {
                source: 'SniffCat',
                status: 'REPORTED',
                reason: `Abuse Score: ${data.abuse_score}%`
            };
        }
    } catch (err) {
        if (err.response && err.response.status === 429) {
            console.warn("⚠️ SniffCat Rate Limit Reached. Pausing checks for 1 hour.");
            sniffCatExhausted = true;
            sniffCatResetTime = Date.now() + (60 * 60 * 1000);
        } else {
             console.error("❌ SniffCat Error:", err.message);
        }
    }
    return null;
}

async function checkSpamVerify(ip) {
    if (spamVerifyExhausted) {
        if (Date.now() > spamVerifyResetTime) {
            spamVerifyExhausted = false;
            console.log("🟢 SpamVerify Circuit Breaker Reset - Trying again.");
        } else {
            return null;
        }
    }

    try {
        const apiKey = process.env.SPAMVERIFY_API_KEY;
        if (!apiKey) return null;

        const encodedIp = encodeURIComponent(ip);
        const res = await axios.get(`https://api.spamverify.com/v1/check/ip/${encodedIp}`, {
            params: {
                days: 365,
                limit: 10,
                include_hierarchy: 'true',
                include_reports: 'true',
                api_key: apiKey
            },
            headers: {
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        const ipData = res.data.ip;
        const reports = res.data.reports || [];

        const score = ipData ? ipData.threat_score : 0;
        const reportCount = reports.length;

        if (score > 0 || reportCount > 0) {
            let reasonStr = '';
            if (score > 0) reasonStr = `Threat Score: ${score}`;
            else reasonStr = `Recent Reports: ${reportCount}`;

            return {
                source: 'SpamVerify',
                status: 'REPORTED',
                reason: `${reasonStr} (${ipData.statistics?.total_reports || reportCount} total reports)`
            };
        }

    } catch (err) {
        if (err.response && err.response.status === 429) {
            console.warn("⚠️ SpamVerify Limit Reached. Pausing for 12 hours.");
            spamVerifyExhausted = true;
            spamVerifyResetTime = Date.now() + (12 * 60 * 60 * 1000);
        } else {
            console.error(`❌ SpamVerify Error (${err.response?.status || 'Unknown'}):`, err.message);
        }
    }
    return null;
}

async function checkAbuseIPDB(ip) {
    if (abuseIpdbExhausted) {
        if (Date.now() > abuseIpdbResetTime) {
            abuseIpdbExhausted = false; // Reset if time passed
            console.log("🟢 AbuseIPDB Circuit Breaker Reset - Trying again.");
        } else {
            return null; // Skip silently
        }
    }

    try {
        const apiKey = process.env.ABUSEIPDB_API_KEY;
        if (!apiKey) return null;

        const res = await axios.get('https://api.abuseipdb.com/api/v2/check', {
            params: { ipAddress: ip, maxAgeInDays: 90, verbose: '' },
            headers: { 'Key': apiKey, 'Accept': 'application/json' },
            timeout: 10000
        });

        const data = res.data.data;
        // AbuseIPDB score from 0-100. flag anything > 0.
        if (data.abuseConfidenceScore > 0) {
            return {
                source: 'AbuseIPDB',
                status: 'REPORTED',
                reason: `Confidence Score: ${data.abuseConfidenceScore}% (${data.totalReports} reports)`
            };
        }
        return null;

    } catch (err) {
        if (err.response && err.response.status === 429) {
            console.warn("⚠️ AbuseIPDB Daily Limit Reached. Pausing checks for 6 hours.");
            abuseIpdbExhausted = true;
            abuseIpdbResetTime = Date.now() + (6 * 60 * 60 * 1000); // Wait 6 hours
        } else {
            console.error("❌ AbuseIPDB Error:", err.message);
        }
        return null;
    }
}

// --- MAIN EXPORT ---
module.exports = async function getReputation(ip) {
    if (!net.isIP(ip)) return { ip, error: "Invalid IP" };

    // 1. Check Cache First (Saves API Credits)
    if (reputationCache.has(ip)) {
        return reputationCache.get(ip);
    }

    // 2. Check Memory Blocklists (Instant)
    const blocklistResult = checkPublicBlocklists(ip);

    // 3. Check External APIs (Async)
    const [dnsblMatches, crowdsecMatch, abuseIpdbMatch, sniffCatMatch, spamVerifyMatch] = await Promise.all([
        checkDNSBL(ip),
        checkCrowdSec(ip),
        checkAbuseIPDB(ip),
        checkSniffCat(ip),
        checkSpamVerify(ip)
    ]);

    // 4. Combine Results
    const detections = [...dnsblMatches];
    if (blocklistResult) detections.push(blocklistResult);
    if (crowdsecMatch) detections.push(crowdsecMatch);
    if (abuseIpdbMatch) detections.push(abuseIpdbMatch);
    if (sniffCatMatch) detections.push(sniffCatMatch);
    if (spamVerifyMatch) detections.push(spamVerifyMatch);

    const result = {
        ip,
        is_clean: detections.length === 0,
        detections
    };

    // 5. Store in Cache
    reputationCache.set(ip, result);

    return result;
};
