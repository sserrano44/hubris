import { createPublicClient, http, type WalletClient } from "viem";
import { base, optimism } from "viem/chains";
import { HubMoneyMarketAbi, HubRiskManagerAbi } from "@zkhub/abis";
import type { Intent, IntentLifecycle, ProtocolAddresses } from "./types";
import { getIntentTypedData } from "./eip712";

export type HubPosition = {
  collateral: Array<{ asset: `0x${string}`; amount: bigint }>;
  debt: Array<{ asset: `0x${string}`; amount: bigint }>;
  healthFactor: bigint;
};

type ReadClient = ReturnType<typeof createPublicClient>;

export function createHubPublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

export function createSpokePublicClient(rpcUrl: string) {
  return createPublicClient({ chain: optimism, transport: http(rpcUrl) });
}

export async function readHubPosition(
  client: ReadClient,
  addresses: ProtocolAddresses,
  user: `0x${string}`,
  assets: `0x${string}`[]
): Promise<HubPosition> {
  const [collateral, debt] = await Promise.all([
    Promise.all(
      assets.map(async (asset) => ({
        asset,
        amount: (await client.readContract({
          abi: HubMoneyMarketAbi,
          address: addresses.hub.moneyMarket,
          functionName: "getUserSupply",
          args: [user, asset]
        })) as bigint
      }))
    ),
    Promise.all(
      assets.map(async (asset) => ({
        asset,
        amount: (await client.readContract({
          abi: HubMoneyMarketAbi,
          address: addresses.hub.moneyMarket,
          functionName: "getUserDebt",
          args: [user, asset]
        })) as bigint
      }))
    )
  ]);

  const healthFactor = (await client.readContract({
    abi: HubRiskManagerAbi,
    address: addresses.hub.riskManager,
    functionName: "healthFactor",
    args: [user]
  })) as bigint;

  return { collateral, debt, healthFactor };
}

export async function signIntent(
  walletClient: WalletClient,
  hubChainId: number,
  intentInbox: `0x${string}`,
  intent: Intent
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) {
    throw new Error("Wallet client account is required to sign intent");
  }
  const typedData = getIntentTypedData(hubChainId, intentInbox, intent);
  return walletClient.signTypedData({ ...typedData, account });
}

export async function fetchIntentStatus(indexerApiUrl: string, intentId: string): Promise<IntentLifecycle | null> {
  const res = await fetch(`${indexerApiUrl}/intents/${intentId}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch status: ${res.status}`);
  }
  return (await res.json()) as IntentLifecycle;
}

export async function fetchActivity(indexerApiUrl: string, user?: string): Promise<IntentLifecycle[]> {
  const endpoint = user ? `${indexerApiUrl}/activity?user=${user}` : `${indexerApiUrl}/activity`;
  const res = await fetch(endpoint);
  if (!res.ok) {
    throw new Error(`Failed to fetch activity: ${res.status}`);
  }
  return (await res.json()) as IntentLifecycle[];
}

export async function submitSignedIntent(relayerApiUrl: string, payload: {
  intent: Intent;
  signature: `0x${string}`;
  relayerFee: bigint;
}) {
  const res = await fetch(`${relayerApiUrl}/intent/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload, (_, value) => (typeof value === "bigint" ? value.toString() : value))
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Submit failed (${res.status}): ${body}`);
  }

  return res.json();
}
