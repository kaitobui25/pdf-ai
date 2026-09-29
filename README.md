# PDF-AI

Local-first Electron PDF reader with a dedicated PDF AI MCP surface and isolated browser bridge.

Development command: npm install, then npm run dev.

Validation commands: npm run typecheck and npm test.

Load the `extension` directory as an unpacked Chrome extension. Its popup reports the PDF-AI bridge status and can request a reconnect. Phase 5 adds PDF-AI-owned ChatGPT automation: the service worker creates or reuses only a conversation already bound to the same PDF-AI session, sends one framed prompt, can upload only the registered PDF addressed by `documentId`, and journals canonical user/assistant observations back to the local app.

Phase 4.1 adds a user-facing OpenAI Secure MCP Tunnel connection card. The normal user does not install or launch `tunnel-client` manually: enter the dedicated PDF-AI `tunnel_id` and restricted tunnel API key, then press Connect. PDF-AI downloads the pinned Windows tunnel runtime on demand, verifies its SHA-256, stores the credential with Electron/OS secure storage when available, starts the tunnel with the current private MCP URL, and supervises reconnects.

The dedicated OpenAI tunnel and ChatGPT MCP app must be named exactly `PDF AI` and expose the seven PDF tools. Browser bridge traffic always remains local on ports 8875–8879 and never travels through the MCP tunnel.

The local AI Chat pane now shows one durable timeline per open PDF. Use **Ask selection**, **Ask page**, **Ask document**, or type a custom prompt; optionally attach the current registered PDF. Assistant `pdf://<documentId>/page/<n>` references are projected as local page buttons only when they match the exact PDF snapshot currently open.

Local hardening keeps chat state and diagnostics bounded under PDF-AI's own user-data directory. If the chat-state primary is damaged, PDF-AI attempts one durable backup and shows a recovery notice; operational JSONL logs contain redacted metadata rather than prompt/PDF content or credentials.
