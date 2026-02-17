import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseAbiItem, privateKeyToAccount } from "viem";
import { HubLockManagerAbi, HubSettlementAbi, HubCustodyAbi, MockERC20Abi, SpokePortalAbi } from "@zkhub/abis";
var IntentType;
(function (IntentType) {
    IntentType[IntentType["SUPPLY"] = 1] = "SUPPLY";
    IntentType[IntentType["REPAY"] = 2] = "REPAY";
    IntentType[IntentType["BORROW"] = 3] = "BORROW";
    IntentType[IntentType["WITHDRAW"] = 4] = "WITHDRAW";
})(IntentType || (IntentType = {}));
const app = express();
app.use(express.json({ limit: "1mb" }));
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
const port = Number(process.env.RELAYER_PORT ?? 3040);
const hubRpc = process.env.HUB_RPC_URL ?? "http://127.0.0.1:8545";
const spokeRpc = process.env.SPOKE_RPC_URL ?? "http://127.0.0.1:9545";
const lockManagerAddress = process.env.HUB_LOCK_MANAGER_ADDRESS;
const settlementAddress = process.env.HUB_SETTLEMENT_ADDRESS;
const custodyAddress = process.env.HUB_CUSTODY_ADDRESS;
const portalAddress = process.env.SPOKE_PORTAL_ADDRESS;
const relayerKey = process.env.RELAYER_PRIVATE_KEY;
const bridgeKey = process.env.BRIDGE_PRIVATE_KEY || relayerKey;
const indexerApi = process.env.INDEXER_API_URL ?? "http://127.0.0.1:3030";
const proverApi = process.env.PROVER_API_URL ?? "http://127.0.0.1:3050";
const internalAuthSecret = process.env.INTERNAL_API_AUTH_SECRET ?? "dev-internal-auth-secret";
const relayerInitialBackfillBlocks = BigInt(process.env.RELAYER_INITIAL_BACKFILL_BLOCKS ?? "2000");
const relayerMaxLogRange = BigInt(process.env.RELAYER_MAX_LOG_RANGE ?? "2000");
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const rateBuckets = new Map();
const spokeToHub = JSON.parse(process.env.SPOKE_TO_HUB_TOKEN_MAP ?? "{}");
if (!lockManagerAddress || !settlementAddress || !custodyAddress || !portalAddress || !relayerKey) {
    throw new Error("Missing required relayer env vars for deployed addresses/private key");
}
if (internalAuthSecret === "dev-internal-auth-secret") {
    console.warn("Relayer is using default INTERNAL_API_AUTH_SECRET. Override it before production.");
}
const relayerAccount = privateKeyToAccount(relayerKey);
const bridgeAccount = privateKeyToAccount(bridgeKey);
const hubPublic = createPublicClient({ transport: http(hubRpc) });
const spokePublic = createPublicClient({ transport: http(spokeRpc) });
const hubWallet = createWalletClient({ account: relayerAccount, transport: http(hubRpc) });
const spokeWallet = createWalletClient({ account: relayerAccount, transport: http(spokeRpc) });
const bridgeWallet = createWalletClient({ account: bridgeAccount, transport: http(hubRpc) });
const trackingPath = process.env.RELAYER_TRACKING_PATH ?? path.join(process.cwd(), "data", "relayer-tracking.json");
const tracking = loadTracking(trackingPath);
const submitSchema = z.object({
    intent: z.object({
        intentType: z.number().int().min(1).max(4),
        user: z.string().startsWith("0x"),
        inputChainId: z.string(),
        outputChainId: z.string(),
        inputToken: z.string().startsWith("0x"),
        outputToken: z.string().startsWith("0x"),
        amount: z.string(),
        recipient: z.string().startsWith("0x"),
        maxRelayerFee: z.string(),
        nonce: z.string(),
        deadline: z.string()
    }),
    signature: z.string().startsWith("0x"),
    relayerFee: z.string()
});
app.use(rateLimitMiddleware);
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        relayer: relayerAccount.address,
        hubRpc,
        spokeRpc,
        tracking
    });
});
app.get("/quote", (req, res) => {
    const amount = BigInt(String(req.query.amount ?? "0"));
    const intentType = Number(req.query.intentType ?? IntentType.BORROW);
    if (amount <= 0n) {
        res.status(400).json({ error: "invalid amount" });
        return;
    }
    // MVP quote model: static 30 bps fee for outbound intents.
    const feeBps = intentType === IntentType.BORROW || intentType === IntentType.WITHDRAW ? 30n : 0n;
    const fee = (amount * feeBps) / 10000n;
    res.json({ feeBps: Number(feeBps), fee: fee.toString() });
});
app.post("/intent/submit", async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "submit_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    try {
        const intent = parseIntent(parsed.data.intent);
        const signature = parsed.data.signature;
        const relayerFee = BigInt(parsed.data.relayerFee);
        if (intent.intentType !== IntentType.BORROW && intent.intentType !== IntentType.WITHDRAW) {
            auditLog(req, "submit_rejected", { reason: "unsupported_intent_type", intentType: intent.intentType });
            res.status(400).json({ error: "only borrow/withdraw are relayed in this endpoint" });
            return;
        }
        const intentId = rawIntentId(intent);
        await upsertIntent(intentId, intent, "pending_lock", {
            relayerFee: relayerFee.toString(),
            relayer: relayerAccount.address
        });
        const lockTx = await hubWallet.writeContract({
            abi: HubLockManagerAbi,
            address: lockManagerAddress,
            functionName: "lock",
            args: [intent, signature],
            account: relayerAccount
        });
        await hubPublic.waitForTransactionReceipt({ hash: lockTx });
        await updateIntentStatus(intentId, "locked", { lockTx });
        await spokeWallet.writeContract({
            abi: MockERC20Abi,
            address: intent.outputToken,
            functionName: "approve",
            args: [portalAddress, intent.amount],
            account: relayerAccount
        });
        const fillTx = await spokeWallet.writeContract({
            abi: SpokePortalAbi,
            address: portalAddress,
            functionName: intent.intentType === IntentType.BORROW ? "fillBorrow" : "fillWithdraw",
            args: [intent, relayerFee, "0x"],
            account: relayerAccount
        });
        await spokePublic.waitForTransactionReceipt({ hash: fillTx });
        await updateIntentStatus(intentId, "filled", { fillTx });
        const hubAsset = spokeToHub[intent.outputToken.toLowerCase()];
        if (!hubAsset) {
            throw new Error(`No spoke->hub token mapping for ${intent.outputToken}`);
        }
        const recordTx = await hubWallet.writeContract({
            abi: HubSettlementAbi,
            address: settlementAddress,
            functionName: "recordFillEvidence",
            args: [
                intentId,
                intent.intentType,
                intent.user,
                hubAsset,
                intent.amount,
                relayerFee,
                relayerAccount.address
            ],
            account: relayerAccount
        });
        await hubPublic.waitForTransactionReceipt({ hash: recordTx });
        await enqueueProverAction({
            kind: intent.intentType === IntentType.BORROW ? "borrow" : "withdraw",
            intentId,
            user: intent.user,
            hubAsset,
            amount: intent.amount.toString(),
            fee: relayerFee.toString(),
            relayer: relayerAccount.address
        });
        await updateIntentStatus(intentId, "awaiting_settlement", {
            fillEvidenceTx: recordTx
        });
        auditLog(req, "submit_ok", {
            intentId,
            intentType: intent.intentType,
            lockTx,
            fillTx,
            fillEvidenceTx: recordTx
        });
        res.json({
            intentId,
            status: "awaiting_settlement",
            lockTx,
            fillTx,
            fillEvidenceTx: recordTx
        });
    }
    catch (error) {
        auditLog(req, "submit_error", { message: error.message });
        res.status(500).json({ error: error.message });
    }
});
app.listen(port, () => {
    console.log(`Relayer API listening on :${port}`);
    setInterval(() => {
        pollSpokeDeposits().catch((error) => {
            console.error("Relayer poll error", error);
        });
    }, 5_000);
});
function rawIntentId(intent) {
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
async function pollSpokeDeposits() {
    const toBlock = await spokePublic.getBlockNumber();
    if (toBlock < tracking.lastSpokeBlock) {
        // Local anvil restarts can rewind chain height; restart scanning from genesis.
        tracking.lastSpokeBlock = 0n;
    }
    if (tracking.lastSpokeBlock === 0n && toBlock > relayerInitialBackfillBlocks) {
        tracking.lastSpokeBlock = toBlock - relayerInitialBackfillBlocks;
    }
    const fromBlock = tracking.lastSpokeBlock + 1n;
    if (toBlock < fromBlock)
        return;
    const rangeToBlock = fromBlock + relayerMaxLogRange - 1n < toBlock ? fromBlock + relayerMaxLogRange - 1n : toBlock;
    auditLog(undefined, "poll_range", {
        fromBlock: fromBlock.toString(),
        toBlock: rangeToBlock.toString(),
        latest: toBlock.toString()
    });
    const supplyLogs = await spokePublic.getLogs({
        address: portalAddress,
        event: parseAbiItem("event SupplyInitiated(uint256 indexed depositId, address indexed user, address indexed token, uint256 amount, uint256 hubChainId, uint256 timestamp)"),
        fromBlock,
        toBlock: rangeToBlock
    });
    const repayLogs = await spokePublic.getLogs({
        address: portalAddress,
        event: parseAbiItem("event RepayInitiated(uint256 indexed depositId, address indexed user, address indexed token, uint256 amount, uint256 hubChainId, uint256 timestamp)"),
        fromBlock,
        toBlock: rangeToBlock
    });
    for (const log of supplyLogs) {
        await handleDepositLog(log.args.depositId, log.args.user, log.args.token, log.args.amount, IntentType.SUPPLY);
    }
    for (const log of repayLogs) {
        await handleDepositLog(log.args.depositId, log.args.user, log.args.token, log.args.amount, IntentType.REPAY);
    }
    tracking.lastSpokeBlock = rangeToBlock;
    saveTracking(trackingPath, tracking);
}
async function handleDepositLog(depositId, user, spokeToken, amount, intentType) {
    const hubToken = spokeToHub[spokeToken.toLowerCase()];
    if (!hubToken) {
        console.warn(`Skipping deposit ${depositId.toString()} with unmapped token ${spokeToken}`);
        return;
    }
    const existing = await fetch(`${indexerApi}/deposits/${depositId.toString()}`).catch(() => null);
    if (existing && existing.ok) {
        const payload = (await existing.json());
        if (payload.status === "settled" || payload.status === "bridged") {
            return;
        }
    }
    await postInternal(indexerApi, "/internal/deposits/upsert", {
        depositId: Number(depositId),
        user,
        intentType,
        token: hubToken,
        amount: amount.toString(),
        status: "initiated"
    });
    // Mock bridge: mint equivalent hub token + register bridged deposit into custody.
    let mintTx = "0x";
    let registerTx = "0x";
    try {
        mintTx = await bridgeWallet.writeContract({
            abi: MockERC20Abi,
            address: hubToken,
            functionName: "mint",
            args: [custodyAddress, amount],
            account: bridgeAccount
        });
        await hubPublic.waitForTransactionReceipt({ hash: mintTx });
        registerTx = await bridgeWallet.writeContract({
            abi: HubCustodyAbi,
            address: custodyAddress,
            functionName: "registerBridgedDeposit",
            args: [depositId, intentType, user, hubToken, amount],
            account: bridgeAccount
        });
        await hubPublic.waitForTransactionReceipt({ hash: registerTx });
    }
    catch (error) {
        console.warn(`Bridge registration skipped for deposit ${depositId.toString()}: ${error.message}`);
    }
    await postInternal(indexerApi, "/internal/deposits/upsert", {
        depositId: Number(depositId),
        user,
        intentType,
        token: hubToken,
        amount: amount.toString(),
        status: "bridged",
        metadata: {
            mintTx,
            registerTx
        }
    });
    await enqueueProverAction({
        kind: intentType === IntentType.SUPPLY ? "supply" : "repay",
        depositId: depositId.toString(),
        user,
        hubAsset: hubToken,
        amount: amount.toString()
    });
}
async function enqueueProverAction(body) {
    await postInternal(proverApi, "/internal/enqueue", body);
}
async function upsertIntent(intentId, intent, status, metadata) {
    await postInternal(indexerApi, "/internal/intents/upsert", {
        intentId,
        status,
        user: intent.user,
        intentType: intent.intentType,
        amount: intent.amount.toString(),
        token: intent.outputToken,
        metadata
    });
}
async function updateIntentStatus(intentId, status, metadata) {
    await postInternal(indexerApi, `/internal/intents/${intentId}/status`, { status, metadata });
}
function parseIntent(payload) {
    return {
        intentType: payload.intentType,
        user: payload.user,
        inputChainId: BigInt(payload.inputChainId),
        outputChainId: BigInt(payload.outputChainId),
        inputToken: payload.inputToken,
        outputToken: payload.outputToken,
        amount: BigInt(payload.amount),
        recipient: payload.recipient,
        maxRelayerFee: BigInt(payload.maxRelayerFee),
        nonce: BigInt(payload.nonce),
        deadline: BigInt(payload.deadline)
    };
}
function loadTracking(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
        const initial = { lastSpokeBlock: 0n };
        saveTracking(filePath, initial);
        return initial;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { lastSpokeBlock: BigInt(raw.lastSpokeBlock ?? "0") };
}
function saveTracking(filePath, state) {
    fs.writeFileSync(filePath, JSON.stringify({ lastSpokeBlock: state.lastSpokeBlock.toString() }, null, 2));
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
            throw new Error(`Failed internal call ${routePath}: ${res.status} ${await res.text()}`);
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
function computeInternalSignature(secret, method, routePath, timestamp, rawBody) {
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const payload = `${method.toUpperCase()}\n${routePath}\n${timestamp}\n${bodyHash}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
}
function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const bucketKey = `public:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const existing = rateBuckets.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
        rateBuckets.set(bucketKey, { count: 1, resetAt: now + apiRateWindowMs });
        next();
        return;
    }
    if (existing.count >= apiRateMaxRequests) {
        auditLog(req, "rate_limit_rejected", { bucketKey });
        res.status(429).json({ error: "rate_limited" });
        return;
    }
    existing.count += 1;
    next();
}
function auditLog(req, action, fields) {
    const payload = {
        ts: new Date().toISOString(),
        service: "relayer",
        action
    };
    if (req) {
        payload.requestId = req.requestId ?? "unknown";
        payload.method = req.method;
        payload.path = req.originalUrl.split("?")[0] ?? req.path;
    }
    if (fields) {
        for (const [key, value] of Object.entries(fields)) {
            payload[key] = value;
        }
    }
    console.log(JSON.stringify(payload));
}
//# sourceMappingURL=server.js.map