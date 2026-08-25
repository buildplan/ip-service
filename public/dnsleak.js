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
        
        const clientIpObj = data.find(d => d.type === 'ip');
        const dnsServers = data.filter(d => d.type === 'dns');
        
        let serversHtml = dnsServers.map(s => `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/20 transition-colors">
                <td class="p-3 font-mono font-bold text-slate-800 dark:text-white">${s.ip}</td>
                <td class="p-3 text-slate-600 dark:text-slate-300">${s.asn || 'Unknown ASN'}</td>
                <td class="p-3 text-slate-600 dark:text-slate-300">${s.country_name || s.country || 'Unknown'}</td>
            </tr>
        `).join('');
        
        if(dnsServers.length === 0) {
            serversHtml = '<tr><td colspan="3" class="p-4 text-center text-slate-500">No DNS resolvers found.</td></tr>';
        }

        const publicIp = clientIpObj ? clientIpObj.ip : (window.currentScanIp || 'Unknown');

        content.innerHTML = `
            <div class="text-left">
                <div class="mb-4 text-slate-700 dark:text-slate-300 font-medium">
                    Your public IP: <span class="font-mono text-blue-600 dark:text-blue-400 font-bold">${publicIp}</span>
                </div>

                <h4 class="text-xl font-bold text-slate-800 dark:text-white border-b border-slate-200 dark:border-slate-700 pb-2 mb-4">Test complete</h4>
                
                <div class="max-h-[40vh] overflow-y-auto custom-scrollbar pr-1 mb-6 border border-slate-200 dark:border-slate-700/50 rounded-lg">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-slate-100 dark:bg-slate-800/50 text-xs uppercase tracking-wider text-slate-500">
                                <th class="p-3 rounded-tl-lg">IP</th>
                                <th class="p-3">ISP / Provider</th>
                                <th class="p-3 rounded-tr-lg">Country</th>
                            </tr>
                        </thead>
                        <tbody class="text-sm divide-y divide-slate-200 dark:divide-slate-700/50">
                            ${serversHtml}
                        </tbody>
                    </table>
                </div>

                <h4 class="text-lg font-bold text-slate-800 dark:text-white border-b border-slate-200 dark:border-slate-700 pb-2 mb-3">What do the results of this test mean?</h4>
                
                <ul class="list-disc list-outside ml-5 space-y-2 text-sm text-slate-600 dark:text-slate-400">
                    <li>The servers identified above receive a request to resolve a domain name (e.g. www.eff.org) to an IP address every time you enter a website address in your browser.</li>
                    <li>The owners of the servers above have the ability to associate your personal IP address with the names of all the sites you connect to. <strong>You need to trust whatever their privacy policy says</strong>.</li>
                    <li>If you are connected to a VPN service and ANY of the servers listed above are not provided by the VPN service, then you have a DNS leak and are exposing your private data.</li>
                </ul>
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
