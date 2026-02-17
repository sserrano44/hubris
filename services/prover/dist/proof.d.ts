import type { SettlementBatchPayload } from "./types";
export interface ProofProvider {
    prove(batch: SettlementBatchPayload): Promise<{
        proof: `0x${string}`;
        publicInputs: bigint[];
    }>;
}
type PublicInputs = [bigint, bigint, bigint, bigint];
export declare class DevProofProvider implements ProofProvider {
    prove(batch: SettlementBatchPayload): Promise<{
        proof: `0x${string}`;
        publicInputs: PublicInputs;
    }>;
}
export declare class CircuitProofProvider implements ProofProvider {
    private readonly repoRoot;
    private readonly snarkjsBin;
    private readonly circuitArtifactsDir;
    private readonly wasmPath;
    private readonly zkeyPath;
    private readonly tmpRoot;
    private readonly keepTmp;
    prove(batch: SettlementBatchPayload): Promise<{
        proof: `0x${string}`;
        publicInputs: bigint[];
    }>;
}
export {};
