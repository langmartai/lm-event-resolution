# lm-event-resolution

Local SQLite-backed **event relationship repository** with full-text search, dependency graphs, and an append-only audit trail of every change.

This project answers four questions for any forecast it stores:

1. **What event happened?** (or is happening, or is registered to happen)
2. **What does it derive from?** (sources cited, predecessor events, parent factors)
3. **What does it gate or resolve into?** (typed-edge dependency graph)
4. **How has it changed over time?** (status history + full diff audit log)

It was built to be the system of record for the kind of structured fundamental analysis used by `lm-unified-trade` (events → factors → sub-factors → resolution drivers → monitors), but it is asset-agnostic and generic enough for any domain that decomposes events into forecasts.

---

## Concepts

The data model is a **typed graph** of nodes and edges.

### Nodes

| Type         | Meaning                                                                  |
|--------------|--------------------------------------------------------------------------|
| `event`      | A discrete fact with temporal state (past/present/future)                |
| `factor`     | A supply or demand factor (a grouping of evidence on a price-mover)      |
| `sub_factor` | A specific verifiable claim that decomposes a factor                     |
| `driver`     | A forward-looking resolution driver (causal history → projection)        |
| `monitor`    | An observable signal that resolves uncertainty on a driver               |
| `scenario`   | A probability-weighted forecast outcome                                  |
| `outcome`    | A resolved (now-known) outcome                                           |

Every node has:

- A stable `uid` (e.g. `brent-oil:2026-05-13:driver:rd1`) that survives renames
- `status` — `active` / `confirmed` / `registered` / `projected` / `invalidated` / `superseded` / `resolved` / `armed` / `triggered` / `expired`
- `certainty` (L1–L5) — Level of grounding (physical/observable → statement-dependent)
- `valid_from` / `valid_to` — temporal validity window
- `eta_date` — expected resolution date (for forward-looking nodes)
- `props` — arbitrary JSON for type-specific attributes
- `body_md` — free-form markdown body

### Edges (typed relationships)

| Type           | Meaning                                                                |
|----------------|------------------------------------------------------------------------|
| `derives_from` | This node was derived from an upstream source/event/factor             |
| `supports`     | Evidence supports a claim                                              |
| `contradicts`  | Evidence contradicts a claim                                           |
| `supersedes`   | This node replaces an older one                                        |
| `gates`        | The other node must resolve before this one can resolve                |
| `resolves_to`  | This node resolves into the target node                                |
| `monitors`     | A monitor watches a driver                                             |
| `parent_of`    | Hierarchical containment (driver → sub-driver)                         |
| `projects_to`  | A scenario projects to a target state                                  |
| `causes`       | Causal relationship                                                    |
| `depends_on`   | Generic dependency                                                     |
| `cross_refs`   | Soft cross-reference                                                   |

Edges optionally carry a `weight` (e.g. probability, influence %, correlation) and free-form `props`.

### Sources

Sources are cited by `citation` + optional `url`, classified as `news` / `official` / `agency` / `llm-search` / `api` / `analyst`, and attached to nodes via `node_sources` rows that can carry an evidence quote.

### Audit trail (`updates` table)

Every create, update, status change, link, and unlink writes a row with:

- `before_json` / `after_json` — full snapshots
- `change_type` — `create` | `update` | `status_change` | `delete` | `link` | `unlink`
- `actor` — who made the change (cli, api, importer, …)
- `reason` — why (free text)
- `session_id` — Claude Code session that originated the call (see below)
- `project_path` — working directory of the originating session
- `tool_use_id` — optional correlation id for a specific tool invocation

**Reads are not tracked.** Only mutations (POST / PATCH / DELETE — or any
library call that writes) land in the `updates` table. GETs and FTS searches
never write rows, so session attribution is exclusively for who has changed
state, not who has looked at it.

Nothing in the data is destructive; deletes leave a tombstone in the audit log.

### Session tracking (who modified this repository?)

**Session identification is MANDATORY for every mutation.** Any create / update
/ delete / link / unlink — whether from the HTTP API, the CLI, the markdown
importer, or a direct library call — must carry the Claude Code session id
that operates it. Mutations without one are rejected:

- HTTP `POST` / `PATCH` / `DELETE` without `X-Claude-Session-Id` → **400 SESSION_REQUIRED**
- CLI mutation without `--session-id` (and no `$LER_SESSION_ID` / `$CLAUDE_SESSION_ID` env) → exit 2 with a clear message
- Library mutation called from code without `opts.sessionId` → throws `MissingSessionError`
- `import-lmut` script (even invoked directly, even from cron) → must receive `--session-id`; the importer is a tool, but a session operates it, and that session is recorded against every row it produces

Read operations (`GET` / `node get` / `node list` / `search` / `graph` / `deps`
/ `history`) are NOT tracked and do NOT require a session id.

To attribute mutations to a specific Claude Code session (or any identifiable
caller), pass these headers on every POST / PATCH / DELETE:

| Header                   | Purpose                                                  |
|--------------------------|----------------------------------------------------------|
| `X-Claude-Session-Id`    | Stable session ID (e.g. lm-assist `exec-...`, Claude Code session id) |
| `X-Claude-Project`       | Originating project / cwd                                |
| `X-Claude-Tool-Use-Id`   | Optional — correlates with a specific tool call          |
| `X-Claude-Actor`         | Optional — display label (default: `session:<id>`)       |

Example — Claude Code agent writing a new event:

```bash
curl -X POST http://localhost:4100/api/nodes \
  -H "Content-Type: application/json" \
  -H "X-Claude-Session-Id: exec-1773287494272" \
  -H "X-Claude-Project: /home/ubuntu/lm-unified-trade" \
  -d '{"uid":"brent-oil:2026-05-14:event:new","type":"event","name":"…","reason":"trade-monitor run"}'
```

Two endpoints surface the resulting attribution:

| Endpoint                          | Returns                                                          |
|-----------------------------------|------------------------------------------------------------------|
| `GET /api/sessions`               | All sessions with `update_count`, `nodes_touched`, first/last seen |
| `GET /api/sessions/:sessionId`    | Summary + nodes touched + full update timeline for one session   |

The web UI exposes a **Sessions** tab listing every Claude Code (or other)
session that has ever mutated data, with drill-down to the timeline of
changes that session made. Individual update rows in the audit log link
back to their session detail page.

---

## Install

```bash
git clone git@github.com:langmartai/lm-event-resolution.git
cd lm-event-resolution
npm install
node bin/ler.js init
```

Requires Node 18+. Database is `data/ler.db` (override with `LER_DB=/path/to/db`).

---

## CLI (`ler`)

```bash
# Database / schema
ler init                          # create + migrate

# Nodes
ler node add --uid X:1 --type event --name "Trump rejects Iran V2" \
             --asset brent-oil --status confirmed --temporal past \
             --direction bullish --magnitude major \
             --occurred-at 2026-05-11T20:00:00Z \
             --body-file event.md
ler node get X:1
ler node update X:1 --status invalidated --reason "Iran withdrew on May 12"
ler node status X:1 superseded --reason "replaced by V3 framework"
ler node list --type driver --asset brent-oil --status active
ler node remove X:1 --reason "duplicate"

# Edges
ler edge link sub:1 factor:hormuz derives_from
ler edge link sub:1 driver:rd1 supports --weight 0.4
ler edge unlink sub:1 driver:rd1 supports
ler edge list driver:rd1 --dir both

# Sources
ler source add --citation "Bloomberg May 11 2026" --url https://… --type news --trust 4
ler source attach X:1 12 --evidence "Direct Trump quote on Truth Social"

# Search (FTS5)
ler search "hormuz blockade"
ler search "rd1 OR rd2" --type driver --asset brent-oil

# Graph / dependencies
ler graph driver:rd1 --depth 2
ler deps driver:rd1            # tree view

# Audit history
ler history driver:rd1

# Import lm-unified-trade analyses
ler import-lmut /path/to/lm-unified-trade/analyses \
    --asset brent-oil --date 2026-05-13

# Serve REST API + Web UI
ler serve --port 4100
```

---

## REST API

Start: `npm start` (or `node bin/ler.js serve`). Default port 4100, override with `LER_PORT`.

| Method | Endpoint                              | Purpose                                                       |
|--------|---------------------------------------|---------------------------------------------------------------|
| GET    | `/api/health`                         | Liveness + table row counts                                   |
| GET    | `/api/meta`                           | Valid node types, statuses, edge types                        |
| GET    | `/api/assets`                         | Distinct assets and node counts                               |
| GET    | `/api/nodes`                          | List nodes (filters: `type`, `asset`, `status`, `limit`)      |
| POST   | `/api/nodes`                          | Create node                                                   |
| GET    | `/api/nodes/:ref`                     | Detail (node + sources + edges + history)                     |
| PATCH  | `/api/nodes/:ref`                     | Update fields                                                 |
| POST   | `/api/nodes/:ref/status`              | Change status (`{status, reason, actor}`)                     |
| DELETE | `/api/nodes/:ref`                     | Delete                                                        |
| GET    | `/api/edges`                          | List edges                                                    |
| POST   | `/api/edges`                          | Create edge (`{src, dst, type, weight?, props?}`)             |
| DELETE | `/api/edges`                          | Remove edge                                                   |
| GET    | `/api/sources`                        | List                                                          |
| POST   | `/api/sources`                        | Create / upsert                                               |
| POST   | `/api/sources/:id/attach`             | Attach to node (`{node, evidence}`)                           |
| GET    | `/api/search?q=…`                     | FTS5 search (filters: `type`, `asset`, `status`, `limit`)     |
| GET    | `/api/graph/:ref?depth=2`             | Neighborhood (nodes + edges)                                  |
| GET    | `/api/deps/:ref`                      | Dependency tree                                               |
| GET    | `/api/updates`                        | Recent audit-log entries                                      |
| GET    | `/api/updates/:entityType/:entityId`  | History of one entity                                         |

`:ref` accepts numeric id or uid.

---

## Web UI

`/` (index.html) hosts a single-page browser with:

- Full-text search box with type/asset/status filters
- Browse by type (events, factors, sub-factors, drivers, monitors, scenarios)
- Node detail with sources, incoming + outgoing edges, dependency neighborhood, audit history
- Recent updates timeline
- Repository stats (counts by type/status/asset)

Zero build step — vanilla HTML, CSS, JS served by Express. Open `http://localhost:4100/` after `npm start`.

---

## Importing lm-unified-trade fundamental analyses

The importer walks `analyses/{asset}/{date}/fundamental/` directories and ingests:

- `supply-factors.md` → nodes of type `factor` (`props.category = supply`)
- `demand-factors.md` → nodes of type `factor` (`props.category = demand`)
- `sub-factors.md` → nodes of type `sub_factor` with `derives_from` edges to their parent factor
- `resolution-drivers.md` → nodes of type `driver` with `parent_of` edges for nested headings
- `resolution-monitors.md` → nodes of type `monitor` with `monitors` edges back to their driver
- Citations from `source_events` / `source` columns → `sources` table + `node_sources` attachments

Idempotent — re-running on the same asset+date upserts existing rows (and appends to the audit log) rather than duplicating.

```bash
# --session-id is REQUIRED. The importer is a script; the session that runs it
# is recorded against every row. Use $LER_SESSION_ID or $CLAUDE_SESSION_ID env
# vars to avoid repeating the flag.
ler import-lmut /home/ubuntu/lm-unified-trade/analyses --session-id $LER_SESSION_ID --dry-run
ler import-lmut /home/ubuntu/lm-unified-trade/analyses --session-id <session-id> \
    --asset brent-oil --date 2026-05-13
```

Sample import (Brent oil, May 13, 2026):

```
{
  "nodes_created": 156,
  "edges_created": 69,
  "sources_created": 325,
  "errors": []
}
```

Producing 23 factors, 60 sub-factors, 21 drivers, 52 monitors with full source citation graph.

---

## Schema

See `migrations/001_init.sql` for the canonical SQL. High-level:

```
nodes (uid, type, name, asset, body_md, status, certainty, …)
edges (src_id, dst_id, type, weight, props_json)
sources (citation, url, source_type, trust_level)
node_sources (node_id, source_id, evidence)
updates (entity_type, entity_id, change_type, before_json, after_json, reason, actor)
tags (node_id, tag)
nodes_fts — FTS5 virtual table over (name, body_md, asset, type)
```

`nodes_fts` is kept in sync by triggers on `nodes` so `UPDATE nodes …` automatically re-indexes.

---

## License

MIT
