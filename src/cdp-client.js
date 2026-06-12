import WebSocket from "ws";

const DEFAULT_METRO_PORT = 8081;

export class CDPClient {
  constructor(metroPort = DEFAULT_METRO_PORT) {
    this.metroPort = metroPort;
    this.ws = null;
    this.messageId = 0;
    this.pendingMessages = new Map();
    this.consoleMessages = [];
    this.networkRequests = new Map();
    this.exceptions = [];
  }

  async getDebuggerTargets() {
    const response = await fetch(
      `http://localhost:${this.metroPort}/json`
    );
    return response.json();
  }

  async connect() {
    const targets = await this.getDebuggerTargets();
    const hermesTarget = targets.find(
      (target) =>
        target.title === "Hermes React Native" ||
        target.title?.includes("React") ||
        target.type === "node"
    );

    if (!hermesTarget) {
      throw new Error(
        `No React Native debugger target found. Available targets: ${JSON.stringify(targets.map((t) => t.title))}`
      );
    }

    const wsUrl = hermesTarget.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error("Target has no webSocketDebuggerUrl");
    }

    return new Promise((resolve, reject) => {
      // Metro's inspector-proxy (RN 0.85+ / Expo SDK 56 "fusebox") rejects
      // debugger WebSocket connections whose Origin header does not match the
      // dev-server origin (HostAgent verifyClient -> 401 Unauthorized).
      // The upgrade succeeds with a `localhost` origin, but the fusebox backend
      // then silently drops every CDP message (total timeout) unless the origin
      // host is exactly `127.0.0.1`. Mirror the official RN DevTools / Argent
      // and use the loopback IP, not the `localhost` hostname.
      const socket = new WebSocket(wsUrl, {
        origin: `http://127.0.0.1:${this.metroPort}`,
      });
      this.ws = socket;

      socket.on("open", async () => {
        this._setupEventListeners();
        // Liveness probe: the WS upgrade can succeed while the fusebox backend
        // silently drops every CDP message (e.g. wrong Origin host on RN 0.85+).
        // Catch that here with an actionable error instead of a generic timeout
        // on the first real command.
        try {
          await this.send("Runtime.evaluate", { expression: "1", returnByValue: true }, 4000);
          resolve();
        } catch {
          this.ws?.close();
          this.ws = null;
          reject(
            new Error(
              "Connected to Metro but the runtime never responded (CDP messages dropped). " +
                "Likely a Metro inspector-proxy / fusebox mismatch (RN 0.85+ / Expo SDK 56): " +
                "the Origin host must be 127.0.0.1, the app must be in dev mode with Hermes, " +
                "and only one debugger may be attached. Reload the app and retry.",
            ),
          );
        }
      });

      socket.on("error", (error) => {
        reject(new Error(`CDP WebSocket error: ${error.message}`));
      });

      // Only clear the active socket if a newer connect() hasn't replaced it.
      // Without this guard, a stale socket's late `close` would null out a
      // freshly reconnected socket (breaks ensureConnected after a reload).
      socket.on("close", () => {
        if (this.ws === socket) this.ws = null;
      });
    });
  }

  // Reconnect transparently if the socket dropped (e.g. after an app reload),
  // so callers don't have to manually re-run `connect`.
  async ensureConnected() {
    if (this.isConnected) return;
    await this.connect();
    await this.enableDomains();
  }

  // Map minified bundle stack frames to source file:line via Metro's
  // /symbolicate endpoint. Accepts CDP callFrames; returns enriched frames.
  async symbolicate(callFrames = []) {
    const stack = callFrames
      .filter((frame) => frame && frame.url)
      .map((frame) => ({
        file: frame.url,
        lineNumber: frame.lineNumber ?? 0,
        column: frame.columnNumber ?? 0,
        methodName: frame.functionName || "<anonymous>",
      }));
    if (stack.length === 0) return [];
    try {
      const response = await fetch(`http://127.0.0.1:${this.metroPort}/symbolicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stack }),
      });
      const data = await response.json();
      return data.stack ?? [];
    } catch {
      return [];
    }
  }

  _setupEventListeners() {
    this.ws.on("message", (data) => {
      const message = JSON.parse(data.toString());

      if (message.id !== undefined) {
        const pending = this.pendingMessages.get(message.id);
        if (pending) {
          this.pendingMessages.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message.result);
          }
        }
      }

      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails ?? {};
        const exc = details.exception ?? {};
        this.exceptions.push({
          timestamp: message.params.timestamp,
          text: details.text ?? exc.description ?? "Uncaught exception",
          description: exc.description ?? exc.value ?? null,
          stackTrace: details.stackTrace ?? null,
        });
        if (this.exceptions.length > 200) {
          this.exceptions = this.exceptions.slice(-100);
        }
      }

      if (message.method === "Runtime.consoleAPICalled") {
        this.consoleMessages.push({
          type: message.params.type,
          timestamp: message.params.timestamp,
          args: message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type),
        });
        if (this.consoleMessages.length > 500) {
          this.consoleMessages = this.consoleMessages.slice(-300);
        }
      }

      if (message.method === "Network.requestWillBeSent") {
        const { requestId, request, timestamp, type } = message.params;
        this.networkRequests.set(requestId, {
          url: request.url,
          method: request.method,
          headers: request.headers,
          postData: request.postData,
          timestamp,
          type,
        });
        if (this.networkRequests.size > 500) {
          const oldest = [...this.networkRequests.keys()].slice(0, 200);
          oldest.forEach((key) => this.networkRequests.delete(key));
        }
      }

      if (message.method === "Network.responseReceived") {
        const { requestId, response } = message.params;
        const existing = this.networkRequests.get(requestId);
        if (existing) {
          existing.status = response.status;
          existing.statusText = response.statusText;
          existing.responseHeaders = response.headers;
          existing.mimeType = response.mimeType;
        }
      }

      if (message.method === "Network.loadingFinished") {
        const { requestId } = message.params;
        const existing = this.networkRequests.get(requestId);
        if (existing) {
          existing.loadingFinished = true;
          existing.requestId = requestId;
        }
      }
    });
  }

  async send(method, params = {}, timeoutMs = 10000) {
    if (!this.ws) {
      throw new Error("Not connected. Call connect() first.");
    }

    const id = ++this.messageId;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pendingMessages.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.ws.send(JSON.stringify(message));
    });
  }

  async enableDomains() {
    // Fusebox handshake (RN 0.85+ / Expo SDK 56): identify as a frontend before
    // enabling CDP domains. These are best-effort — older runtimes report
    // "Unsupported method", which is harmless, so swallow failures.
    const ignore = () => {};
    await this.send("FuseboxClient.setClientMetadata").catch(ignore);
    await this.send("ReactNativeApplication.enable").catch(ignore);
    await Promise.all([
      this.send("Runtime.enable"),
      this.send("Network.enable"),
    ]);
    await this.installAppHooks().catch(() => {});
  }

  // Inject an in-app error capture hook. React Native routes uncaught JS errors
  // through ErrorUtils.setGlobalHandler, so they rarely surface as a CDP
  // Runtime.exceptionThrown event. We wrap the global handler (idempotently,
  // chaining the previous one) so get_exceptions can see real RN errors.
  async installAppHooks() {
    const script = `
      (function() {
        if (globalThis.__RN_DEVTOOLS_ERR_HOOK) return "already";
        var EU = globalThis.ErrorUtils;
        if (!EU || typeof EU.setGlobalHandler !== "function") return "no-errorutils";
        var buf = globalThis.__RN_DEVTOOLS_ERRORS__ = globalThis.__RN_DEVTOOLS_ERRORS__ || [];
        var prev = typeof EU.getGlobalHandler === "function" ? EU.getGlobalHandler() : null;
        EU.setGlobalHandler(function(error, isFatal) {
          try {
            buf.push({
              text: (error && (error.message || String(error))) || "Unknown error",
              stack: error && error.stack ? String(error.stack) : null,
              isFatal: !!isFatal,
              t: Date.now(),
            });
            if (buf.length > 100) buf.splice(0, buf.length - 100);
          } catch (e) {}
          if (typeof prev === "function") return prev(error, isFatal);
        });
        globalThis.__RN_DEVTOOLS_ERR_HOOK = true;
        return "installed";
      })()
    `;
    return this.evaluate(script);
  }

  async getResponseBody(requestId) {
    const result = await this.send("Network.getResponseBody", { requestId });
    return result;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingMessages.clear();
  }

  get isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
