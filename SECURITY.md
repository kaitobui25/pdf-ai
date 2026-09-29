# PDF-AI Security

The renderer runs with context isolation enabled, Node integration disabled, sandbox enabled, and web security enabled. Native file access remains in the main process and is exposed through narrow IPC operations.

The browser bridge must bind only to 127.0.0.1, use ports 8875–8879, validate the Chrome-extension origin, require an authenticated pairing token after discovery, enforce protocol compatibility, cap request bodies, rate-limit callers, and use explicit command acknowledgement.

The MCP server exposes documents by stable documentId. MCP calls never accept arbitrary filesystem paths. Tool arguments and results are bounded.

Secrets belong in PDF-AI's private user-data storage and must never be committed to the repository. The application does not read or write runtime state, credentials, extension storage, sessions, tunnels, or user-data owned by other applications.

