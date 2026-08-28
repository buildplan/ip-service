# WiredAlter IP Service

An IP intelligence API and web service. It provides real-time geolocation, ISP/ASN details, and risk analysis (VPN, Proxy, and Tor detection).

## Features

* **Dual Interface:** Web UI for human users and a JSON/Text API for automated scripts (`curl`/`wget`).
* **Deep Risk Analysis:** Detects VPNs, Datacenters, Tor Exit Nodes, and Public Proxies.
* **Integrated Threat Intelligence:** Aggregates real-time reputation data from CrowdSec, AbuseIPDB, GreenSnow, FireHOL, and SpamCop.
* **Smart Labeling:** Distinguishes between "Safe Cloud" infrastructure (e.g., AWS/Oracle content delivery) and high-risk VPN/Proxy hosting.
* **Privacy First:** Engineered to run entirely in-memory with zero logging of user IP addresses.
* **Dockerized:** Simplified deployment using `docker compose`.

## Usage

### Web Interface

Visit the homepage, [ip.wiredalter.com](https://ip.wiredalter.com) to see your own connection details, or search for any IP address manually.

### CLI / API Access

Developers and system administrators can use standard command-line tools to fetch data.

**Plain Text (IP Address Only):**
Returns the detected public IP address as a string.

```bash
curl ip.wiredalter.com
```

**JSON Output (Full Metadata):**
Returns a complete data object containing location, network, and threat intelligence details.

```bash
curl ip.wiredalter.com/json
```

**Manual IP Lookup:**
Append `?ip=` to query a specific address.

```bash
curl "ip.wiredalter.com/json?ip=8.8.8.8"
```

**Example JSON Response:**

```json
{
  "ip": "8.8.8.8",
  "hostname": "dns.google",
  "country": "United States",
  "city": "Mountain View",
  "region": "California",
  "timezone": "America/Chicago",
  "coordinates": "37.751, -97.822",
  "latitude": 37.751,
  "longitude": -97.822,
  "zip": "N/A",
  "asn": "AS15169",
  "org": "GOOGLE",
  "is_proxy": false,
  "proxy_type": "No",
  "usage_type": "Cloud Infrastructure",
  "threat": "None",
  "provider": "N/A"
}
```

## Installation (Self-Hosted)

### Prerequisites

1. **Clone the repository:**

```bash
git clone https://github.com/buildplan/ip-service.git
cd ip-service
```

2. **Download Databases:**

The service requires the following database files to be placed in the `ip_dbs/` directory:

* `GeoLite2-City.mmdb` (MaxMind)
* `GeoLite2-ASN.mmdb` (MaxMind)
* `IP2LOCATION-LITE-DB11.IPV6.BIN` (IP2Location)
* `IP2PROXY-LITE-PX11.IPV6.BIN` (IP2Location)

### Deployment

**Option 1: Quick Start (Pre-built Image)**
Uses the pre-built image from the container registry. Ideal for quick deployment without modification.

1. Create a `docker-compose.yml` file or use the default provided in the repo.
2. Start the service:

```bash
docker compose up -d
```

**Option 2: Build from Source**
Build the image locally. This is required if you wish to modify the frontend templates (e.g., `views/index.html`) or backend logic.

1. Edit `docker-compose.yml` to use `build: .` instead of the remote image.
2. Configure your environment variables for Threat Intelligence APIs (optional but recommended).

**Example `docker-compose.yml` configuration:**

```bash
services:
  ip-echo:
    # Instead of pulling an image, we build from the cloned repo
    build: .
    image: ip-service:local  # Optional: tags the built image locally
    container_name: ip-echo
    restart: unless-stopped
    
    # Run as secure non-root user
    user: "node"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

    # Lock to localhost so only npm can talk to it
    ports:
      - "127.0.0.1:4040:4040"

    environment:
      - NODE_ENV=production
      - PORT=4040
      # Optional: Removes the CARTO "API key required" watermark from the map.
      # Get a free key (5M tile requests/month) at https://carto.com/basemaps/apikey
      - CARTO_API_KEY=your_carto_key_here
      # Optional: Add API keys for enhanced threat intelligence
      - ABUSEIPDB_API_KEY=your_key_here
      - CROWDSEC_API_KEY=your_key_here
    
    # Map DBs exactly where the code looks (/app/db)
    # Ensure you have the 'ip_dbs' folder populated locally!
    volumes:
      - ./ip_dbs:/app/db:ro

    deploy:
      resources:
        limits:
          cpus: '0.50'
          memory: 256M

  # --- NGINX PROXY MANAGER ---
  npm:
    image: 'jc21/nginx-proxy-manager:2.13.5'
    container_name: npm
    restart: unless-stopped
    
    # Host mode is critical for accurate IP detection
    network_mode: host

    volumes:
      - ./npm/data:/data
      - ./npm/letsencrypt:/etc/letsencrypt
    
    deploy:
      resources:
        limits:
          cpus: '0.50'
          memory: 256M
```

Then build and run::

```bash
docker compose up -d --build
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default: `4040`) |
| `CARTO_API_KEY` | No | Removes the "API key required" watermark from CARTO basemap tiles. Free key at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey) |
| `ABUSEIPDB_API_KEY` | No | Enables AbuseIPDB reputation checks |
| `CROWDSEC_API_KEY` | No | Enables CrowdSec threat intelligence |
| `SNIFFCAT_API_KEY` | No | Enables SniffCat VPN/proxy detection |
| `SPAMVERIFY_API_KEY` | No | Enables SpamVerify reputation checks |
| `CROWDSEC_URL` | No | CrowdSec local API URL (default: `http://crowdsec:8080`) |
| `MAX_MEMORY_MB` | No | Memory limit for the `/health` endpoint check |

> **Note on `CARTO_API_KEY`:** The key is public by design — it will be visible in browser network requests (this is CARTO's intended model). Store it in your `.env` file alongside your other API keys. The service degrades gracefully if the key is absent: the map still works but shows the watermark.

## License & Attributions

This project is licensed under the **[MIT License](LICENSE)**.

* This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com).
* This product uses IP2Location LITE data available from [https://lite.ip2location.com](https://lite.ip2location.com).
* Threat intelligence data aggregated from [CrowdSec](https://www.crowdsec.net/), [AbuseIPDB](https://www.abuseipdb.com/), [GreenSnow](https://greensnow.co/), [FireHOL](https://iplists.firehol.org/), and [SpamCop](https://www.spamcop.net/).
* Fallback data, in case local database has issues, comes from the API of [https://www.geojs.io](https://www.geojs.io/).
* Map tiles provided by [CARTO](https://carto.com/attributions) and [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
