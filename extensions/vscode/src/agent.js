"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const runExecutable = promisify(execFile);

class AgentError extends Error {
    constructor(error) {
        super(error.message);
        this.code = error.code;
        this.details = error.details;
    }
}

class AgentClient {
    constructor({ executable, prefix = [], env, verify, hdcPath, stateDir }) {
        this.executable = executable;
        this.prefix = prefix;
        this.env = env;
        this.verify = verify;
        this.hdcPath = hdcPath;
        this.stateDir = stateDir;
    }

    async call(command, input = {}) {
        await this.verify?.();
        const requests = path.join(this.stateDir, "requests");
        await fs.mkdir(requests, { recursive: true });
        const request = path.join(requests, randomUUID() + ".json");
        await fs.writeFile(request, JSON.stringify({ schemaVersion: "1", command, input }), {
            encoding: "utf8",
            flag: "wx",
        });
        const args = [...this.prefix, "--state-dir", this.stateDir, "--request", request, "--json"];
        if (this.hdcPath) args.push("--hdc", this.hdcPath);
        try {
            let stdout;
            try {
                ({ stdout } = await runExecutable(this.executable, args, {
                    encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: this.env,
                }));
            } catch (error) {
                if (!error.stdout) {
                    if (this.prefix.length) throw new Error(error.stderr?.trim() || error.message);
                    throw error;
                }
                stdout = error.stdout;
            }
            let envelope;
            try {
                envelope = JSON.parse(stdout);
            } catch {
                throw new AgentError({ code: "INVALID_AGENT_RESPONSE", message: "The CLI returned invalid JSON." });
            }
            if (!envelope.success) throw new AgentError(envelope.error);
            return envelope.data;
        } finally {
            await fs.unlink(request).catch(() => {});
        }
    }
}

module.exports = { AgentClient };
