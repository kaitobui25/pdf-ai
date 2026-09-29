import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TUNNEL_CLIENT_VERSION,
  TUNNEL_RUNTIME_TARGETS,
  TunnelRuntimeProvider,
  tunnelRuntimeAsset,
  type TunnelRuntimeAsset
} from '../src/main/tunnel-runtime.js';

const temporary = new Set<string>();

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-ai-tunnel-runtime-test-'));
  temporary.add(directory);
  return directory;
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  await Promise.all([...temporary].map(directory => rm(directory, { recursive: true, force: true })));
  temporary.clear();
});

describe('PDF-AI tunnel runtime', () => {
  it('pins the CoS-vetted OpenAI tunnel-client release for Windows x64 and arm64', () => {
    expect(TUNNEL_CLIENT_VERSION).toBe('v0.0.15');
    expect(TUNNEL_RUNTIME_TARGETS.x64).toEqual({
      upstreamArch: 'amd64',
      sha256: '3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1'
    });
    expect(TUNNEL_RUNTIME_TARGETS.arm64).toEqual({
      upstreamArch: 'arm64',
      sha256: '571e0d59ed9e86d1b105dc34f3267865f654de6968b01efd7c847f0af657d11d'
    });
    expect(tunnelRuntimeAsset('win32', 'x64').assetName).toBe('tunnel-client-v0.0.15-windows-amd64.zip');
    expect(() => tunnelRuntimeAsset('linux', 'x64')).toThrow(/Unsupported tunnel runtime target/);
  });

  it('rejects a checksum mismatch before extraction or execution', async () => {
    const cache = await tempDir();
    const extract = vi.fn(async () => undefined);
    const provider = new TunnelRuntimeProvider(cache, {
      download: async () => Buffer.from('wrong archive'),
      extract
    });

    await expect(provider.ensure()).rejects.toThrow(/checksum verification failed/i);
    expect(extract).not.toHaveBeenCalled();
  });

  it('publishes only verified runtime content and revalidates the cache before reuse', async () => {
    const cache = await tempDir();
    const archive = Buffer.from('test archive with deterministic checksum');
    const executable = Buffer.from('fake tunnel executable');
    const asset: TunnelRuntimeAsset = {
      target: { upstreamArch: 'amd64', sha256: digest(archive) },
      assetName: 'test-tunnel.zip'
    };
    const download = vi.fn(async () => archive);
    const extract = vi.fn(async (_zipPath: string, destination: string) => {
      await writeFile(path.join(destination, 'tunnel-client.exe'), executable);
    });
    const provider = new TunnelRuntimeProvider(cache, { download, extract }, asset);

    const first = await provider.ensure();
    expect(first.source).toBe('downloaded');
    expect(await readFile(first.executable)).toEqual(executable);
    expect(download).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);

    const second = await provider.ensure();
    expect(second.source).toBe('verified-cache');
    expect(download).toHaveBeenCalledTimes(1);

    await writeFile(first.executable, Buffer.from('tampered executable'));
    const third = await provider.ensure();
    expect(third.source).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(2);
    expect(await readFile(third.executable)).toEqual(executable);
  });

  it('coalesces concurrent prepares so only one archive is downloaded and published', async () => {
    const cache = await tempDir();
    const archive = Buffer.from('concurrent test archive');
    const asset: TunnelRuntimeAsset = {
      target: { upstreamArch: 'amd64', sha256: digest(archive) },
      assetName: 'concurrent-test.zip'
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const download = vi.fn(async () => {
      await gate;
      return archive;
    });
    const provider = new TunnelRuntimeProvider(cache, {
      download,
      extract: async (_zipPath, destination) => {
        await writeFile(path.join(destination, 'tunnel-client.exe'), 'fake executable');
      }
    }, asset);

    const first = provider.ensure();
    const second = provider.ensure();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.executable).toBe(b.executable);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an invalid explicit override and never falls back to PATH', async () => {
    const cache = await tempDir();
    const download = vi.fn(async () => Buffer.from('unused'));
    const provider = new TunnelRuntimeProvider(cache, { download, extract: async () => undefined });
    const missing = path.join(cache, 'missing-tunnel-client.exe');

    await expect(provider.ensure(missing)).rejects.toThrow(/explicit tunnel-client override/i);
    expect(download).not.toHaveBeenCalled();

    const explicit = path.join(cache, 'explicit-tunnel-client.exe');
    await writeFile(explicit, 'fake executable');
    await expect(provider.ensure(explicit)).resolves.toMatchObject({
      executable: path.resolve(explicit),
      source: 'explicit-override',
      version: 'override'
    });
    expect(download).not.toHaveBeenCalled();
  });
});
