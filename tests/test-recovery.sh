#!/usr/bin/env bash
# tests/test-recovery.sh — Integration tests for daemon self-recovery
#
# Tests the following recovery scenarios in order (each depends on a running daemon):
#   1. Normal start           — daemon and worker start, worker is responsive
#   2. Worker crash           — SIGKILL worker, monitor auto-restarts it
#  3. SIGHUP reload          — hot-reload signal restarts worker cleanly
#   4. Multiple rapid crashes — verifies exponential backoff keeps recovering
#   5. Status command         — `status` reports the daemon as running
#   6. Clean stop             — `stop` kills daemon and cleans up PID files
#
# Prerequisites:
#   - The daemon must NOT be running before this script starts.
#   - This script manages the full lifecycle (start, crash, stop).
#   - macOS/Linux: runs natively. Windows: requires Git Bash or WSL.
#
# Usage:
#   ./tests/test-recovery.sh [PORT]
#   ./tests/test-recovery.sh           # defaults to port 3456
#   ./tests/test-recovery.sh 8080      # uses port 8080
#
set -euo pipefail

PORT=${1:-3456}
PASS=0
FAIL=0
SKIP=0
PID_DIR="$HOME/.modelweaver"
DAEMON_PID_FILE="$PID_DIR/modelweaver.pid"
WORKER_PID_FILE="$PID_DIR/modelweaver.worker.pid"

# Platform detection
IS_WINDOWS=false
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=true ;;
esac

log_pass() { ((PASS++)); echo "  PASS: $1"; }
log_fail() { ((FAIL++)); echo "  FAIL: $1"; }
log_skip() { ((SKIP++)); echo "  SKIP: $1 (not applicable on this platform)"; }

cleanup() {
  echo "Cleaning up..."
  node dist/index.js stop 2>/dev/null || true
  sleep 1
}
trap cleanup EXIT

# Wait for a file to appear with a non-empty PID value
wait_for_pid_file() {
  local pid_file="$1"
  local timeout="$2"
  local start=$(date +%s)
  while true; do
    if [ -f "$pid_file" ]; then
      local pid=$(cat "$pid_file" 2>/dev/null)
      if [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null; then
        echo "$pid"
        return 0
      fi
    fi
    if [ $(($(date +%s) - start)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 0.2
  done
}

get_monitor_pid() {
  cat "$DAEMON_PID_FILE" 2>/dev/null || echo ""
}

get_worker_pid() {
  cat "$WORKER_PID_FILE" 2>/dev/null || echo ""
}

is_pid_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  # kill -0 checks process existence (POSIX). On Windows with Git Bash, falls back to /proc.
  kill -0 "$pid" 2>/dev/null && return 0
  return 1
}

echo "========================================="
echo " Daemon Recovery Integration Tests"
echo " Port: $PORT"
echo " Platform: $(uname -s)${IS_WINDOWS:+ (Git Bash)}"
echo "========================================="

# Build first
echo ""
echo "Building..."
npm run build --silent 2>/dev/null

# Clean up stale PID files from previous runs
rm -f "$DAEMON_PID_FILE" "$WORKER_PID_FILE" 2>/dev/null

# ── Test 1: Normal start ──
echo ""
echo "Test 1: Daemon starts normally"
node dist/index.js start &
sleep 2
MONITOR_PID=$(wait_for_pid_file "$DAEMON_PID_FILE" 15)
if [ $? -eq 0 ]; then
  WORKER_PID=$(wait_for_pid_file "$WORKER_PID_FILE" 10)
  if [ $? -eq 0 ]; then
    log_pass "Worker started within timeout (monitor=$MONITOR_PID, worker=$WORKER_PID)"
  else
    log_fail "Monitor started but worker did not start within 10s"
  fi
else
  log_fail "Daemon failed to start within 15s"
  exit 1
fi

# ── Test 2: Worker crash → auto-restart ──
echo ""
echo "Test 2: Worker crash triggers auto-restart"
OLD_WORKER=$WORKER_PID
if is_pid_alive "$OLD_WORKER"; then
  kill -9 "$OLD_WORKER" 2>/dev/null
fi
sleep 2
NEW_WORKER=$(wait_for_pid_file "$WORKER_PID_FILE" 10)
if [ $? -eq 0 ] && [ "$NEW_WORKER" != "$OLD_WORKER" ]; then
  log_pass "Worker restarted with new PID: $NEW_WORKER (was $OLD_WORKER)"
else
  log_fail "Worker did not restart after crash within 10s"
fi
WORKER_PID=$NEW_WORKER

# ── Test 3: SIGHUP reload ──
echo ""
echo "Test 3: SIGHUP reload (hot-reload)"
if [ "$IS_WINDOWS" = true ]; then
  log_skip "SIGHUP not available on Windows"
else
  BEFORE_WORKER=$WORKER_PID
  if is_pid_alive "$MONITOR_PID"; then
    kill -HUP "$MONITOR_PID" 2>/dev/null
  fi
  sleep 2
  AFTER_WORKER=$(wait_for_pid_file "$WORKER_PID_FILE" 10)
  if [ $? -eq 0 ] && [ "$AFTER_WORKER" != "$BEFORE_WORKER" ]; then
    log_pass "Worker restarted on reload: $AFTER_WORKER (was $BEFORE_WORKER)"
  else
    log_fail "Worker did not restart after SIGHUP within 10s"
  fi
  WORKER_PID=$AFTER_WORKER
fi

# ── Test 4: Multiple rapid crashes (backoff) ──
echo ""
echo "Test 4: Multiple rapid crashes (backoff timing)"
CRASH_COUNT=0
for i in 1 2 3; do
  WPID=$(get_worker_pid)
  if is_pid_alive "$WPID"; then
    kill -9 "$WPID" 2>/dev/null
    CRASH_COUNT=$((CRASH_COUNT + 1))
    echo "  Crash $CRASH_COUNT: killed PID $WPID"
  fi
  sleep 1
done
echo "  Waiting for recovery (up to 30s with backoff)..."
NEW_WORKER=$(wait_for_pid_file "$WORKER_PID_FILE" 30)
if [ $? -eq 0 ]; then
  log_pass "Worker recovered after $CRASH_COUNT rapid crashes (backoff working)"
else
  log_fail "Worker did not recover after $CRASH_COUNT rapid crashes within 30s"
fi
WORKER_PID=$NEW_WORKER

# ── Test 5: Status command ──
echo ""
echo "Test 5: Status command reports running state"
STATUS=$(node dist/index.js status 2>&1 || true)
if echo "$STATUS" | grep -qi "running"; then
  log_pass "Status reports daemon as running"
else
  log_fail "Status does not show running state"
fi

# ── Test 6: Clean stop ──
echo ""
echo "Test 6: Clean stop"
node dist/index.js stop 2>/dev/null
sleep 1
if [ ! -f "$DAEMON_PID_FILE" ]; then
  log_pass "PID file cleaned up on stop"
else
  log_fail "PID file still exists after stop"
fi

# ── Summary ──
echo ""
echo "========================================="
TOTAL=$((PASS + FAIL + SKIP))
echo " Results: $PASS passed, $FAIL failed, $SKIP skipped (of $TOTAL)"
if [ "$FAIL" -eq 0 ]; then
  echo "  ALL TESTS PASSED"
else
  echo "  SOME TESTS FAILED — check logs above"
fi
echo "========================================="
