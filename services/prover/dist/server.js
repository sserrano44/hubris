import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { createPublicClient, createWalletClient, formatEther, parseEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HubSettlementAbi } from "@zkhub/abis";
import { buildBatch } from "./batch";
import { CircuitProofProvider, DevProofProvider } from "./proof";
const app = express();
app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
        req.rawBody = buf.toString("utf8");
    }
}));
app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.trim() || randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
});
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ALLOW_ORIGIN ?? "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-request-id");
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
});
const port = Number(process.env.PROVER_PORT ?? 3050);
const queuePath = process.env.PROVER_QUEUE_PATH ?? path.join(process.cwd(), "data", "prover-queue.json");
const statePath = process.env.PROVER_STATE_PATH ?? path.join(process.cwd(), "data", "prover-state.json");
const mode = process.env.PROVER_MODE ?? "dev";
const batchSize = Number(process.env.PROVER_BATCH_SIZE ?? 20);
const internalAuthSecret = process.env.INTERNAL_API_AUTH_SECRET ?? "dev-internal-auth-secret";
const internalAuthMaxSkewMs = Number(process.env.INTERNAL_API_AUTH_MAX_SKEW_MS ?? "60000");
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const internalRateWindowMs = Number(process.env.INTERNAL_API_RATE_WINDOW_MS ?? "60000");
const internalRateMaxRequests = Number(process.env.INTERNAL_API_RATE_MAX_REQUESTS ?? "2400");
const hubRpc = process.env.HUB_RPC_URL ?? "http://127.0.0.1:8545";
const hubChainId = BigInt(process.env.HUB_CHAIN_ID ?? "8453");
const spokeChainId = BigInt(process.env.SPOKE_CHAIN_ID ?? "480");
const settlementAddress = process.env.HUB_SETTLEMENT_ADDRESS;
const proverKey = process.env.PROVER_PRIVATE_KEY;
const proverFunderKey = process.env.PROVER_FUNDER_PRIVATE_KEY;
const proverMinNativeEth = process.env.PROVER_MIN_NATIVE_ETH ?? "0";
const proverMinNativeWei = parseNativeWei(proverMinNativeEth);
const indexerUrl = process.env.INDEXER_API_URL ?? "http://127.0.0.1:3030";
if (!settlementAddress || !proverKey) {
    throw new Error("Missing HUB_SETTLEMENT_ADDRESS or PROVER_PRIVATE_KEY");
}
const account = privateKeyToAccount(proverKey);
const walletClient = createWalletClient({ account, transport: http(hubRpc) });
const publicClient = createPublicClient({ transport: http(hubRpc) });
const funderAccount = proverFunderKey ? privateKeyToAccount(proverFunderKey) : null;
const funderWallet = funderAccount ? createWalletClient({ account: funderAccount, transport: http(hubRpc) }) : null;
const proofProvider = mode === "dev" ? new DevProofProvider() : new CircuitProofProvider();
const seenSignatures = new Map();
const rateBuckets = new Map();
let isFlushing = false;
if (internalAuthSecret === "dev-internal-auth-secret") {
    console.warn("Prover is using default INTERNAL_API_AUTH_SECRET. Override it before production.");
}
const actionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("supply"),
        depositId: z.string(),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string()
    }),
    z.object({
        kind: z.literal("repay"),
        depositId: z.string(),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string()
    }),
    z.object({
        kind: z.literal("borrow"),
        intentId: z.string().startsWith("0x"),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string(),
        fee: z.string(),
        relayer: z.string().startsWith("0x")
    }),
    z.object({
        kind: z.literal("withdraw"),
        intentId: z.string().startsWith("0x"),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string(),
        fee: z.string(),
        relayer: z.string().startsWith("0x")
    })
]);
const queue = loadQueue(queuePath);
const persistedState = loadState(statePath);
let nextBatchId = persistedState.nextBatchId > 0n
    ? persistedState.nextBatchId
    : BigInt(process.env.PROVER_BATCH_START ?? "1");
app.use("/internal", requireInternalAuth);
app.use(rateLimitMiddleware);
app.get("/health", (_req, res) => {
    res.json({ ok: true, mode, queued: queue.length, nextBatchId: nextBatchId.toString(), isFlushing });
});
app.post("/internal/enqueue", (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "enqueue_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    const action = normalizeAction(parsed.data);
    const key = actionKey(action);
    const alreadyQueued = queue.some((item) => actionKey(item) === key);
    if (alreadyQueued) {
        auditLog(req, "enqueue_duplicate", { key });
        res.json({ ok: true, queued: queue.length, duplicate: true });
        return;
    }
    queue.push(action);
    saveQueue(queuePath, queue);
    auditLog(req, "enqueue_ok", { key, queued: queue.length });
    res.json({ ok: true, queued: queue.length });
});
app.post("/internal/flush", async (_req, res) => {
    try {
        const settled = await flushQueue();
        auditLog(_req, "flush_ok", { settled, queued: queue.length });
        res.json({ ok: true, settled });
    }
    catch (error) {
        auditLog(_req, "flush_error", { message: error.message });
        res.status(500).json({ ok: false, error: error.message });
    }
});
app.listen(port, () => {
    console.log(`Prover service listening on :${port} (mode=${mode})`);
    startupPreflight().catch((error) => {
        console.error("Prover startup preflight failed", error);
        process.exit(1);
    });
    setInterval(() => {
        flushQueue().catch((error) => {
            console.error("Prover flush error", error);
        });
    }, 5_000);
});
async function flushQueue() {
    if (isFlushing)
        return 0;
    if (queue.length === 0)
        return 0;
    isFlushing = true;
    try {
        const actions = queue.slice(0, batchSize);
        const batch = buildBatch(nextBatchId, hubChainId, spokeChainId, actions);
        const { proof } = await proofProvider.prove(batch);
        await ensureProverHasGas("flush");
        const txHash = await walletClient.writeContract({
            abi: HubSettlementAbi,
            address: settlementAddress,
            functionName: "settleBatch",
            args: [batch, proof],
            account
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        // Persist queue + batch cursor immediately after on-chain success.
        queue.splice(0, actions.length);
        saveQueue(queuePath, queue);
        nextBatchId += 1n;
        saveState(statePath, { nextBatchId });
        for (const action of actions) {
            if (action.kind === "supply" || action.kind === "repay") {
                await postInternal(indexerUrl, "/internal/deposits/upsert", {
                    depositId: Number(action.depositId),
                    user: action.user,
                    intentType: action.kind === "supply" ? 1 : 2,
                    token: action.hubAsset,
                    amount: action.amount.toString(),
                    status: "settled",
                    metadata: {
                        batchId: batch.batchId.toString(),
                        txHash
                    }
                }).catch((error) => {
                    console.error(`Failed to update settled deposit ${action.depositId.toString()}`, error);
                });
            }
            if (action.kind === "borrow" || action.kind === "withdraw") {
                await postInternal(indexerUrl, `/internal/intents/${action.intentId}/status`, {
                    status: "settled",
                    txHash,
                    metadata: { batchId: batch.batchId.toString() }
                }).catch((error) => {
                    console.error(`Failed to update settled intent ${action.intentId}`, error);
                });
            }
        }
        console.log(`Settled batch ${batch.batchId.toString()} with ${actions.length} actions (tx=${txHash})`);
        return actions.length;
    }
    finally {
        isFlushing = false;
    }
}
async function startupPreflight() {
    const [chainId, balance] = await Promise.all([
        publicClient.getChainId(),
        publicClient.getBalance({ address: account.address })
    ]);
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        service: "prover",
        action: "startup_context",
        hubRpc,
        hubChainId: String(chainId),
        signer: account.address,
        signerBalanceEth: formatEther(balance),
        minNativeEth: proverMinNativeEth,
        funder: funderAccount?.address ?? null
    }));
    await ensureProverHasGas("startup");
}
async function ensureProverHasGas(reason) {
    if (proverMinNativeWei <= 0n)
        return;
    const current = await publicClient.getBalance({ address: account.address });
    if (current >= proverMinNativeWei)
        return;
    if (!funderWallet || !funderAccount) {
        throw new Error(`prover signer ${account.address} balance too low (${formatEther(current)} ETH < ${proverMinNativeEth} ETH) ` +
            `and PROVER_FUNDER_PRIVATE_KEY is not set.`);
    }
    if (funderAccount.address.toLowerCase() === account.address.toLowerCase()) {
        throw new Error(`prover signer ${account.address} balance too low (${formatEther(current)} ETH < ${proverMinNativeEth} ETH) ` +
            "and PROVER_FUNDER_PRIVATE_KEY points to the same address.");
    }
    const needed = proverMinNativeWei - current;
    const funderBalance = await publicClient.getBalance({ address: funderAccount.address });
    if (funderBalance <= needed) {
        throw new Error(`funder ${funderAccount.address} lacks balance to top up prover. ` +
            `needed=${formatEther(needed)} funder=${formatEther(funderBalance)}`);
    }
    const txHash = await funderWallet.sendTransaction({
        to: account.address,
        value: needed,
        account: funderAccount
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const updated = await publicClient.getBalance({ address: account.address });
    if (updated < proverMinNativeWei) {
        throw new Error(`prover top-up did not reach required minimum. balance=${formatEther(updated)} required=${proverMinNativeEth}`);
    }
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        service: "prover",
        action: "prover_gas_topped_up",
        reason,
        signer: account.address,
        funder: funderAccount.address,
        txHash,
        balanceEth: formatEther(updated)
    }));
}
function normalizeAction(input) {
    if (input.kind === "supply" || input.kind === "repay") {
        return {
            kind: input.kind,
            depositId: BigInt(input.depositId),
            user: input.user,
            hubAsset: input.hubAsset,
            amount: BigInt(input.amount)
        };
    }
    return {
        kind: input.kind,
        intentId: input.intentId,
        user: input.user,
        hubAsset: input.hubAsset,
        amount: BigInt(input.amount),
        fee: BigInt(input.fee),
        relayer: input.relayer
    };
}
function loadQueue(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, "[]");
        return [];
    }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return raw.map((entry) => normalizeAction(entry));
    }
    catch {
        return [];
    }
}
function saveQueue(filePath, actions) {
    const json = actions.map((action) => JSON.parse(JSON.stringify(action, (_, value) => {
        if (typeof value === "bigint")
            return value.toString();
        return value;
    })));
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
}
async function postInternal(baseUrl, routePath, body) {
    const rawBody = JSON.stringify(body);
    const { timestamp, signature } = signInternalRequest("POST", routePath, rawBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(new URL(routePath, baseUrl).toString(), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-zkhub-internal-ts": timestamp,
                "x-zkhub-internal-sig": signature
            },
            body: rawBody,
            signal: controller.signal
        });
        if (!res.ok) {
            throw new Error(`${res.status} ${await res.text()}`);
        }
    }
    finally {
        clearTimeout(timeout);
    }
}
function signInternalRequest(method, routePath, rawBody) {
    const timestamp = Date.now().toString();
    const signature = computeInternalSignature(internalAuthSecret, method, routePath, timestamp, rawBody);
    return { timestamp, signature };
}
function requireInternalAuth(req, res, next) {
    const request = req;
    const timestamp = req.header("x-zkhub-internal-ts");
    const signature = req.header("x-zkhub-internal-sig");
    if (!timestamp || !signature) {
        auditLog(request, "internal_auth_rejected", { reason: "missing_headers" });
        res.status(401).json({ error: "missing_internal_auth_headers" });
        return;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
        auditLog(request, "internal_auth_rejected", { reason: "bad_timestamp" });
        res.status(401).json({ error: "invalid_internal_auth_timestamp" });
        return;
    }
    if (Math.abs(Date.now() - ts) > internalAuthMaxSkewMs) {
        auditLog(request, "internal_auth_rejected", { reason: "stale_timestamp" });
        res.status(401).json({ error: "stale_internal_auth_timestamp" });
        return;
    }
    const cacheKey = `${timestamp}:${signature}`;
    purgeExpiredSignatures();
    if (seenSignatures.has(cacheKey)) {
        auditLog(request, "internal_auth_rejected", { reason: "replay" });
        res.status(409).json({ error: "replayed_internal_request" });
        return;
    }
    const rawBody = request.rawBody ?? "";
    const expected = computeInternalSignature(internalAuthSecret, req.method, req.originalUrl.split("?")[0] ?? req.path, timestamp, rawBody);
    if (!constantTimeHexEqual(signature, expected)) {
        auditLog(request, "internal_auth_rejected", { reason: "bad_signature" });
        res.status(401).json({ error: "invalid_internal_auth_signature" });
        return;
    }
    seenSignatures.set(cacheKey, Date.now() + internalAuthMaxSkewMs);
    auditLog(request, "internal_auth_ok");
    next();
}
function purgeExpiredSignatures() {
    const now = Date.now();
    for (const [key, expiresAt] of seenSignatures.entries()) {
        if (expiresAt <= now)
            seenSignatures.delete(key);
    }
}
function computeInternalSignature(secret, method, routePath, timestamp, rawBody) {
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const payload = `${method.toUpperCase()}\n${routePath}\n${timestamp}\n${bodyHash}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
}
function constantTimeHexEqual(a, b) {
    try {
        const lhs = Buffer.from(a, "hex");
        const rhs = Buffer.from(b, "hex");
        if (lhs.length === 0 || rhs.length === 0 || lhs.length !== rhs.length)
            return false;
        return timingSafeEqual(lhs, rhs);
    }
    catch {
        return false;
    }
}
function actionKey(action) {
    switch (action.kind) {
        case "supply":
        case "repay":
            return `${action.kind}:${action.depositId.toString()}:${action.user}:${action.hubAsset}:${action.amount.toString()}`;
        case "borrow":
        case "withdraw":
            return `${action.kind}:${action.intentId}:${action.user}:${action.hubAsset}:${action.amount.toString()}:${action.fee.toString()}:${action.relayer}`;
        default:
            return JSON.stringify(action);
    }
}
function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const isInternal = req.path.startsWith("/internal");
    const windowMs = isInternal ? internalRateWindowMs : apiRateWindowMs;
    const maxRequests = isInternal ? internalRateMaxRequests : apiRateMaxRequests;
    const bucketKey = `${isInternal ? "internal" : "public"}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const existing = rateBuckets.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
        rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
        next();
        return;
    }
    if (existing.count >= maxRequests) {
        auditLog(req, "rate_limit_rejected", { isInternal, bucketKey });
        res.status(429).json({ error: "rate_limited" });
        return;
    }
    existing.count += 1;
    next();
}
function auditLog(req, action, fields) {
    const payload = {
        ts: new Date().toISOString(),
        service: "prover",
        action,
        requestId: req.requestId ?? "unknown",
        method: req.method,
        path: req.originalUrl.split("?")[0] ?? req.path
    };
    if (fields) {
        for (const [key, value] of Object.entries(fields)) {
            payload[key] = value;
        }
    }
    console.log(JSON.stringify(payload));
}
function loadState(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
        const initial = { nextBatchId: 1n };
        saveState(filePath, initial);
        return initial;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return { nextBatchId: BigInt(raw.nextBatchId ?? "1") };
    }
    catch {
        return { nextBatchId: 1n };
    }
}
function saveState(filePath, state) {
    fs.writeFileSync(filePath, JSON.stringify({ nextBatchId: state.nextBatchId.toString() }, null, 2));
}
function parseNativeWei(value) {
    const normalized = value.trim();
    if (!normalized || normalized === "0")
        return 0n;
    return parseEther(normalized);
}
//# sourceMappingURL=server.js.map