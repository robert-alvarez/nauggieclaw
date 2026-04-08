/**
 * Ollama MCP Server for NauggieClaww
 * Exposes local Ollama models as tools for the container agent.
 * Launched by the agent runner via --mcp-config.
 *
 * Core tools (always available):
 *   ollama_list_models  — list installed models
 *   ollama_generate     — run a prompt against a local model
 *
 * Management tools (OLLAMA_ADMIN_TOOLS=true):
 *   ollama_pull_model   — download a model from the registry
 *   ollama_delete_model — remove a locally installed model
 *   ollama_show_model   — inspect model details / parameters
 *   ollama_list_running — list models currently loaded in memory
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Resolve Ollama base URL: prefer explicit OLLAMA_HOST, then Docker Desktop
// host gateway, then localhost (Apple Container / native).
const OLLAMA_HOST =
  process.env.OLLAMA_HOST ||
  'http://host.docker.internal:11434';

const ADMIN_TOOLS = process.env.OLLAMA_ADMIN_TOOLS === 'true';

function log(message: string): void {
  process.stderr.write(`[OLLAMA] ${message}\n`);
}

async function ollamaFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${OLLAMA_HOST}${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const server = new McpServer({ name: 'ollama', version: '1.0.0' });

// ── Core tools ───────────────────────────────────────────────────────────────

server.tool(
  'ollama_list_models',
  'List all locally installed Ollama models with name, size, and family.',
  {},
  async () => {
    log('Listing models');
    const data = await ollamaFetch('GET', '/api/tags') as { models?: Array<{
      name: string; size: number; details?: { family?: string };
    }> };
    const models = data.models ?? [];
    if (models.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No models installed.' }] };
    }
    const lines = models.map((m) => {
      const gb = (m.size / 1e9).toFixed(1);
      const family = m.details?.family ?? 'unknown';
      return `- ${m.name}  (${gb} GB, ${family})`;
    });
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

server.tool(
  'ollama_generate',
  'Send a prompt to a local Ollama model and return the response.',
  {
    model: z.string().describe('Model name, e.g. "llama3.2" or "gemma3:1b"'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt'),
  },
  async (args) => {
    log(`>>> Generating with ${args.model}`);
    const data = await ollamaFetch('POST', '/api/generate', {
      model: args.model,
      prompt: args.prompt,
      system: args.system,
      stream: false,
    }) as { response?: string };
    log(`<<< Done (${data.response?.length ?? 0} chars)`);
    return {
      content: [{ type: 'text' as const, text: data.response ?? '(no response)' }],
    };
  },
);


// ── Management tools (opt-in) ────────────────────────────────────────────────

if (ADMIN_TOOLS) {
  server.tool(
    'ollama_pull_model',
    'Download a model from the Ollama registry. Blocks until complete (large models can take several minutes).',
    { model: z.string().describe('Model name, e.g. "llama3.2" or "gemma3:1b"') },
    async (args) => {
      log(`Pulling model: ${args.model}`);
      await ollamaFetch('POST', '/api/pull', { name: args.model, stream: false });
      log(`Pull complete: ${args.model}`);
      return { content: [{ type: 'text' as const, text: `Model "${args.model}" pulled successfully.` }] };
    },
  );

  server.tool(
    'ollama_delete_model',
    'Delete a locally installed Ollama model to free disk space.',
    { model: z.string().describe('Model name to delete') },
    async (args) => {
      log(`Deleted: ${args.model}`);
      await ollamaFetch('DELETE', '/api/delete', { name: args.model });
      return { content: [{ type: 'text' as const, text: `Model "${args.model}" deleted.` }] };
    },
  );

  server.tool(
    'ollama_show_model',
    'Show model details: modelfile, parameters, and architecture info.',
    { model: z.string().describe('Model name to inspect') },
    async (args) => {
      const data = await ollamaFetch('POST', '/api/show', { name: args.model });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'ollama_list_running',
    'List models currently loaded in memory with memory usage and processor type.',
    {},
    async () => {
      const data = await ollamaFetch('GET', '/api/ps') as { models?: Array<{
        name: string; size_vram?: number; details?: { family?: string };
      }> };
      const models = data.models ?? [];
      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No models currently loaded.' }] };
      }
      const lines = models.map((m) => {
        const vram = m.size_vram ? `${(m.size_vram / 1e9).toFixed(1)} GB VRAM` : 'CPU';
        return `- ${m.name}  (${vram})`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
