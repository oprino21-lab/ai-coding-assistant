#!/bin/bash
# Kill any process already using PORT (default 5000) before starting
PORT=${PORT:-5000}
EXISTING=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "[start.sh] Killing existing process on port $PORT (PID $EXISTING)"
  kill -9 $EXISTING 2>/dev/null
  sleep 0.5
fi
exec node src/index.js
