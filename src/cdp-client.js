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
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this._setupEventListeners();
        resolve();
      });

      this.ws.on("error", (error) => {
        reject(new Error(`CDP WebSocket error: ${error.message}`));
      });

      this.ws.on("close", () => {
        this.ws = null;
      });
    });
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

  async send(method, params = {}) {
    if (!this.ws) {
      throw new Error("Not connected. Call connect() first.");
    }

    const id = ++this.messageId;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);

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
    await Promise.all([
      this.send("Runtime.enable"),
      this.send("Network.enable"),
    ]);
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
