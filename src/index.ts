#!/usr/bin/env node

/**
 * KFST Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying KFST decisions, merger control
 * cases, and sector enforcement activity under Konkurrenceloven.
 *
 * Tool prefix: dk_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "danish-competition-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "dk_comp_search_decisions",
    description:
      "Full-text search across KFST enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and Konkurrenceloven articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'misbrug af dominerende stilling', 'Facebook data', 'prisaftaler')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID (e.g., 'digital_economy', 'food_retail', 'energy'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_comp_get_decision",
    description:
      "Get a specific KFST decision by case number (e.g., 'B6-22/16', 'B2-94/12').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "KFST case number (e.g., 'B6-22/16', 'B2-94/12')",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "dk_comp_search_mergers",
    description:
      "Search KFST merger control decisions (Fusionskontrolle). Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'Vonovia Deutsche Wohnen', 'Energieversorgung', 'Lebensmitteleinzelhandel')",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID (e.g., 'energy', 'food_retail', 'real_estate'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "dk_comp_get_merger",
    description:
      "Get a specific merger control decision by case number (e.g., 'B1-35/21', 'B8-101/18').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "KFST merger case number (e.g., 'B1-35/21', 'B8-101/18')",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "dk_comp_list_sectors",
    description:
      "List all sectors with KFST enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "dk_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "dk_comp_list_sources",
    description:
      "Return authoritative data sources used by this server: source name, URL, record counts, and last ingestion date.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "dk_comp_check_data_freshness",
    description:
      "Return per-source data freshness status including last updated date and staleness warnings.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- Helper ------------------------------------------------------------------

const META = {
  disclaimer:
    "Data sourced from KFST (Konkurrence- og Forbrugerstyrelsen). For informational use only; not legal advice.",
  copyright: "© Konkurrence- og Forbrugerstyrelsen (kfst.dk)",
  source_url: "https://www.kfst.dk/",
};

function textContent(data: unknown, dataAge?: string) {
  const payload = {
    _meta: { ...META, data_age: dataAge ?? "unknown" },
    ...(typeof data === "object" && data !== null ? data : { data }),
  };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "dk_comp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "dk_comp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.case_number);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.case_number}`);
        }
        return textContent(decision);
      }

      case "dk_comp_search_mergers": {
        const parsed = SearchMergersArgs.parse(args);
        const results = searchMergers({
          query: parsed.query,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "dk_comp_get_merger": {
        const parsed = GetMergerArgs.parse(args);
        const merger = getMerger(parsed.case_number);
        if (!merger) {
          return errorContent(`Merger case not found: ${parsed.case_number}`);
        }
        return textContent(merger);
      }

      case "dk_comp_list_sectors": {
        const sectors = listSectors();
        return textContent({ sectors, count: sectors.length });
      }

      case "dk_comp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "KFST (Konkurrence- og Forbrugerstyrelsen) MCP server. Provides access to Danish competition law enforcement decisions, merger control cases, and sector enforcement data under the Konkurrenceloven.",
          data_source: "KFST (https://www.kfst.dk/)",
          coverage: {
            decisions: "Abuse of dominance (misbrug af dominerende stilling), cartel enforcement, and sector inquiries",
            mergers: "Merger control decisions (Fusionskontrol) — Phase I and Phase II",
            sectors: "Digital economy, energy, food retail, automotive, financial services, healthcare, media, telecommunications",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      case "dk_comp_list_sources": {
        const db = (await import("./db.js")).getDb();
        const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
        const mergerCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
        const sectorCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;
        const lastIngested = (db.prepare(
          "SELECT MAX(date) as last_date FROM decisions"
        ).get() as { last_date: string | null }).last_date;
        return textContent({
          sources: [
            {
              name: "KFST — Konkurrence- og Forbrugerstyrelsen",
              url: "https://www.kfst.dk/",
              record_counts: {
                decisions: decisionCount,
                mergers: mergerCount,
                sectors: sectorCount,
              },
              last_ingestion_date: lastIngested ?? "unknown",
            },
          ],
        });
      }

      case "dk_comp_check_data_freshness": {
        const db = (await import("./db.js")).getDb();
        const lastIngested = (db.prepare(
          "SELECT MAX(date) as last_date FROM decisions"
        ).get() as { last_date: string | null }).last_date;
        const today = new Date().toISOString().split("T")[0]!;
        const daysSince = lastIngested
          ? Math.floor((Date.now() - new Date(lastIngested).getTime()) / 86_400_000)
          : null;
        const stale = daysSince !== null && daysSince > 90;
        return textContent({
          sources: [
            {
              name: "KFST — Konkurrence- og Forbrugerstyrelsen",
              url: "https://www.kfst.dk/",
              last_updated: lastIngested ?? "unknown",
              checked_at: today,
              days_since_update: daysSince,
              status: lastIngested === null ? "no_data" : stale ? "stale" : "fresh",
              warning: stale
                ? `Data may be outdated — last ingestion was ${daysSince} days ago. Re-run npm run ingest to refresh.`
                : null,
            },
          ],
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
