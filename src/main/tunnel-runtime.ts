import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export const TUNNEL_CLIENT_VERSION = 'v0.0.15' as const;

export interface TunnelRuntimeTarget {
  upstreamArch: 'amd64' | 'arm64';
  sha256: string;
}

export interface TunnelRuntimeAsset {
  target: TunnelRuntimeTarget;
  assetName: string;
}

export const TUNNEL_RUNTIME_TARGETS: Readonly<Record<'x64' | 'arm64', TunnelRuntimeTarget>> = Object.freeze({
  x64: Object.freeze({
    upstreamArch: 'amd64',
    sha256: '3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1'
  }),
  arm64: Object.freeze({
    upstreamArch: 'arm64',
    sha256: '571e0d59ed9e86d1b105dc34f3267865f654de6968b01efd7c847f0af657d11d'
  })
});

export interface TunnelRuntime {
  executable: string;
  version: string;
  source: 'verified-cache' | 'downloaded' | 'explicit-override';
}

export interface TunnelRuntimeDependencies {
  download(url: string): Promise<Buffer>;
  extract(zipPath: string, destination: string): Promise<void>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function defaultDownload(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'user-agent': 'pdf-ai-local' } });
  if (!response.ok) throw new Error(`Tunnel runtime download failed with HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) {
    throw new Error('Tunnel runtime archive is larger than the allowed download limit.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Tunnel runtime archive is larger than the allowed download limit.');
  }
  return bytes;
}

async function defaultExtract(zipPath: string, destination: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Phase 4.1 tunnel runtime preparation currently supports Windows only.');
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const tarExecutable = path.join(systemRoot, 'System32', 'tar.exe');
  await execFileAsync(tarExecutable, ['-xf', zipPath, '-C', destination], { windowsHide: true });
}

async function findExecutable(root: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === 'tunnel-client.exe') {
      return path.join(root, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await findExecutable(path.join(root, entry.name), depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export function tunnelRuntimeAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): TunnelRuntimeAsset {
  if (platform !== 'win32' || (arch !== 'x64' && arch !== 'arm64')) {
    throw new Error(`Unsupported tunnel runtime target: ${platform}-${arch}.`);
  }
  const target = TUNNEL_RUNTIME_TARGETS[arch];
  return {
    target,
    assetName: `tunnel-client-${TUNNEL_CLIENT_VERSION}-windows-${target.upstreamArch}.zip`
  };
}

export class TunnelRuntimeProvider {
  private readonly dependencies: TunnelRuntimeDependencies;
  private inFlight: Promise<TunnelRuntime> | null = null;

  constructor(
    private readonly cacheRoot: string,
    dependencies: Partial<TunnelRuntimeDependencies> = {},
    private readonly asset: TunnelRuntimeAsset = tunnelRuntimeAsset()
  ) {
    this.dependencies = {
      download: dependencies.download ?? defaultDownload,
      extract: dependencies.extract ?? defaultExtract
    };
  }

  async ensure(explicitPath?: string): Promise<TunnelRuntime> {
    if (explicitPath !== undefined && explicitPath.trim() !== '') {
      const selected = path.resolve(explicitPath.trim());
      if (!(await isFile(selected))) {
        throw new Error('The explicit tunnel-client override does not point to an executable file.');
      }
      return { executable: selected, version: 'override', source: 'explicit-override' };
    }

    if (this.inFlight) return this.inFlight;
    const run = this.ensureVerifiedRuntime();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async ensureVerifiedRuntime(): Promise<TunnelRuntime> {
    const { target, assetName } = this.asset;
    const runtimeDir = path.join(this.cacheRoot, TUNNEL_CLIENT_VERSION, `${process.platform}-${process.arch}`);
    const executable = path.join(runtimeDir, 'tunnel-client.exe');
    if (await this.verifyCached(runtimeDir, executable, target.sha256)) {
      return { executable, version: TUNNEL_CLIENT_VERSION, source: 'verified-cache' };
    }

    const url = `https://github.com/openai/tunnel-client/releases/download/${TUNNEL_CLIENT_VERSION}/${assetName}`;
    const archive = await this.dependencies.download(url);
    const actualArchiveSha = sha256(archive);
    if (actualArchiveSha !== target.sha256) {
      throw new Error('Tunnel runtime checksum verification failed. The downloaded binary was not installed or executed.');
    }

    const staging = runtimeDir + `.tmp-${process.pid}-${Date.now()}`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    try {
      const archivePath = path.join(staging, 'source.zip');
      await fs.writeFile(archivePath, archive, { mode: 0o600 });
      await this.dependencies.extract(archivePath, staging);
      const found = await findExecutable(staging);
      if (!found) throw new Error('Verified tunnel runtime archive did not contain tunnel-client.exe.');
      const canonicalExecutable = path.join(staging, 'tunnel-client.exe');
      if (path.resolve(found) !== path.resolve(canonicalExecutable)) {
        await fs.copyFile(found, canonicalExecutable);
      }
      const executableSha = sha256(await fs.readFile(canonicalExecutable));
      await fs.writeFile(path.join(staging, 'VERSION'), TUNNEL_CLIENT_VERSION + '\n', 'utf8');
      await fs.writeFile(path.join(staging, 'SOURCE_SHA256'), target.sha256 + '\n', 'utf8');
      await fs.writeFile(path.join(staging, 'EXECUTABLE_SHA256'), executableSha + '\n', 'utf8');
      await fs.mkdir(path.dirname(runtimeDir), { recursive: true });
      await fs.rm(runtimeDir, { recursive: true, force: true });
      await fs.rename(staging, runtimeDir);
      return { executable, version: TUNNEL_CLIENT_VERSION, source: 'downloaded' };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async verifyCached(runtimeDir: string, executable: string, sourceSha: string): Promise<boolean> {
    try {
      if (!(await isFile(executable))) return false;
      const [version, recordedSourceSha, recordedExecutableSha, archive, executableBytes] = await Promise.all([
        fs.readFile(path.join(runtimeDir, 'VERSION'), 'utf8'),
        fs.readFile(path.join(runtimeDir, 'SOURCE_SHA256'), 'utf8'),
        fs.readFile(path.join(runtimeDir, 'EXECUTABLE_SHA256'), 'utf8'),
        fs.readFile(path.join(runtimeDir, 'source.zip')),
        fs.readFile(executable)
      ]);
      return version.trim() === TUNNEL_CLIENT_VERSION
        && recordedSourceSha.trim() === sourceSha
        && sha256(archive) === sourceSha
        && recordedExecutableSha.trim() === sha256(executableBytes);
    } catch {
      return false;
    }
  }
}
