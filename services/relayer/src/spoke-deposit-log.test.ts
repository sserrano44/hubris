import assert from "node:assert/strict";
import test from "node:test";
import { collectNormalizedSpokeDepositLogs } from "./spoke-deposit-log";

const HUB_RECEIVER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUB_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE_USER = "0xcccccccccccccccccccccccccccccccccccccccc";
const MESSAGE = "0x1234";

function toBytes32Address(address: string): `0x${string}` {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

test("normalizes canonical FundsDeposited (bytes32 addresses)", () => {
  const canonicalLogs = [
    {
      args: {
        outputToken: toBytes32Address(HUB_TOKEN),
        recipient: toBytes32Address(HUB_RECEIVER),
        outputAmount: 250000000n,
        destinationChainId: 1n,
        message: MESSAGE
      },
      transactionHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
      logIndex: 7n,
      blockNumber: 101n
    }
  ];

  const normalized = collectNormalizedSpokeDepositLogs({ canonicalLogs, mockLogs: [] });
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0], {
    message: MESSAGE,
    outputToken: HUB_TOKEN,
    recipient: HUB_RECEIVER,
    outputAmount: 250000000n,
    destinationChainId: 1n,
    originTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    originLogIndex: 7n,
    spokeObservedBlock: 101n
  });
});

test("normalizes mock V3FundsDeposited (address fields)", () => {
  const mockLogs = [
    {
      args: {
        outputToken: HUB_TOKEN,
        recipient: HUB_RECEIVER,
        outputAmount: 42n,
        destinationChainId: 8453n,
        message: MESSAGE
      },
      transactionHash: "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`,
      logIndex: 9n,
      blockNumber: 303n
    }
  ];

  const normalized = collectNormalizedSpokeDepositLogs({ canonicalLogs: [], mockLogs });
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0], {
    message: MESSAGE,
    outputToken: HUB_TOKEN,
    recipient: HUB_RECEIVER,
    outputAmount: 42n,
    destinationChainId: 8453n,
    originTxHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    originLogIndex: 9n,
    spokeObservedBlock: 303n
  });
});

test("merges canonical + mock logs in block/log order and dedupes by txHash+logIndex", () => {
  const canonicalLogs = [
    {
      args: {
        outputToken: toBytes32Address(HUB_TOKEN),
        recipient: toBytes32Address(HUB_RECEIVER),
        outputAmount: 10n,
        destinationChainId: 1n,
        message: "0xaa"
      },
      transactionHash: "0x3333333333333333333333333333333333333333333333333333333333333333" as `0x${string}`,
      logIndex: 3n,
      blockNumber: 200n
    }
  ];

  const mockLogs = [
    {
      args: {
        outputToken: HUB_TOKEN,
        recipient: SOURCE_USER,
        outputAmount: 11n,
        destinationChainId: 1n,
        message: "0xbb"
      },
      transactionHash: "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`,
      logIndex: 1n,
      blockNumber: 150n
    },
    {
      args: {
        outputToken: HUB_TOKEN,
        recipient: HUB_RECEIVER,
        outputAmount: 99n,
        destinationChainId: 1n,
        message: "0xcc"
      },
      transactionHash: "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`,
      logIndex: 1n,
      blockNumber: 150n
    }
  ];

  const normalized = collectNormalizedSpokeDepositLogs({ canonicalLogs, mockLogs });
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0]?.originTxHash, "0x2222222222222222222222222222222222222222222222222222222222222222");
  assert.equal(normalized[0]?.originLogIndex, 1n);
  assert.equal(normalized[1]?.originTxHash, "0x3333333333333333333333333333333333333333333333333333333333333333");
  assert.equal(normalized[1]?.originLogIndex, 3n);
});
