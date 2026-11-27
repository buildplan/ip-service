// Pure, stateless RDAP JSON parsing & validation helpers

function formatIsoDate(dateStr) {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "N/A";
  return d.toISOString().split("T")[0];
}

function parseVcard(vcardArray) {
  const parsed = { fn: null, org: null, emails: [] };
  if (!Array.isArray(vcardArray) || !Array.isArray(vcardArray[1])) {
    return parsed;
  }

  for (const prop of vcardArray[1]) {
    if (!Array.isArray(prop) || prop.length < 4) continue;
    const key = typeof prop[0] === "string" ? prop[0].toLowerCase() : "";
    const value = prop[3];

    if (key === "fn" && typeof value === "string" && value.trim()) {
      parsed.fn = value.trim();
    } else if (key === "org") {
      if (typeof value === "string" && value.trim()) {
        parsed.org = value.trim();
      } else if (Array.isArray(value)) {
        const joined = value
          .filter((v) => typeof v === "string" && v.trim())
          .join(" ")
          .trim();
        if (joined) parsed.org = joined;
      }
    } else if (key === "email" && typeof value === "string" && value.trim()) {
      parsed.emails.push(value.trim());
    }
  }

  return parsed;
}

function extractEmailsFromRemarks(remarks, requireAbuseContext = false) {
  if (!Array.isArray(remarks)) return [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = [];

  for (const remark of remarks) {
    const title = typeof remark?.title === "string" ? remark.title : "";
    const desc = Array.isArray(remark?.description)
      ? remark.description.filter((d) => typeof d === "string").join(" ")
      : "";
    const combined = `${title} ${desc}`;
    if (!requireAbuseContext || /abuse/i.test(combined)) {
      const matches = combined.match(emailRegex);
      if (matches) found.push(...matches);
    }
  }

  return found;
}

function extractNetworkRange(data) {
  if (data.startAddress && data.endAddress) {
    return `${data.startAddress} - ${data.endAddress}`;
  }
  if (Array.isArray(data.cidr0_cidrs) && data.cidr0_cidrs.length > 0) {
    const cidrs = data.cidr0_cidrs
      .map((c) => {
        const prefix = c?.v6prefix || c?.v4prefix;
        return prefix && c.length !== undefined ? `${prefix}/${c.length}` : null;
      })
      .filter(Boolean);
    if (cidrs.length > 0) return cidrs.join(", ");
  }
  return "N/A";
}

function parseRdapResponse(data, ip) {
  if (!data || typeof data !== "object") return null;

  const result = {
    ip,
    network_name: data.name || data.handle || "N/A",
    handle: data.handle || "N/A",
    country: data.country || "N/A",
    type: data.type || "N/A",
    network_range: extractNetworkRange(data),
    organization: "N/A",
    abuse_contacts: [],
    registration_date: "N/A",
    updated_date: "N/A",
    is_raw: false,
  };

  // Extract registration & last-changed dates
  if (Array.isArray(data.events)) {
    const regEvent = data.events.find((e) => e?.eventAction === "registration");
    const updEvent =
      data.events.find((e) => e?.eventAction === "last changed") ||
      data.events.find((e) => e?.eventAction === "last update of RDAP database");
    if (regEvent) result.registration_date = formatIsoDate(regEvent.eventDate);
    if (updEvent) result.updated_date = formatIsoDate(updEvent.eventDate);
  }

  // Recursively collect organization name (with role priority) and abuse emails
  const orgCandidates = {
    registrant: null,
    administrative: null,
    technical: null,
    abuse: null,
    other: null,
  };

  const visited = new Set();

  function walkEntities(entities, underAbuse = false) {
    if (!Array.isArray(entities)) return;

    for (const entity of entities) {
      if (!entity || typeof entity !== "object" || visited.has(entity)) continue;
      visited.add(entity);

      const roles = Array.isArray(entity.roles)
        ? entity.roles.map((r) => String(r).toLowerCase())
        : [];
      const isAbuse = underAbuse || roles.includes("abuse");
      const vcard = parseVcard(entity.vcardArray);
      const displayName = vcard.fn || vcard.org;

      if (displayName) {
        if (roles.includes("registrant") && !orgCandidates.registrant) {
          orgCandidates.registrant = displayName;
        } else if (roles.includes("administrative") && !orgCandidates.administrative) {
          orgCandidates.administrative = displayName;
        } else if (roles.includes("technical") && !orgCandidates.technical) {
          orgCandidates.technical = displayName;
        } else if (roles.includes("abuse") && !orgCandidates.abuse) {
          orgCandidates.abuse = displayName;
        } else if (!orgCandidates.other) {
          orgCandidates.other = displayName;
        }
      }

      if (isAbuse) {
        if (vcard.emails.length > 0) {
          result.abuse_contacts.push(...vcard.emails);
        }
        const remarkEmails = extractEmailsFromRemarks(entity.remarks, false);
        if (remarkEmails.length > 0) {
          result.abuse_contacts.push(...remarkEmails);
        }
      }

      if (Array.isArray(entity.entities)) {
        walkEntities(entity.entities, isAbuse);
      }
    }
  }

  walkEntities(data.entities, false);

  result.organization =
    orgCandidates.registrant ||
    orgCandidates.administrative ||
    orgCandidates.technical ||
    orgCandidates.abuse ||
    orgCandidates.other ||
    "N/A";

  // Fallback: extract abuse contact emails from top-level remarks if none found in vCards
  if (result.abuse_contacts.length === 0) {
    result.abuse_contacts.push(...extractEmailsFromRemarks(data.remarks, true));
  }

  result.abuse_contacts = [...new Set(result.abuse_contacts)];

  return result;
}

function isBrokenRdapResult(result) {
  if (!result) return true;
  const upperName = (result.network_name || "").toUpperCase();
  const isIanaPlaceholder =
    upperName === "IANA-BLOCK" ||
    upperName === "IANA" ||
    upperName.startsWith("IANA-");
  const isUnspecified =
    result.network_range.includes("0.0.0.0") ||
    result.network_range.startsWith("::/0") ||
    /^::\s*-\s*ffff:/i.test(result.network_range);
  const isEmpty =
    result.network_name === "N/A" &&
    result.handle === "N/A" &&
    result.organization === "N/A";

  return isIanaPlaceholder || isUnspecified || isEmpty;
}

module.exports = {
  formatIsoDate,
  parseVcard,
  extractEmailsFromRemarks,
  extractNetworkRange,
  parseRdapResponse,
  isBrokenRdapResult,
};
