"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { IntentLifecycle } from "@zkhub/sdk";

const INDEXER_API = process.env.NEXT_PUBLIC_INDEXER_API_URL ?? "http://127.0.0.1:3030";

export function ActivityClient() {
  const { address } = useAccount();
  const [items, setItems] = useState<IntentLifecycle[]>([]);

  useEffect(() => {
    if (!address) return;
    fetch(`${INDEXER_API}/activity?user=${address}`)
      .then(async (res) => (await res.json()) as IntentLifecycle[])
      .then(setItems)
      .catch((error) => {
        console.error(error);
      });
  }, [address]);

  if (!address) return <p className="muted">Connect wallet to see activity.</p>;

  return (
    <div className="card stack">
      {items.length === 0 ? <p className="muted">No activity yet.</p> : null}
      {items.map((item) => (
        <article key={item.intentId} className="activity-item">
          <p className="muted">Intent: {item.intentId.slice(0, 10)}...</p>
          <p>Status: <strong>{item.status}</strong></p>
          <p>Type: {item.intentType} | Amount: {item.amount}</p>
          <p>Updated: {new Date(item.updatedAt).toLocaleString()}</p>
        </article>
      ))}
    </div>
  );
}
