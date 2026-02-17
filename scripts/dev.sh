#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export COREPACK_HOME="${COREPACK_HOME:-$ROOT_DIR/.corepack}"
export PNPM_HOME="${PNPM_HOME:-$ROOT_DIR/.pnpm-home}"
mkdir -p "$COREPACK_HOME" "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Installing workspace dependencies (first run)..."
  pnpm install
fi

HUB_CHAIN_ID="${HUB_CHAIN_ID:-8453}"
SPOKE_CHAIN_ID="${SPOKE_CHAIN_ID:-480}"
HUB_RPC_PORT="${HUB_RPC_PORT:-8545}"
SPOKE_RPC_PORT="${SPOKE_RPC_PORT:-9545}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

echo "Starting Base-local anvil on :${HUB_RPC_PORT}"
anvil --port "$HUB_RPC_PORT" --chain-id "$HUB_CHAIN_ID" --block-time 1 >/tmp/zkhub-anvil-base.log 2>&1 &
PIDS+=("$!")

echo "Starting Worldchain-local anvil on :${SPOKE_RPC_PORT}"
anvil --port "$SPOKE_RPC_PORT" --chain-id "$SPOKE_CHAIN_ID" --block-time 1 >/tmp/zkhub-anvil-world.log 2>&1 &
PIDS+=("$!")

rpc_ready() {
  local url="$1"
  curl -sS -H "content-type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$url" >/dev/null 2>&1
}

for _ in {1..30}; do
  if rpc_ready "http://127.0.0.1:${HUB_RPC_PORT}" && rpc_ready "http://127.0.0.1:${SPOKE_RPC_PORT}"; then
    break
  fi
  sleep 1
done

echo "Deploying local contracts"
bash ./contracts/script/deploy-local.sh

if [[ ! -f ./contracts/deployments/local.env ]]; then
  echo "Missing ./contracts/deployments/local.env after deploy"
  exit 1
fi

set -a
source ./contracts/deployments/local.env
set +a

echo "Generating shared ABIs"
pnpm --filter @zkhub/abis run generate

echo "Starting indexer, prover, relayer, and web"
pnpm --filter @zkhub/indexer dev &
PIDS+=("$!")

pnpm --filter @zkhub/prover dev &
PIDS+=("$!")

pnpm --filter @zkhub/relayer dev &
PIDS+=("$!")

pnpm --filter @zkhub/web dev &
PIDS+=("$!")

wait -n
