import fs from "node:fs";
import path from "node:path";
export function createInitialRelayerState() {
    return {
        version: 2,
        lastSpokeBlock: 0n,
        lastHubBlock: 0n,
        tasks: {}
    };
}
export function loadRelayerState(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
        const initial = createInitialRelayerState();
        saveRelayerState(filePath, initial);
        return initial;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (typeof raw.version === "number"
            && raw.version === 2) {
            const state = raw;
            return {
                version: 2,
                lastSpokeBlock: BigInt(state.lastSpokeBlock ?? "0"),
                lastHubBlock: BigInt(state.lastHubBlock ?? "0"),
                tasks: sanitizeTasks(state.tasks)
            };
        }
        // Legacy one-file tracking format.
        return {
            version: 2,
            lastSpokeBlock: BigInt(raw.lastSpokeBlock ?? "0"),
            lastHubBlock: BigInt(raw.lastHubBlock ?? "0"),
            tasks: {}
        };
    }
    catch {
        return createInitialRelayerState();
    }
}
export function saveRelayerState(filePath, state) {
    const serialized = {
        version: 2,
        lastSpokeBlock: state.lastSpokeBlock.toString(),
        lastHubBlock: state.lastHubBlock.toString(),
        tasks: sanitizeTasks(state.tasks)
    };
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(serialized, null, 2));
    fs.renameSync(tmpPath, filePath);
}
function sanitizeTasks(tasks) {
    const result = {};
    if (!tasks || typeof tasks !== "object")
        return result;
    for (const [id, task] of Object.entries(tasks)) {
        if (!task || typeof task !== "object")
            continue;
        if (typeof task.kind !== "string")
            continue;
        if (typeof task.attempts !== "number" || !Number.isFinite(task.attempts))
            continue;
        if (typeof task.nextAttemptAt !== "number" || !Number.isFinite(task.nextAttemptAt))
            continue;
        if (typeof task.createdAt !== "number" || !Number.isFinite(task.createdAt))
            continue;
        if (typeof task.updatedAt !== "number" || !Number.isFinite(task.updatedAt))
            continue;
        if (!task.payload || typeof task.payload !== "object")
            continue;
        result[id] = {
            id,
            kind: task.kind,
            payload: task.payload,
            attempts: task.attempts,
            nextAttemptAt: task.nextAttemptAt,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            terminal: task.terminal === true,
            terminalReason: typeof task.terminalReason === "string" ? task.terminalReason : undefined,
            lastError: typeof task.lastError === "string" ? task.lastError : undefined
        };
    }
    return result;
}
//# sourceMappingURL=finalization-state.js.map