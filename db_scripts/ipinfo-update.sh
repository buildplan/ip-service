#!/usr/bin/env bash

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

# Get the physical directory of the script
SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
ENV_FILE="${SCRIPT_DIR}/.env.ipinfo"

# --- Configuration ---
DEST_DIR="${DEST_DIR:-/path/to/your/db/folder}" # <-- Change this
DB_FILENAME="ipinfo-asn.mmdb"
LOG_FILE="${SCRIPT_DIR}/ipinfo-update.log"
LOG_MAX_LINES="500"
DOCKER_CONTAINER="ip-echo" # <-- Change this

# Tokens & Notifications
IPINFO_TOKEN="${IPINFO_TOKEN:-your_token_here}" # <-- set in .env.ipinfo
NTFY_ENABLED=false
NTFY_TOPIC="${NTFY_TOPIC:-ntfy_topic_here}"
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"
DISCORD_ENABLED=false
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-webhook_url_here}"

# --- Internal defaults / runtime ---
CURL_OPTS="--retry 3 --retry-delay 5 --retry-connrefused --connect-timeout 10 --max-time 300"
TMP_DIR=""
LOCK_DIR=""
LOCK_CREATED=false

# Portable SHA256 computation
compute_sha256() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    else
        shasum -a 256 "$file" | awk '{print $1}'
    fi
}

log_message() {
    local level="$1"
    local message="$2"
    local ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "${ts} [${level}] - ${message}" | tee -a "$LOG_FILE" 2>/dev/null || true
}

# Notification: ntfy
send_notification_ntfy() {
    local title="$1"
    local message="$2"
    local priority="${3:-3}"

    if [ "$NTFY_ENABLED" != true ]; then
        return
    fi

    if [ "$NTFY_TOPIC" == "ntfy_topic_here" ] || [ -z "$NTFY_TOPIC" ]; then
        log_message "WARNING" "ntfy notification is enabled but NTFY_TOPIC is not set."
        return
    fi

    local auth_args=()
    if [ -n "$NTFY_TOKEN" ]; then
        auth_args=(-H "Authorization: Bearer $NTFY_TOKEN")
    fi

    log_message "INFO" "Sending ntfy notification to $NTFY_TOPIC..."

    if ! curl -fsS -o /dev/null -L $CURL_OPTS \
        -H "Title: $title" \
        -H "Tags: database" \
        -H "Priority: $priority" \
        "${auth_args[@]}" \
        -d "$message (Host: $(hostname))" \
        "$NTFY_SERVER/$NTFY_TOPIC"; then
        log_message "WARNING" "Failed to send ntfy notification."
    fi
}

# Notification: Discord (requires jq to compose JSON)
send_notification_discord() {
    local title="$1"
    local description="$2"
    local color="${3:-3066993}"

    if [ "$DISCORD_ENABLED" != true ]; then
        return
    fi

    if [ "$DISCORD_WEBHOOK_URL" == "webhook_url_here" ] || [ -z "$DISCORD_WEBHOOK_URL" ]; then
        log_message "WARNING" "Discord notification enabled but DISCORD_WEBHOOK_URL is not set."
        return
    fi

    if ! command -v jq >/dev/null 2>&1; then
        log_message "WARNING" "Discord notifications enabled but jq not installed; skipping Discord notification."
        return
    fi

    log_message "INFO" "Sending Discord notification..."
    local server_name timestamp JSON_PAYLOAD
    server_name=$(hostname)
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    JSON_PAYLOAD=$(jq -n \
      --arg title "$title" \
      --arg description "$description" \
      --arg color "$color" \
      --arg server_name "$server_name" \
      --arg timestamp "$timestamp" \
      '{
         "username": "GeoLite2 Updater",
         "avatar_url": "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/geo-guessr.png",
         "embeds": [{
            "title": $title,
            "description": $description,
            "color": ($color | tonumber),
            "footer": {"text": ("Host: " + $server_name)},
            "timestamp": $timestamp
         }]
       }')

    if [ -z "$JSON_PAYLOAD" ]; then
        log_message "WARNING" "Failed to build Discord payload."
        return
    fi

    if ! curl -fsS -o /dev/null -L -H "Content-Type: application/json" -d "$JSON_PAYLOAD" "$DISCORD_WEBHOOK_URL"; then
        log_message "WARNING" "Failed to send Discord notification."
    fi
}

send_failure_notification() {
    local message="$1"
    local title="GeoLite2 Update FAILED"
    local discord_color=15158332 # red
    send_notification_ntfy "$title" "$message" 4
    send_notification_discord "$title" "$message" "$discord_color"
}

send_success_notification() {
    local message="$1"
    local title="GeoLite2 DB Updated"
    local discord_color=3066993 # green
    send_notification_ntfy "$title" "$message" 3
    send_notification_discord "$title" "$message" "$discord_color"
}

send_checkin_notification() {
    local message="$1"
    local title="GeoLite2 Check Complete"
    local discord_color=9807270 # gray
    send_notification_ntfy "$title" "$message" 2
    send_notification_discord "$title" "$message" "$discord_color"
}


cleanup() {
    if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR" || true; fi
    if [ "$LOCK_CREATED" = true ] && [ -n "${LOCK_DIR:-}" ] && [ -d "$LOCK_DIR" ]; then rm -rf "$LOCK_DIR" || true; fi
}
trap cleanup EXIT
TMP_DIR=$(mktemp -d)

# --- Load secrets ---
if [ -f "$ENV_FILE" ]; then
    . "$ENV_FILE"
fi

if [ "$IPINFO_TOKEN" == "your_token_here" ] || [ -z "$IPINFO_TOKEN" ]; then
    log_message "ERROR" "IPINFO_TOKEN is not set. Please add it to $ENV_FILE."
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    log_message "ERROR" "Required command 'jq' is not installed. Please install it (apt install jq)."
    exit 1
fi

log_message "INFO" "Starting IPinfo database update."

# 1. Fetch Official Checksum from API
log_message "INFO" "Fetching official checksum from IPinfo API..."
API_RESPONSE=$(curl -s "https://ipinfo.io/data/free/asn.mmdb/checksums?token=${IPINFO_TOKEN}")
OFFICIAL_HASH=$(echo "$API_RESPONSE" | jq -r '.checksums.sha256 // empty')

if [ -z "$OFFICIAL_HASH" ]; then
    log_message "ERROR" "Failed to retrieve valid checksum from IPinfo. Response: $API_RESPONSE"
    exit 1
fi
log_message "INFO" "Official Checksum: $OFFICIAL_HASH"

# 2. Compare with Existing DB
EXISTING_DB_PATH="${DEST_DIR}/${DB_FILENAME}"
if [ -f "$EXISTING_DB_PATH" ]; then
    EXISTING_HASH=$(compute_sha256 "$EXISTING_DB_PATH")
    log_message "INFO" "Local DB Checksum: $EXISTING_HASH"

    if [ "$EXISTING_HASH" == "$OFFICIAL_HASH" ]; then
        log_message "INFO" "Local database is perfectly up-to-date. Skipping download to save API quota."
        exit 0
    fi
else
    log_message "INFO" "No existing DB found at $EXISTING_DB_PATH. Proceeding with download."
fi

# 3. Download the DB
TMP_DB_PATH="$TMP_DIR/$DB_FILENAME"
DOWNLOAD_URL="https://ipinfo.io/data/free/asn.mmdb?token=${IPINFO_TOKEN}"

log_message "INFO" "Downloading new database..."
if ! curl -LsSf $CURL_OPTS -o "$TMP_DB_PATH" "$DOWNLOAD_URL"; then
    log_message "ERROR" "Failed to download IPinfo database."
    exit 1
fi

# 4. Verify Download Integrity
DOWNLOADED_HASH=$(compute_sha256 "$TMP_DB_PATH")
log_message "INFO" "Verifying downloaded file... (Hash: $DOWNLOADED_HASH)"

if [ "$DOWNLOADED_HASH" != "$OFFICIAL_HASH" ]; then
    log_message "ERROR" "Checksum mismatch! Downloaded file is corrupted. Aborting update."
    exit 1
fi
log_message "INFO" "Checksum verification passed."

# 5. Apply the Update
log_message "INFO" "Atomically replacing old database..."
chmod 0644 "$TMP_DB_PATH"
if ! mv -f "$TMP_DB_PATH" "$EXISTING_DB_PATH"; then
    log_message "ERROR" "Failed to move database into place."
    exit 1
fi

log_message "SUCCESS" "IPinfo database successfully updated."
send_success_notification "IPinfo ASN DB updated successfully."

exit 0
