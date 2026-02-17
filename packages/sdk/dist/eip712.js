import { keccak256, encodeAbiParameters } from "viem";
export const intentTypes = {
    Intent: [
        { name: "intentType", type: "uint8" },
        { name: "user", type: "address" },
        { name: "inputChainId", type: "uint256" },
        { name: "outputChainId", type: "uint256" },
        { name: "inputToken", type: "address" },
        { name: "outputToken", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "recipient", type: "address" },
        { name: "maxRelayerFee", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
    ]
};
export function getIntentTypedData(chainId, intentInbox, intent) {
    return {
        domain: {
            name: "ZkHubIntentInbox",
            version: "1",
            chainId,
            verifyingContract: intentInbox
        },
        types: intentTypes,
        primaryType: "Intent",
        message: intent
    };
}
export function rawIntentId(intent) {
    return keccak256(encodeAbiParameters([
        {
            type: "tuple",
            components: [
                { name: "intentType", type: "uint8" },
                { name: "user", type: "address" },
                { name: "inputChainId", type: "uint256" },
                { name: "outputChainId", type: "uint256" },
                { name: "inputToken", type: "address" },
                { name: "outputToken", type: "address" },
                { name: "amount", type: "uint256" },
                { name: "recipient", type: "address" },
                { name: "maxRelayerFee", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" }
            ]
        }
    ], [intent]));
}
//# sourceMappingURL=eip712.js.map