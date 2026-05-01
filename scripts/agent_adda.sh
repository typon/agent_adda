#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${AGENT_ADDA_RUNTIME_DIR:-$ROOT_DIR/.runtime}"
PGDATA="${AGENT_ADDA_PGDATA:-$RUNTIME_DIR/postgres}"
RUN_DIR="$RUNTIME_DIR/run"
LOG_DIR="$RUNTIME_DIR/logs"
POSTGRES_PORT="${AGENT_ADDA_POSTGRES_PORT:-15432}"
BACKEND_PORT="${AGENT_ADDA_BACKEND_PORT:-4322}"
FRONTEND_PORT="${AGENT_ADDA_FRONTEND_PORT:-4321}"
POSTGRES_DB="${AGENT_ADDA_POSTGRES_DB:-agent_adda}"
POSTGRES_USER="${AGENT_ADDA_POSTGRES_USER:-agent_adda}"
POSTGRES_PASSWORD="${AGENT_ADDA_POSTGRES_PASSWORD:-agent_adda}"
DATABASE_URL="${AGENT_ADDA_DATABASE_URL:-postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB}"
BACKEND_BIN="$ROOT_DIR/backend/target/debug/agent_adda_backend"
ASTRO_BIN="$ROOT_DIR/node_modules/.bin/astro"

PIDS=()

usage() {
  cat <<EOF
Usage: scripts/agent_adda.sh

Runs Agent Adda directly on the host:
  - Postgres on 127.0.0.1:$POSTGRES_PORT
  - Rocket backend on 0.0.0.0:$BACKEND_PORT
  - Astro frontend on 0.0.0.0:$FRONTEND_PORT

Logs: $LOG_DIR
EOF
}

die() {
  printf 'agent_adda: %s\n' "$*" >&2
  exit 1
}

require_executable() {
  local path="$1"
  local install_hint="$2"
  if [[ -z "$path" || ! -x "$path" ]]; then
    die "missing executable: $path"$'\n'"$install_hint"
  fi
}

port_is_busy() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" | tail -n +2 | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

wait_for_postgres() {
  local tries=80
  while (( tries > 0 )); do
    if "$PG_BIN_DIR/pg_isready" -h 127.0.0.1 -p "$POSTGRES_PORT" -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    tries=$((tries - 1))
  done
  die "Postgres did not become ready. See $LOG_DIR/postgres.log"
}

ensure_database() {
  local psql=("$PG_BIN_DIR/psql" -h 127.0.0.1 -p "$POSTGRES_PORT" -d postgres -v ON_ERROR_STOP=1 -qtA)
  if ! "${psql[@]}" -c "SELECT 1 FROM pg_roles WHERE rolname = '$POSTGRES_USER'" | grep -q '^1$'; then
    "${psql[@]}" -c "CREATE ROLE $POSTGRES_USER LOGIN PASSWORD '$POSTGRES_PASSWORD'"
  fi
  if ! "${psql[@]}" -c "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB'" | grep -q '^1$'; then
    "${psql[@]}" -c "CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER"
  fi
}

cleanup() {
  local status=$?
  trap - INT TERM EXIT
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait >/dev/null 2>&1 || true
  exit "$status"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

USER_HOME="${HOME:-}"
if [[ -z "$USER_HOME" ]]; then
  USER_HOME="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true)"
fi
USER_HOME="${USER_HOME:-$ROOT_DIR/.runtime/home}"
BREW_BIN="${BREW_BIN:-$(command -v brew || true)}"
BREW_PREFIX="${HOMEBREW_PREFIX:-}"
if [[ -z "$BREW_PREFIX" && -n "$BREW_BIN" ]]; then
  BREW_PREFIX="$("$BREW_BIN" --prefix 2>/dev/null || true)"
fi
POSTGRES_PREFIX="${AGENT_ADDA_POSTGRES_PREFIX:-}"
if [[ -z "$POSTGRES_PREFIX" && -n "$BREW_BIN" ]]; then
  POSTGRES_PREFIX="$("$BREW_BIN" --prefix postgresql@17 2>/dev/null || true)"
fi
PG_BIN_DIR="${AGENT_ADDA_PG_BIN_DIR:-${POSTGRES_PREFIX:+$POSTGRES_PREFIX/bin}}"
if [[ -z "$PG_BIN_DIR" ]]; then
  POSTGRES_BIN="$(command -v postgres || true)"
  PG_BIN_DIR="${POSTGRES_BIN:+$(dirname "$POSTGRES_BIN")}"
fi
CARGO_BIN="${CARGO_BIN:-${BREW_PREFIX:+$BREW_PREFIX/bin/cargo}}"
if [[ -z "$CARGO_BIN" || ! -x "$CARGO_BIN" ]]; then
  CARGO_BIN="$(command -v cargo || true)"
fi
NPM_BIN="${NPM_BIN:-${BREW_PREFIX:+$BREW_PREFIX/bin/npm}}"
if [[ -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
  NPM_BIN="$(command -v npm || true)"
fi
CODEX_HOME="${CODEX_HOME:-$USER_HOME/.codex}"
ALLOWED_HOSTS="${AGENT_ADDA_ALLOWED_HOSTS:-localhost,127.0.0.1}"

if [[ -n "$PG_BIN_DIR" ]]; then
  export PATH="$PG_BIN_DIR:$PATH"
fi
if [[ -n "$BREW_PREFIX" && -d "$BREW_PREFIX/bin" ]]; then
  export PATH="$BREW_PREFIX/bin:$PATH"
fi
require_executable "$PG_BIN_DIR/postgres" "Install it with: brew install postgresql@17"
require_executable "$PG_BIN_DIR/initdb" "Install it with: brew install postgresql@17"
require_executable "$PG_BIN_DIR/pg_isready" "Install it with: brew install postgresql@17"
require_executable "$PG_BIN_DIR/psql" "Install it with: brew install postgresql@17"
require_executable "$CARGO_BIN" "Install it with: brew install rust"
require_executable "$NPM_BIN" "Install it with: brew install node"
require_executable "$ASTRO_BIN" "Install frontend dependencies with: npm install"

mkdir -p "$PGDATA" "$RUN_DIR" "$LOG_DIR"

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  "$PG_BIN_DIR/initdb" \
    --encoding=UTF8 \
    --locale=en_US.UTF-8 \
    --auth-local=trust \
    --auth-host=trust \
    "$PGDATA" >"$LOG_DIR/initdb.log" 2>&1
fi

if port_is_busy "$POSTGRES_PORT"; then
  die "port $POSTGRES_PORT is already in use. Stop the process using it or set AGENT_ADDA_POSTGRES_PORT."
fi
if port_is_busy "$BACKEND_PORT"; then
  die "port $BACKEND_PORT is already in use. Stop the old backend or set AGENT_ADDA_BACKEND_PORT."
fi
if port_is_busy "$FRONTEND_PORT"; then
  die "port $FRONTEND_PORT is already in use. Stop the old frontend or set AGENT_ADDA_FRONTEND_PORT."
fi

trap cleanup INT TERM EXIT

LC_ALL=en_US.UTF-8 "$PG_BIN_DIR/postgres" \
  -D "$PGDATA" \
  -h 127.0.0.1 \
  -p "$POSTGRES_PORT" \
  -k "$RUN_DIR" \
  >"$LOG_DIR/postgres.log" 2>&1 &
PIDS+=("$!")

wait_for_postgres
ensure_database

"$CARGO_BIN" build --manifest-path "$ROOT_DIR/backend/Cargo.toml"

(
  cd "$ROOT_DIR"
  AGENT_ADDA_DATABASE_URL="$DATABASE_URL" \
  CODEX_HOME="$CODEX_HOME" \
  HOME="$USER_HOME" \
  ROCKET_ADDRESS=0.0.0.0 \
  ROCKET_PORT="$BACKEND_PORT" \
  "$BACKEND_BIN"
) >"$LOG_DIR/backend.log" 2>&1 &
PIDS+=("$!")

(
  cd "$ROOT_DIR/frontend"
  AGENT_ADDA_BACKEND_TARGET="http://127.0.0.1:$BACKEND_PORT" \
  AGENT_ADDA_ALLOWED_HOSTS="$ALLOWED_HOSTS" \
  "$ASTRO_BIN" dev --host 0.0.0.0 --port "$FRONTEND_PORT" --allowed-hosts "$ALLOWED_HOSTS"
) >"$LOG_DIR/frontend.log" 2>&1 &
PIDS+=("$!")

cat <<EOF
Agent Adda is running on the host.
  Frontend: http://127.0.0.1:$FRONTEND_PORT
  Backend:  http://127.0.0.1:$BACKEND_PORT/api/v1/health
  Postgres: 127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB
  Logs:     $LOG_DIR

Press Ctrl-C to stop Agent Adda.
EOF

set +e
wait -n "${PIDS[@]}"
child_status=$?
set -e
die "one Agent Adda process exited with status $child_status. See logs in $LOG_DIR"
