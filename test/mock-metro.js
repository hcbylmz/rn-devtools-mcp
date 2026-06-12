import http from "node:http";
import { WebSocketServer } from "ws";

// Minimal stand-in for Metro's inspector-proxy + Hermes fusebox backend.
// Lets us test CDPClient without a running simulator.
export async function startMockMetro() {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/json" || req.url === "/json/list") {
      const port = httpServer.address().port;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            title: "com.test.app (Mock)",
            description: "React Native Bridgeless [C++ connection]",
            type: "node",
            webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=mock&page=1`,
          },
        ]),
      );
      return;
    }
    if (req.url === "/symbolicate" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          stack: [{ file: "src/App.tsx", lineNumber: 42, column: 7, methodName: "render" }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;

  const wss = new WebSocketServer({ server: httpServer, path: "/inspector/debug" });
  const sockets = new Set();

  wss.on("connection", (socket, req) => {
    sockets.add(socket);
    // Emulate the fusebox backend: only service CDP messages when the Origin
    // host is exactly 127.0.0.1 (the regression this client works around).
    const originOk = req.headers.origin === `http://127.0.0.1:${port}`;
    socket.originOk = originOk;
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      if (!originOk) return; // silent drop — mirrors the real backend
      const msg = JSON.parse(raw.toString());
      if (msg.method === "FuseboxClient.setClientMetadata") {
        socket.send(JSON.stringify({ id: msg.id, error: { message: "Unsupported method" } }));
        return;
      }
      // Respond only to the methods a real backend services; leave anything
      // else unanswered so timeout behaviour can be tested.
      if (msg.method === "Runtime.evaluate" || msg.method.endsWith(".enable")) {
        socket.send(JSON.stringify({ id: msg.id, result: { result: { type: "number", value: 1 } } }));
      }
    });
  });

  return {
    port,
    // Push an arbitrary CDP event to every connected debugger.
    emit(event) {
      for (const socket of sockets) socket.send(JSON.stringify(event));
    },
    lastOrigin() {
      return [...sockets][0]?.originOk;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}
