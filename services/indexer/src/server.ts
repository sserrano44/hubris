import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import type { IntentLifecycle } from "@hubris/sdk";
import { JsonIndexerStore } from "./store";

type RequestWithMeta = express.Request & { rawBody?: string; requestId?: string };

const runtimeEnv = (process.env.HUBRIS_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = runtimeEnv === "production";
const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN ?? "*";
const internalAuthSecret =
  process.env.INTERNAL_API_AUTH_SECRET
  ?? (isProduction ? "" : "dev-internal-auth-secret");
const internalAuthPreviousSecret = process.env.INTERNAL_API_AUTH_PREVIOUS_SECRET?.trim() ?? "";
const internalAuthVerificationSecrets = Array.from(
  new Set(
    [internalAuthSecret, internalAuthPreviousSecret].filter((secret): secret is string => secret.length > 0)
  )
);

validateStartupConfig();

const app = express();
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as RequestWithMeta).rawBody = buf.toString("utf8");
    }
  })
);
app.use((req, res, next) => {
  const requestId = req.header("x-request-id")?.trim() || randomUUID();
  (req as RequestWithMeta).requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
});
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-request-id");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

const port = Number(process.env.INDEXER_PORT ?? 3030);
const dbPath = process.env.INDEXER_DB_PATH ?? path.join(process.cwd(), "data", "indexer.json");
const store = new JsonIndexerStore(dbPath);
const internalAuthMaxSkewMs = Number(process.env.INTERNAL_API_AUTH_MAX_SKEW_MS ?? "60000");
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const internalRateWindowMs = Number(process.env.INTERNAL_API_RATE_WINDOW_MS ?? "60000");
const internalRateMaxRequests = Number(process.env.INTERNAL_API_RATE_MAX_REQUESTS ?? "2400");
const seenSignatures = new Map<string, number>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

if (!isProduction && internalAuthSecret === "dev-internal-auth-secret") {
  console.warn("Indexer is using default INTERNAL_API_AUTH_SECRET. Override it before production.");
}
if (internalAuthPreviousSecret.length > 0) {
  console.log("Indexer internal auth previous secret enabled for key rotation.");
}

const intentSchema = z.object({
  intentId: z.string().startsWith("0x"),
  status: z.enum(["initiated", "pending_lock", "locked", "filled", "awaiting_settlement", "settled", "failed"]),
  user: z.string().startsWith("0x"),
  intentType: z.number().int(),
  amount: z.string(),
  token: z.string(),
  txHash: z.string().startsWith("0x").optional(),
  metadata: z.record(z.unknown()).optional()
});

const statusPatchSchema = z.object({
  status: z.enum(["initiated", "pending_lock", "locked", "filled", "awaiting_settlement", "settled", "failed"]),
  txHash: z.string().startsWith("0x").optional(),
  metadata: z.record(z.unknown()).optional()
});

const depositSchema = z.object({
  depositId: z.number().int().nonnegative(),
  user: z.string().startsWith("0x"),
  intentType: z.number().int(),
  token: z.string().startsWith("0x"),
  amount: z.string(),
  status: z.enum(["initiated", "bridged", "settled"]),
  metadata: z.record(z.unknown()).optional()
});

app.use(rateLimitMiddleware);
app.use("/internal", requireInternalAuth);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/activity", (req, res) => {
  const user = typeof req.query.user === "string" ? req.query.user : undefined;
  const intents = store.listIntents(user);
  res.json(intents);
});

app.get("/intents/:intentId", (req, res) => {
  const intent = store.getIntent(req.params.intentId);
  if (!intent) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(intent);
});

app.post("/internal/intents/upsert", (req, res) => {
  const parsed = intentSchema.safeParse(req.body);
  if (!parsed.success) {
    auditLog(req as RequestWithMeta, "intent_upsert_rejected", { reason: "invalid_payload" });
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const payload = parsed.data;
  const entity: IntentLifecycle = {
    ...payload,
    intentId: payload.intentId as `0x${string}`,
    user: payload.user as `0x${string}`,
    updatedAt: new Date().toISOString()
  };

  auditLog(req as RequestWithMeta, "intent_upsert", { intentId: entity.intentId, status: entity.status });
  res.json(store.upsertIntent(entity));
});

app.post("/internal/intents/:intentId/status", (req, res) => {
  const parsed = statusPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    auditLog(req as RequestWithMeta, "intent_status_rejected", {
      intentId: req.params.intentId,
      reason: "invalid_payload"
    });
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const updated = store.updateIntentStatus(req.params.intentId as `0x${string}`, parsed.data.status, {
    txHash: parsed.data.txHash as `0x${string}` | undefined,
    metadata: parsed.data.metadata
  });

  if (!updated) {
    auditLog(req as RequestWithMeta, "intent_status_rejected", { intentId: req.params.intentId, reason: "not_found" });
    res.status(404).json({ error: "not_found" });
    return;
  }

  auditLog(req as RequestWithMeta, "intent_status_updated", {
    intentId: req.params.intentId,
    status: parsed.data.status
  });
  res.json(updated);
});

app.post("/internal/deposits/upsert", (req, res) => {
  const parsed = depositSchema.safeParse(req.body);
  if (!parsed.success) {
    auditLog(req as RequestWithMeta, "deposit_upsert_rejected", { reason: "invalid_payload" });
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  auditLog(req as RequestWithMeta, "deposit_upsert", {
    depositId: parsed.data.depositId,
    status: parsed.data.status
  });
  res.json(store.upsertDeposit(parsed.data));
});

app.get("/deposits/:depositId", (req, res) => {
  const dep = store.getDeposit(Number(req.params.depositId));
  if (!dep) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(dep);
});

app.listen(port, () => {
  console.log(`Indexer API listening on :${port}`);
  console.log(`Indexer state file: ${dbPath}`);
});

function requireInternalAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const request = req as RequestWithMeta;
  const timestamp = req.header("x-hubris-internal-ts");
  const signature = req.header("x-hubris-internal-sig");

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
  const routePath = req.originalUrl.split("?")[0] ?? req.path;
  const matchedSecret = internalAuthVerificationSecrets.find((secret) => {
    const expected = computeInternalSignature(secret, req.method, routePath, timestamp, rawBody);
    return constantTimeHexEqual(signature, expected);
  });
  if (!matchedSecret) {
    auditLog(request, "internal_auth_rejected", { reason: "bad_signature" });
    res.status(401).json({ error: "invalid_internal_auth_signature" });
    return;
  }

  seenSignatures.set(cacheKey, Date.now() + internalAuthMaxSkewMs);
  auditLog(request, "internal_auth_ok", {
    keyVersion: matchedSecret === internalAuthSecret ? "current" : "previous"
  });
  next();
}

function purgeExpiredSignatures() {
  const now = Date.now();
  for (const [key, expiresAt] of seenSignatures.entries()) {
    if (expiresAt <= now) seenSignatures.delete(key);
  }
}

function computeInternalSignature(
  secret: string,
  method: string,
  routePath: string,
  timestamp: string,
  rawBody: string
): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const payload = `${method.toUpperCase()}\n${routePath}\n${timestamp}\n${bodyHash}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  try {
    const lhs = Buffer.from(a, "hex");
    const rhs = Buffer.from(b, "hex");
    if (lhs.length === 0 || rhs.length === 0 || lhs.length !== rhs.length) {
      return false;
    }
    return timingSafeEqual(lhs, rhs);
  } catch {
    return false;
  }
}

function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
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
    auditLog(req as RequestWithMeta, "rate_limit_rejected", { isInternal, bucketKey });
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  existing.count += 1;
  next();
}

function auditLog(req: RequestWithMeta, action: string, fields?: Record<string, unknown>) {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    service: "indexer",
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

function validateStartupConfig() {
  if (!internalAuthSecret) {
    throw new Error("Missing INTERNAL_API_AUTH_SECRET");
  }
  if (isProduction && internalAuthSecret === "dev-internal-auth-secret") {
    throw new Error("INTERNAL_API_AUTH_SECRET cannot use dev default in production");
  }
  if (isProduction && corsAllowOrigin.trim() === "*") {
    throw new Error("CORS_ALLOW_ORIGIN cannot be '*' in production");
  }
}
