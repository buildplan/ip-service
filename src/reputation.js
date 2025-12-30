const dns = require('dns').promises;
const axios = require('axios');

// --- DNSBL Checker ---
async function checkDNSBL(ip) {
    // Reverse IP: 1.2.3.4 -> 4.3.2.1
    const reversed = ip.split('.').reverse().join('.');

    // Publicly usable lists (Spamhaus often blocks public DNS resolvers, so stick to these safer options)
    const lists = [
        { zone: 'bl.spamcop.net', name: 'SpamCop' },
        { zone: 'dnsbl.dronebl.org', name: 'DroneBL' },
        { zone: 'b.barracudacentral.org', name: 'Barracuda' }
    ];

    // Check all lists in parallel
    const checks = lists.map(async (list) => {
        try {
            await dns.resolve4(`${reversed}.${list.zone}`);
            return { source: list.name, status: 'LISTED' };
        } catch (err) {
            return null; // Clean or Error
        }
    });

    const results = await Promise.all(checks);
    return results.filter(r => r !== null);
}

// --- CrowdSec Checker ---
async function checkCrowdSec(ip) {
    try {
        const apiKey = process.env.CROWDSEC_API_KEY;
        const apiUrl = process.env.CROWDSEC_URL || 'http://crowdsec:8080';

        if (!apiKey) return null;

        // Query Local API with a strict 2s timeout
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
        // Silently fail if CrowdSec is down
        console.error("CrowdSec check skipped:", err.message);
        return null;
    }
}

// --- Main Export ---
module.exports = async function getReputation(ip) {
    const [dnsblMatches, crowdsecMatch] = await Promise.all([
        checkDNSBL(ip),
        checkCrowdSec(ip)
    ]);

    const detections = [...dnsblMatches];
    if (crowdsecMatch) detections.push(crowdsecMatch);

    return {
        ip,
        is_clean: detections.length === 0,
        detections
    };
};
