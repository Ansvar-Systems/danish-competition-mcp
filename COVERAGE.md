# Corpus Coverage

This document describes the completeness and scope of data indexed by the Danish Competition MCP server.

## Data Source

**Authority:** KFST — Konkurrence- og Forbrugerstyrelsen (Danish Competition and Consumer Authority)
**URL:** <https://www.kfst.dk/>
**Legal basis:** Konkurrenceloven (Danish Competition Act), EU Treaty Articles 101–102 TEUF

## Coverage Scope

### Enforcement Decisions (`decisions` table)

| Type | Coverage | Notes |
|---|---|---|
| Abuse of dominance (§ 11 KL / Art. 102 TEUF) | Partial | Published KFST decisions from kfst.dk |
| Cartel enforcement (§ 6 KL / Art. 101 TEUF) | Partial | Published decisions; some cases under SSK prosecution excluded |
| Sector inquiries (§ 12a KL) | Partial | Published sector inquiry reports |

### Merger Control (`mergers` table)

| Type | Coverage | Notes |
|---|---|---|
| Phase I decisions (Fase 1) | Partial | Published merger decisions from kfst.dk |
| Phase II decisions (Fase 2) | Partial | Full Phase II decisions with conditions |

### Sectors (`sectors` table)

| Sector | Status |
|---|---|
| Digital economy | Covered |
| Food retail | Covered |
| Energy | Covered |
| Financial services | Covered |
| Telecommunications | Covered |
| Healthcare | Covered |
| Construction | Covered |
| Media | Covered |

## Known Gaps

- Decisions not yet published on kfst.dk are not indexed.
- Ongoing (non-final) decisions may have incomplete data.
- Pre-2010 decisions have limited coverage.
- SSK (Statsadvokaten for Særlig Kriminalitet) criminal prosecution details are not included.
- EU Commission decisions affecting Danish markets are not included (see EU regulations MCP).

## Freshness

Run `npm run ingest` to refresh data from the KFST website.
Use the `dk_comp_check_data_freshness` tool to check current data age.

## Record Counts

Use the `dk_comp_list_sources` tool to get current record counts.
