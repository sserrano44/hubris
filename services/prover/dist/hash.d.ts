import type { SettlementBatchPayload } from "./types";
export declare const MAX_BATCH_ACTIONS = 50;
export declare const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export declare function toField(value: bigint): bigint;
export declare function hashPair(left: bigint, right: bigint): bigint;
export declare function poseidon2Permute3(state: readonly [bigint, bigint, bigint]): [bigint, bigint, bigint];
export declare function deriveActionIds(batch: Omit<SettlementBatchPayload, "actionsRoot">): bigint[];
export declare function computeActionsRoot(batch: Omit<SettlementBatchPayload, "actionsRoot">): `0x${string}`;
