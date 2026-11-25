"use strict";

const {randomUUID}=require("node:crypto");

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

    remove(id) { this.removeMany([id]); }

    removeMany(ids) {
        const items=[...new Set(ids)].map(id=>this.items.get(id)).filter(Boolean);
        if (!items.length) return;
        this.removed={id:items.length===1 ? items[0].record.id : randomUUID(),items};
        for (const item of items) this.items.delete(item.record.id);
    }

    undoRemoval(id) {
        if (!this.removed || this.removed.id !== id) return;
        for (const item of this.removed.items) {
            if (!this.items.has(item.record.id)) this.items.set(item.record.id,item);
        }
        this.removed=undefined;
    }

    recordsWithHistory(records) {
        const present = new Set(records.map(row => row.id));
        return [...this.items.values()].map(item => item.record).filter(record => !present.has(record.id)).concat(records);
    }
}
module.exports = {NetworkCollection};
