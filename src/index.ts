#!/usr/bin/env node
/**
 * index.ts — MCP server entrypoint.
 *
 * Transport is selected by configuration:
 *   - stdio (default) — the server is launched by an MCP client
 *   - HTTP (MC_NEXT_HTTP_ENABLED=true) — a network listener, with its own
 *     security requirements. See docs/HTTP-DEPLOYMENT.md.
 *
 * Exposes:
 *   - Marketing Cloud Next, Data 360, and Data 360 Connect APIs (catalog-driven)
 *   - Salesforce platform tools (SOQL, describe, REST explorer, org limits)
 *   - Record and metadata CRUD
 *   - Cache control and async job polling
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  loadConfig,
  missingCredentials,
  unconfiguredBases,
  fatalConfigErrors,
  log,
} from './config.js';
import { TokenManager } from './auth.js';
import { McNextClient } from './client.js';
import { SfRestClient } from './sfrest.js';
import { loadCatalog } from './catalog.js';
import { registerTools } from './tools.js';
import { registerPlatformTools } from './platform.js';
import { registerRecordTools } from './records.js';
import { registerMetadataTools } from './metadata.js';
import { registerMaintenanceTools } from './maintenance.js';
import { startHttp } from './http.js';

const SERVER_NAME = 'mc-next-mcp-server';
const SERVER_VERSION = '1.0.0';

/**
 * Build a fully-configured McpServer. Called once for stdio, and once per
 * session for HTTP.
 */
function buildServer(cfg: ReturnType<typeof loadConfig>): McpServer {
  const catalog = loadCatalog();

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const tokens = new TokenManager(cfg);
  const client = new McNextClient(cfg, tokens);
  // One SfRestClient (and therefore one response cache) shared by every tool
  // group, so a cache hit in the platform tools is visible to the record and
  // metadata tools too.
  const rest = new SfRestClient(cfg, tokens);

  registerTools(server, cfg, client);
  registerPlatformTools(server, cfg, tokens, rest);
  registerRecordTools(server, cfg, tokens, rest);
  registerMetadataTools(server, cfg, tokens, rest);
  registerMaintenanceTools(server, cfg, client, rest);

  // --- Resources: expose the catalog and API metadata ----------------------
  server.registerResource(
    'endpoint-catalog',
    'mcnext://catalog',
    {
      title: 'Marketing Cloud Next / Data 360 endpoint catalog',
      description:
        `Full machine-readable catalog of ${catalog.stats.endpointCount} endpoints across ` +
        `${catalog.stats.familyCount} API families and ${catalog.stats.groupCount} resource groups.`,
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(catalog, null, 2),
        },
      ],
    })
  );

  server.registerResource(
    'api-overview',
    'mcnext://overview',
    {
      title: 'Marketing Cloud Next / Data 360 API overview',
      description: 'Authentication model, base URLs, API families, and endpoint statistics.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              api: catalog.api,
              stats: catalog.stats,
              groups: catalog.groups,
              configuration: {
                loginUrl: cfg.loginUrl,
                bases: cfg.bases,
                instanceUrl: cfg.instanceUrl,
                apiVersion: cfg.apiVersion,
                // Computed here rather than captured from main(), so this is
                // correct per-session under the HTTP transport too.
                credentialsConfigured: missingCredentials(cfg).length === 0,
                basesConfigured: unconfiguredBases(cfg).length === 0,
                allowDestructive: cfg.allowDestructive,
                allowMetadataChanges: cfg.allowMetadataChanges,
                cacheTtlMs: cfg.cacheTtlMs,
                transport: cfg.http.enabled ? 'http' : 'stdio',
              },
            },
            null,
            2
          ),
        },
      ],
    })
  );

  // --- Prompts: guided workflows -------------------------------------------
  server.registerPrompt(
    'explore-mc-next',
    {
      title: 'Explore the Marketing Cloud Next / Data 360 APIs',
      description: 'Guided workflow for discovering and calling Marketing Cloud Next endpoints.',
      argsSchema: {
        goal: z.string().describe('What you want to accomplish, e.g. "publish an email template".'),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\n\n` +
              'Work through these steps:\n' +
              '1. Call mcnext_list_endpoints with a `search`, `family`, or `group` filter to find candidates.\n' +
              '2. Call mcnext_describe_endpoint on the best match to learn its required params and body schema.\n' +
              '3. Call the matching verb tool (mcnext_query / mcnext_read / mcnext_create / ' +
              'mcnext_update / mcnext_delete / mcnext_action).\n' +
              '4. For org data (not CMS/Data 360), use sf_soql_query and sf_describe_object.\n' +
              '5. If a call fails, read the `hint` field in the error response before retrying.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'explore-salesforce-org',
    {
      title: 'Explore the Salesforce org',
      description: 'Guided workflow for querying org data and metadata.',
      argsSchema: {
        goal: z.string().describe('What you want to find, e.g. "all Accounts created this week".'),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\n\n` +
              'Work through these steps:\n' +
              '1. Call sf_list_objects to find the right sObject.\n' +
              '2. Call sf_describe_object to learn its field names and types.\n' +
              '3. Call sf_soql_query with a SOQL statement; paginate with sf_soql_query_more.\n' +
              '4. Use sf_rest_request for anything the dedicated tools do not cover.\n' +
              '5. Check sf_org_limits before running large or repeated queries.',
          },
        },
      ],
    })
  );

  return server;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const catalog = loadCatalog();

  // Fatal misconfiguration must stop startup, not warn. Currently this catches
  // HTTP bound to a non-loopback host without a bearer token.
  const fatal = fatalConfigErrors(cfg);
  if (fatal.length) {
    for (const e of fatal) console.error(`[${SERVER_NAME}] FATAL: ${e}`);
    process.exit(1);
  }

  const missing = missingCredentials(cfg);
  if (missing.length) {
    // Warn but still start: the model can browse the catalog without credentials,
    // and the error surfaces clearly on the first API call.
    console.error(
      `[${SERVER_NAME}] WARNING: missing required environment variable(s): ${missing.join(', ')}. ` +
        'Catalog browsing will work, but API calls will fail until they are set.'
    );
  }

  const unconfigured = unconfiguredBases(cfg);
  if (unconfigured.length) {
    console.error(
      `[${SERVER_NAME}] WARNING: base URL(s) still at placeholder defaults: ${unconfigured.join(', ')}. ` +
        'Set them to your org/tenant URLs before making API calls.'
    );
  }

  log(
    cfg,
    `catalog: ${catalog.stats.endpointCount} endpoints / ${catalog.stats.groupCount} groups / ` +
      `${catalog.stats.familyCount} families`
  );
  if (cfg.cacheTtlMs > 0) {
    log(cfg, `response cache: ttl=${cfg.cacheTtlMs}ms maxEntries=${cfg.cacheMaxEntries}`);
  } else {
    log(cfg, 'response cache: disabled');
  }

  // --- Transport selection -------------------------------------------------
  if (cfg.http.enabled) {
    const handle = await startHttp(cfg, () => buildServer(cfg));

    const shutdown = async () => {
      log(cfg, 'shutting down HTTP transport');
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const server = buildServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(cfg, `${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
