#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  DATABASE_URL="$TEST_DATABASE_URL" NODE_ENV=test npm test
  exit
fi
PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
TASK_TEST_DIR="$(mktemp -d /tmp/motuo-postgres.XXXXXX)"
TASK_TEST_PORT="$(node -e "const n=require('net').createServer(); n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})")"
finish() {
 "$PG_BIN/pg_ctl" -D "$TASK_TEST_DIR/db" -m fast stop >/dev/null 2>&1 || true
 rm -rf "$TASK_TEST_DIR"
}
trap finish EXIT INT TERM
"$PG_BIN/initdb" -D "$TASK_TEST_DIR/db" -A trust -U motuo --no-instructions >"$TASK_TEST_DIR/init.log"
"$PG_BIN/pg_ctl" -D "$TASK_TEST_DIR/db" -o "-h 127.0.0.1 -p $TASK_TEST_PORT -k $TASK_TEST_DIR" -l "$TASK_TEST_DIR/postgres.log" -w start
"$PG_BIN/createdb" -h 127.0.0.1 -p "$TASK_TEST_PORT" -U motuo motuo_test
DATABASE_URL="postgresql://motuo@127.0.0.1:$TASK_TEST_PORT/motuo_test" NODE_ENV=test npm test
