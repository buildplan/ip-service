#!/usr/bin/env bash
#
# GeoLite2 Database Auto-Update
#
# Description: This script checks for updates to the GeoLite2-Country database from
# the node-geolite2-redist GitHub repository, downloads it if it's newer,
# places it in a specified directory, and sends notifications on success/failure.
#
# Requirements: curl, tar, find, mv, cp, (sha256sum OR shasum), chown, chmod. jq only required for Discord.
# Usage: Configure DEST_DIR and notification settings or create a geolite2.env and add:
# -----
# GeoLite2 Update Configuration (example: https://github.com/buildplan/docker/blob/main/Pangolin/geolite2.env)
# Set permissions: chmod 600 geolite2.env
#
# Required: Destination directory for database
# export DEST_DIR="/var/lib/geoip"
#
# Optional: Enable ntfy notifications
# export NTFY_ENABLED=true
# export NTFY_TOPIC="geolite2-updates"
# export NTFY_SERVER="https://ntfy.self-host.url"
# export NTFY_TOKEN="tk_..."  # Bearer token for private topics
#
# Optional: Enable Discord notifications
# export DISCORD_ENABLED=false
# export DISCORD_WEBHOOK_URL="https://discord.com/api/..."
# -----
# set strict per missions to .env file chmod 600 /path/to/.secrets/geolite2.env
# then run the script - ./geolite2-update.sh
# Example systemd cron: Wed/Sat at 06:30, (systemd example: https://github.com/buildplan/docker/blob/main/Pangolin/geolite-systemd.md)
# or crontab 30 6 * * 3,6 /path/to/geolite2-update.sh
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

# Get the physical directory of the script, resolving any symlinks
SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
# Path to secure env file.
ENV_FILE="${SCRIPT_DIR}/.env.geolite2"

# --- Configuration ---
DEST_DIR="${DEST_DIR:-/path/to/your/config/}" # <-- Change this to actual config directory.
DB_FILENAME="GeoLite2-City.mmdb" # Final db name.
DOWNLOAD_URL="https://github.com/GitSquared/node-geolite2-redist/raw/refs/heads/master/redist/GeoLite2-City.tar.gz"
LOG_FILE="${SCRIPT_DIR}/geolite2-update.log" # Log file path (ensure writable by runner) or leave default and change below
LOG_MAX_LINES="500"

# ntfy
NTFY_ENABLED=false
NTFY_TOPIC="${NTFY_TOPIC:-ntfy_topic_here}"       # <-- Change this in .env
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"     # Default server, change for self-hosted
NTFY_TOKEN="${NTFY_TOKEN:-}"                      # <-- Add token if you use private topics

# Discord
DISCORD_ENABLED=false
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-webhook_url_here}" # <-- Change this

# --- Internal defaults / runtime ---
CURL_OPTS="--retry 3 --retry-delay 5 --retry-connrefused --connect-timeout 10 --max-time 300"
TMP_DIR=""
LOCK_DIR=""
LOCK_CREATED=false

# Preferred helpers (may be empty)
IONICE=$(command -v ionice || true)
NICE=$(command -v nice || true)

run_io() {
    if [ -n "$IONICE" ]; then
        ionice -c2 -n7 "$@"
    else
        "$@"
    fi
}

run_cpu() {
    if [ -n "$NICE" ]; then
        nice -n 10 "$@"
    else
        "$@"
    fi
}

# Portable filesize (bytes) - supports GNU stat and BSD/macOS
filesize() {
    local file="$1"
    if stat --version >/dev/null 2>&1; then
        stat -c%s "$file"
    else
        stat -f%z "$file"
    fi
}

# Portable SHA256 computation: prefer sha256sum, fallback to shasum -a 256
compute_sha256() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        run_cpu sha256sum "$file" | awk '{print $1}'
    else
        run_cpu shasum -a 256 "$file" | awk '{print $1}'
    fi
}

log_message() {
    local level="$1"
    local message="$2"
    local ts
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    # Try append to LOG_FILE, fallback to stdout if not writable
    echo "${ts} [${level}] - ${message}" | tee -a "$LOG_FILE" 2>/dev/null || echo "${ts} [${level}] - ${message}"

    if command -v systemd-cat > /dev/null 2>&1; then
        local syslog_level="info" # default
        case "$level" in
            SUCCESS) syslog_level="notice" ;;
            INFO)    syslog_level="info" ;;
            WARNING) syslog_level="warning" ;;
            ERROR)   syslog_level="err" ;;
        esac
        echo "$message" | systemd-cat -t "geolite2-update" -p "$syslog_level" || true
    fi
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

# shellcheck disable=SC2329
cleanup() {
    if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR" || true
        log_message "INFO" "Cleaned up temporary directory: $TMP_DIR"
    fi
    if [ "$LOCK_CREATED" = true ] && [ -n "${LOCK_DIR:-}" ] && [ -d "$LOCK_DIR" ]; then
        rm -rf "$LOCK_DIR" || true
        log_message "INFO" "Removed lock directory: $LOCK_DIR"
    fi
}

# Create temp dir early so logs can fall back to it
TMP_DIR=$(mktemp -d)

# If LOG_FILE not writable, fallback to tmp log
if [ -e "$LOG_FILE" ] && [ ! -w "$LOG_FILE" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [WARNING] - Log file $LOG_FILE not writable. Using $TMP_DIR/geolite2-update.log instead."
    LOG_FILE="$TMP_DIR/geolite2-update.log"
elif [ ! -e "$LOG_FILE" ]; then
    # Try to create it, or fall back to temp.
    touch "$LOG_FILE" 2>/dev/null || LOG_FILE="$TMP_DIR/geolite2-update.log"
fi

# Truncate old log if too long
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE" 2>/dev/null || true)" -gt "$LOG_MAX_LINES" ]; then
    tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE" || true
    echo "$(date '+%Y-%m-%d %H:%M:%S') [INFO] - Log file truncated to last $LOG_MAX_LINES lines." >> "$LOG_FILE" 2>/dev/null || true
fi

trap cleanup EXIT

echo "" | tee -a "$LOG_FILE" 2>/dev/null || echo ""
echo "==================== GeoLite2 Update Run Starting ====================" | tee -a "$LOG_FILE" 2>/dev/null || echo "=== Starting Run ==="

log_message "INFO" "Starting GeoLite2 database update script."
log_message "INFO" "Created temporary directory at $TMP_DIR"

# --- Locking: create atomic lockdir with stale lock detection ---
LOCK_BASE="/tmp"
if [ -w /var/lock ]; then
    LOCK_BASE="/var/lock"
fi
LOCK_DIR="${LOCK_BASE}/geolite2-update.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -f "${LOCK_DIR}/pid" ]; then
        old_pid=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
        if [ -n "$old_pid" ] && ! kill -0 "$old_pid" 2>/dev/null; then
            log_message "WARNING" "Removing stale lock (PID $old_pid no longer exists)"
            rm -rf "$LOCK_DIR" || true
            if mkdir "$LOCK_DIR" 2>/dev/null; then
                LOCK_CREATED=true
                echo "$$" > "${LOCK_DIR}/pid"
                log_message "INFO" "Acquired lock after removing stale lock: $LOCK_DIR"
            else
                log_message "ERROR" "Failed to acquire lock even after stale lock removal"
                exit 1
            fi
        else
            log_message "INFO" "Another instance is running (PID $old_pid). Exiting."
            exit 0
        fi
    else
        log_message "WARNING" "Lock directory exists but no PID file found. Attempting cleanup."
        rm -rf "$LOCK_DIR" || true
        if mkdir "$LOCK_DIR" 2>/dev/null; then
            LOCK_CREATED=true
            echo "$$" > "${LOCK_DIR}/pid"
            log_message "INFO" "Acquired lock after cleaning orphaned lock directory"
        else
            log_message "ERROR" "Failed to acquire lock"
            exit 1
        fi
    fi
else
    LOCK_CREATED=true
    echo "$$" > "${LOCK_DIR}/pid"
    log_message "INFO" "Acquired lock: $LOCK_DIR"
fi

# --- Load secrets from .env file if it exists ---
if [ -f "$ENV_FILE" ]; then
    log_message "INFO" "Loading secrets from $ENV_FILE"
    . "$ENV_FILE"
else
    log_message "INFO" "No $ENV_FILE found, relying on pre-set environment variables."
fi

# --- Validate configuration and prerequisites ---
if [[ "$DEST_DIR" == "/path/to/your/config/" ]]; then
    err_msg="Configuration needed: Set DEST_DIR variable to your actual config directory."
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi
[[ "${DEST_DIR}" != */ ]] && DEST_DIR="${DEST_DIR}/"
if [ ! -d "$DEST_DIR" ]; then
    err_msg="Destination directory does not exist: $DEST_DIR"
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi
if [ ! -w "$DEST_DIR" ]; then
    err_msg="Destination directory is not writable: $DEST_DIR"
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi

# Basic required command checks
for cmd in curl tar find mv cp; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        err_msg="Required command '$cmd' is not installed."
        log_message "ERROR" "$err_msg"
        send_failure_notification "$err_msg"
        exit 1
    fi
done

# Ensure we have a SHA utility
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    err_msg="Neither sha256sum nor shasum is installed; cannot compute file hashes."
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi

# Discord validation (if enabled)
if [ "$DISCORD_ENABLED" = true ]; then
    if [ "$DISCORD_WEBHOOK_URL" == "webhook_url_here" ] || [ -z "$DISCORD_WEBHOOK_URL" ]; then
        err_msg="Discord is enabled but DISCORD_WEBHOOK_URL is not configured. Disabling Discord for this run."
        log_message "WARNING" "$err_msg"
        DISCORD_ENABLED=false
    elif [[ "$DISCORD_WEBHOOK_URL" =~ ^https://(canary\.|ptb\.)?discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$ ]]; then
        err_msg="DISCORD_WEBHOOK_URL does not appear to be a valid Discord webhook URL. Disabling Discord for this run."
        log_message "WARNING" "$err_msg"
        DISCORD_ENABLED=false
    else
        log_message "INFO" "Discord notification validated."
    fi
fi

# ntfy validation (if enabled)
if [ "$NTFY_ENABLED" = true ]; then
    if [ "$NTFY_TOPIC" == "ntfy_topic_here" ] || [ -z "$NTFY_TOPIC" ]; then
        err_msg="ntfy is enabled but NTFY_TOPIC is not configured. Disabling ntfy for this run."
        log_message "WARNING" "$err_msg"
        NTFY_ENABLED=false
    elif [[ ! "$NTFY_TOPIC" =~ ^[a-zA-Z0-9._-]+$ ]]; then
        err_msg="NTFY_TOPIC contains invalid characters. Disabling ntfy for this run."
        log_message "WARNING" "$err_msg"
        NTFY_ENABLED=false
    else
        log_message "INFO" "ntfy notification validated: topic=$NTFY_TOPIC"
    fi
    if [[ ! "$NTFY_SERVER" =~ ^https?:// ]]; then
        log_message "WARNING" "NTFY_SERVER does not look like a valid URL: $NTFY_SERVER"
    fi
fi

# If Discord is enabled, ensure jq exists
if [ "$DISCORD_ENABLED" = true ] && ! command -v jq >/dev/null 2>&1; then
    log_message "WARNING" "jq not found; disabling Discord notifications for this run."
    DISCORD_ENABLED=false
fi

# 2. Disk space check
need_kb=51200
avail_tmp=$(df -kP "$TMP_DIR" | awk 'NR==2{print $4}')
avail_dest=$(df -kP "$DEST_DIR" | awk 'NR==2{print $4}')
if [ "$avail_tmp" -lt "$need_kb" ] || [ "$avail_dest" -lt "$need_kb" ]; then
  err_msg="Insufficient free space (need ~${need_kb} KB) in TMP or DEST"
  log_message "ERROR" "$err_msg"
  send_failure_notification "$err_msg"
  exit 1
fi

# 3. Download the db
ARCHIVE_PATH="$TMP_DIR/GeoLite2-Country.tar.gz"
log_message "INFO" "Downloading database from $DOWNLOAD_URL"
if ! curl -LsSf $CURL_OPTS -o "$ARCHIVE_PATH" "$DOWNLOAD_URL"; then
    err_msg="Failed to download the database archive."
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi

if [ ! -s "$ARCHIVE_PATH" ] || [ "$(filesize "$ARCHIVE_PATH")" -lt 10240 ]; then
    err_msg="Downloaded archive is unexpectedly small or empty: $(filesize "$ARCHIVE_PATH") bytes"
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi

# 4. Extract the database into TMP_DIR
log_message "INFO" "Extracting archive..."
if ! run_io tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"; then
    err_msg="Failed to extract the database archive."
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi

# 5. Find the new database file (first match only)
NEW_DB_PATH=$(find "$TMP_DIR" -type f -name "$DB_FILENAME" -print -quit || true)
if [ -z "$NEW_DB_PATH" ]; then
    err_msg="Could not find '$DB_FILENAME' in the extracted archive."
    log_message "ERROR" "$err_msg"
    send_failure_notification "$err_msg"
    exit 1
fi

# Ensure the found file is under TMP_DIR (mitigate tar path traversal)
case "$NEW_DB_PATH" in
    "$TMP_DIR"/*) ;;
    *)
        err_msg="Discovered DB path ($NEW_DB_PATH) is outside temporary directory; aborting."
        log_message "ERROR" "$err_msg"
        send_failure_notification "$err_msg"
        exit 1
        ;;
esac

# 6. Compare with existing database
EXISTING_DB_PATH="${DEST_DIR}${DB_FILENAME}"
UPDATE_NEEDED=false

if [ ! -f "$EXISTING_DB_PATH" ]; then
    log_message "INFO" "No existing database found. Proceeding with installation."
    UPDATE_NEEDED=true
else
    log_message "INFO" "Existing database found. Computing hashes..."
    EXISTING_HASH=$(compute_sha256 "$EXISTING_DB_PATH")
    NEW_HASH=$(compute_sha256 "$NEW_DB_PATH")
    log_message "INFO" "Existing DB hash: $EXISTING_HASH"
    log_message "INFO" "New DB hash:     $NEW_HASH"
    if [ "$EXISTING_HASH" != "$NEW_HASH" ]; then
        log_message "INFO" "Hashes differ. An update is required."
        UPDATE_NEEDED=true
    else
        log_message "INFO" "Hashes are identical. Database is already up-to-date."
    fi
fi

# 7. Perform the update when needed
if [ "$UPDATE_NEEDED" = true ]; then
    TEMP_DB_IN_DEST="${EXISTING_DB_PATH}.tmp"
    log_message "INFO" "Staging new database to $TEMP_DB_IN_DEST"

    # Try move first; if it fails (likely cross-filesystem), fallback to cp -p
    if mv "$NEW_DB_PATH" "$TEMP_DB_IN_DEST" 2>/dev/null; then
        log_message "INFO" "Moved new DB into destination temp file."
    else
        log_message "INFO" "mv failed (possibly cross-FS). Falling back to copy/preserve."
        if ! cp -p "$NEW_DB_PATH" "$TEMP_DB_IN_DEST"; then
            err_msg="Failed to move/copy the new database to the destination directory."
            log_message "ERROR" "$err_msg"
            send_failure_notification "$err_msg"
            exit 1
        fi
        rm -f "$NEW_DB_PATH" || true
    fi

    # Apply ownership/permissions relative to existing DB if present
    if [ -f "$EXISTING_DB_PATH" ]; then
        log_message "INFO" "Matching ownership and permissions to existing database."
        if ! chown --reference="$EXISTING_DB_PATH" "$TEMP_DB_IN_DEST" 2>/dev/null; then
            log_message "WARNING" "Could not set ownership on new database file. Check script permissions."
        fi
        if ! chmod --reference="$EXISTING_DB_PATH" "$TEMP_DB_IN_DEST" 2>/dev/null; then
            log_message "WARNING" "Could not set permissions on new database file."
        fi
    else
        chmod 0644 "$TEMP_DB_IN_DEST" || true
        log_message "INFO" "Set permissions to 0644 for new database installation."
    fi

    log_message "INFO" "Atomically replacing old database..."
    if ! mv -f "$TEMP_DB_IN_DEST" "$EXISTING_DB_PATH"; then
        err_msg="Failed to atomically rename the new database into place."
        log_message "ERROR" "$err_msg"
        send_failure_notification "$err_msg"
        rm -f "$TEMP_DB_IN_DEST"
        exit 1
    fi

    log_message "SUCCESS" "Database has been successfully updated."
    send_success_notification "The GeoLite2-City.mmdb database was successfully updated."

else
    log_message "INFO" "Update check complete. No new version found."
    send_checkin_notification "Database is already up-to-date. No action needed."
fi

exit 0
