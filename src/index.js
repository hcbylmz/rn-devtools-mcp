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
      await cdpClient.ensureConnected();
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
      await cdpClient.ensureConnected();
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
    await cdpClient.ensureConnected();
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
    await cdpClient.ensureConnected();
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
    await cdpClient.ensureConnected();
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
      await cdpClient.ensureConnected();
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
      await cdpClient.ensureConnected();
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
      await cdpClient.ensureConnected();
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
  "get_exceptions",
  "Get uncaught JS exceptions / red-box errors captured from the app, with source-mapped stack frames",
  {
    count: z.number().optional().describe("Number of recent exceptions (default: 20)"),
    symbolicate: z.boolean().optional().describe("Map minified frames to source file:line via Metro (default: true)"),
  },
  async ({ count = 20, symbolicate = true }) => {
    await cdpClient.ensureConnected();
    const recent = cdpClient.exceptions.slice(-count);
    if (recent.length === 0) {
      return { content: [{ type: "text", text: "No uncaught exceptions captured. (Handled errors logged via console.error appear in get_console_logs.)" }] };
    }
    const blocks = [];
    for (const exc of recent) {
      let frames = exc.stackTrace?.callFrames ?? [];
      if (symbolicate && frames.length > 0) {
        const mapped = await cdpClient.symbolicate(frames);
        if (mapped.length > 0) frames = mapped;
      }
      const stackText = frames
        .slice(0, 12)
        .map((frame) => {
          const fn = frame.functionName || frame.methodName || "<anonymous>";
          const file = frame.file ?? frame.url ?? "?";
          const line = frame.lineNumber ?? 0;
          const col = frame.column ?? frame.columnNumber ?? 0;
          return `    at ${fn} (${file}:${line}:${col})`;
        })
        .join("\n");
      blocks.push(`${exc.text}${stackText ? "\n" + stackText : ""}`);
    }
    return { content: [{ type: "text", text: blocks.join("\n\n") }] };
  }
);

server.tool(
  "get_redux_actions",
  "Get the recent Redux action log (type + which top-level slices changed). Installs a dispatch hook on first call.",
  { count: z.number().optional().describe("Number of recent actions (default: 30)") },
  async ({ count = 30 }) => {
    try {
      await cdpClient.ensureConnected();
      const script = `
        (function() {
          const store = globalThis.__REDUX_STORE__;
          if (!store || typeof store.dispatch !== 'function') {
            return JSON.stringify({ error: "Redux store not exposed. Add: globalThis.__REDUX_STORE__ = store;" });
          }
          if (!store.__rnDevtoolsActionHook) {
            const buf = globalThis.__RN_DEVTOOLS_ACTIONS__ = globalThis.__RN_DEVTOOLS_ACTIONS__ || [];
            const orig = store.dispatch;
            store.dispatch = function(action) {
              const before = store.getState();
              const result = orig.apply(this, arguments);
              const after = store.getState();
              let changed = [];
              try {
                changed = Object.keys(after).filter((k) => after[k] !== before[k]);
              } catch (e) {}
              buf.push({ type: action && action.type ? action.type : '(unknown)', t: Date.now(), changedSlices: changed });
              if (buf.length > 300) buf.splice(0, buf.length - 300);
              return result;
            };
            store.__rnDevtoolsActionHook = true;
          }
          const buf = globalThis.__RN_DEVTOOLS_ACTIONS__ || [];
          return JSON.stringify(buf.slice(-${Math.max(1, Math.floor(count))}));
        })()
      `;
      const result = await cdpClient.evaluate(script);
      const raw = result.result?.value ?? "[]";
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { content: [{ type: "text", text: raw }] };
      }
      if (parsed.error) {
        return { content: [{ type: "text", text: parsed.error }], isError: true };
      }
      if (parsed.length === 0) {
        return { content: [{ type: "text", text: "Action hook installed. No actions dispatched yet — interact with the app and call again." }] };
      }
      const lines = parsed.map((action) => {
        const changed = action.changedSlices?.length ? ` [changed: ${action.changedSlices.join(", ")}]` : "";
        return `${action.type}${changed}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "dispatch_redux_action",
  "Dispatch a Redux action into the running app (for testing reducers/flows)",
  { action: z.string().describe('Action as JSON, e.g. {"type":"auth/logout"} or {"type":"counter/add","payload":5}') },
  async ({ action }) => {
    try {
      await cdpClient.ensureConnected();
      let parsedAction;
      try {
        parsedAction = JSON.parse(action);
      } catch (parseError) {
        return { content: [{ type: "text", text: `Invalid action JSON: ${parseError.message}` }], isError: true };
      }
      if (!parsedAction || typeof parsedAction.type !== "string") {
        return { content: [{ type: "text", text: 'Action must be an object with a string "type".' }], isError: true };
      }
      const script = `
        (function() {
          const store = globalThis.__REDUX_STORE__;
          if (!store || typeof store.dispatch !== 'function') {
            return JSON.stringify({ error: "Redux store not exposed." });
          }
          try {
            store.dispatch(${JSON.stringify(parsedAction)});
            return JSON.stringify({ ok: true });
          } catch (e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `;
      const result = await cdpClient.evaluate(script);
      const outcome = JSON.parse(result.result?.value ?? "{}");
      if (outcome.error) {
        return { content: [{ type: "text", text: outcome.error }], isError: true };
      }
      return { content: [{ type: "text", text: `Dispatched: ${parsedAction.type}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "discover_stores",
  "Probe the app runtime for known state containers (Redux, Zustand, Jotai, React Query, Recoil) and report what's available and how to read each.",
  {},
  async () => {
    try {
      await cdpClient.ensureConnected();
      const script = `
        (function() {
          const out = {};
          const g = globalThis;
          if (g.__REDUX_STORE__ && typeof g.__REDUX_STORE__.getState === 'function') {
            out.redux = { available: true, slices: Object.keys(g.__REDUX_STORE__.getState()), read: "get_redux_state" };
          }
          if (g.__REACT_QUERY_CLIENT__) {
            out.reactQuery = { available: true, read: "get_app_state with __REACT_QUERY_CLIENT__.getQueryCache().getAll()" };
          }
          if (g.__JOTAI_DEVTOOLS_STORE__ || g.jotaiStore) {
            out.jotai = { available: true };
          }
          if (g.__RECOIL_DEVTOOLS_EXTENSION__) {
            out.recoil = { available: true };
          }
          out.reactDevToolsHook = typeof g.__REACT_DEVTOOLS_GLOBAL_HOOK__ === 'object';
          return JSON.stringify(out, null, 2);
        })()
      `;
      const result = await cdpClient.evaluate(script);
      const text = result.result?.value ?? "{}";
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
