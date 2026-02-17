import type { IntentLifecycle, IntentStatus } from "@zkhub/sdk";
export type DepositState = {
    depositId: number;
    user: `0x${string}`;
    intentType: number;
    token: `0x${string}`;
    amount: string;
    status: "initiated" | "bridged" | "settled";
    metadata?: Record<string, unknown>;
    updatedAt: string;
};
export declare class JsonIndexerStore {
    private readonly filePath;
    private state;
    constructor(filePath: string);
    upsertIntent(intent: IntentLifecycle): IntentLifecycle;
    updateIntentStatus(intentId: `0x${string}`, status: IntentStatus, patch?: Partial<IntentLifecycle>): IntentLifecycle | null;
    getIntent(intentId: string): IntentLifecycle | null;
    listIntents(user?: string): IntentLifecycle[];
    upsertDeposit(dep: DepositState): DepositState;
    getDeposit(depositId: number): DepositState | null;
    private load;
    private save;
}
