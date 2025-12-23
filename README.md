# WiredAlter IP Service

A IP intelligence API and web service. It provides real-time geolocation, ISP/ASN details, and risk analysis (VPN, Proxy, and Tor detection).

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
git clone https://codeberg.org/buildplan/ip-service.git
cd ip-service

```

2. **Download Databases:**

You must place the following databases in the `ip_dbs/` folder:

* `GeoLite2-City.mmdb` (MaxMind)
* `GeoLite2-ASN.mmdb` (MaxMind)
* `IP2LOCATION-LITE-DB11.IPV6.BIN` (IP2Location)
* `IP2PROXY-LITE-PX11.IPV6.BIN` (IP2Location)

3. **Run with Docker:**

```bash
docker compose up -d --build

```

## License & Attributions

This project is licensed under the **MIT License**.

This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com).  
This product uses IP2Location LITE data available from [https://lite.ip2location.com](https://lite.ip2location.com).

