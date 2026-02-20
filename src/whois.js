const axios = require('axios');
const net = require('net');

async function getWhois(ip) {
    if (!net.isIP(ip)) return { error: "Invalid IP" };

    try {
        // rdap.org acts as a bootstrap server and redirects to ARIN, RIPE, APNIC, etc.
        const res = await axios.get(`https://rdap.org/ip/${ip}`, {
            timeout: 5000,
            headers: { 'Accept': 'application/rdap+json' }
        });

        const data = res.data;

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
            updated_date: 'N/A'
        };

        // Extract dates
        if (data.events) {
            const regEvent = data.events.find(e => e.eventAction === 'registration');
            const updEvent = data.events.find(e => e.eventAction === 'last changed');
            if (regEvent) result.registration_date = new Date(regEvent.eventDate).toLocaleDateString();
            if (updEvent) result.updated_date = new Date(updEvent.eventDate).toLocaleDateString();
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

        // Extract Entities (Org Name & Abuse Emails)
        if (data.entities) {
            data.entities.forEach(entity => {
                const roles = entity.roles || [];
                const vcard = parseVcard(entity.vcardArray);

                // Set Organization Name
                if (vcard.name && (roles.includes('registrant') || roles.includes('administrative') || roles.includes('abuse'))) {
                    if (result.organization === 'N/A' || roles.includes('registrant')) {
                        result.organization = vcard.name;
                    }
                }

                // Get Abuse Emails from root entity
                if (roles.includes('abuse') && vcard.emails.length > 0) {
                    result.abuse_contacts.push(...vcard.emails);
                }

                // ARIN nests the actual abuse contact inside sub-entities
                if (entity.entities) {
                    entity.entities.forEach(subEntity => {
                        const subRoles = subEntity.roles || [];
                        const subVcard = parseVcard(subEntity.vcardArray);
                        if (subRoles.includes('abuse') && subVcard.emails.length > 0) {
                            result.abuse_contacts.push(...subVcard.emails);
                        }
                    });
                }
            });
        }

        result.abuse_contacts = [...new Set(result.abuse_contacts)]; // Deduplicate

        return result;

    } catch (err) {
        console.error("RDAP WHOIS Error:", err.message);
        return { error: "Registry lookup failed or rate limited." };
    }
}

module.exports = getWhois;
