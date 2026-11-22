"use strict";

const {randomUUID} = require("node:crypto");
const {validateScenario} = require("./network");

class ScenarioLibrary {
    constructor(saved, initial, untitled) {
        this.untitled = untitled;
        this.entries = new Map();
        if (saved) {
            if (!Array.isArray(saved.entries)) throw new Error("Invalid rule group library / 规则组库数据无效");
            for (const {id, scenario} of saved.entries) {
                if (typeof id !== "string" || !id || this.entries.has(id)) throw new Error("Invalid rule group ID / 规则组标识无效");
                this.entries.set(id, validateScenario(scenario));
            }
            if (this.entries.size && !this.entries.has(saved.activeId)) throw new Error("Active rule group missing / 找不到当前规则组");
            this.activeId = saved.activeId;
        }
        if (!this.entries.size) this.add(initial);
    }
    get active() { return this.entries.get(this.activeId); }
    get(id) {
        const scenario = this.entries.get(id);
        if (!scenario) throw new Error("Rule group no longer exists / 规则组已不存在");
        return scenario;
    }
    uniqueName(base) {
        const names = new Set([...this.entries.values()].map(s => s.name));
        if (!names.has(base)) return base;
        let suffix = 2;
        while (names.has(base+" ("+suffix+")")) suffix++;
        return base+" ("+suffix+")";
    }
    add(value) {
        return this.select(this.create(value));
    }
    create(value) {
        const scenario = validateScenario(value);
        scenario.name = this.uniqueName(String(scenario.name || this.untitled));
        const id = randomUUID();
        this.entries.set(id, scenario);
        return id;
    }
    select(id) {
        const scenario = this.get(id);
        this.activeId = id;
        return scenario;
    }
    named(value, except) {
        if (typeof value !== "string" || !value.trim()) throw new Error("Enter a rule group name / 请填写规则组名称");
        const name = value.trim();
        if ([...this.entries].some(([id,s]) => id !== except && s.name === name))
            throw new Error("A rule group with this name already exists / 已存在同名规则组");
        return name;
    }
    remove(id) {
        this.get(id);
        this.entries.delete(id);
        if (this.activeId === id) {
            this.activeId = this.entries.keys().next().value;
            if (!this.activeId) this.add({version:1,name:this.untitled,rules:[]});
        }
    }
    forFlow(value) {
        const normalized = validateScenario(value);
        const json = JSON.stringify(normalized);
        // Run bindings are immutable snapshots. Never overwrite an edited
        // workspace scenario when an older workflow asks for its snapshot.
        for (const [id,scenario] of this.entries) {
            if (JSON.stringify({...scenario,name:normalized.name}) === json &&
                (scenario.name === normalized.name || scenario.name.startsWith((normalized.name || this.untitled)+" (")))
                return this.select(id);
        }
        return this.add(normalized);
    }
    listing() {
        return [...this.entries].map(([id,s]) => ({id,name:s.name,ruleCount:s.rules.length,paused:s.paused===true}));
    }
    serialize() {
        return {activeId:this.activeId, entries:[...this.entries].map(([id,scenario])=>({id,scenario}))};
    }
}
module.exports={ScenarioLibrary};
