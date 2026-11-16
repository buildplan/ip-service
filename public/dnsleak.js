let activeDnsLeakRunId = 0;

function generateTestId() {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(8);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normaliseAsn(asnStr) {
  if (!asnStr) return null;
  const match = String(asnStr).match(/^(AS\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

async function fetchBashWsResults(id, isStale) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (isStale()) return null;

    const res = await fetch(`https://bash.ws/dnsleak/test/${id}?json`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (attempt === 0 && data && data.error) continue;
    throw new Error(data?.error || "No DNS servers found.");
  }
  throw new Error("No DNS servers found.");
}

async function runDnsLeakTest() {
  const runId = ++activeDnsLeakRunId;
  const btn = document.getElementById("btn-dnsleak");
  const rerunBtn = document.getElementById("dnsleak-rerun-btn");
  const content = document.getElementById("dnsleak-content");
  const modal = document.getElementById("dnsleak-modal");
  if (!modal || !content) return;

  const isStale = () => !modal.open || runId !== activeDnsLeakRunId;

  if (btn) {
    btn.disabled = true;
    btn.innerText = "RUNNING...";
  }
  if (rerunBtn) rerunBtn.disabled = true;

  if (typeof window.openAppDialog === "function") {
    window.openAppDialog(modal);
  } else if (!modal.open) {
    modal.showModal();
  }

  content.innerHTML = `
    <div class="text-center py-8">
      <svg class="animate-spin h-8 w-8 mx-auto text-blue-500 mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
      <h4 class="text-lg font-semibold text-slate-800 dark:text-white">Running DNS Leak Test...</h4>
      <p class="text-sm text-slate-500 mt-2" id="dnsleak-status">Querying test resolvers...</p>
    </div>
  `;

  try {
    // Generate the 16-hex test ID locally because bash.ws/id no longer sends CORS headers.
    const id = generateTestId();

    const probes = [];
    for (let i = 1; i <= 10; i++) {
      probes.push(
        fetch(`https://${i}.${id}.bash.ws`, {
          mode: "no-cors",
          cache: "no-store",
        }).catch(() => {}),
      );
    }
    await Promise.all(probes);
    if (isStale()) return;

    const statusEl = document.getElementById("dnsleak-status");
    if (statusEl) statusEl.innerText = "Analyzing resolver responses...";

    const data = await fetchBashWsResults(id, isStale);
    if (!data || isStale()) return;

    const clientIpObj = data.find((d) => d.type === "ip");
    const dnsServers = data.filter((d) => d.type === "dns");

    const serversHtml =
      dnsServers.length > 0
        ? dnsServers
            .map((s) => {
              const ip = escapeHtml(s.ip);
              const asn = escapeHtml(s.asn || "Unknown ASN");
              const country = escapeHtml(
                s.country_name || s.country || "Unknown",
              );
              return `
                <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/20 transition-colors">
                  <td class="p-3 font-mono font-bold text-slate-800 dark:text-white break-all">${ip}</td>
                  <td class="p-3 text-slate-600 dark:text-slate-300">
                    <div>${asn}</div>
                    <div class="text-xs text-slate-400 sm:hidden mt-0.5">${country}</div>
                  </td>
                  <td class="p-3 text-slate-600 dark:text-slate-300 hidden sm:table-cell">${country}</td>
                </tr>
              `;
            })
            .join("")
        : '<tr><td colspan="3" class="p-4 text-center text-slate-500">No DNS resolvers found.</td></tr>';

    const publicIp = escapeHtml(
      clientIpObj?.ip || window.currentScanIp || "Unknown",
    );
    const publicAsn = escapeHtml(
      clientIpObj?.asn || "your internet provider",
    );

    let dynamicConclusion = "";
    if (dnsServers.length > 0) {
      const normPublic = normaliseAsn(clientIpObj?.asn);
      const allMatch = dnsServers.every((s) => {
        const normDns = normaliseAsn(s.asn);
        return Boolean(normDns && normPublic && normDns === normPublic);
      });

      if (allMatch) {
        dynamicConclusion = `
          <div class="mb-5 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-500/20">
            <h4 class="text-sm font-bold text-emerald-800 dark:text-emerald-400 mb-1">✅ DNS does not appear to be leaking.</h4>
            <p class="text-sm text-emerald-900/80 dark:text-emerald-200/80">
              You use the same ISP for DNS and Internet. If <strong>${publicAsn}</strong> is your VPN or intended provider, then your connection is secure.
            </p>
          </div>
        `;
      } else {
        const dnsIsps = [
          ...new Set(
            dnsServers.map((s) => escapeHtml(s.asn || "an unknown provider")),
          ),
        ].join(", ");
        dynamicConclusion = `
          <div class="mb-5 p-4 rounded-lg bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-500/20">
            <h4 class="text-sm font-bold text-orange-800 dark:text-orange-400 mb-1">⚠️ DNS may be leaking.</h4>
            <p class="text-sm text-orange-900/80 dark:text-orange-200/80">
              You use different ISPs for DNS and Internet. If <strong>${publicAsn}</strong> is your VPN, your internet traffic is 100% secured, while your DNS queries are handled by <strong>${dnsIsps}</strong>.
            </p>
          </div>
        `;
      }
    }

    const resolverBadge = `${dnsServers.length} resolver${dnsServers.length === 1 ? "" : "s"} detected`;

    content.innerHTML = `
      <div class="text-left">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4 text-slate-700 dark:text-slate-300 font-medium">
          <span>Your public IP: <span class="font-mono text-blue-600 dark:text-blue-400 font-bold break-all">${publicIp}</span></span>
          <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">${resolverBadge}</span>
        </div>

        <h4 class="text-xl font-bold text-slate-800 dark:text-white border-b border-slate-200 dark:border-slate-700 pb-2 mb-4">Test complete</h4>

        ${dynamicConclusion}

        <div class="max-h-[35vh] overflow-y-auto overscroll-contain custom-scrollbar pr-1 mb-6 border border-slate-200 dark:border-slate-700/50 rounded-lg">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-100 dark:bg-slate-800/50 text-xs uppercase tracking-wider text-slate-500">
                <th class="p-3 rounded-tl-lg">IP</th>
                <th class="p-3">ISP / Provider</th>
                <th class="p-3 rounded-tr-lg hidden sm:table-cell">Country</th>
              </tr>
            </thead>
            <tbody class="text-sm divide-y divide-slate-200 dark:divide-slate-700/50">
              ${serversHtml}
            </tbody>
          </table>
        </div>

        <h4 class="text-lg font-bold text-slate-800 dark:text-white border-b border-slate-200 dark:border-slate-700 pb-2 mb-3">Understanding the results</h4>

        <ul class="list-disc list-outside ml-5 space-y-2 text-sm text-slate-600 dark:text-slate-400">
          <li>Whenever you type a website address into your browser, your computer asks the servers listed above to convert that name into an IP address.</li>
          <li>Because these servers handle all your web requests, their owners can associate your public IP with the websites you visit. You need to trust their privacy policy.</li>
          <li>If you are using a VPN to hide your activity, but the servers above belong to your home ISP, you may have a <strong>DNS leak</strong> and your DNS queries are visible to that ISP.</li>
        </ul>
      </div>
    `;
  } catch (e) {
    if (isStale()) return;

    content.innerHTML = `
      <div class="text-center py-8 text-red-500 space-y-2">
        <svg class="h-10 w-10 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <p class="font-medium">Failed to run DNS leak test.</p>
        <p class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(e?.message || "Please try again.")}</p>
      </div>
    `;
  } finally {
    if (runId === activeDnsLeakRunId) {
      if (btn) {
        btn.disabled = false;
        btn.innerText = "DNS LEAK";
      }
      if (rerunBtn) rerunBtn.disabled = false;
    }
  }
}

function closeDnsLeakModal() {
  activeDnsLeakRunId++;
  const modal = document.getElementById("dnsleak-modal");
  if (typeof window.closeAppDialog === "function") {
    window.closeAppDialog(modal);
  } else if (modal?.open) {
    modal.close();
  }
}
