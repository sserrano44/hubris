import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { encodeAbiParameters, stringToHex } from "viem";
import { deriveActionIds, MAX_BATCH_ACTIONS, toField } from "./hash";
export class DevProofProvider {
    async prove(batch) {
        return {
            proof: stringToHex("ZKHUB_DEV_PROOF"),
            publicInputs: expectedPublicInputs(batch)
        };
    }
}
export class CircuitProofProvider {
    repoRoot = findRepoRoot(process.cwd());
    snarkjsBin = process.env.PROVER_SNARKJS_BIN ?? "snarkjs";
    circuitArtifactsDir = process.env.PROVER_CIRCUIT_ARTIFACTS_DIR
        ?? path.join(this.repoRoot, "circuits", "prover", "artifacts");
    wasmPath = process.env.PROVER_CIRCUIT_WASM_PATH
        ?? path.join(this.circuitArtifactsDir, "SettlementBatchRoot_js", "SettlementBatchRoot.wasm");
    zkeyPath = process.env.PROVER_CIRCUIT_ZKEY_PATH
        ?? path.join(this.circuitArtifactsDir, "SettlementBatchRoot_final.zkey");
    tmpRoot = process.env.PROVER_TMP_DIR ?? path.join(os.tmpdir(), "zkhub-prover");
    keepTmp = process.env.PROVER_KEEP_TMP_FILES === "1";
    async prove(batch) {
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
                ...new Array(MAX_BATCH_ACTIONS - actionIds.length).fill(0n)
            ];
            const publicInputs = expectedPublicInputs(batch);
            const witnessInput = {
                batchId: publicInputs[0].toString(),
                hubChainId: publicInputs[1].toString(),
                spokeChainId: publicInputs[2].toString(),
                actionsRoot: publicInputs[3].toString(),
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
            const proofJson = JSON.parse(fs.readFileSync(proofPath, "utf8"));
            const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8"));
            if (publicSignals.length !== 4) {
                throw new Error(`Unexpected public signal count: got ${publicSignals.length}, expected 4`);
            }
            const computedPublic = publicSignals.map((value) => BigInt(value));
            for (let i = 0; i < 4; i++) {
                if (computedPublic[i] !== publicInputs[i]) {
                    throw new Error(`Public input mismatch at index ${i}: got ${computedPublic[i].toString()}, expected ${publicInputs[i].toString()}`);
                }
            }
            return {
                proof: encodeGroth16Proof(proofJson),
                publicInputs
            };
        }
        finally {
            if (!this.keepTmp) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        }
    }
}
function runCommand(cmd, args) {
    const result = spawnSync(cmd, args, {
        stdio: "pipe",
        encoding: "utf8"
    });
    if (result.error) {
        throw new Error(`Failed to execute ${cmd}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
}
function expectedPublicInputs(batch) {
    return [
        toField(batch.batchId),
        toField(batch.hubChainId),
        toField(batch.spokeChainId),
        toField(BigInt(batch.actionsRoot))
    ];
}
function encodeGroth16Proof(proof) {
    const a = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
    // snarkjs calldata convention uses reversed inner pairs for G2.
    const b = [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]
    ];
    const c = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];
    return encodeAbiParameters([{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }], [a, b, c]);
}
function findRepoRoot(startDir) {
    let cursor = path.resolve(startDir);
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(cursor, "contracts"))
            && fs.existsSync(path.join(cursor, "circuits"))
            && fs.existsSync(path.join(cursor, "services"))) {
            return cursor;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor)
            break;
        cursor = parent;
    }
    return startDir;
}
//# sourceMappingURL=proof.js.map