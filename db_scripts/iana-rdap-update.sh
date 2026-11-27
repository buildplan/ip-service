#!/usr/bin/env bash
#
# IANA RDAP Bootstrap Auto-Update (IPv4 & IPv6)
#
# Description: Downloads the official IANA RDAP bootstrap registry files
# (ipv4.json and ipv6.json, ~35 KB total) into DEST_DIR as rdap-ipv4.json and
# rdap-ipv6.json so ip-service can query authoritative RIR RDAP servers directly
# without relying on rdap.org redirects.
#
# Requirements: curl, mv, chmod, (sha256sum OR shasum). jq or node optional for JSON validation.
# Optional config file: db_scripts/.env.iana-rdap (chmod 600)
#   export DEST_DIR="/home/user/ip-service/ip_dbs"
#   export NTFY_ENABLED=false
#   export NTFY_TOPIC="rdap-updates"
#   export NTFY_SERVER="https://ntfy.sh"
#   export NTFY_TOKEN=""
#   export DISCORD_ENABLED=false
#   export DISCORD_WEBHOOK_URL=""

set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
ENV_FILE="${SCRIPT_DIR}/.env.iana-rdap"

# --- Configuration ---
DEST_DIR="${DEST_DIR:-/path/to/your/ip_dbs}" # <-- Set in .env.iana-rdap
LOG_FILE="${SCRIPT_DIR}/iana-rdap-update.log"
LOG_MAX_LINES="500"

IPV4_URL="https://data.iana.org/rdap/ipv4.json"
IPV6_URL="https://data.iana.org/rdap/ipv6.json"
IPV4_FILENAME="rdap-ipv4.json"
IPV6_FILENAME="rdap-ipv6.json"

NTFY_ENABLED=false
NTFY_TOPIC="${NTFY_TOPIC:-ntfy_topic_here}"
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"
NTFY_TOKEN="${NTFY_TOKEN:-}"

DISCORD_ENABLED=false
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-webhook_url_here}"

CURL_OPTS="--retry 3 --retry-delay 5 --retry-connrefused --connect-timeout 10 --max-time 60"
TMP_DIR=""

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
    local ts
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "${ts} [${level}] - ${message}" | tee -a "$LOG_FILE" 2>/dev/null || echo "${ts} [${level}] - ${message}"
}

send_notification_ntfy() {
    local title="$1"
    local message="$2"
    local priority="${3:-3}"

    if [ "$NTFY_ENABLED" != true ]; then
        return
    fi
    if [ "$NTFY_TOPIC" = "ntfy_topic_here" ] || [ -z "$NTFY_TOPIC" ]; then
        log_message "WARNING" "ntfy enabled but NTFY_TOPIC is not set."
        return
    fi

    local auth_args=()
    if [ -n "${NTFY_TOKEN:-}" ]; then
        auth_args=(-H "Authorization: Bearer $NTFY_TOKEN")
    fi

    if ! curl -fsS -o /dev/null -L $CURL_OPTS \
        -H "Title: $title" \
        -H "Tags: database" \
        -H "Priority: $priority" \
        ${auth_args[@]+"${auth_args[@]}"} \
        -d "$message (Host: $(hostname))" \
        "$NTFY_SERVER/$NTFY_TOPIC"; then
        log_message "WARNING" "Failed to send ntfy notification."
    fi
}

send_notification_discord() {
    local title="$1"
    local description="$2"
    local color="${3:-3066993}"

    if [ "$DISCORD_ENABLED" != true ]; then
        return
    fi
    if [ "$DISCORD_WEBHOOK_URL" = "webhook_url_here" ] || [ -z "$DISCORD_WEBHOOK_URL" ]; then
        log_message "WARNING" "Discord enabled but DISCORD_WEBHOOK_URL is not set."
        return
    fi
    if ! command -v jq >/dev/null 2>&1; then
        log_message "WARNING" "Discord enabled but jq not installed; skipping notification."
        return
    fi

    local server_name timestamp json_payload
    server_name=$(hostname)
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    json_payload=$(jq -n \
        --arg title "$title" \
        --arg description "$description" \
        --arg color "$color" \
        --arg server_name "$server_name" \
        --arg timestamp "$timestamp" \
        '{
            "username": "IANA RDAP Updater",
            "embeds": [{
                "title": $title,
                "description": $description,
                "color": ($color | tonumber),
                "footer": {"text": ("Host: " + $server_name)},
                "timestamp": $timestamp
            }]
        }')

    if ! curl -fsS -o /dev/null -L -H "Content-Type: application/json" -d "$json_payload" "$DISCORD_WEBHOOK_URL"; then
        log_message "WARNING" "Failed to send Discord notification."
    fi
}

validate_rdap_json() {
    local file="$1"
    if [ ! -s "$file" ]; then
        return 1
    fi
    if command -v jq >/dev/null 2>&1; then
        jq -e '.services | type == "array" and length > 0' "$file" >/dev/null 2>&1
    elif command -v node >/dev/null 2>&1; then
        node -e 'const fs = require("fs"); const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Array.isArray(j.services) || j.services.length === 0) process.exit(1);' "$file" >/dev/null 2>&1
    else
        grep -q '"services"' "$file"
    fi
}

cleanup() {
    if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR" || true
    fi
}
trap cleanup EXIT
TMP_DIR=$(mktemp -d)

# Truncate log if needed
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_LINES" ]; then
    tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE" || true
fi

# Load optional secrets/config
if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
fi

if [ "$DEST_DIR" = "/path/to/your/ip_dbs" ]; then
    log_message "ERROR" "DEST_DIR is not configured. Set DEST_DIR in $ENV_FILE or environment."
    exit 1
fi

mkdir -p "$DEST_DIR"
if [ ! -w "$DEST_DIR" ]; then
    log_message "ERROR" "Destination directory is not writable: $DEST_DIR"
    exit 1
fi

for cmd in curl mv chmod; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        log_message "ERROR" "Required command '$cmd' is not installed."
        exit 1
    fi
done

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    log_message "ERROR" "Neither sha256sum nor shasum is installed."
    exit 1
fi

updated_files=()

update_file() {
    local url="$1"
    local filename="$2"
    local tmp_path="${TMP_DIR}/${filename}"
    local dest_path="${DEST_DIR%/}/${filename}"
    local stage_path="${dest_path}.tmp"

    log_message "INFO" "Fetching ${url}..."
    if ! curl -LsSf $CURL_OPTS -o "$tmp_path" "$url"; then
        log_message "ERROR" "Failed to download ${url}."
        return 1
    fi

    if ! validate_rdap_json "$tmp_path"; then
        log_message "ERROR" "Downloaded ${filename} is not a valid IANA RDAP bootstrap JSON."
        return 1
    fi

    local new_hash old_hash=""
    new_hash=$(compute_sha256 "$tmp_path")
    if [ -f "$dest_path" ]; then
        old_hash=$(compute_sha256 "$dest_path")
    fi

    if [ "$new_hash" = "$old_hash" ]; then
        log_message "INFO" "${filename} is already up-to-date."
        return 0
    fi

    if ! cp "$tmp_path" "$stage_path" || ! chmod 0644 "$stage_path" || ! mv -f "$stage_path" "$dest_path"; then
        rm -f "$stage_path" || true
        log_message "ERROR" "Failed to install ${filename} into ${DEST_DIR}."
        return 1
    fi
    log_message "SUCCESS" "Updated ${filename} (SHA256: ${new_hash})."
    updated_files+=("$filename")
}

log_message "INFO" "Starting IANA RDAP bootstrap update."

failed=false
if ! update_file "$IPV4_URL" "$IPV4_FILENAME"; then
    failed=true
fi
if ! update_file "$IPV6_URL" "$IPV6_FILENAME"; then
    failed=true
fi

if [ "$failed" = true ]; then
    send_notification_ntfy "IANA RDAP Update FAILED" "One or more IANA RDAP bootstrap files failed to update." 4
    send_notification_discord "IANA RDAP Update FAILED" "One or more IANA RDAP bootstrap files failed to update." 15158332
    exit 1
fi

if [ "${#updated_files[@]}" -gt 0 ]; then
    summary="Updated IANA RDAP bootstrap files: ${updated_files[*]}"
    send_notification_ntfy "IANA RDAP Updated" "$summary" 3
    send_notification_discord "IANA RDAP Updated" "$summary" 3066993
fi

exit 0
