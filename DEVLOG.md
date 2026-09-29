# PDF-AI Development Log

## Phase 0 — CoS inspection and standalone initialization

Inspected the read-only CoS reference before implementation:

- AGENTS.md
- package.json
- src/main/index.ts
- src/preload/index.ts
- src/main/bridge.ts
- src/main/bridge-ports.ts
- src/main/mcp/server.ts
- src/main/mcp/tools.ts
- src/main/mcp/tool-declarations.ts
- extension/background.js
- src/renderer/file-pdf-viewer.ts
- src/main/project-files.ts
- src/shared/project-files.ts

Patterns reused or simplified:

- Keep Electron's renderer sandboxed and publish only named preload IPC methods.
- Keep the browser bridge separate from MCP and bind sensitive local transports to loopback.
- Centralize app/bridge/MCP identities and port ranges.
- Bound PDF bytes, canvas work, HTTP bodies, and MCP result sizes at their owners.
- Keep native file paths in the main process; renderer and MCP use controlled document identities/data.
- Fail closed when an identity or protocol boundary is ambiguous.

Features intentionally omitted:

- Goal/Loop, workers, desktop control, plugin management, updater/packaging, project filesystem editing, arbitrary command/file tools, ChatGPT automation, and session continuation.

Isolation:

- PDF-AI uses app/bridge id pdf-ai, app/user-data name PDF-AI, bridge ports 8875–8879, and MCP connector name PDF AI.
- The CoS reference repository remains read-only and no CoS runtime path, state, session, extension storage, tunnel, or bridge port is used.

Validation:

- npm run typecheck: pass.
- npm test: pass.
- npm run build: pass.
- npm run dev: Electron starts and remains running until stopped.
