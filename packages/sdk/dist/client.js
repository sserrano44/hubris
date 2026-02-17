import { createPublicClient, http } from "viem";
import { base, optimism } from "viem/chains";
import { HubMoneyMarketAbi, HubRiskManagerAbi } from "@zkhub/abis";
import { getIntentTypedData } from "./eip712";
export function createHubPublicClient(rpcUrl) {
    return createPublicClient({ chain: base, transport: http(rpcUrl) });
}
export function createSpokePublicClient(rpcUrl) {
    return createPublicClient({ chain: optimism, transport: http(rpcUrl) });
}
export async function readHubPosition(client, addresses, user, assets) {
    const [collateral, debt] = await Promise.all([
        Promise.all(assets.map(async (asset) => ({
            asset,
            amount: (await client.readContract({
                abi: HubMoneyMarketAbi,
                address: addresses.hub.moneyMarket,
                functionName: "getUserSupply",
                args: [user, asset]
            }))
        }))),
        Promise.all(assets.map(async (asset) => ({
            asset,
            amount: (await client.readContract({
                abi: HubMoneyMarketAbi,
                address: addresses.hub.moneyMarket,
                functionName: "getUserDebt",
                args: [user, asset]
            }))
        })))
    ]);
    const healthFactor = (await client.readContract({
        abi: HubRiskManagerAbi,
        address: addresses.hub.riskManager,
        functionName: "healthFactor",
        args: [user]
    }));
    return { collateral, debt, healthFactor };
}
export async function signIntent(walletClient, hubChainId, intentInbox, intent) {
    const account = walletClient.account;
    if (!account) {
        throw new Error("Wallet client account is required to sign intent");
    }
    const typedData = getIntentTypedData(hubChainId, intentInbox, intent);
    return walletClient.signTypedData({ ...typedData, account });
}
export async function fetchIntentStatus(indexerApiUrl, intentId) {
    const res = await fetch(`${indexerApiUrl}/intents/${intentId}`);
    if (res.status === 404)
        return null;
    if (!res.ok) {
        throw new Error(`Failed to fetch status: ${res.status}`);
    }
    return (await res.json());
}
export async function fetchActivity(indexerApiUrl, user) {
    const endpoint = user ? `${indexerApiUrl}/activity?user=${user}` : `${indexerApiUrl}/activity`;
    const res = await fetch(endpoint);
    if (!res.ok) {
        throw new Error(`Failed to fetch activity: ${res.status}`);
    }
    return (await res.json());
}
export async function submitSignedIntent(relayerApiUrl, payload) {
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
//# sourceMappingURL=client.js.map