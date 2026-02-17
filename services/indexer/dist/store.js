import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const DEFAULT_DB = {
    intents: {},
    deposits: {}
};
export class JsonIndexerStore {
    filePath;
    state;
    constructor(filePath) {
        this.filePath = filePath;
        this.state = this.load();
    }
    upsertIntent(intent) {
        const current = this.state.intents[intent.intentId];
        const merged = {
            ...current,
            ...intent,
            metadata: {
                ...(current?.metadata ?? {}),
                ...(intent.metadata ?? {})
            },
            updatedAt: new Date().toISOString()
        };
        this.state.intents[intent.intentId] = merged;
        this.save();
        return merged;
    }
    updateIntentStatus(intentId, status, patch) {
        const current = this.state.intents[intentId];
        if (!current)
            return null;
        const updated = {
            ...current,
            ...patch,
            status,
            metadata: {
                ...(current.metadata ?? {}),
                ...(patch?.metadata ?? {})
            },
            updatedAt: new Date().toISOString()
        };
        this.state.intents[intentId] = updated;
        this.save();
        return updated;
    }
    getIntent(intentId) {
        return this.state.intents[intentId] ?? null;
    }
    listIntents(user) {
        return Object.values(this.state.intents)
            .filter((intent) => (user ? intent.user.toLowerCase() === user.toLowerCase() : true))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    upsertDeposit(dep) {
        const current = this.state.deposits[String(dep.depositId)];
        const merged = {
            ...current,
            ...dep,
            metadata: {
                ...(current?.metadata ?? {}),
                ...(dep.metadata ?? {})
            },
            updatedAt: new Date().toISOString()
        };
        this.state.deposits[String(dep.depositId)] = merged;
        this.save();
        return merged;
    }
    getDeposit(depositId) {
        return this.state.deposits[String(depositId)] ?? null;
    }
    load() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, JSON.stringify(DEFAULT_DB, null, 2));
            return structuredClone(DEFAULT_DB);
        }
        try {
            const raw = fs.readFileSync(this.filePath, "utf8");
            return { ...DEFAULT_DB, ...JSON.parse(raw) };
        }
        catch {
            return structuredClone(DEFAULT_DB);
        }
    }
    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    }
}
export class SqliteIndexerStore {
    db;
    constructor(filePath) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.db = new DatabaseSync(filePath);
        this.db.exec("PRAGMA journal_mode=WAL;");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        intent_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intents_updated_at ON intents(updated_at DESC);

      CREATE TABLE IF NOT EXISTS deposits (
        deposit_id INTEGER PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deposits_updated_at ON deposits(updated_at DESC);
    `);
    }
    upsertIntent(intent) {
        const current = this.getIntent(intent.intentId);
        const merged = {
            ...current,
            ...intent,
            metadata: {
                ...(current?.metadata ?? {}),
                ...(intent.metadata ?? {})
            },
            updatedAt: new Date().toISOString()
        };
        this.db.prepare(`
      INSERT INTO intents (intent_id, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(intent_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      `).run(merged.intentId, JSON.stringify(merged), merged.updatedAt);
        return merged;
    }
    updateIntentStatus(intentId, status, patch) {
        const current = this.getIntent(intentId);
        if (!current)
            return null;
        const updated = {
            ...current,
            ...patch,
            status,
            metadata: {
                ...(current.metadata ?? {}),
                ...(patch?.metadata ?? {})
            },
            updatedAt: new Date().toISOString()
        };
        this.db.prepare(`
      UPDATE intents
      SET payload_json = ?, updated_at = ?
      WHERE intent_id = ?
      `).run(JSON.stringify(updated), updated.updatedAt, intentId);
        return updated;
    }
    getIntent(intentId) {
        const row = this.db.prepare("SELECT payload_json FROM intents WHERE intent_id = ?").get(intentId);
        if (!row)
            return null;
        return safeJsonParse(row.payload_json);
    }
    listIntents(user) {
        const rows = this.db.prepare("SELECT payload_json FROM intents ORDER BY updated_at DESC").all();
        const intents = [];
        for (const row of rows) {
            const parsed = safeJsonParse(row.payload_json);
            if (!parsed)
                continue;
            if (user && parsed.user.toLowerCase() !== user.toLowerCase())
                continue;
            intents.push(parsed);
        }
        return intents;
    }
    upsertDeposit(dep) {
        const current = this.getDeposit(dep.depositId);
        const merged = {
            ...current,
            ...dep,
            metadata: {
                ...(current?.metadata ?? {}),
                ...(dep.metadata ?? {})
            },
            updatedAt: new Date().toISOString()
        };
        this.db.prepare(`
      INSERT INTO deposits (deposit_id, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(deposit_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      `).run(merged.depositId, JSON.stringify(merged), merged.updatedAt);
        return merged;
    }
    getDeposit(depositId) {
        const row = this.db.prepare("SELECT payload_json FROM deposits WHERE deposit_id = ?").get(depositId);
        if (!row)
            return null;
        return safeJsonParse(row.payload_json);
    }
}
function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=store.js.map