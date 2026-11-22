"use strict";

// Only the host's retained, redacted record enters the durable collection.
// An item's identity is the originating exchange, even after history evicts it.
class NetworkCollection {
    constructor() { this.items = new Map(); }

    restore(items = []) {
        this.items = new Map(items.map(item => [item.record.id, item]));
    }

    save(record) {
        if (!record || this.items.has(record.id)) return;
        this.items.set(record.id, {
            name: record.method+" "+record.path, savedAt: new Date().toISOString(),
            record: structuredClone(record),
        });
    }

    rename(id, name) {
        const item = this.items.get(id);
        const value = typeof name === "string" && name.trim();
        if (item && value) item.name = value;
    }

    remove(id) {
        const item = this.items.get(id);
        if (!item) return;
        this.removed = item;
        this.items.delete(id);
    }

    undoRemoval(id) {
        if (this.removed?.record.id !== id) return;
        if (!this.items.has(id)) this.items.set(id,this.removed);
        this.removed = undefined;
    }

    recordsWithHistory(records) {
        const present = new Set(records.map(row => row.id));
        return [...this.items.values()].map(item => item.record).filter(record => !present.has(record.id)).concat(records);
    }
}
module.exports = {NetworkCollection};
