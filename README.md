# PDF-AI

Local-first Electron PDF reader with a dedicated PDF AI MCP surface and isolated browser bridge.

Development command: npm install, then npm run dev.

Validation commands: npm run typecheck and npm test.

Load the `extension` directory as an unpacked Chrome extension. Its popup reports the PDF-AI bridge status and can request a reconnect. Phase 5 adds PDF-AI-owned ChatGPT automation: the service worker creates or reuses only a conversation already bound to the same PDF-AI session, sends one framed prompt, can upload only the registered PDF addressed by `documentId`, and journals canonical user/assistant observations back to the local app.

Phase 4.1 adds a user-facing OpenAI Secure MCP Tunnel connection card. The normal user does not install or launch `tunnel-client` manually: enter the dedicated PDF-AI `tunnel_id` and restricted tunnel API key, then press Connect. PDF-AI downloads the pinned Windows tunnel runtime on demand, verifies its SHA-256, stores the credential with Electron/OS secure storage when available, starts the tunnel with the current private MCP URL, and supervises reconnects.

The dedicated OpenAI tunnel and ChatGPT MCP app must be named exactly `PDF AI` and expose the seven PDF tools. Browser bridge traffic always remains local on ports 8875–8879 and never travels through the MCP tunnel.
