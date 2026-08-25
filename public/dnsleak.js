async function runDnsLeakTest() {
    const btn = document.getElementById('btn-dnsleak');
    const content = document.getElementById('dnsleak-content');
    
    const modal = document.getElementById('dnsleak-modal');
    const backdrop = document.getElementById('dnsleak-modal-backdrop');
    const panel = document.getElementById('dnsleak-modal-panel');
    
    modal.classList.remove('hidden');
    setTimeout(() => {
        backdrop.classList.remove('opacity-0');
        panel.classList.remove('opacity-0', 'scale-95');
        panel.classList.add('opacity-100', 'scale-100');
    }, 10);

    content.innerHTML = `
        <div class="text-center py-8">
            <svg class="animate-spin h-8 w-8 mx-auto text-blue-500 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            <h4 class="text-lg font-semibold text-slate-800 dark:text-white">Running DNS Leak Test...</h4>
            <p class="text-sm text-slate-500 mt-2" id="dnsleak-status">Generating unique identifiers...</p>
        </div>
    `;

    try {
        const idRes = await fetch('https://bash.ws/id');
        const id = await idRes.text();
        
        document.getElementById('dnsleak-status').innerText = 'Querying test servers...';
        
        const promises = [];
        for (let i = 1; i <= 10; i++) {
            promises.push(
                fetch(`https://${i}.${id}.bash.ws`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {})
            );
        }
        await Promise.all(promises);
        
        document.getElementById('dnsleak-status').innerText = 'Analyzing results...';
        
        await new Promise(r => setTimeout(r, 1500));
        
        const res = await fetch(`https://bash.ws/dnsleak/test/${id}?json`);
        const data = await res.json();
        
        const dnsServers = data.filter(d => d.type === 'dns');
        const conclusion = data.find(d => d.type === 'conclusion');
        
        let serversHtml = dnsServers.map(s => `
            <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50 flex justify-between items-center mb-2">
                <div>
                    <div class="font-mono font-bold text-slate-800 dark:text-white">${s.ip}</div>
                    <div class="text-xs text-slate-500 mt-1">${s.asn || 'Unknown ASN'}</div>
                </div>
                <div class="text-right">
                    <div class="text-sm font-semibold text-slate-700 dark:text-slate-300">${s.country_name || s.country || 'Unknown Location'}</div>
                </div>
            </div>
        `).join('');
        
        if(dnsServers.length === 0) {
            serversHtml = '<div class="text-center text-slate-500 dark:text-slate-400 py-4">No DNS resolvers found.</div>';
        }
        
        let conclusionHtml = '';
        if (conclusion) {
            const isLeaking = conclusion.ip.toLowerCase().includes('leaking');
            const alertColor = isLeaking ? 'text-red-600 bg-red-100 border-red-200 dark:text-red-400 dark:bg-red-900/20 dark:border-red-500/20' : 'text-emerald-600 bg-emerald-100 border-emerald-200 dark:text-emerald-400 dark:bg-emerald-900/20 dark:border-emerald-500/20';
            conclusionHtml = `
                <div class="p-4 rounded-lg border ${alertColor} mb-4 text-center font-bold">
                    ${conclusion.ip}
                </div>
            `;
        }

        content.innerHTML = `
            ${conclusionHtml}
            <div class="text-sm font-bold text-slate-600 dark:text-slate-400 mb-2">Resolvers detected (${dnsServers.length}):</div>
            <div class="max-h-[50vh] overflow-y-auto custom-scrollbar pr-1">
                ${serversHtml}
            </div>
            <div class="mt-4 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-500/20 text-xs text-slate-600 dark:text-slate-400">
                <strong>What does this mean?</strong> If you are using a VPN and see DNS servers provided by your ISP or a third party not associated with your VPN, your DNS queries are leaking.
            </div>
        `;
    } catch (e) {
        content.innerHTML = `
            <div class="text-center py-8 text-red-500">
                <svg class="h-10 w-10 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <p>Failed to run DNS leak test. Please try again.</p>
            </div>
        `;
    }
}

function closeDnsLeakModal() {
    const modal = document.getElementById('dnsleak-modal');
    const backdrop = document.getElementById('dnsleak-modal-backdrop');
    const panel = document.getElementById('dnsleak-modal-panel');

    backdrop.classList.add('opacity-0');
    panel.classList.add('opacity-0', 'scale-95');
    panel.classList.remove('opacity-100', 'scale-100');

    setTimeout(() => { modal.classList.add('hidden'); }, 300);
}
