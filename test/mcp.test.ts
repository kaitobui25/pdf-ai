import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PDF_MCP_TOOL_NAMES,
  startPdfMcpServer,
  type PdfMcpEndpoint
} from '../src/main/mcp.js';
import { PdfDocumentEngine } from '../src/main/pdf-document-engine.js';

const temporary = new Set<string>();
const engines = new Set<PdfDocumentEngine>();
const endpoints = new Set<PdfMcpEndpoint>();
const clients = new Set<Client>();

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-ai-mcp-'));
  temporary.add(directory);
  return directory;
}

async function textPdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = pdf.addPage([400, 300]);
    page.drawText(line, { x: 36, y: 240, size: 18, font });
  }
  return pdf.save();
}

async function colorPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 100]);
  page.drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 100, y: 0, width: 100, height: 100, color: rgb(0, 0, 1) });
  return pdf.save();
}

async function setup() {
  const engine = new PdfDocumentEngine();
  engines.add(engine);
  const endpoint = await startPdfMcpServer(engine);
  endpoints.add(endpoint);
  const client = new Client({ name: 'pdf-ai-test-client', version: '0.1.0' });
  clients.add(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
  return { engine, endpoint, client };
}

function json(result: CallToolResult): unknown {
  const text = result.content.find(item => item.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Expected text tool result.');
  return JSON.parse(text.text) as unknown;
}

afterEach(async () => {
  await Promise.all([...clients].map(client => client.close().catch(() => undefined)));
  clients.clear();
  await Promise.all([...endpoints].map(endpoint => endpoint.stop().catch(() => undefined)));
  endpoints.clear();
  await Promise.all([...engines].map(engine => engine.destroy()));
  engines.clear();
  await Promise.all([...temporary].map(directory => rm(directory, { recursive: true, force: true })));
  temporary.clear();
});

describe('PDF AI MCP server', () => {
  it('discovers exactly the seven document tools and exposes no filesystem-path tool', async () => {
    const { client } = await setup();
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([...PDF_MCP_TOOL_NAMES].sort());
    for (const tool of tools.tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(properties).not.toHaveProperty('path');
      expect(properties).not.toHaveProperty('filePath');
    }
  });

  it('calls the document tools through the real HTTP transport', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'document.pdf');
    await writeFile(filePath, await colorPdf());
    const { engine, client } = await setup();
    const opened = await engine.openFile(filePath);
    engine.setSelection(opened.documentId, opened.viewEpoch, 1, {
      text: 'selected',
      startPage: 1,
      endPage: 1,
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
    });

    const listed = await client.callTool({ name: 'pdf_list_documents', arguments: {} });
    expect(json(listed)).toMatchObject({
      documents: [{ documentId: opened.documentId, pageCount: 1 }]
    });

    const current = await client.callTool({
      name: 'pdf_get_current_page',
      arguments: { documentId: opened.documentId }
    });
    expect(json(current)).toMatchObject({
      documentId: opened.documentId,
      page: 1,
      reference: 'pdf://' + opened.documentId + '/page/1'
    });

    const selection = await client.callTool({
      name: 'pdf_get_selection',
      arguments: { documentId: opened.documentId }
    });
    expect(json(selection)).toMatchObject({
      selection: { text: 'selected', startPage: 1, endPage: 1 }
    });

    const rendered = await client.callTool({
      name: 'pdf_render_page',
      arguments: { documentId: opened.documentId, page: 1, scale: 0.5 }
    });
    expect(rendered.isError).not.toBe(true);
    const image = rendered.content.find(item => item.type === 'image');
    expect(image?.type).toBe('image');
    if (image?.type === 'image') {
      expect(Buffer.from(image.data, 'base64').byteLength).toBeGreaterThan(100);
    }

    const region = await client.callTool({
      name: 'pdf_render_region',
      arguments: {
        documentId: opened.documentId,
        page: 1,
        region: { x: 0, y: 0, width: 0.5, height: 1 },
        scale: 0.5
      }
    });
    expect(region.isError).not.toBe(true);
  });

  it('returns search/read results and keeps multiple documents isolated under concurrent calls', async () => {
    const directory = await tempDir();
    const firstPath = path.join(directory, 'first.pdf');
    const secondPath = path.join(directory, 'second.pdf');
    await writeFile(firstPath, await textPdf(['Alpha needle', 'Alpha second']));
    await writeFile(secondPath, await textPdf(['Beta needle']));
    const { engine, client } = await setup();
    const first = await engine.openFile(firstPath);
    const second = await engine.openFile(secondPath);

    const [search, readFirst, readSecond] = await Promise.all([
      client.callTool({
        name: 'pdf_search',
        arguments: { documentId: first.documentId, query: 'needle' }
      }),
      client.callTool({
        name: 'pdf_read_pages',
        arguments: { documentId: first.documentId, startPage: 1, endPage: 2 }
      }),
      client.callTool({
        name: 'pdf_read_pages',
        arguments: { documentId: second.documentId, startPage: 1 }
      })
    ]);

    expect(json(search)).toMatchObject({
      documentId: first.documentId,
      results: [{ page: 1 }]
    });
    expect(json(readFirst)).toMatchObject({
      documentId: first.documentId,
      pages: [{ page: 1, text: 'Alpha needle' }, { page: 2, text: 'Alpha second' }]
    });
    expect(json(readSecond)).toMatchObject({
      documentId: second.documentId,
      pages: [{ page: 1, text: 'Beta needle' }]
    });
  });

  it('fails closed for invalid document IDs and pages', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'one.pdf');
    await writeFile(filePath, await textPdf(['One']));
    const { engine, client } = await setup();
    const opened = await engine.openFile(filePath);

    const missing = await client.callTool({
      name: 'pdf_read_pages',
      arguments: { documentId: 'pdf-does-not-exist', startPage: 1 }
    });
    expect(missing.isError).toBe(true);
    expect(json(missing)).toMatchObject({ error: 'document_not_found' });

    const badPage = await client.callTool({
      name: 'pdf_render_page',
      arguments: { documentId: opened.documentId, page: 2 }
    });
    expect(badPage.isError).toBe(true);
    expect(json(badPage)).toMatchObject({ error: 'page_out_of_range' });
  });

  it('enforces bounded query and page-range arguments', async () => {
    const directory = await tempDir();
    const filePath = path.join(directory, 'many.pdf');
    await writeFile(
      filePath,
      await textPdf(Array.from({ length: 51 }, (_, index) => 'Page ' + (index + 1)))
    );
    const { engine, client } = await setup();
    const opened = await engine.openFile(filePath);

    const tooLongQuery = await client.callTool({
      name: 'pdf_search',
      arguments: { documentId: opened.documentId, query: 'x'.repeat(501) }
    });
    expect(tooLongQuery.isError).toBe(true);

    const tooManyPages = await client.callTool({
      name: 'pdf_read_pages',
      arguments: { documentId: opened.documentId, startPage: 1, endPage: 51 }
    });
    expect(tooManyPages.isError).toBe(true);
    expect(json(tooManyPages)).toMatchObject({ error: 'limit_exceeded' });
  });
});
