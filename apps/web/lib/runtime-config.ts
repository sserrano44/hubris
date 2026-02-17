"use client";

import { useEffect, useState } from "react";

export type Deployments = {
  hub: {
    tokenRegistry: `0x${string}`;
    moneyMarket: `0x${string}`;
    riskManager: `0x${string}`;
    intentInbox: `0x${string}`;
    lockManager: `0x${string}`;
    custody: `0x${string}`;
    settlement: `0x${string}`;
  };
  spoke: {
    portal: `0x${string}`;
    bridgeAdapter: `0x${string}`;
  };
  tokens: Record<
    string,
    {
      hub: `0x${string}`;
      spoke: `0x${string}`;
      decimals: number;
    }
  >;
};

const envConfig = process.env.NEXT_PUBLIC_PROTOCOL_CONFIG_JSON;

export function useDeployments() {
  const [config, setConfig] = useState<Deployments | null>(() => {
    if (!envConfig) return null;
    try {
      return JSON.parse(envConfig) as Deployments;
    } catch {
      return null;
    }
  });

  const [loading, setLoading] = useState(!config);

  useEffect(() => {
    if (config) {
      setLoading(false);
      return;
    }

    fetch("/deployments/local.json")
      .then(async (res) => {
        if (!res.ok) throw new Error("missing deployment config");
        return (await res.json()) as Deployments;
      })
      .then((value) => {
        setConfig(value);
      })
      .catch((error) => {
        console.error("Failed to load deployment config", error);
      })
      .finally(() => setLoading(false));
  }, [config]);

  return { config, loading };
}
