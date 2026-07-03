# rn-devtools-mcp

[![CI](https://github.com/hcbylmz/rn-devtools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hcbylmz/rn-devtools-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/rn-devtools-mcp.svg)](https://www.npmjs.com/package/rn-devtools-mcp)
[![license](https://img.shields.io/npm/l/rn-devtools-mcp.svg)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude Code, Cursor, Windsurf, etc.) inspect a running React Native app through the Chrome DevTools Protocol exposed by Metro / Hermes.

With it, your AI can:

- Read the **React component tree** (names, props, hook state)
- Tail **console logs** captured from the device
- Tail **uncaught exceptions / red-box errors** with source-mapped stack frames
- List **network requests** and fetch response bodies
- Inspect **Redux state** (with slice/path selectors)
- Watch the **Redux action log** (type + which slices changed) and **dispatch** actions
- Discover available **state containers** (Redux, Zustand, Jotai, React Query, Recoil)
- Evaluate arbitrary JavaScript in the app runtime
- Inspect any app state via custom expressions (AsyncStorage, globals, …)

Connections **auto-reconnect** — tools transparently re-establish the CDP session
after an app reload, so you rarely need to call `connect` more than once.

It's the missing bridge between "the app is running on my simulator" and "my AI can actually see what's happening inside it."

## Why

When debugging a React Native app with an AI assistant, the assistant usually flies blind — it can read your code but not your runtime. This MCP server connects directly to the CDP endpoint that Metro already exposes on port 8081, so the AI can query live app state instead of asking you to paste logs.

## For AI agents (Claude Code, Codex, Cursor, …)

If a user points you at this repository and asks you to "set it up" or "install it", follow these steps exactly:

1. **Clone into a stable location** (not a temp dir — the MCP client needs an absolute path that persists):
   ```bash
   git clone https://github.com/hcbylmz/rn-devtools-mcp.git ~/.mcp-servers/rn-devtools-mcp
   cd ~/.mcp-servers/rn-devtools-mcp
   npm install
   ```

2. **Register the server with the user's MCP client.** Detect which client is in use and patch its config:

   - **Claude Code:** add to `~/.claude.json` (user scope) under `mcpServers`, or run:
     ```bash
     claude mcp add rn-devtools node $(pwd)/src/index.js
     ```
   - **Codex CLI:** add to `~/.codex/config.toml`:
     ```toml
     [mcp_servers.rn-devtools]
     command = "node"
     args = ["/absolute/path/to/rn-devtools-mcp/src/index.js"]
     ```
   - **Cursor / Windsurf / generic:** add to the client's MCP config:
     ```json
     {
       "mcpServers": {
         "rn-devtools": {
           "command": "node",
           "args": ["/absolute/path/to/rn-devtools-mcp/src/index.js"],
           "env": { "METRO_PORT": "8081" }
         }
       }
     }
     ```

   Always use an **absolute path** — MCP clients don't resolve `~` or relative paths.

3. **Tell the user to restart their MCP client** so the new server is picked up, then verify it loaded (in Claude Code: `/mcp`; in Codex: the server should appear in startup logs).

4. **On first use, call the `connect` tool** before any other tool. If the user reloads the RN app, call `connect` again.

5. **Quick self-check prompt for the user to run** after setup:
   > "Use rn-devtools to connect and then show me the last 20 console logs."

If Metro isn't running or the app isn't in dev mode, `connect` will fail with a clear error — surface it verbatim rather than guessing.

## Requirements

- Node.js 18+
- A React Native app running in **development mode** with Hermes (default in modern RN)
- Metro bundler running (the app must be actively connected)

## Install

```bash
git clone https://github.com/hcbylmz/rn-devtools-mcp.git
cd rn-devtools-mcp
npm install
```

## Configure your MCP client

### Claude Code

Add to `~/.claude/mcp.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "rn-devtools": {
      "command": "node",
      "args": ["/absolute/path/to/rn-devtools-mcp/src/index.js"],
      "env": {
        "METRO_PORT": "8081"
      }
    }
  }
}
```

### Cursor / Windsurf / other MCP clients

Same idea — point the client at `src/index.js` with Node. `METRO_PORT` is optional (defaults to 8081).

## Usage

1. Start your React Native app (`npm run ios` / `npm run android` / `npx expo start`).
2. In your AI client, call the `connect` tool first. This attaches to the Hermes debugger and enables the Runtime + Network CDP domains.
3. From then on, the AI can call any of the tools below.

If you reload the app, call `connect` again to re-attach.

## Tools

| Tool | Purpose |
|---|---|
| `connect` | Attach to the Hermes debugger. **Call this first.** |
| `disconnect` | Detach. |
| `get_targets` | List all debugger targets Metro exposes. |
| `evaluate_js` | Run a JS expression in the app runtime and return the result. |
| `get_component_tree` | Walk the React fiber tree and return components, props, and hook state. |
| `get_console_logs` | Recent `console.*` calls, filterable by level. |
| `get_network_requests` | Recent network requests, filterable by URL substring. |
| `get_network_request_detail` | Full headers/metadata for a specific request. |
| `get_response_body` | Decoded response body (JSON auto-formatted). |
| `get_redux_state` | Full state, a slice, or a dot-path inside a slice. |
| `get_app_state` | Evaluate any custom inspection expression. |

### Redux integration

For `get_redux_state` to work, expose your store once at app startup:

```ts
// src/store.ts (or wherever you create the store)
export const store = configureStore({ /* … */ });

if (__DEV__) {
  // @ts-ignore
  globalThis.__REDUX_STORE__ = store;
}
```

Then your AI can ask things like "what's in `auth.user`?" and actually get the answer.

### Component tree hook

`get_component_tree` reads `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__`, which React Native sets up automatically in dev mode — no extra setup required.

## How it works

Metro exposes a CDP endpoint at `http://localhost:8081/json`. This server discovers the Hermes target, opens a WebSocket to its `webSocketDebuggerUrl`, and speaks plain Chrome DevTools Protocol. Console messages and network events are buffered as they stream in; tools either query the buffer or issue `Runtime.evaluate` calls against the live runtime.

No native code, no patches to your app — just the debug protocol that's already there.

## Caveats

- The app must be in **development mode**. Production builds don't expose the CDP endpoint.
- Hermes only. JSC targets may work partially (Runtime domain), but it's not tested.
- Console and network buffers are capped (~500 entries) and trimmed when they grow.
- Tools don't try to sanitize what the AI evaluates — treat it as a dev tool, not a sandbox.

## License

MIT — see [LICENSE](LICENSE).
