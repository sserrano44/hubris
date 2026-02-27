import { parseAbiItem } from "viem";
export const spokeFundsDepositedEvent = parseAbiItem("event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)");
export const spokeV3FundsDepositedEvent = parseAbiItem("event V3FundsDeposited(uint256 indexed depositId, address indexed depositor, address indexed recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message, address caller)");
export function collectNormalizedSpokeDepositLogs({ canonicalLogs, mockLogs }) {
    const normalized = [];
    for (const log of canonicalLogs) {
        const parsed = normalizeCanonicalSpokeDepositLog(log);
        if (parsed)
            normalized.push(parsed);
    }
    for (const log of mockLogs) {
        const parsed = normalizeMockSpokeDepositLog(log);
        if (parsed)
            normalized.push(parsed);
    }
    normalized.sort((a, b) => {
        if (a.spokeObservedBlock !== b.spokeObservedBlock) {
            return a.spokeObservedBlock < b.spokeObservedBlock ? -1 : 1;
        }
        if (a.originLogIndex !== b.originLogIndex) {
            return a.originLogIndex < b.originLogIndex ? -1 : 1;
        }
        return a.originTxHash.toLowerCase().localeCompare(b.originTxHash.toLowerCase());
    });
    const deduped = [];
    const seen = new Set();
    for (const log of normalized) {
        const key = `${log.originTxHash.toLowerCase()}:${log.originLogIndex.toString()}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(log);
    }
    return deduped;
}
function normalizeCanonicalSpokeDepositLog(log) {
    const message = asHex(log.args.message);
    const outputToken = bytes32ToAddress(log.args.outputToken);
    const recipient = bytes32ToAddress(log.args.recipient);
    const outputAmount = asBigInt(log.args.outputAmount);
    const destinationChainId = asBigInt(log.args.destinationChainId);
    const originTxHash = asHex(log.transactionHash);
    const originLogIndex = toLogIndex(log.logIndex);
    const spokeObservedBlock = log.blockNumber ?? 0n;
    if (!message || !outputToken || !recipient || outputAmount === undefined || destinationChainId === undefined || !originTxHash) {
        return undefined;
    }
    return {
        message,
        outputToken,
        recipient,
        outputAmount,
        destinationChainId,
        originTxHash,
        originLogIndex,
        spokeObservedBlock
    };
}
function normalizeMockSpokeDepositLog(log) {
    const message = asHex(log.args.message);
    const outputToken = asAddress(log.args.outputToken);
    const recipient = asAddress(log.args.recipient);
    const outputAmount = asBigInt(log.args.outputAmount);
    const destinationChainId = asBigInt(log.args.destinationChainId);
    const originTxHash = asHex(log.transactionHash);
    const originLogIndex = toLogIndex(log.logIndex);
    const spokeObservedBlock = log.blockNumber ?? 0n;
    if (!message || !outputToken || !recipient || outputAmount === undefined || destinationChainId === undefined || !originTxHash) {
        return undefined;
    }
    return {
        message,
        outputToken,
        recipient,
        outputAmount,
        destinationChainId,
        originTxHash,
        originLogIndex,
        spokeObservedBlock
    };
}
function asBigInt(value) {
    if (typeof value === "bigint")
        return value;
    if (typeof value === "number" && Number.isInteger(value))
        return BigInt(value);
    if (typeof value === "string" && value.length > 0) {
        try {
            return BigInt(value);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function asHex(value) {
    if (typeof value !== "string" || !value.startsWith("0x"))
        return undefined;
    return value;
}
function asAddress(value) {
    if (typeof value !== "string" || !value.startsWith("0x") || value.length !== 42)
        return undefined;
    return value;
}
function bytes32ToAddress(value) {
    if (typeof value !== "string" || !value.startsWith("0x") || value.length !== 66)
        return undefined;
    return `0x${value.slice(-40)}`;
}
function toLogIndex(value) {
    if (typeof value === "bigint")
        return value;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0)
        return BigInt(value);
    return 0n;
}
//# sourceMappingURL=spoke-deposit-log.js.map