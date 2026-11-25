"use strict";

const {createServer} = require("node:http");
const {readFileSync} = require("node:fs");
const path = require("node:path");

const host = "127.0.0.1";
const port = 18991;
const page = readFileSync(path.join(__dirname, "checkout.html"));
const apiResponses = new Map([
    ["/api/workbench-order/payment", "付款接口正常"],
    ["/api/workbench-order/stock", "库存接口正常"],
]);

function send(response, status, type, body) {
    response.writeHead(status, {"Content-Type": type, "Cache-Control": "no-store"});
    response.end(body);
}

const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/workbench-order/") {
        send(response, 200, "text/html; charset=utf-8", page);
        return;
    }
    const label = apiResponses.get(request.url);
    if (request.method === "GET" && label) {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({label}));
        return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found");
});

server.on("error", error => {
    console.error(error.message);
    process.exitCode = 1;
});
server.listen(port, host, () => console.log(`http://${host}:${port}/workbench-order/`));
