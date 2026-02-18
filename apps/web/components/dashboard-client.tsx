"use client";

import { useEffect, useMemo, useState } from "react";
import { createPublicClient, formatUnits, http } from "viem";
import { useAccount } from "wagmi";
import { readHubPosition } from "@elhub/sdk";
import { useDeployments } from "../lib/runtime-config";

const HUB_RPC = process.env.NEXT_PUBLIC_HUB_RPC_URL ?? "http://127.0.0.1:8545";

export function DashboardClient() {
  const { address } = useAccount();
  const { config, loading } = useDeployments();
  const [state, setState] = useState<{
    collateral: Array<{ symbol: string; amount: string }>;
    debt: Array<{ symbol: string; amount: string }>;
    hf: string;
  } | null>(null);

  const client = useMemo(() => createPublicClient({ transport: http(HUB_RPC) }), []);

  useEffect(() => {
    if (!address || !config) return;

    const assets = Object.values(config.tokens).map((t) => t.hub);
    readHubPosition(
      client,
      {
        hub: {
          moneyMarket: config.hub.moneyMarket,
          riskManager: config.hub.riskManager,
          intentInbox: config.hub.intentInbox,
          lockManager: config.hub.lockManager,
          settlement: config.hub.settlement,
          custody: config.hub.custody,
          tokenRegistry: config.hub.tokenRegistry
        },
        spoke: {
          portal: config.spoke.portal,
          bridgeAdapter: config.spoke.bridgeAdapter
        }
      },
      address,
      assets
    )
      .then((position) => {
        const symbolByHub = Object.fromEntries(
          Object.entries(config.tokens).map(([symbol, t]) => [t.hub.toLowerCase(), [symbol, t.decimals] as const])
        );

        setState({
          collateral: position.collateral.map((p) => {
            const [symbol, decimals] = symbolByHub[p.asset.toLowerCase()] ?? ["UNKNOWN", 18];
            return { symbol, amount: Number(formatUnits(p.amount, decimals)).toFixed(4) };
          }),
          debt: position.debt.map((p) => {
            const [symbol, decimals] = symbolByHub[p.asset.toLowerCase()] ?? ["UNKNOWN", 18];
            return { symbol, amount: Number(formatUnits(p.amount, decimals)).toFixed(4) };
          }),
          hf: Number(formatUnits(position.healthFactor, 18)).toFixed(4)
        });
      })
      .catch((error) => {
        console.error(error);
      });
  }, [address, client, config]);

  if (!address) {
    return <p className="muted">Connect wallet to view hub position.</p>;
  }

  if (loading || !state) {
    return <p className="muted">Loading hub position…</p>;
  }

  return (
    <div className="card-grid">
      <article className="card">
        <h3>Health Factor</h3>
        <p className="metric">{state.hf === "Infinity" ? "∞" : state.hf}</p>
      </article>
      <article className="card">
        <h3>Collateral</h3>
        {state.collateral.map((c) => (
          <p key={`coll-${c.symbol}`}>{c.symbol}: {c.amount}</p>
        ))}
      </article>
      <article className="card">
        <h3>Debt</h3>
        {state.debt.map((d) => (
          <p key={`debt-${d.symbol}`}>{d.symbol}: {d.amount}</p>
        ))}
      </article>
    </div>
  );
}
