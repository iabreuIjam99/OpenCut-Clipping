// Diagnóstico one-off: sink con node:http para comprobar si un upstream Node
// detecta el abort del cliente que el sink Bun no ve. No forma parte del bench.
const http = require("node:http");

let run = 0;
const server = http.createServer((req, res) => {
  const id = ++run;
  let bytes = 0;
  console.log(
    `[node-sink] #${id} start te=${req.headers["transfer-encoding"]} cl=${req.headers["content-length"]}`,
  );
  req.on("data", (chunk) => {
    bytes += chunk.length;
  });
  req.on("aborted", () => {
    console.log(`[node-sink] #${id} ABORTED after ${bytes} B`);
  });
  req.on("close", () => {
    console.log(`[node-sink] #${id} CLOSE after ${bytes} B complete=${req.complete}`);
  });
  req.on("end", () => {
    console.log(`[node-sink] #${id} END ${bytes} B`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ bytes }));
  });
});
server.listen(8798, "127.0.0.1", () => console.log("[node-sink] listening on 8798"));
