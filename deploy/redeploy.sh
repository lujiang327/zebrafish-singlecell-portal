#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PULL_CODE=1

usage() {
  cat <<'EOF'
Usage: ./deploy/redeploy.sh [--no-pull]

Build and redeploy the production Docker Compose application.

Options:
  --no-pull  Do not run git pull --ff-only before deployment.
  -h, --help Show this help message.
EOF
}

for argument in "$@"; do
  case "${argument}" in
    --no-pull)
      PULL_CODE=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: ${argument}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

cd "${PROJECT_ROOT}"

require_command docker
require_command curl

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is unavailable. Expected: docker compose" >&2
  exit 1
fi

if [[ ! -f compose.yaml ]]; then
  echo "compose.yaml was not found in ${PROJECT_ROOT}" >&2
  exit 1
fi

if [[ ${PULL_CODE} -eq 1 && -d .git ]]; then
  require_command git
  log "Updating application code"
  git pull --ff-only
else
  log "Skipping Git pull"
fi

required_h5ad_files=(
  "annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad"
  "AC_subtypes_reproduced.h5ad"
  "bc_9_sample_guca1b_gt2_mikiko_no_contam_26_28.h5ad"
  "corrected_RGC_annotated_clustered_corrected_doubletRemoved_Zebrafishes.h5ad"
)

missing_files=0
for h5ad_file in "${required_h5ad_files[@]}"; do
  if [[ ! -f "${h5ad_file}" ]]; then
    echo "Missing required dataset: ${PROJECT_ROOT}/${h5ad_file}" >&2
    missing_files=1
  fi
done

if [[ ${missing_files} -ne 0 ]]; then
  exit 1
fi

if [[ ! -f .env ]]; then
  log "Warning: .env is absent; Docker Compose defaults will be used"
fi

mkdir -p data/processed

log "Building production images while the current site remains online"
docker compose build

timestamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir=""
if find data/processed -mindepth 1 -print -quit | grep -q .; then
  backup_dir="data/processed.backup-${timestamp}"
  log "Backing up current processed data to ${backup_dir}"
  cp -a data/processed "${backup_dir}"
fi

log "Stopping current application containers"
docker compose down

log "Preprocessing all registered H5AD datasets"
if ! docker compose --profile tools run --rm preprocess; then
  failed_dir="data/processed.failed-${timestamp}"
  echo "Preprocessing failed. Preserving failed output in ${failed_dir}." >&2
  mv data/processed "${failed_dir}"

  if [[ -n "${backup_dir}" && -d "${backup_dir}" ]]; then
    mv "${backup_dir}" data/processed
    echo "Restored the previous processed-data backup." >&2
    echo "Attempting to restart the previous application." >&2
    docker compose up -d --remove-orphans || true
  else
    mkdir -p data/processed
    echo "No previous processed-data backup was available." >&2
  fi
  exit 1
fi

log "Starting production containers"
if ! docker compose up -d --remove-orphans; then
  docker compose logs --tail=100 backend frontend || true
  exit 1
fi

published_address="$(docker compose port frontend 80 2>/dev/null || true)"
published_port="${published_address##*:}"
if [[ -z "${published_port}" || "${published_port}" == "${published_address}" ]]; then
  published_port="8080"
fi

health_url="http://127.0.0.1:${published_port}/api/health"
log "Waiting for ${health_url}"

healthy=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 "${health_url}" >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ ${healthy} -ne 1 ]]; then
  echo "Deployment started, but the health endpoint did not become ready." >&2
  docker compose ps
  docker compose logs --tail=100 backend frontend || true
  exit 1
fi

log "Deployment is healthy"
docker compose ps
curl --fail --silent --show-error "${health_url}"
printf '\n'

if [[ -n "${backup_dir}" && -d "${backup_dir}" ]]; then
  log "Previous processed data remains available at ${backup_dir}"
fi

log "Redeployment completed successfully"
