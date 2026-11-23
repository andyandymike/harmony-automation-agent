"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Webview scripts are ES modules alongside a CommonJS locator used by the
// extension host. Resolve local imports the same way as the browser in Node tests.
function moduleUrl(filename) {
    const source = fs.readFileSync(filename, "utf8").replace(
        /\b(from|import)\s+["'](\.\.?\/[^"']+\.js)["']/g,
        (_, keyword, relative) => keyword + ' "' + moduleUrl(path.resolve(path.dirname(filename), relative)) + '"',
    );
    return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}

module.exports = name => import(moduleUrl(path.resolve(__dirname, "../media", name + ".js")));
