#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CDPClient } from "./cdp-client.js";

const cdpClient = new CDPClient(
  parseInt(process.env.METRO_PORT || "8081", 10)
);

const server = new McpServer({
  name: "rn-devtools-mcp",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "connect",
  "Connect to React Native Hermes debugger via CDP. Must be called first.",
  { metroPort: z.number().optional().describe("Metro bundler port (default: 8081)") },
  async ({ metroPort }) => {
    try {
      if (cdpClient.isConnected) {
        cdpClient.disconnect();
      }
      if (metroPort) cdpClient.metroPort = metroPort;
      await cdpClient.connect();
      await cdpClient.enableDomains();
      return { content: [{ type: "text", text: "Connected to React Native debugger. Network and Runtime domains enabled." }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Connection failed: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_targets",
  "List available debugger targets from Metro bundler",
  {},
  async () => {
    try {
      const targets = await cdpClient.getDebuggerTargets();
      const summary = targets.map((target) => ({
        title: target.title,
        type: target.type,
        url: target.url,
        hasDebuggerUrl: !!target.webSocketDebuggerUrl,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed to get targets: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "evaluate_js",
  "Execute JavaScript in the React Native runtime and return the result",
  { expression: z.string().describe("JavaScript expression to evaluate") },
  async ({ expression }) => {
    try {
      const result = await cdpClient.evaluate(expression);
      if (result.exceptionDetails) {
        return {
          content: [{ type: "text", text: `Error: ${result.exceptionDetails.text}\n${JSON.stringify(result.exceptionDetails, null, 2)}` }],
          isError: true,
        };
      }
      const value = result.result?.value ?? result.result?.description ?? "undefined";
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Evaluation failed: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_component_tree",
  "Get React component tree from the running app (requires React DevTools hook)",
  { depth: z.number().optional().describe("Max tree depth (default: 3)") },
  async ({ depth = 3 }) => {
    try {
      const script = `
        (function() {
          const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (!hook) return JSON.stringify({ error: "React DevTools hook not found. Make sure the app is in development mode." });

          const renderers = hook.renderers;
          if (!renderers || renderers.size === 0) return JSON.stringify({ error: "No React renderers found." });

          const fiberRoots = hook.getFiberRoots(1);
          if (!fiberRoots || fiberRoots.size === 0) return JSON.stringify({ error: "No fiber roots found." });

          const root = fiberRoots.values().next().value;
          if (!root || !root.current) return JSON.stringify({ error: "No current fiber found." });

          function getDisplayName(fiber) {
            if (!fiber || !fiber.type) return null;
            if (typeof fiber.type === 'string') return fiber.type;
            return fiber.type.displayName || fiber.type.name || null;
          }

          function getProps(fiber) {
            if (!fiber.memoizedProps) return {};
            const props = {};
            for (const [key, val] of Object.entries(fiber.memoizedProps)) {
              if (key === 'children') continue;
              if (typeof val === 'function') { props[key] = '[Function]'; continue; }
              if (typeof val === 'object' && val !== null) {
                try { props[key] = JSON.parse(JSON.stringify(val)); } catch { props[key] = '[Object]'; }
                continue;
              }
              props[key] = val;
            }
            return props;
          }

          function getState(fiber) {
            if (!fiber.memoizedState) return null;
            const state = fiber.memoizedState;
            if (state && typeof state === 'object' && 'memoizedState' in state) {
              const hooks = [];
              let current = state;
              let idx = 0;
              while (current && idx < 10) {
                const val = current.memoizedState;
                if (val !== undefined && val !== null && typeof val !== 'function') {
                  try { hooks.push(JSON.parse(JSON.stringify(val))); } catch { hooks.push('[Complex]'); }
                }
                current = current.next;
                idx++;
              }
              return hooks.length > 0 ? hooks : null;
            }
            try { return JSON.parse(JSON.stringify(state)); } catch { return '[Complex State]'; }
          }

          function traverse(fiber, currentDepth) {
            if (!fiber || currentDepth > ${depth}) return null;
            const name = getDisplayName(fiber);
            const children = [];
            let child = fiber.child;
            while (child) {
              const childNode = traverse(child, currentDepth + (name ? 1 : 0));
              if (childNode) children.push(childNode);
              child = child.sibling;
            }
            if (!name) {
              return children.length === 1 ? children[0] : children.length > 0 ? { type: 'Fragment', children } : null;
            }
            const node = { type: name };
            const props = getProps(fiber);
            if (Object.keys(props).length > 0) node.props = props;
            const state = getState(fiber);
            if (state) node.state = state;
            if (children.length > 0) node.children = children;
            return node;
          }

          const tree = traverse(root.current, 0);
          return JSON.stringify(tree, null, 2);
        })()
      `;
      const result = await cdpClient.evaluate(script);
      const text = result.result?.value ?? "No result";
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed to get component tree: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_console_logs",
  "Get captured console.log/warn/error messages from the app",
  {
    count: z.number().optional().describe("Number of recent messages (default: 50)"),
    level: z.enum(["log", "warn", "error", "info", "debug", "all"]).optional().describe("Filter by log level"),
  },
  async ({ count = 50, level = "all" }) => {
    let messages = cdpClient.consoleMessages;
    if (level !== "all") {
      messages = messages.filter((msg) => msg.type === level);
    }
    const recent = messages.slice(-count);
    if (recent.length === 0) {
      return { content: [{ type: "text", text: "No console messages captured yet. Make sure you called 'connect' first." }] };
    }
    const formatted = recent.map((msg) => {
      const args = msg.args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
      return `[${msg.type}] ${args}`;
    }).join("\n");
    return { content: [{ type: "text", text: formatted }] };
  }
);

server.tool(
  "get_network_requests",
  "Get captured network requests from the app",
  {
    count: z.number().optional().describe("Number of recent requests (default: 30)"),
    urlFilter: z.string().optional().describe("Filter requests by URL substring"),
  },
  async ({ count = 30, urlFilter }) => {
    let requests = [...cdpClient.networkRequests.values()];
    if (urlFilter) {
      requests = requests.filter((req) => req.url.includes(urlFilter));
    }
    const recent = requests.slice(-count);
    if (recent.length === 0) {
      return { content: [{ type: "text", text: "No network requests captured yet. Make sure you called 'connect' first." }] };
    }
    const formatted = recent.map((req) => ({
      method: req.method,
      url: req.url,
      status: req.status ?? "pending",
      type: req.type,
      mimeType: req.mimeType,
    }));
    return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
  }
);

server.tool(
  "get_network_request_detail",
  "Get detailed info for a specific network request including headers and body",
  { url: z.string().describe("URL substring to match the request") },
  async ({ url }) => {
    const requests = [...cdpClient.networkRequests.values()];
    const match = requests.reverse().find((req) => req.url.includes(url));
    if (!match) {
      return { content: [{ type: "text", text: `No request found matching: ${url}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(match, null, 2) }] };
  }
);

server.tool(
  "get_response_body",
  "Get the response body (JSON/text) for a specific network request",
  { url: z.string().describe("URL substring to match the request") },
  async ({ url }) => {
    try {
      const requests = [...cdpClient.networkRequests.values()];
      const match = requests.reverse().find((req) => req.url.includes(url));
      if (!match) {
        return { content: [{ type: "text", text: `No request found matching: ${url}` }], isError: true };
      }
      if (!match.requestId) {
        return { content: [{ type: "text", text: "Response not yet received for this request." }], isError: true };
      }
      const response = await cdpClient.getResponseBody(match.requestId);
      let body = response.body ?? "";
      if (response.base64Encoded) {
        body = Buffer.from(body, "base64").toString("utf-8");
      }
      const isJson = match.mimeType?.includes("json");
      let formatted;
      try {
        formatted = isJson ? JSON.stringify(JSON.parse(body), null, 2) : body;
      } catch {
        formatted = body;
      }
      return {
        content: [{ type: "text", text: `${match.method} ${match.url} → ${match.status}\n\n${formatted}` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed to get response body: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_redux_state",
  "Get current Redux store state (requires store exposed on globalThis.__REDUX_STORE__)",
  {
    slice: z.string().optional().describe("Specific slice name (e.g. 'auth', 'settings'). Omit for full state."),
    path: z.string().optional().describe("Dot-separated path within the slice (e.g. 'user' or 'user.email')"),
  },
  async ({ slice, path }) => {
    try {
      const sliceLit = slice ? JSON.stringify(slice) : null;
      const pathSafe = path && /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/.test(path) ? path : null;
      let expression;
      if (sliceLit && pathSafe) {
        expression = `globalThis.__REDUX_STORE__?.getState()?.[${sliceLit}]?.${pathSafe}`;
      } else if (sliceLit) {
        expression = `globalThis.__REDUX_STORE__?.getState()?.[${sliceLit}]`;
      } else {
        expression = `Object.fromEntries(Object.entries(globalThis.__REDUX_STORE__?.getState() ?? {}).map(([k, v]) => [k, typeof v === 'object' && v !== null ? Object.keys(v) : v]))`;
      }
      const wrappedExpression = `
        (function() {
          try {
            if (!globalThis.__REDUX_STORE__) return JSON.stringify({ error: "Redux store not exposed. Add: globalThis.__REDUX_STORE__ = store; in your store.ts" });
            const result = ${expression};
            return JSON.stringify(result, null, 2);
          } catch (e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `;
      const result = await cdpClient.evaluate(wrappedExpression);
      const value = result.result?.value ?? "No result";
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "get_app_state",
  "Evaluate a custom expression to inspect app state (AsyncStorage, global vars, etc.)",
  { expression: z.string().describe("JS expression that returns the state to inspect") },
  async ({ expression }) => {
    try {
      const wrappedExpression = `
        (function() {
          try {
            const result = ${expression};
            return JSON.stringify(result, null, 2);
          } catch (e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `;
      const result = await cdpClient.evaluate(wrappedExpression);
      const value = result.result?.value ?? "No result";
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "disconnect",
  "Disconnect from the React Native debugger",
  {},
  async () => {
    cdpClient.disconnect();
    return { content: [{ type: "text", text: "Disconnected." }] };
  }
);

// --- Start Server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
