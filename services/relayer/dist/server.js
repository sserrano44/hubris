import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { createPublicClient, createWalletClient, decodeAbiParameters, defineChain, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HubLockManagerAbi, HubSettlementAbi, MockERC20Abi, SpokePortalAbi } from "@zkhub/abis";
var IntentType;
(function (IntentType) {
    IntentType[IntentType["SUPPLY"] = 1] = "SUPPLY";
    IntentType[IntentType["REPAY"] = 2] = "REPAY";
    IntentType[IntentType["BORROW"] = 3] = "BORROW";
    IntentType[IntentType["WITHDRAW"] = 4] = "WITHDRAW";
})(IntentType || (IntentType = {}));
const runtimeEnv = (process.env.ZKHUB_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = runtimeEnv === "production";
const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN ?? "*";
const internalAuthSecret = process.env.INTERNAL_API_AUTH_SECRET
    ?? (isProduction ? "" : "dev-internal-auth-secret");
const internalCallerHeader = "x-zkhub-internal-service";
const internalServiceName = process.env.INTERNAL_API_SERVICE_NAME?.trim() || "relayer";
const app = express();
app.set("json replacer", (_key, value) => (typeof value === "bigint" ? value.toString() : value));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.trim() || randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
});
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin);
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
const hubChainId = BigInt(process.env.HUB_CHAIN_ID ?? "8453");
const spokeChainId = BigInt(process.env.SPOKE_CHAIN_ID ?? "480");
const lockManagerAddress = process.env.HUB_LOCK_MANAGER_ADDRESS;
const settlementAddress = process.env.HUB_SETTLEMENT_ADDRESS;
const custodyAddress = process.env.HUB_CUSTODY_ADDRESS;
const canonicalReceiverAddress = process.env.HUB_CANONICAL_BRIDGE_RECEIVER_ADDRESS;
const portalAddress = process.env.SPOKE_PORTAL_ADDRESS;
const spokeCanonicalBridgeAddress = process.env.SPOKE_CANONICAL_BRIDGE_ADDRESS;
const relayerKey = process.env.RELAYER_PRIVATE_KEY;
const indexerApi = process.env.INDEXER_API_URL ?? "http://127.0.0.1:3030";
const proverApi = process.env.PROVER_API_URL ?? "http://127.0.0.1:3050";
const relayerInitialBackfillBlocks = BigInt(process.env.RELAYER_INITIAL_BACKFILL_BLOCKS ?? "2000");
const relayerMaxLogRange = BigInt(process.env.RELAYER_MAX_LOG_RANGE ?? "2000");
const relayerBridgeFinalityBlocks = BigInt(process.env.RELAYER_BRIDGE_FINALITY_BLOCKS ?? "0");
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const rateBuckets = new Map();
const spokeToHub = JSON.parse(process.env.SPOKE_TO_HUB_TOKEN_MAP ?? "{}");
if (!lockManagerAddress
    || !settlementAddress
    || !custodyAddress
    || !canonicalReceiverAddress
    || !portalAddress
    || !spokeCanonicalBridgeAddress
    || !relayerKey) {
    throw new Error("Missing required relayer env vars for deployed addresses/private key");
}
validateStartupConfig();
if (!isProduction && internalAuthSecret === "dev-internal-auth-secret") {
    console.warn("Relayer is using default INTERNAL_API_AUTH_SECRET. Override it before production.");
}
const relayerAccount = privateKeyToAccount(relayerKey);
const hubChain = defineChain({
    id: Number(hubChainId),
    name: "Hub",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [hubRpc] } }
});
const spokeChain = defineChain({
    id: Number(spokeChainId),
    name: "Spoke",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [spokeRpc] } }
});
const hubPublic = createPublicClient({ chain: hubChain, transport: http(hubRpc) });
const spokePublic = createPublicClient({ chain: spokeChain, transport: http(spokeRpc) });
const hubWallet = createWalletClient({ account: relayerAccount, chain: hubChain, transport: http(hubRpc) });
const spokeWallet = createWalletClient({ account: relayerAccount, chain: spokeChain, transport: http(spokeRpc) });
const canonicalBridgeReceiverAbi = parseAbi([
    "function forwardBridgedDeposit(uint256 depositId,uint8 intentType,address user,address hubAsset,uint256 amount,uint256 originChainId,bytes32 originTxHash,uint256 originLogIndex)"
]);
const trackingPath = process.env.RELAYER_TRACKING_PATH ?? path.join(process.cwd(), "data", "relayer-tracking.json");
const tracking = loadTracking(trackingPath);
let isPollingSpokeDeposits = false;
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
        hubChainId: hubChainId.toString(),
        canonicalReceiverAddress,
        spokeCanonicalBridgeAddress,
        bridgeFinalityBlocks: relayerBridgeFinalityBlocks.toString(),
        tracking: {
            lastSpokeBlock: tracking.lastSpokeBlock.toString()
        }
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
    if (isPollingSpokeDeposits)
        return;
    isPollingSpokeDeposits = true;
    try {
        const latestBlock = await spokePublic.getBlockNumber();
        if (latestBlock < tracking.lastSpokeBlock) {
            // Local anvil restarts can rewind chain height; restart scanning from genesis.
            tracking.lastSpokeBlock = 0n;
        }
        const finalizedToBlock = latestBlock > relayerBridgeFinalityBlocks
            ? latestBlock - relayerBridgeFinalityBlocks
            : 0n;
        if (finalizedToBlock == 0n)
            return;
        if (tracking.lastSpokeBlock === 0n && finalizedToBlock > relayerInitialBackfillBlocks) {
            tracking.lastSpokeBlock = finalizedToBlock - relayerInitialBackfillBlocks;
        }
        const fromBlock = tracking.lastSpokeBlock + 1n;
        if (finalizedToBlock < fromBlock)
            return;
        const rangeToBlock = fromBlock + relayerMaxLogRange - 1n < finalizedToBlock
            ? fromBlock + relayerMaxLogRange - 1n
            : finalizedToBlock;
        auditLog(undefined, "poll_range", {
            fromBlock: fromBlock.toString(),
            toBlock: rangeToBlock.toString(),
            latest: latestBlock.toString(),
            finalizedToBlock: finalizedToBlock.toString()
        });
        const canonicalBridgeLogs = await spokePublic.getLogs({
            address: spokeCanonicalBridgeAddress,
            event: parseAbiItem("event BridgeCalled(address indexed localToken, address indexed remoteToken, address indexed recipient, uint256 amount, uint32 minGasLimit, bytes extraData, address caller)"),
            fromBlock,
            toBlock: rangeToBlock
        });
        for (const log of canonicalBridgeLogs) {
            await handleCanonicalBridgeLog(log);
        }
        tracking.lastSpokeBlock = rangeToBlock;
        saveTracking(trackingPath, tracking);
    }
    finally {
        isPollingSpokeDeposits = false;
    }
}
async function handleCanonicalBridgeLog(log) {
    const localToken = log.args.localToken;
    const remoteToken = log.args.remoteToken;
    const recipient = log.args.recipient;
    const amount = log.args.amount;
    const extraData = log.args.extraData;
    const originTxHash = log.transactionHash;
    const originLogIndex = typeof log.logIndex === "bigint" ? log.logIndex : BigInt(log.logIndex ?? 0);
    if (!localToken || !remoteToken || !recipient || !extraData || amount === undefined || !originTxHash) {
        console.warn("Skipping canonical bridge log with missing fields");
        return;
    }
    if (recipient.toLowerCase() !== custodyAddress.toLowerCase()) {
        return;
    }
    let decoded;
    try {
        decoded = decodeAbiParameters([
            { type: "uint256" }, // depositId
            { type: "uint8" }, // intentType
            { type: "address" }, // user
            { type: "address" }, // spoke token
            { type: "uint256" }, // amount
            { type: "uint256" }, // origin chain id
            { type: "uint256" } // hub chain id
        ], extraData);
    }
    catch (error) {
        console.warn(`Skipping canonical bridge log with undecodable extraData: ${error.message}`);
        return;
    }
    const [depositId, decodedIntentTypeRaw, user, decodedSpokeToken, decodedAmount, originChainId, decodedHubChainId] = decoded;
    const intentType = Number(decodedIntentTypeRaw);
    if (intentType !== IntentType.SUPPLY && intentType !== IntentType.REPAY) {
        return;
    }
    if (decodedHubChainId !== hubChainId) {
        console.warn(`Skipping deposit ${depositId.toString()} due to hub chain mismatch extraData=${decodedHubChainId.toString()} expected=${hubChainId.toString()}`);
        return;
    }
    if (decodedSpokeToken.toLowerCase() !== localToken.toLowerCase()) {
        console.warn(`Skipping deposit ${depositId.toString()} due to spoke token mismatch in extraData`);
        return;
    }
    if (decodedAmount !== amount) {
        console.warn(`Skipping deposit ${depositId.toString()} due to amount mismatch in extraData`);
        return;
    }
    const mappedHubToken = spokeToHub[decodedSpokeToken.toLowerCase()];
    if (mappedHubToken && mappedHubToken.toLowerCase() !== remoteToken.toLowerCase()) {
        console.warn(`Skipping deposit ${depositId.toString()} due to hub token mismatch map=${mappedHubToken} bridge=${remoteToken}`);
        return;
    }
    const hubToken = (mappedHubToken ?? remoteToken);
    if (!hubToken) {
        console.warn(`Skipping deposit ${depositId.toString()} due to missing hub token`);
        return;
    }
    const status = await fetchDepositStatus(depositId);
    if (status === "settled" || status === "bridged") {
        return;
    }
    await postInternal(indexerApi, "/internal/deposits/upsert", {
        depositId: Number(depositId),
        user,
        intentType: intentType,
        token: hubToken,
        amount: amount.toString(),
        status: "initiated",
        metadata: {
            canonicalBridgeTx: originTxHash,
            canonicalBridgeLogIndex: originLogIndex.toString(),
            canonicalBridge: spokeCanonicalBridgeAddress
        }
    });
    let registerTx = "0x";
    try {
        registerTx = await hubWallet.writeContract({
            abi: canonicalBridgeReceiverAbi,
            address: canonicalReceiverAddress,
            functionName: "forwardBridgedDeposit",
            args: [
                depositId,
                intentType,
                user,
                hubToken,
                amount,
                originChainId,
                originTxHash,
                originLogIndex
            ],
            account: relayerAccount
        });
        await hubPublic.waitForTransactionReceipt({ hash: registerTx });
    }
    catch (error) {
        console.warn(`Canonical bridge attestation registration failed for deposit ${depositId.toString()}: ${error.message}`);
        return;
    }
    const latestStatus = await fetchDepositStatus(depositId);
    if (latestStatus === "settled" || latestStatus === "bridged") {
        return;
    }
    await postInternal(indexerApi, "/internal/deposits/upsert", {
        depositId: Number(depositId),
        user,
        intentType: intentType,
        token: hubToken,
        amount: amount.toString(),
        status: "bridged",
        metadata: {
            registerTx,
            canonicalBridgeTx: originTxHash,
            canonicalBridgeLogIndex: originLogIndex.toString(),
            canonicalBridge: spokeCanonicalBridgeAddress,
            originChainId: originChainId.toString()
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
async function fetchDepositStatus(depositId) {
    const existing = await fetch(`${indexerApi}/deposits/${depositId.toString()}`).catch(() => null);
    if (!existing || !existing.ok)
        return undefined;
    const payload = (await existing.json());
    return payload.status;
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
                "x-zkhub-internal-sig": signature,
                [internalCallerHeader]: internalServiceName
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
    const signature = computeInternalSignature(internalAuthSecret, method, routePath, timestamp, internalServiceName, rawBody);
    return { timestamp, signature };
}
function computeInternalSignature(secret, method, routePath, timestamp, callerService, rawBody) {
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const payload = `${method.toUpperCase()}\n${routePath}\n${timestamp}\n${callerService}\n${bodyHash}`;
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
function validateStartupConfig() {
    if (!internalAuthSecret) {
        throw new Error("Missing INTERNAL_API_AUTH_SECRET");
    }
    if (!internalServiceName) {
        throw new Error("INTERNAL_API_SERVICE_NAME cannot be empty");
    }
    if (isProduction && internalAuthSecret === "dev-internal-auth-secret") {
        throw new Error("INTERNAL_API_AUTH_SECRET cannot use dev default in production");
    }
    if (isProduction && corsAllowOrigin.trim() === "*") {
        throw new Error("CORS_ALLOW_ORIGIN cannot be '*' in production");
    }
    if (relayerBridgeFinalityBlocks < 0n) {
        throw new Error("RELAYER_BRIDGE_FINALITY_BLOCKS cannot be negative");
    }
    if (!canonicalReceiverAddress) {
        throw new Error("Missing HUB_CANONICAL_BRIDGE_RECEIVER_ADDRESS");
    }
    if (!spokeCanonicalBridgeAddress) {
        throw new Error("Missing SPOKE_CANONICAL_BRIDGE_ADDRESS");
    }
}
//# sourceMappingURL=server.js.map