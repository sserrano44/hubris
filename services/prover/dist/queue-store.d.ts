import type { QueuedAction } from "./types";
export type QueuedActionRecord = {
    id: number;
    key: string;
    action: QueuedAction;
};
export interface ProverQueueStore {
    getNextBatchId(fallback: bigint): bigint;
    getQueuedCount(): number;
    enqueue(action: QueuedAction): "enqueued" | "duplicate";
    peek(limit: number): QueuedActionRecord[];
    markSettled(records: QueuedActionRecord[], nextBatchId: bigint): void;
}
export declare class JsonProverQueueStore implements ProverQueueStore {
    private readonly queuePath;
    private readonly statePath;
    private queue;
    private state;
    constructor(queuePath: string, statePath: string, initialBatchId: bigint);
    getNextBatchId(fallback: bigint): bigint;
    getQueuedCount(): number;
    enqueue(action: QueuedAction): "enqueued" | "duplicate";
    peek(limit: number): QueuedActionRecord[];
    markSettled(records: QueuedActionRecord[], nextBatchId: bigint): void;
}
export declare class SqliteProverQueueStore implements ProverQueueStore {
    private readonly db;
    constructor(filePath: string, initialBatchId: bigint);
    getNextBatchId(fallback: bigint): bigint;
    getQueuedCount(): number;
    enqueue(action: QueuedAction): "enqueued" | "duplicate";
    peek(limit: number): QueuedActionRecord[];
    markSettled(records: QueuedActionRecord[], nextBatchId: bigint): void;
}
export declare function actionKey(action: QueuedAction): string;
