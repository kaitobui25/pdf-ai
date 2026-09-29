# PDF-AI

Local-first Electron PDF reader with a dedicated PDF AI MCP surface and isolated browser bridge.

Development command: npm install, then npm run dev.

Validation commands: npm run typecheck and npm test.

For Phase 4 local browser connectivity, load the extension directory as an unpacked Chrome extension. Its popup reports the PDF-AI bridge status and can request a reconnect. The extension does not automate ChatGPT yet.

Phase 4.1 adds a user-facing OpenAI Secure MCP Tunnel connection card. The normal user does not install or launch `tunnel-client` manually: enter the dedicated PDF-AI `tunnel_id` and restricted tunnel API key, then press Connect. PDF-AI downloads the pinned Windows tunnel runtime on demand, verifies its SHA-256, stores the credential with Electron/OS secure storage when available, starts the tunnel with the current private MCP URL, and supervises reconnects.

The roadmap now stops after Phase 4.1 until the dedicated OpenAI tunnel and ChatGPT MCP app named exactly `PDF AI` are created and the seven PDF tools are visible. Browser bridge traffic always remains local on ports 8875–8879 and never travels through the MCP tunnel.
