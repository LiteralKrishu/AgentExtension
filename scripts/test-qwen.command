#!/bin/bash
# Runs the real-model checks against LM Studio on this Mac. Double-click it in Finder, or run it from a terminal.
# Starts TrueForge on 127.0.0.1:8790 when nothing is listening there, and stops it again afterwards.
# Results: test-results/model-latest.md. Full output: test-results/qwen-run.log.
cd "$(dirname "$0")/.." || exit 1
mkdir -p test-results
LOG=test-results/qwen-run.log
FORGE_URL=${AGENTEXTENSION_TEST_FORGE_URL:-http://127.0.0.1:8790}
MODEL_URL=${AGENTEXTENSION_TEST_MODEL_URL:-http://127.0.0.1:1234/v1}
{
  echo "Started $(date)"
  if ! curl -s -m 5 "$MODEL_URL/models" >/dev/null; then
    echo "LM Studio is not answering at $MODEL_URL. Start its server and load Qwen 3.5 9B, then run this again."
    exit 2
  fi
  echo "LM Studio models: $(curl -s -m 5 "$MODEL_URL/models" | tr -d '\n' | head -c 600)"
  FORGE_PID=
  if ! curl -s -m 5 -o /dev/null "$FORGE_URL"; then
    echo "Starting TrueForge (log: test-results/trueforge.log)"
    HOST=127.0.0.1 PORT=8790 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' \
      npx --yes @truefoundry/trueforge@0.184.2 > test-results/trueforge.log 2>&1 &
    FORGE_PID=$!
    for _ in $(seq 1 180); do curl -s -m 2 -o /dev/null "$FORGE_URL" && break; sleep 1; done
    curl -s -m 5 -o /dev/null "$FORGE_URL" || { echo "TrueForge did not start. See test-results/trueforge.log."; kill "$FORGE_PID" 2>/dev/null; exit 3; }
  fi
  [ -d node_modules ] || npm install
  npm run test:qwen -- "$@"
  STATUS=$?
  if [ -n "$FORGE_PID" ]; then lsof -ti tcp:8790 -sTCP:LISTEN | xargs kill 2>/dev/null; kill "$FORGE_PID" 2>/dev/null; fi
  echo "Finished $(date) with exit code $STATUS"
  exit $STATUS
} 2>&1 | tee "$LOG"
echo
echo "Done. Results are in test-results/model-latest.md. You can close this window."
