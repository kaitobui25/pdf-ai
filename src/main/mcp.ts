import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
  MAX_MCP_BODY_BYTES,
  MAX_MCP_IMAGE_BYTES,
  MCP_CONNECTOR_NAME,
  MCP_SERVER_NAME
} from '../shared/constants.js';
import type { PdfNormalizedRegion, PdfRenderedImage } from '../shared/pdf.js';
import { PdfDocumentEngine, PdfEngineError } from './pdf-document-engine.js';

const MCP_VERSION = '0.1.0';

export const PDF_MCP_TOOL_NAMES = [
  'pdf_list_documents',
  'pdf_get_current_page',
  'pdf_get_selection',
  'pdf_search',
  'pdf_read_pages',
  'pdf_render_page',
  'pdf_render_region'
] as const;

export interface PdfMcpEndpoint {
  port: number;
  url: string;
  stop(): Promise<void>;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof PdfEngineError) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({ error: error.code, message: error.message })
      }]
    };
  }
  const message = error instanceof Error ? error.message : 'PDF tool failed.';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', message }) }]
  };
}

function imageResult(image: PdfRenderedImage): CallToolResult {
  if (image.bytes.byteLength > MAX_MCP_IMAGE_BYTES) {
    return toolError(new PdfEngineError(
      'limit_exceeded',
      'Rendered image exceeds the MCP image payload limit.'
    ));
  }
  const metadata = {
    documentId: image.documentId,
    revision: image.revision,
    page: image.page,
    pageCount: image.pageCount,
    reference: image.reference,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    scale: image.scale,
    ...(image.region ? { region: image.region } : {})
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(metadata) },
      {
        type: 'image',
        data: Buffer.from(image.bytes).toString('base64'),
        mimeType: image.mimeType
      }
    ]
  };
}

function registerTools(server: McpServer, engine: PdfDocumentEngine): void {
  server.registerTool(
    'pdf_list_documents',
    {
      description: 'List PDFs currently registered in PDF-AI with stable document and page metadata.',
      inputSchema: z.object({}).strict()
    },
    async () => {
      try {
        return textResult({ documents: await engine.listDocuments() });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  const optionalDocumentId = z.object({
    documentId: z.string().min(1).max(128).optional()
  }).strict();

  server.registerTool(
    'pdf_get_current_page',
    {
      description: 'Get the current page for a PDF-AI document. Omit documentId for the current document.',
      inputSchema: optionalDocumentId
    },
    async ({ documentId }) => {
      try {
        return textResult(await engine.getCurrentPage(documentId));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'pdf_get_selection',
    {
      description: 'Get the current text selection and page-qualified bounds for a PDF-AI document.',
      inputSchema: optionalDocumentId
    },
    async ({ documentId }) => {
      try {
        return textResult({
          documentId: documentId ?? null,
          selection: await engine.getSelection(documentId)
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'pdf_search',
    {
      description: 'Search one registered PDF and return bounded page-mapped matches.',
      inputSchema: z.object({
        documentId: z.string().min(1).max(128),
        query: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(100).optional()
      }).strict()
    },
    async ({ documentId, query, maxResults }) => {
      try {
        return textResult({
          documentId,
          results: await engine.search(documentId, query, maxResults)
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'pdf_read_pages',
    {
      description: 'Read exact extracted text for a bounded inclusive page range in one registered PDF.',
      inputSchema: z.object({
        documentId: z.string().min(1).max(128),
        startPage: z.number().int().min(1),
        endPage: z.number().int().min(1).optional()
      }).strict()
    },
    async ({ documentId, startPage, endPage }) => {
      try {
        return textResult(await engine.readPages(documentId, startPage, endPage));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'pdf_render_page',
    {
      description: 'Render one registered PDF page to a bounded PNG image.',
      inputSchema: z.object({
        documentId: z.string().min(1).max(128),
        page: z.number().int().min(1),
        scale: z.number().min(0.1).max(4).optional()
      }).strict()
    },
    async ({ documentId, page, scale }) => {
      try {
        return imageResult(await engine.renderPage(documentId, page, scale));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  const regionSchema = z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1)
  }).strict();

  server.registerTool(
    'pdf_render_region',
    {
      description: 'Render a normalized 0..1 page region from one registered PDF to a bounded PNG image.',
      inputSchema: z.object({
        documentId: z.string().min(1).max(128),
        page: z.number().int().min(1),
        region: regionSchema,
        scale: z.number().min(0.1).max(4).optional()
      }).strict()
    },
    async ({ documentId, page, region, scale }) => {
      try {
        return imageResult(await engine.renderRegion(
          documentId,
          page,
          region as PdfNormalizedRegion,
          scale
        ));
      } catch (error) {
        return toolError(error);
      }
    }
  );
}

export function buildPdfMcpServer(engine: PdfDocumentEngine): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        MCP_CONNECTOR_NAME +
        ' exposes only PDFs that are already open in PDF-AI. Use documentId and page numbers; filesystem paths are not accepted.'
    }
  );
  registerTools(server, engine);
  return server;
}

export async function startPdfMcpServer(engine: PdfDocumentEngine): Promise<PdfMcpEndpoint> {
  const secretPath = '/mcp/pdf-ai/' + randomBytes(32).toString('base64url');
  const handler = createMcpHandler(
    () => buildPdfMcpServer(engine),
    {
      maxRequestBodySize: MAX_MCP_BODY_BYTES
    }
  );
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MAX_MCP_BODY_BYTES });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = http.createServer((req, res) => {
    const pathOnly = (req.url ?? '').split('?')[0] ?? '';
    if (!safeEqual(pathOnly, secretPath)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res).catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'mcp_handler_failed',
          message: error instanceof Error ? error.message : String(error)
        }));
      } else {
        res.end();
      }
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error('MCP server did not acquire a local port.');
  }
  const url = 'http://127.0.0.1:' + address.port + secretPath;
  let stopping: Promise<void> | null = null;
  return {
    port: address.port,
    url,
    stop: () => {
      if (stopping) return stopping;
      stopping = (async () => {
        await handler.close();
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
      })();
      return stopping;
    }
  };
}
