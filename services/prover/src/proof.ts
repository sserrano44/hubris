import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { encodeAbiParameters, stringToHex } from "viem";
import type { SettlementBatchPayload } from "./types";
import { deriveActionIds, MAX_BATCH_ACTIONS, toField } from "./hash";

export interface ProofProvider {
  prove(batch: SettlementBatchPayload): Promise<{ proof: `0x${string}`; publicInputs: bigint[] }>;
}

type PublicInputs = [bigint, bigint, bigint, bigint];

export class DevProofProvider implements ProofProvider {
  async prove(batch: SettlementBatchPayload) {
    return {
      proof: stringToHex("ZKHUB_DEV_PROOF") as `0x${string}`,
      publicInputs: expectedPublicInputs(batch)
    };
  }
}

export class CircuitProofProvider implements ProofProvider {
  private readonly repoRoot = findRepoRoot(process.cwd());
  private readonly snarkjsBin = process.env.PROVER_SNARKJS_BIN ?? "snarkjs";
  private readonly circuitArtifactsDir =
    process.env.PROVER_CIRCUIT_ARTIFACTS_DIR
    ?? path.join(this.repoRoot, "circuits", "prover", "artifacts");
  private readonly wasmPath =
    process.env.PROVER_CIRCUIT_WASM_PATH
    ?? path.join(this.circuitArtifactsDir, "SettlementBatchRoot_js", "SettlementBatchRoot.wasm");
  private readonly zkeyPath =
    process.env.PROVER_CIRCUIT_ZKEY_PATH
    ?? path.join(this.circuitArtifactsDir, "SettlementBatchRoot_final.zkey");
  private readonly tmpRoot = process.env.PROVER_TMP_DIR ?? path.join(os.tmpdir(), "zkhub-prover");
  private readonly keepTmp = process.env.PROVER_KEEP_TMP_FILES === "1";

  async prove(batch: SettlementBatchPayload): Promise<{ proof: `0x${string}`; publicInputs: bigint[] }> {
    fs.mkdirSync(this.tmpRoot, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(this.tmpRoot, "proof-"));
    const inputPath = path.join(tmpDir, "input.json");
    const proofPath = path.join(tmpDir, "proof.json");
    const publicPath = path.join(tmpDir, "public.json");

    try {
      if (!fs.existsSync(this.wasmPath)) {
        throw new Error(`Missing circuit wasm at ${this.wasmPath}. Build artifacts in circuits/prover first.`);
      }
      if (!fs.existsSync(this.zkeyPath)) {
        throw new Error(`Missing proving key at ${this.zkeyPath}. Build artifacts in circuits/prover first.`);
      }

      const actionIds = deriveActionIds(batch);
      const paddedActionIds = [
        ...actionIds,
        ...new Array<bigint>(MAX_BATCH_ACTIONS - actionIds.length).fill(0n)
      ];

      const publicInputs = expectedPublicInputs(batch);
      const [batchIdInput, hubChainIdInput, spokeChainIdInput, actionsRootInput] = publicInputs;
      const witnessInput = {
        batchId: batchIdInput.toString(),
        hubChainId: hubChainIdInput.toString(),
        spokeChainId: spokeChainIdInput.toString(),
        actionsRoot: actionsRootInput.toString(),
        actionCount: actionIds.length.toString(),
        actionIds: paddedActionIds.map((value) => value.toString())
      };

      fs.writeFileSync(inputPath, JSON.stringify(witnessInput, null, 2));

      runCommand(this.snarkjsBin, [
        "groth16",
        "fullprove",
        inputPath,
        this.wasmPath,
        this.zkeyPath,
        proofPath,
        publicPath
      ]);

      const proofJson = JSON.parse(fs.readFileSync(proofPath, "utf8")) as Groth16Proof;
      const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8")) as string[];

      const computedPublic = parsePublicSignals(publicSignals);
      assertPublicInputsMatch(computedPublic, publicInputs);

      return {
        proof: encodeGroth16Proof(proofJson),
        publicInputs
      };
    } finally {
      if (!this.keepTmp) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }
}

function runCommand(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, {
    stdio: "pipe",
    encoding: "utf8"
  });

  if (result.error) {
    throw new Error(`Failed to execute ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed with exit code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

function expectedPublicInputs(batch: SettlementBatchPayload): PublicInputs {
  return [
    toField(batch.batchId),
    toField(batch.hubChainId),
    toField(batch.spokeChainId),
    toField(BigInt(batch.actionsRoot))
  ];
}

function parsePublicSignals(publicSignals: string[]): PublicInputs {
  const [batchId, hubChainId, spokeChainId, actionsRoot, ...rest] = publicSignals;
  if (
    rest.length > 0
    || batchId === undefined
    || hubChainId === undefined
    || spokeChainId === undefined
    || actionsRoot === undefined
  ) {
    throw new Error(`Unexpected public signal count: got ${publicSignals.length}, expected 4`);
  }

  return [BigInt(batchId), BigInt(hubChainId), BigInt(spokeChainId), BigInt(actionsRoot)];
}

function assertPublicInputsMatch(computed: PublicInputs, expected: PublicInputs) {
  if (computed[0] !== expected[0]) {
    throw new Error(
      `Public input mismatch at index 0: got ${computed[0].toString()}, expected ${expected[0].toString()}`
    );
  }
  if (computed[1] !== expected[1]) {
    throw new Error(
      `Public input mismatch at index 1: got ${computed[1].toString()}, expected ${expected[1].toString()}`
    );
  }
  if (computed[2] !== expected[2]) {
    throw new Error(
      `Public input mismatch at index 2: got ${computed[2].toString()}, expected ${expected[2].toString()}`
    );
  }
  if (computed[3] !== expected[3]) {
    throw new Error(
      `Public input mismatch at index 3: got ${computed[3].toString()}, expected ${expected[3].toString()}`
    );
  }
}

type Groth16Proof = {
  pi_a: [string, string, string?];
  pi_b: [[string, string], [string, string], [string, string]?];
  pi_c: [string, string, string?];
};

function encodeGroth16Proof(proof: Groth16Proof): `0x${string}` {
  const a: readonly [bigint, bigint] = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
  // snarkjs calldata convention uses reversed inner pairs for G2.
  const b: readonly [readonly [bigint, bigint], readonly [bigint, bigint]] = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]
  ];
  const c: readonly [bigint, bigint] = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];

  return encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }],
    [a, b, c]
  );
}

function findRepoRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(cursor, "contracts"))
      && fs.existsSync(path.join(cursor, "circuits"))
      && fs.existsSync(path.join(cursor, "services"))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return startDir;
}
