# WiredAlter IP Service

An IP intelligence API and web service. It provides real-time geolocation, ISP/ASN details, and risk analysis (VPN, Proxy, and Tor detection).

## Features

* **Dual Interface:** Web UI for humans, JSON/Text API for scripts (`curl`/`wget`).
* **Deep Risk Analysis:** Detects VPNs, Datacenters, Tor Exit Nodes, and Public Proxies.
* **Smart Labeling:** Distinguishes between "Safe Cloud" (AWS/Oracle) and "High Risk" (VPN Hosting) infrastructure.
* **Privacy First:** Runs entirely in-memory. Zero logging of user IP addresses.
* **Dockerized:** Simple deployment with `docker compose`.

## Usage

### Web Interface

Visit the homepage, [ip.wiredalter.com](https://ip.wiredalter.com) to see your own connection details, or search for any IP address manually.

### CLI / API Access

Developers can use standard tools to fetch data:

```bash
# Get plain text IP
curl ip.wiredalter.com

# Get full JSON data
curl ip.wiredalter.com/json
```

**Example JSON Response:**

```json
{
  "ip": "1.1.1.1",
  "country": "Australia",
  "city": "Brisbane",
  "asn": "AS13335",
  "org": "Cloudflare, Inc.",
  "usage_type": "Cloud Infrastructure",
  "is_proxy": false,
  "threat": "None"
}
```

## Installation (Self-Hosted)

1. **Clone the repository:**

```bash
git clone https://github.com/buildplan/ip-service.git
cd ip-service
```

2. **Download Databases:**

You must place the following databases in the `ip_dbs/` folder:

* `GeoLite2-City.mmdb` (MaxMind)
* `GeoLite2-ASN.mmdb` (MaxMind)
* `IP2LOCATION-LITE-DB11.IPV6.BIN` (IP2Location)
* `IP2PROXY-LITE-PX11.IPV6.BIN` (IP2Location)

3. **Run with Docker:**

**Option 1: Quick Start**: Default Docker compose file in the repo uses pre-build image from the files in this repo `ghcr.io/buildplan/ip-service:latest`

```bash
docker compose up -d

```

**Option 2: Build from Source** To build the image locally, edit `docker-compose.yml` to use `build: .` instead of `image: ...`. This is useful if you want to modify the frontend (e.g., branding, colors, or layout). Docker hardened node image is used in the `Dockerfile` in this repo. If you building locally login to dhi.io (`docker login dhi.io`) or Change the Dockerfile to `nodhi.Dockerfile`.

1. **Customize the UI (Optional):** You can edit `views/index.html` to change the look and feel of the service before building.
2. **Edit `docker-compose.yml`:**

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

## License & Attributions

This project is licensed under the **MIT License**.

This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com).  
This product uses IP2Location LITE data available from [https://lite.ip2location.com](https://lite.ip2location.com).
