#!/usr/bin/env bash
# Phase 10 local trials with the largest context each installed model can load. Local models only, $0 spend.
# Usage: bash scripts/phase10-local-trials.sh            (smoke all models, then the full corpus on the best one)
#        SMOKE_ONLY=1 bash scripts/phase10-local-trials.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
LMS="${LMS:-$(command -v lms || echo "$HOME/.lmstudio/bin/lms")}"
FORGE=http://127.0.0.1:8790
LMURL=http://127.0.0.1:1234/v1
STAMP=$(date +%Y%m%d-%H%M)
export AGENTEXTENSION_TEST_FORGE_URL=$FORGE
export AGENTEXTENSION_TEST_EDITOR_APP_ROOT="/Applications/Visual Studio Code.app/Contents/Resources/app"
export AGENTEXTENSION_TEST_FLASK_ROOT="${AGENTEXTENSION_TEST_FLASK_ROOT:-/private/tmp/agentextension-upgrade-flask}"

[ -x "$LMS" ] || { echo "LM Studio CLI (lms) not found. In LM Studio run: Developer > Install lms CLI."; exit 1; }
curl -sf -m 5 "$LMURL/models" >/dev/null || "$LMS" server start >/dev/null 2>&1 || true
curl -sf -m 5 "$LMURL/models" >/dev/null || { echo "LM Studio's server is not running at $LMURL. Open LM Studio and start the server."; exit 1; }
if [ ! -d "$AGENTEXTENSION_TEST_FLASK_ROOT/.git" ]; then
  git clone -q --depth 1 --branch 3.1.3 https://github.com/pallets/flask "$AGENTEXTENSION_TEST_FLASK_ROOT"
fi
# Flask acceptance runs `python` from PATH with the versions its reference check was verified with.
# Two levels below /private/tmp so the check sandbox can read the whole environment, not just its bin folder.
VENV=/private/tmp/agentextension/flask-venv
if ! "$VENV/bin/python" -c "import flask, pytest, click, dotenv" 2>/dev/null; then
  PY=$(command -v python3.14 || command -v python3)
  mkdir -p "$(dirname "$VENV")" && "$PY" -m venv "$VENV"
  "$VENV/bin/python" -m pip install -q flask==3.1.3 pytest==8.4.2 click==8.5.1 python-dotenv==1.2.4
fi
export PATH="$VENV/bin:$PATH"
python -c "import flask, pytest, click, dotenv" || { echo "Could not prepare Python for the Flask checks."; exit 1; }

# Start TrueForge on 8790 unless it is already running.
# Same settings as the extension's managed server: IPv4 loopback, and local model URLs allowed past the SSRF guard.
# Restart a server this script started earlier so it picks up these settings.
pkill -f 'trueforge.*--port 8790' 2>/dev/null && sleep 2 || true
if ! curl -s -m 3 -o /dev/null "$FORGE"; then
  (cd trueforge/server && HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost","[::1]"]' SENTRY_ENABLED=false nohup npx --no-install @truefoundry/trueforge --port 8790 > "$ROOT/test-results/trueforge-$STAMP.log" 2>&1 &)
  for _ in $(seq 60); do curl -s -m 2 -o /dev/null "$FORGE" && break; sleep 2; done
  curl -s -m 3 -o /dev/null "$FORGE" || { echo "TrueForge did not start; see test-results/trueforge-$STAMP.log"; exit 1; }
fi

# Model keys as LM Studio lists them; override with MODELS="key1 key2".
if [ -z "${MODELS:-}" ]; then
  MODELS=$("$LMS" ls --json | node -e '
    const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const keys = list.filter(m => (m.type ?? "llm") === "llm").map(m => m.modelKey ?? m.path);
    const pick = [/gpt-oss-20b/i, /coder-30b/i, /qwen3?\.?5.*9b/i].map(r => keys.find(k => r.test(k))).filter(Boolean);
    console.log((pick.length ? pick : keys).join(" "));') || { echo "Could not list models; rerun with MODELS=\"<lms model keys>\"."; exit 1; }
fi
echo "Models: $MODELS"

ceiling() {  # largest context each model fits in 24 GiB; the Coder at 131k crashed this Mac
  case "$1" in *gpt-oss*) echo 131072 ;; *coder-30b*) echo 32768 ;; *9b*) echo 65536 ;; *) echo 32768 ;; esac
}

load_max() {  # load at the largest context up to the model's ceiling; prints the context length used
  local key=$1 id=$2 max
  max=$(ceiling "$key")
  "$LMS" unload --all >/dev/null 2>&1 || true
  for ctx in 131072 98304 65536 49152 32768; do
    [ "$ctx" -le "$max" ] || continue
    if "$LMS" load "$key" --identifier "$id" --context-length "$ctx" -y >/dev/null 2>&1; then echo "$ctx"; return 0; fi
  done
  return 1
}

register() {  # TrueForge provider for one loaded model with its real context length
  node -e '
    (async () => {
      const { TrueForge } = await import("@truefoundry/trueforge-sdk");
      const forge = new TrueForge({ baseUrl: process.argv[1], maxRetries: 0 });
      await forge.settings.modelProviders.createOrUpdate({ manifest: { type: "custom", name: process.argv[2], baseUrl: process.argv[3],
        models: [{ name: "main", modelId: process.argv[4], properties: { contextLength: Number(process.argv[5]), maxOutputTokens: 2600 } }] } });
    })().catch(e => { console.error(e.message); process.exit(1); });' "$FORGE" "$1" "$LMURL" "$2" "$3"
}

run_corpus() {  # provider, results dir, extra args
  local provider=$1 dir=$2; shift 2
  AGENTEXTENSION_TEST_MODEL="$provider/main" AGENTEXTENSION_TEST_RESULTS_DIR="$dir" \
    caffeinate -i node test/model/run.cjs --corpus "$@" || true
}

SUMMARY=test-results/phase10-max-context-$STAMP.txt
best="" bestScore=-1 bestCtx=""
for key in $MODELS; do
  short=$(echo "$key" | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z' | cut -c1-40 | sed 's/-*$//')
  id="agentextension-max-$short"; provider="local-max-$short"
  if ! ctx=$(load_max "$key" "$id"); then echo "$key: could not load at 32k or above" | tee -a "$SUMMARY"; continue; fi
  register "$provider" "$id" "$ctx"
  dir="test-results/phase10-max-$short-smoke-$STAMP"
  run_corpus "$provider" "$dir" --only edit-and-check,flask-task-b --repetitions 1
  score=$(node -e 'const r=require(process.argv[1]);console.log((r.results||[]).filter(x=>x.outcome==="complete").length)' "$ROOT/$dir/model-latest.json" 2>/dev/null || echo 0)
  echo "$key context=$ctx smoke-complete=$score/2 results=$dir" | tee -a "$SUMMARY"
  if [ "$score" -gt "$bestScore" ]; then best=$key bestScore=$score bestCtx=$ctx; fi
done

if [ -n "$best" ] && [ -z "${SMOKE_ONLY:-}" ]; then
  short=$(echo "$best" | tr -c 'a-zA-Z0-9\n' '-' | tr 'A-Z' 'a-z' | cut -c1-40 | sed 's/-*$//')
  load_max "$best" "agentextension-max-$short" >/dev/null
  dir="test-results/phase10-max-$short-full-$STAMP"
  echo "Full corpus (20 tasks x 3) on $best at context $bestCtx -> $dir" | tee -a "$SUMMARY"
  run_corpus "local-max-$short" "$dir"
fi
"$LMS" unload --all >/dev/null 2>&1 || true
echo "Done. Summary: $SUMMARY"
