import { keccak256, encodeAbiParameters } from "viem";
import type { Intent } from "./types";

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
} as const;

export function getIntentTypedData(chainId: number, intentInbox: `0x${string}`, intent: Intent) {
  return {
    domain: {
      name: "ElHubIntentInbox",
      version: "1",
      chainId,
      verifyingContract: intentInbox
    },
    types: intentTypes,
    primaryType: "Intent" as const,
    message: intent
  };
}

export function rawIntentId(intent: Intent): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
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
      ],
      [intent]
    )
  );
}
