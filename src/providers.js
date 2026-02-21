module.exports = {
  vpnHostingProviders: {
    high: [
        'M247', 'Datacamp', 'DataPacket', 'London Trust Media', 'Kape Technologies', '31173 Services', 'Owl Limited', 'PacketHub',
        'Hydra Communications', 'Strong Technology', 'Powerhouse Management', 'Proton', 'Mullvad', 'NordVPN', 'Surfshark', 'ExpressVPN',
        'CyberGhost', 'Windscribe', 'TunnelBear', 'ZenMate', 'Private Internet Access', 'HideMyAss', 'QuadraNet', 'Psychz', 'ColoCrossing',
        'NFOrce', 'i3D.net', 'Melbicom', 'Green Floid', 'LogicWeb', 'Creanova', 'EstNOC', 'Ip-Only', 'GSL Networks', 'Tzulo', 'ReliableSite',
        'Feral Hosting', 'Spine Telecom', 'Anexia', 'HostRoyale', 'Keminet', 'Cablenet Communications', 'NovoServe', 'Leaseweb', 'DataCamp Limited',
        'Heficed', 'HostHatch', 'FranTech', 'PONYNET', 'BuyVM', 'Performive', 'G-Core Labs', 'M247 Europe', 'Clouvider', 'Datacamp', 'PacketHub',
        // SPECIFIC HIGH RISK / PROXY PROVIDERS
        'Digital Energy Technologies', 'Stark Industries', 'Web Horizon', 'Misaka', 'AEZA', 'XTom', 'TerraHost', 'ServerAstra',
        'HostKey', 'Inferno Solutions', 'Lawrenceville Plasma Physics', 'UAB Cherry Servers', 'Veesp', 'PQ Hosting', 'Zappie Host'
    ],
    // MEDIUM: Budget/Offshore VPS (Often abused for VPNs, but distinct from Major Clouds)
    medium: [
        'Zenlayer', 'Cogent', 'Clouvider', 'Nexeon', 'PONYNET', 'FranTech', 'BuyVM', 'Limestone', 'Hivelocity', 'TerraHost',
        'WebHorizon', 'Nexus Bytes', 'Glesys', 'Host Universal', 'Latitude.sh', 'AEZA', 'XTom', 'Misaka', 'Performive', 'Contabo',
        'Netcup', 'HostHatch', 'HostEONS', 'DataWagon', 'G-Core', 'Gcore', 'Selectel', 'UpCloud', 'Time4VPS'
    ],
    // LOW: Major Clouds & Enterprise Infrastructure (Safe, but definitely NOT "Standard ISPs")
    low: [
        'Amazon', 'AWS', 'Google', 'Google Cloud', 'Microsoft', 'Azure', 'Oracle', 'Oracle Cloud', // Big Cloud
        'Alibaba', 'Aliyun', 'Tencent', 'Tencent Cloud', 'Huawei', 'Huawei Cloud', 'Baidu',
        'IBM', 'IBM Cloud', 'SoftLayer', 'Rackspace', 'Salesforce', 'SAP', // Tier 1 Enterprise
        'Hetzner', 'OVH', 'OVHcloud', 'Linode', 'Akamai', 'DigitalOcean', 'Vultr', 'Scaleway',
        'Equinix', 'Equinix Metal', 'Leaseweb', 'Servers.com', 'Choopa', 'The Constant Company',
        'Cloudflare', 'Fastly', 'Edgio', 'Limelight', 'EdgeCast', 'CDN77', 'BunnyCDN', // CDNs & EDGE Nets
        'Imperva', 'Incapsula', 'Sucuri', 'StackPath', 'KeyCDN', 'CacheFly',
        'Fly.io', 'Heroku', 'Netlify', 'Vercel', 'Render', 'Railway', 'DigitalOcean App Platform', // PAAS & App Hosts
        'WP Engine', 'Kinsta', 'Pantheon',
        'GoDaddy', 'Bluehost', 'HostGator', 'DreamHost', 'IONOS', '1&1', 'Strato', // MASS Web Hosts
        'Hostinger', 'SiteGround', 'Namecheap', 'InMotion', 'A2 Hosting', 'InterServer',
        'Liquid Web',
        // --- REGIONAL ---
        'Sakura Internet', 'GMO Internet', // Japan
        'Naver Cloud', 'Kakao Corp',       // Korea
        'Yandex', 'Selectel', 'VK Cloud', 'Mail.Ru', // Russia/CIS
        'Kingsoft', 'JD Cloud', 'UCloud',  // China (Tier 2)
        'UOL', 'Locaweb',                  // Brazil / LATAM
        'Tata Communications'              // India
    ]
  },
  vpnASNs: [
    "AS60729", "AS4224", "AS396507", "AS200651", "AS1921", "AS202425",
    "AS9009", "AS39351", "AS212238", "AS60068", "AS216025", "AS208172", "AS136787", "AS147049", "AS207137", "AS141039", "AS204957", "AS47583",
    "AS53667", "AS25369", "AS62651", "AS22363", "AS56655", "AS200019", "AS11878", "AS203020", "AS9009", "AS210644", "AS44477",
    "AS57523", "AS213896", "AS49981", "AS397423"
  ]
};