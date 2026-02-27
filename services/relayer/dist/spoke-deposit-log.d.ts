import { type Address, type Hex } from "viem";
export declare const spokeFundsDepositedEvent: {
    readonly name: "FundsDeposited";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "inputToken";
    }, {
        readonly type: "bytes32";
        readonly name: "outputToken";
    }, {
        readonly type: "uint256";
        readonly name: "inputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "outputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "destinationChainId";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "depositId";
        readonly indexed: true;
    }, {
        readonly type: "uint32";
        readonly name: "quoteTimestamp";
    }, {
        readonly type: "uint32";
        readonly name: "fillDeadline";
    }, {
        readonly type: "uint32";
        readonly name: "exclusivityDeadline";
    }, {
        readonly type: "bytes32";
        readonly name: "depositor";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "recipient";
    }, {
        readonly type: "bytes32";
        readonly name: "exclusiveRelayer";
    }, {
        readonly type: "bytes";
        readonly name: "message";
    }];
};
export declare const spokeV3FundsDepositedEvent: {
    readonly name: "V3FundsDeposited";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "depositId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "depositor";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "recipient";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "inputToken";
    }, {
        readonly type: "address";
        readonly name: "outputToken";
    }, {
        readonly type: "uint256";
        readonly name: "inputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "outputAmount";
    }, {
        readonly type: "uint256";
        readonly name: "destinationChainId";
    }, {
        readonly type: "address";
        readonly name: "exclusiveRelayer";
    }, {
        readonly type: "uint32";
        readonly name: "quoteTimestamp";
    }, {
        readonly type: "uint32";
        readonly name: "fillDeadline";
    }, {
        readonly type: "uint32";
        readonly name: "exclusivityDeadline";
    }, {
        readonly type: "bytes";
        readonly name: "message";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
};
type AcrossDepositLogLike = {
    args: Record<string, unknown>;
    transactionHash?: Hex;
    logIndex?: bigint | number | undefined;
    blockNumber?: bigint | undefined;
};
export type NormalizedSpokeDepositLog = {
    message: Hex;
    outputToken: Address;
    recipient: Address;
    outputAmount: bigint;
    destinationChainId: bigint;
    originTxHash: Hex;
    originLogIndex: bigint;
    spokeObservedBlock: bigint;
};
export declare function collectNormalizedSpokeDepositLogs({ canonicalLogs, mockLogs }: {
    canonicalLogs: AcrossDepositLogLike[];
    mockLogs: AcrossDepositLogLike[];
}): NormalizedSpokeDepositLog[];
export {};
