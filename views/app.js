document.getElementById("year").innerText = new Date().getFullYear();

function initTheme() {
    if (localStorage.theme === 'light') {
        document.documentElement.classList.remove('dark');
    } else {
        document.documentElement.classList.add('dark');
    }
}

function toggleTheme() {
    const html = document.documentElement;
    if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        localStorage.theme = 'light';
        updateMapTheme('light');
    } else {
        html.classList.add('dark');
        localStorage.theme = 'dark';
        updateMapTheme('dark');
    }
}
initTheme();

const darkTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>', subdomains: 'abcd', maxZoom: 19
});

const lightTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19
});

const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri', maxZoom: 19
});

const isDark = document.documentElement.classList.contains('dark');
const initialLayer = isDark ? darkTiles : lightTiles;

const map = L.map('map', {
    zoomControl: false,
    layers: [initialLayer]
}).setView([51.505, -0.09], 13);

const baseMaps = {
    "Dark Mode": darkTiles,
    "Light Mode": lightTiles,
    "Satellite": satelliteTiles
};
L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

function updateMapTheme(theme) {
    if (!map.hasLayer(satelliteTiles)) {
        if (theme === 'dark') {
            map.addLayer(darkTiles); map.removeLayer(lightTiles);
        } else {
            map.addLayer(lightTiles); map.removeLayer(darkTiles);
        }
    }
}

let marker;
let currentScanIp = '';
let lastReputationResult = null;

function showToast(message) {
    const x = document.getElementById("toast");
    x.innerText = message; x.className = "show";
    setTimeout(() => { x.className = x.className.replace("show", ""); }, 3000);
}

function copyWithFeedback(ip, elId, type) {
    navigator.clipboard.writeText(ip).then(() => {
        showToast(`${type} Copied!`);
        const iconContainer = document.getElementById(elId);
        const originalSvg = iconContainer.innerHTML;
        iconContainer.innerHTML = `<svg class="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>`;
        setTimeout(() => { iconContainer.innerHTML = originalSvg; }, 2000);
    });
}

function createIpRow(ip, type, isPrimary = true) {
    const isV6 = type === 'IPv6';
    const badgeColor = isV6
        ? 'bg-purple-900/40 text-purple-600 dark:text-purple-400 border-purple-800'
        : 'bg-blue-900/40 text-blue-600 dark:text-blue-400 border-blue-800';

    const textSize = isPrimary ? 'text-3xl md:text-5xl' : 'text-xl md:text-2xl text-slate-500 dark:text-slate-400';
    const padding = isPrimary ? 'px-6 py-4' : 'px-4 py-2 opacity-80 hover:opacity-100';
    const iconId = `copy-icon-${type}`;

    return `
    <div class="group cursor-pointer flex flex-col sm:flex-row items-center gap-3 sm:gap-5 bg-white dark:bg-slate-900/60 ${padding} rounded-2xl border border-slate-200 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all w-full md:w-auto min-w-[280px] sm:min-w-[420px] justify-center shadow-lg hover:shadow-blue-900/10 hover:border-blue-500/30 dark:hover:border-blue-500/30" onclick="copyWithFeedback('${ip}', '${iconId}', '${type}')">
        <span class="px-2.5 py-1 rounded text-[10px] sm:text-xs font-bold border uppercase tracking-wider ${badgeColor} shrink-0">${type}</span>
        <span class="font-bold tracking-tight break-all font-mono text-center ${textSize} text-slate-800 dark:text-white">${ip}</span>
        <div id="${iconId}" class="hidden sm:block shrink-0">
            <svg class="w-5 h-5 text-slate-400 dark:text-slate-600 group-hover:text-blue-500 dark:group-hover:text-white transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2z"></path></svg>
        </div>
    </div>
    `;
}

async function fetchSmartIPs() {
    const displayArea = document.getElementById('ip-display-area');
    try {
        const configRes = await fetch('/api/config');
        const config = await configRes.json();

        let apiUrl = '/api/info';
        const rawSearch = window.location.search.substring(1).trim();
        let targetIp = null;

        if (rawSearch) {
            const params = new URLSearchParams(window.location.search);
            if (params.has('ip')) {
                targetIp = params.get('ip');
            } else if (!rawSearch.includes('=')) {
                targetIp = rawSearch;
            }
        }

        if (targetIp) {
            apiUrl = `/api/info?ip=${targetIp}`;
            const searchInput = document.getElementById('searchInput');
            if (searchInput) searchInput.value = targetIp;
        }

        const res = await fetch(apiUrl);
        const primaryData = await res.json();
        if (primaryData.error) throw new Error(primaryData.error);

        const primaryIsV6 = primaryData.ip.includes(':');
        const primaryType = primaryIsV6 ? 'IPv6' : 'IPv4';

        displayArea.innerHTML = createIpRow(primaryData.ip, primaryType, true); // true = isPrimary
        populateDetails(primaryData);

        // Only fetch secondary protocol IP if we are checking the client's own IP
        if (!targetIp) {
            const missingUrl = primaryIsV6 ? config.v4_url : config.v6_url;
            const missingType = primaryIsV6 ? 'IPv4' : 'IPv6';

            try {
                const secRes = await fetch(missingUrl);
                if (secRes.ok) {
                    const secData = await secRes.json();
                    displayArea.innerHTML += createIpRow(secData.ip, missingType, false); // false = isSecondary
                }
            } catch (e) { console.log("Secondary protocol unavailable."); }
        }

    } catch (err) {
        displayArea.innerHTML = `<span class="text-red-400">Error loading IP</span>`;
        console.error(err);
    }
}

function populateDetails(data) {
    currentScanIp = data.ip;
    resetReputationUI();

    document.getElementById('dataOrg').innerText = data.org || 'N/A';
    document.getElementById('dataAsn').innerText = data.asn || 'N/A';
    
    if (data.hostname && data.hostname !== 'N/A') {
        document.getElementById('dataHostname').innerText = data.hostname;
        document.getElementById('hostnameWrapper').classList.remove('hidden');
    } else {
        document.getElementById('hostnameWrapper').classList.add('hidden');
    }

    document.getElementById('dataCity').innerText = data.city;
    document.getElementById('mainLocation').innerText = `${data.city}, ${data.country}`;
    document.getElementById('dataRegion').innerText = `${data.region}, ${data.country}`;

    if (data.zip && data.zip !== "N/A" && data.zip !== "-") {
        document.getElementById('dataZip').innerText = data.zip;
        document.getElementById('zipWrapper').style.display = "inline";
    } else {
        document.getElementById('zipWrapper').style.display = "none";
    }

    document.getElementById('dataTimezone').innerText = data.timezone;
    document.getElementById('dataCoords').innerText = data.coordinates;
    document.getElementById('jsonPreview').innerHTML = syntaxHighlight(data);

    const proxyEl = document.getElementById('dataProxyBadge');
    if (data.is_proxy) {
        proxyEl.innerText = data.proxy_type;
        proxyEl.className = "px-2 py-0.5 rounded text-xs font-bold bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/20 shadow-[0_0_10px_rgba(239,68,68,0.2)]";
    } else if (data.usage_type === 'Residential' || data.usage_type === 'Mobile Data') {
        proxyEl.innerText = data.usage_type;
        proxyEl.className = "px-2 py-0.5 rounded text-xs font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20";
    } else {
        proxyEl.innerText = data.usage_type || "Clean";
        proxyEl.className = "px-2 py-0.5 rounded text-xs font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20";
    }

    if (data.latitude && data.longitude) {
        const lat = parseFloat(data.latitude);
        const lon = parseFloat(data.longitude);
        map.setView([lat, lon], 13);
        if (marker) map.removeLayer(marker);
        marker = L.circleMarker([lat, lon], { radius: 8, fillColor: "#3b82f6", color: "#fff", weight: 2, opacity: 1, fillOpacity: 0.8 }).addTo(map).bindPopup(`<b>${data.city}</b>`).openPopup();
    }
}

async function searchIp() {
    const input = document.getElementById('searchInput').value.trim();
    if(!input) return;
    try {
        const res = await fetch(`/api/info?ip=${input}`);
        const data = await res.json();
        populateDetails(data);
        const type = input.includes(':') ? 'IPv6' : 'IPv4';
        document.getElementById('ip-display-area').innerHTML = createIpRow(data.ip, type);
        document.getElementById('mainLocation').innerText = `${data.city}, ${data.country}`;
    } catch(e) { console.error(e); }
}

function copyText(id) {
    navigator.clipboard.writeText(document.getElementById(id).innerText.replace('$ ', '')).then(() => showToast('Command Copied!'));
}

function resetReputationUI() {
    const btn = document.getElementById('btn-scan');
    if(btn) {
        btn.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> SCAN THREATS`;
    }
    document.getElementById('rep-badge').classList.add('hidden');
    lastReputationResult = null;
}

async function checkReputation() {
    const btn = document.getElementById('btn-scan');
    const badge = document.getElementById('rep-badge');

    btn.disabled = true;
    btn.innerHTML = `<svg class="animate-spin h-3 w-3 mr-2" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> SCANNING...`;

    try {
        const res = await fetch(`/api/reputation?ip=${currentScanIp}`);
        const data = await res.json();
        lastReputationResult = data;

        btn.classList.add('hidden');
        btn.disabled = false;
        badge.classList.remove('hidden');

        badge.onclick = openReputationModal;
        badge.style.cursor = 'pointer';

        if (data.is_clean) {
            badge.innerHTML = `NO THREATS DETECTED <span class="text-lg leading-none">ⓘ</span>`;
            badge.className = "px-2 py-1 rounded text-[11px] font-bold bg-sky-500/20 text-sky-600 dark:text-sky-400 border border-sky-500/30 hover:bg-sky-500/30 transition-colors whitespace-nowrap flex items-center gap-1";
        } else if (data.detections) {
            badge.innerText = `${data.detections.length} THREATS FOUND ⚠️`;
            badge.className = "px-2 py-0.5 rounded text-xs font-bold bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/30 shadow-[0_0_10px_rgba(239,68,68,0.3)] hover:bg-red-500/30 transition-colors";
        } else {
            throw new Error("Invalid API response");
        }

    } catch (e) {
        console.error(e);
        btn.innerHTML = "ERROR - TRY AGAIN";
        btn.disabled = false;
    }
}

function openReputationModal() {
    if (!lastReputationResult) return;
    const modal = document.getElementById('rep-modal');
    const content = document.getElementById('modal-content');
    const backdrop = document.getElementById('rep-modal-backdrop');
    const panel = document.getElementById('rep-modal-panel');

    modal.classList.remove('hidden');

    if (lastReputationResult.is_clean) {
        const copyStr = `IP: ${lastReputationResult.ip} - Status: CLEAN (No threats detected in active feeds)`;
        content.innerHTML = `
            <div class="flex items-center gap-3 mb-4">
                <div class="p-3 rounded-full bg-sky-500/10 border border-sky-500/20">
                    <svg class="w-8 h-8 text-sky-600 dark:text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
                <div>
                    <h4 class="text-lg font-bold text-slate-900 dark:text-white">No Threats Detected</h4>
                    <p class="text-sm text-slate-500 dark:text-slate-400">IP: <span class="font-mono text-sky-600 dark:text-sky-400">${lastReputationResult.ip}</span></p>
                </div>
            </div>
            <div class="p-4 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                <p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                    This IP address was not found in any of our active threat intelligence feeds (Blocklists, Spam lists, or CrowdSec).
                    <br><br>
                    <span class="text-yellow-600 dark:text-yellow-500/90 font-semibold">⚠️ Note:</span>
                    "No threats detected" does <strong>not</strong> guarantee safety. An IP can be malicious but not yet listed.
                </p>
            </div>
            <button onclick="navigator.clipboard.writeText('${copyStr}').then(() => showToast('Scan Result Copied!'))" class="mt-4 w-full px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-bold tracking-wider uppercase transition-colors flex justify-center items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2z"></path></svg>
                Copy Scan Result
            </button>
        `;
    } else {
        let listHtml = '';
        let threatSources = [];
        lastReputationResult.detections.forEach(det => {
            threatSources.push(det.source);
            listHtml += `
                <div class="p-3 rounded bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-500/20 flex justify-between items-start">
                    <div>
                        <span class="block font-bold text-red-600 dark:text-red-400 text-sm">${det.source}</span>
                        <span class="text-xs text-slate-500 dark:text-slate-400">${det.reason || 'Listed in blocklist'}</span>
                    </div>
                    <span class="px-2 py-0.5 bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-500 text-[10px] font-bold rounded uppercase border border-red-200 dark:border-red-500/20">Listed</span>
                </div>
            `;
        });

        const copyStr = `⚠️ THREAT DETECTED ⚠️\\nIP: ${lastReputationResult.ip}\\nListed By: ${threatSources.join(', ')}`;

        content.innerHTML = `
            <div class="flex items-center gap-3 mb-4">
                <div class="p-3 rounded-full bg-red-500/10 border border-red-500/20">
                    <svg class="w-8 h-8 text-red-600 dark:text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                </div>
                <div>
                    <h4 class="text-lg font-bold text-slate-900 dark:text-white">Threats Detected</h4>
                    <p class="text-sm text-slate-500 dark:text-slate-400">IP: <span class="font-mono text-red-600 dark:text-red-400">${lastReputationResult.ip}</span></p>
                </div>
            </div>
            <p class="text-sm text-slate-600 dark:text-slate-400 mb-2">The following security providers have flagged this IP:</p>
            <div class="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                ${listHtml}
            </div>
            <button onclick="navigator.clipboard.writeText('${copyStr}').then(() => showToast('Threat Report Copied!'))" class="mt-4 w-full px-4 py-2.5 bg-red-50 dark:bg-red-500/10 hover:bg-red-100 dark:hover:bg-red-500/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-500/30 rounded-lg text-xs font-bold tracking-wider uppercase transition-colors flex justify-center items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2z"></path></svg>
                Copy Threat Report
            </button>
        `;
    }

    setTimeout(() => {
        backdrop.classList.remove('opacity-0');
        panel.classList.remove('opacity-0', 'scale-95');
        panel.classList.add('opacity-100', 'scale-100');
    }, 10);
}

function closeReputationModal() {
    const modal = document.getElementById('rep-modal');
    const backdrop = document.getElementById('rep-modal-backdrop');
    const panel = document.getElementById('rep-modal-panel');

    backdrop.classList.add('opacity-0');
    panel.classList.add('opacity-0', 'scale-95');
    panel.classList.remove('opacity-100', 'scale-100');

    setTimeout(() => {
        modal.classList.add('hidden');
    }, 300);
}

fetchSmartIPs();

async function checkWhois() {
    const btn = document.getElementById('btn-whois');
    const content = document.getElementById('whois-content');

    btn.disabled = true;
    btn.innerText = "LOADING...";

    try {
        const res = await fetch(`/api/whois?ip=${currentScanIp}`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        if (data.is_raw) {
            const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
            let formattedRawText = data.raw_whois
                .replace(/</g, '&lt;').replace(/>/g, '&gt;') // Sanitize HTML first
                .replace(emailRegex, '<a href="mailto:$1" class="text-blue-400 hover:text-blue-300 hover:underline">$1</a>');
            // --- RENDER FALLBACK TERMINAL UI ---
            content.innerHTML = `
                <div class="bg-[#0b1120] border border-slate-700 p-4 rounded-xl font-mono text-[11px] md:text-xs text-green-400 overflow-y-auto max-h-[60vh] custom-scrollbar whitespace-pre-wrap shadow-inner">
${formattedRawText}
                </div>
                <p class="text-[10px] text-slate-500 mt-3 text-center uppercase tracking-widest">Fallback: Raw WHOIS Data shown due to unformatted registry</p>
            `;
        } else {
            // --- RENDER GRID UI ---
            let emailsHtml = data.abuse_contacts.length > 0
                ? data.abuse_contacts.map(e => `<a href="mailto:${e}" class="text-blue-500 hover:underline">${e}</a>`).join(', ')
                : '<span class="text-slate-400">Not provided</span>';

            content.innerHTML = `
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50">
                        <span class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Network Name</span>
                        <span class="font-mono text-slate-800 dark:text-slate-200 break-all">${data.network_name}</span>
                    </div>
                    <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50">
                        <span class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">IP Range</span>
                        <span class="font-mono text-slate-800 dark:text-slate-200 break-all">${data.network_range}</span>
                    </div>
                    <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50 sm:col-span-2">
                        <span class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Organization</span>
                        <span class="text-slate-800 dark:text-slate-200">${data.organization}</span>
                    </div>
                    <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50">
                        <span class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Allocation Type</span>
                        <span class="text-slate-800 dark:text-slate-200">${data.type}</span>
                    </div>

                    <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50">
                        <span class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Last Updated</span>
                        <span class="text-slate-800 dark:text-slate-200">${data.updated_date}</span>
                    </div>
                    <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50">
                        <span class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Registered</span>
                        <span class="text-slate-800 dark:text-slate-200">${data.registration_date}</span>
                    </div>
                    <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50">
                        <span class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Registry Handle</span>
                        <span class="font-mono text-slate-800 dark:text-slate-200 break-all">${data.handle} (${data.country})</span>
                    </div>
                </div>
                <div class="mt-4 p-4 rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-500/20">
                    <span class="block text-xs font-bold text-red-600 dark:text-red-400 uppercase tracking-wider mb-1">Abuse Contacts</span>
                    <div class="font-medium">${emailsHtml}</div>
                    <p class="text-xs text-slate-500 mt-2">Use these contacts to report malicious activity from this IP.</p>
                </div>
            `;
        }

        // Show Modal
        const modal = document.getElementById('whois-modal');
        const backdrop = document.getElementById('whois-modal-backdrop');
        const panel = document.getElementById('whois-modal-panel');

        modal.classList.remove('hidden');
        setTimeout(() => {
            backdrop.classList.remove('opacity-0');
            panel.classList.remove('opacity-0', 'scale-95');
            panel.classList.add('opacity-100', 'scale-100');
        }, 10);

    } catch (e) {
        showToast("WHOIS lookup failed. Registry might be rate limiting.");
    } finally {
        btn.innerText = "WHOIS";
        btn.disabled = false;
    }
}

function closeWhoisModal() {
    const modal = document.getElementById('whois-modal');
    const backdrop = document.getElementById('whois-modal-backdrop');
    const panel = document.getElementById('whois-modal-panel');

    backdrop.classList.add('opacity-0');
    panel.classList.add('opacity-0', 'scale-95');
    panel.classList.remove('opacity-100', 'scale-100');

    setTimeout(() => { modal.classList.add('hidden'); }, 300);
}

// --- MODAL UX ---
    // Close on 'Escape'
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const repModal = document.getElementById('rep-modal');
        const whoisModal = document.getElementById('whois-modal');
        const dnsLeakModal = document.getElementById('dnsleak-modal');
        if (repModal && !repModal.classList.contains('hidden')) closeReputationModal();
        if (whoisModal && !whoisModal.classList.contains('hidden')) closeWhoisModal();
        if (dnsLeakModal && !dnsLeakModal.classList.contains('hidden')) closeDnsLeakModal();
    }
});
// Close when clicking outside the panel
const repModal = document.getElementById('rep-modal');
if (repModal) {
    repModal.addEventListener('click', (e) => {
        if (e.target.id === 'rep-modal' || e.target.id === 'rep-modal-backdrop') {
            closeReputationModal();
        }
    });
}
const whoisModal = document.getElementById('whois-modal');
if (whoisModal) {
    whoisModal.addEventListener('click', (e) => {
        if (e.target.id === 'whois-modal' || e.target.id === 'whois-modal-backdrop') {
            closeWhoisModal();
        }
    });
}
const dnsLeakModal = document.getElementById('dnsleak-modal');
if (dnsLeakModal) {
    dnsLeakModal.addEventListener('click', (e) => {
        if (e.target.id === 'dnsleak-modal' || e.target.id === 'dnsleak-modal-backdrop') {
            closeDnsLeakModal();
        }
    });
}

function syntaxHighlight(json) {
    if (typeof json != 'string') {
        json = JSON.stringify(json, undefined, 2);
    }
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'text-blue-400 dark:text-blue-300'; // Numbers
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'text-indigo-500 dark:text-indigo-300 font-semibold'; // Keys
            } else {
                cls = 'text-emerald-500 dark:text-emerald-400'; // Strings
            }
        } else if (/true|false/.test(match)) {
            cls = 'text-orange-500 dark:text-orange-400'; // Booleans
        } else if (/null/.test(match)) {
            cls = 'text-slate-400'; // Null
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

