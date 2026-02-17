"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { MockERC20Abi, SpokePortalAbi } from "@zkhub/abis";
import { useDeployments } from "../lib/runtime-config";

export function SupplyRepayForm({ mode }: { mode: "supply" | "repay" }) {
  const { address } = useAccount();
  const { config, loading } = useDeployments();
  const { writeContractAsync } = useWriteContract();
  const [asset, setAsset] = useState("USDC");
  const [amount, setAmount] = useState("100");
  const [status, setStatus] = useState<string>("");

  const token = useMemo(() => config?.tokens[asset], [asset, config]);

  async function submit() {
    if (!address || !config || !token) return;

    const amountRaw = parseUnits(amount, token.decimals);

    setStatus("Approving token...");
    const approveTx = await writeContractAsync({
      abi: MockERC20Abi,
      address: token.spoke,
      functionName: "approve",
      args: [config.spoke.portal, amountRaw]
    });

    setStatus(`Approval submitted: ${approveTx.slice(0, 10)}...`);

    const fn = mode === "supply" ? "initiateSupply" : "initiateRepay";
    setStatus(`${mode === "supply" ? "Supplying" : "Repaying"} on Worldchain...`);

    const tx = await writeContractAsync({
      abi: SpokePortalAbi,
      address: config.spoke.portal,
      functionName: fn,
      args: [token.spoke, amountRaw, address]
    });

    setStatus(
      `Tx sent: ${tx.slice(0, 10)}... Bridging + pending settlement. Hub credit applies only after settlement.`
    );
  }

  if (!address) return <p className="muted">Connect wallet first.</p>;
  if (loading || !config) return <p className="muted">Loading deployment config...</p>;

  return (
    <div className="card stack">
      <label>
        Asset
        <select value={asset} onChange={(e) => setAsset(e.target.value)}>
          {Object.keys(config.tokens).map((symbol) => (
            <option key={symbol} value={symbol}>{symbol}</option>
          ))}
        </select>
      </label>
      <label>
        Amount
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
      </label>
      <button className="btn" onClick={submit}>
        {mode === "supply" ? "Initiate Supply" : "Initiate Repay"}
      </button>
      {status ? <p className="muted">{status}</p> : null}
    </div>
  );
}
