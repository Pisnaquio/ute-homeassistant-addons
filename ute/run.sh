#!/usr/bin/with-contenv bashio

set -euo pipefail

APP_DIR=/app
RUNTIME_NAME="${UTE_RUNTIME_NAME:-ute}"
export UTE_RUNTIME_NAME="${RUNTIME_NAME}"
RUNTIME_ROOT="/data/${RUNTIME_NAME}"
DATA_DIR="${RUNTIME_ROOT}/data"
REPORT_DIR="${RUNTIME_ROOT}/reportes"
LOG_DIR="${RUNTIME_ROOT}/logs"
TEMP_DIR="${RUNTIME_ROOT}/temp"
mkdir -p "${DATA_DIR}" "${REPORT_DIR}" "${LOG_DIR}" "${TEMP_DIR}"

export PORT=3000
if [[ -x /usr/bin/chromium-browser ]]; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
elif [[ -x /usr/bin/chromium ]]; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
fi

cd "${APP_DIR}"
exec node web.js
