#!/bin/bash

# -------- CONFIGURATION ---------
SCRIPT_DIR=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
LOG_FILE="${SCRIPT_DIR}/ip2loc-db-update.log"
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}
ENV_FILE="${SCRIPT_DIR}/.env_ip2db"
if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
else
    log "⚠️ Warning: $ENV_FILE not found. Relying on system environment variables or defaults."
fi
# Define variables using .env values OR defaults
TOKEN="${IP2_TOKEN:-token_in_env}"
CODE="${DB_CODE:-DB11LITEBINIPV6}"
DEST_DIR="${DEST_DIR:-/ip-service/ip_dbs}"
TARGET_FILE="${TARGET_FILE:-IP2LOCATION-LITE-DB11.IPV6.BIN}"
COMPOSE_FILE="${COMPOSE_FILE:-/path/to/ip-service/docker-compose-prod.yml}"
SERVICE_NAME="${SERVICE_NAME:-ip-echo}"
# -----------------------------------

# Ensure destination directory exists
mkdir -p "$DEST_DIR"

log "⬇️  Starting update check for code: $CODE..."

# 3. Download to a temp file
wget -q -O /tmp/px11.zip "https://www.ip2location.com/download?token=$TOKEN&file=$CODE"

# 4. Check if the zip is valid
if ! unzip -t /tmp/px11.zip > /dev/null 2>&1; then
    # GET FILE SIZE for debugging
    FILE_SIZE=$(du -h /tmp/px11.zip | cut -f1)

    log "❌ Error: Downloaded file is not a valid ZIP."
    log "ℹ️  Downloaded File Size: $FILE_SIZE"
    log "ℹ️  Possible causes: Daily Limit Exceeded (file is HTML) or Token Invalid."

    # Clean up and exit
    rm -f /tmp/px11.zip
    exit 1
fi

# 5. Compare Checksums
NEW_MD5=$(unzip -p /tmp/px11.zip "*.BIN" | md5sum | awk '{print $1}')

if [ -f "$DEST_DIR/$TARGET_FILE" ]; then
    OLD_MD5=$(md5sum "$DEST_DIR/$TARGET_FILE" | awk '{print $1}')
else
    OLD_MD5="none"
fi

log "ℹ️  New MD5: $NEW_MD5"
log "ℹ️  Old MD5: $OLD_MD5"

# 6. Decide to Update or Not
if [ "$NEW_MD5" != "$OLD_MD5" ]; then
    log "✅ Update detected! Installing new database..."

    # Extract to temp file, then move.
    TEMP_TARGET="$DEST_DIR/${TARGET_FILE}.tmp"

    if unzip -p /tmp/px11.zip "*.BIN" > "$TEMP_TARGET"; then
        mv "$TEMP_TARGET" "$DEST_DIR/$TARGET_FILE"

        # Restart the container
        log "🚀 Restarting Docker container..."
        if docker compose -f "$COMPOSE_FILE" restart "$SERVICE_NAME"; then
             log "🎉 Success: Database updated and service restarted."
        else
             log "⚠️ Warning: Database updated, but Docker restart failed."
        fi
    else
        log "❌ Error: Failed to extract to temp file."
        rm -f "$TEMP_TARGET"
        exit 1
    fi
else
    log "👍 No update needed. Database is already current."
fi

# 7. Cleanup
rm -f /tmp/px11.zip
alis@f2VPS:~/scripts/geolite2-update $
