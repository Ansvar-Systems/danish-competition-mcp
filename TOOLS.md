# Tools Reference

All tools exposed by the Danish Competition MCP server (`danish-competition-mcp`).

Tool prefix: `dk_comp_`

---

## Search & Retrieval

### `dk_comp_search_decisions`

Full-text search across KFST enforcement decisions (abuse of dominance, cartel, sector inquiries).

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query (e.g., `misbrug af dominerende stilling`, `prisaftaler`) |
| `type` | enum | no | Filter: `abuse_of_dominance`, `cartel`, `merger`, `sector_inquiry` |
| `sector` | string | no | Filter by sector ID (e.g., `digital_economy`, `food_retail`) |
| `outcome` | enum | no | Filter: `prohibited`, `cleared`, `cleared_with_conditions`, `fine` |
| `limit` | number | no | Max results (default 20, max 100) |

**Returns:** Array of matching decisions with case number, title, parties, outcome, fine amount, and `kl_articles`.

---

### `dk_comp_get_decision`

Get a specific KFST decision by case number.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `case_number` | string | yes | KFST case number (e.g., `KFST/2022/001`, `B6-22/16`) |

**Returns:** Full decision record or error if not found.

---

### `dk_comp_search_mergers`

Search KFST merger control decisions (Fusionskontrol).

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query (e.g., `Salling Group`, `energifusion`) |
| `sector` | string | no | Filter by sector ID |
| `outcome` | enum | no | Filter: `cleared`, `cleared_phase1`, `cleared_with_conditions`, `prohibited` |
| `limit` | number | no | Max results (default 20, max 100) |

**Returns:** Array of matching merger decisions.

---

### `dk_comp_get_merger`

Get a specific merger control decision by case number.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `case_number` | string | yes | KFST merger case number (e.g., `KFST/2022/M/001`) |

**Returns:** Full merger record or error if not found.

---

### `dk_comp_list_sectors`

List all sectors with KFST enforcement activity.

**Input:** None

**Returns:** Array of sectors with `id`, `name`, `name_en`, `description`, `decision_count`, `merger_count`.

---

## Meta Tools

### `dk_comp_about`

Return metadata about this MCP server.

**Input:** None

**Returns:** Server name, version, description, data source URL, coverage summary, and tool list.

---

### `dk_comp_list_sources`

Return authoritative data sources used by this server.

**Input:** None

**Returns:** Source name, URL, record counts (decisions, mergers, sectors), and last ingestion date. Required by fleet golden standard.

---

### `dk_comp_check_data_freshness`

Return per-source data freshness status with staleness warnings.

**Input:** None

**Returns:** Last updated date, days since update, freshness status (`fresh` / `stale` / `no_data`), and warning message if stale (>90 days). Required by fleet golden standard.

---

## Response Format

All tools return a JSON object with a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "Data sourced from KFST. For informational use only; not legal advice.",
    "copyright": "© Konkurrence- og Forbrugerstyrelsen (kfst.dk)",
    "source_url": "https://www.kfst.dk/",
    "data_age": "unknown"
  },
  ...
}
```
