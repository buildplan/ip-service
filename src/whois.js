const axios = require('axios');
const net = require('net');

async function getWhois(ip) {
    if (!net.isIP(ip)) return { error: "Invalid IP" };

    try {
        // --- 1. TRY RDAP FIRST ---
        const rdapRes = await axios.get(`https://rdap.org/ip/${ip}`, {
            timeout: 5000,
            headers: { 'Accept': 'application/rdap+json' }
        });

        const data = rdapRes.data;
        const result = {
            ip: ip,
            network_name: data.name || 'N/A',
            handle: data.handle || 'N/A',
            country: data.country || 'N/A',
            type: data.type || 'N/A',
            network_range: (data.startAddress && data.endAddress) ? `${data.startAddress} - ${data.endAddress}` : 'N/A',
            organization: 'N/A',
            abuse_contacts: [],
            registration_date: 'N/A',
            updated_date: 'N/A',
            is_raw: false
        };

        // Extract dates
        if (data.events) {
            const regEvent = data.events.find(e => e.eventAction === 'registration');
            const updEvent = data.events.find(e => e.eventAction === 'last changed');
            if (regEvent) result.registration_date = new Date(regEvent.eventDate).toISOString().split('T')[0];
            if (updEvent) result.updated_date = new Date(updEvent.eventDate).toISOString().split('T')[0];
        }

        // Helper to parse vCard arrays
        const parseVcard = (vcardArray) => {
            const parsed = { name: null, emails: [] };
            if (!vcardArray || vcardArray.length < 2) return parsed;
            vcardArray[1].forEach(prop => {
                if (prop[0] === 'fn') parsed.name = prop[3];
                if (prop[0] === 'email') parsed.emails.push(prop[3]);
            });
            return parsed;
        };

        // Extract Entities
        if (data.entities) {
            data.entities.forEach(entity => {
                const roles = entity.roles || [];
                const vcard = parseVcard(entity.vcardArray);

                if (vcard.name && (roles.includes('registrant') || roles.includes('administrative') || roles.includes('abuse'))) {
                    if (result.organization === 'N/A' || roles.includes('registrant')) result.organization = vcard.name;
                }
                if (roles.includes('abuse') && vcard.emails.length > 0) result.abuse_contacts.push(...vcard.emails);

                if (entity.entities) {
                    entity.entities.forEach(subEntity => {
                        const subRoles = subEntity.roles || [];
                        const subVcard = parseVcard(subEntity.vcardArray);
                        if (subRoles.includes('abuse') && subVcard.emails.length > 0) result.abuse_contacts.push(...subVcard.emails);
                    });
                }
            });
        }
        result.abuse_contacts = [...new Set(result.abuse_contacts)];

        // --- VALIDATION: Is the RDAP Registry Broken? ---
        const isBroken = result.network_name === 'IANA-BLOCK' ||
                         result.network_range.includes('0.0.0.0') ||
                         result.network_name === 'N/A';

        if (!isBroken) {
            return result;
        }
        console.warn(`RDAP returned bad data for ${ip}, triggering fallback...`);

    } catch (err) {
        console.warn(`RDAP failed for ${ip}, triggering fallback...`);
    }

    // --- 2. FALLBACK: FETCH RAW WHOIS (RIPEstat) ---
    try {
        const statRes = await axios.get(`https://stat.ripe.net/data/whois/data.json?resource=${ip}`, {
            timeout: 6000,
            headers: { 'Accept': 'application/json' }
        });

        const statData = statRes.data.data;
        let rawText = '';

        if (statData && statData.records) {
            statData.records.forEach(record => {
                record.forEach(entry => { rawText += `${entry.key}: ${entry.value}\n`; });
                rawText += '\n';
            });
        }

        if (!rawText.trim()) rawText = "No WHOIS records found for this IP.";

        return {
            ip: ip,
            is_raw: true,
            raw_whois: rawText.trim()
        };

    } catch (fallbackErr) {
        console.error("WHOIS Fallback Error:", fallbackErr.message);
        return { error: "Registry lookup failed entirely." };
    }
}

module.exports = getWhois;
