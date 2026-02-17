# Prover Integration Notes

`services/prover` supports two proof providers:

1. `PROVER_MODE=dev`
- Uses fixed `ZKHUB_DEV_PROOF`.
- Useful for local deterministic testing.

2. `PROVER_MODE=circuit`
- Uses `snarkjs groth16 fullprove` against the Circom artifacts.
- Produces ABI-encoded Groth16 proof bytes (`uint256[2], uint256[2][2], uint256[2]`) for on-chain adapter consumption.

## Required env for circuit mode

- `PROVER_MODE=circuit`
- Optional overrides:
  - `PROVER_SNARKJS_BIN` (default `snarkjs`)
  - `PROVER_CIRCUIT_ARTIFACTS_DIR` (default `circuits/prover/artifacts`)
  - `PROVER_CIRCUIT_WASM_PATH`
  - `PROVER_CIRCUIT_ZKEY_PATH`
  - `PROVER_TMP_DIR`
  - `PROVER_KEEP_TMP_FILES=1` (debug)

## Build artifacts

```bash
bash ./circuits/prover/build-artifacts.sh
```

The script compiles the circuit, performs a local Groth16 setup, exports verification key JSON, and writes a Solidity verifier contract template.
