export interface RuntimeInfo {
  appName: string;
  appId: string;
  bridgeId: string;
  bridgePorts: readonly number[];
  mcpConnectorName: string;
}

export interface PdfAiApi {
  runtimeInfo(): Promise<RuntimeInfo>;
}

