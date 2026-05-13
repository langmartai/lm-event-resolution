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

Every mutating command requires `--session-id <id>` (or `$LER_SESSION_ID` /
`$CLAUDE_SESSION_ID` env var). Read commands (`get`, `list`, `search`,
`graph`, `deps`, `history`) do not.

```bash
# One-time: set your session id in the env so you don't repeat the flag.
export LER_SESSION_ID="exec-1773287494272"

# Database / schema (init is not gated — it doesn't write to the audit table)
ler init

# Nodes — mutating: --session-id required (or LER_SESSION_ID in env)
ler node add --session-id $LER_SESSION_ID \
             --uid X:1 --type event --name "Trump rejects Iran V2" \
             --asset brent-oil --status confirmed --temporal past \
             --direction bullish --magnitude major \
             --occurred-at 2026-05-11T20:00:00Z \
             --body-file event.md
ler node update --session-id $LER_SESSION_ID X:1 \
             --status invalidated --reason "Iran withdrew on May 12"
ler node status --session-id $LER_SESSION_ID X:1 superseded \
             --reason "replaced by V3 framework"
ler node remove --session-id $LER_SESSION_ID X:1 --reason "duplicate"

# Nodes — read-only (no session id required)
ler node get X:1
ler node list --type driver --asset brent-oil --status active

# Edges — mutating: --session-id required
ler edge link --session-id $LER_SESSION_ID sub:1 factor:hormuz derives_from
ler edge link --session-id $LER_SESSION_ID sub:1 driver:rd1 supports --weight 0.4
ler edge unlink --session-id $LER_SESSION_ID sub:1 driver:rd1 supports

# Edges — read-only
ler edge list driver:rd1 --dir both

# Sources — mutating
ler source add --session-id $LER_SESSION_ID \
             --citation "Bloomberg May 11 2026" --url https://… --type news --trust 4
ler source attach --session-id $LER_SESSION_ID X:1 12 \
             --evidence "Direct Trump quote on Truth Social"

# Read-only
ler search "hormuz blockade"
ler search "rd1 OR rd2" --type driver --asset brent-oil
ler graph driver:rd1 --depth 2
ler deps driver:rd1            # tree view
ler history driver:rd1

# Import lm-unified-trade analyses — mutating (writes lots of rows)
ler import-lmut --session-id $LER_SESSION_ID /path/to/lm-unified-trade/analyses \
    --asset brent-oil --date 2026-05-13

# Serve REST API + Web UI (server itself doesn't write — but mutating
# requests routed through it still require the X-Claude-Session-Id header)
ler serve --port 4100
```

Global flags accepted by every command:

| Flag                | Env var               | Purpose                                            |
|---------------------|-----------------------|----------------------------------------------------|
| `--session-id <id>` | `LER_SESSION_ID` / `CLAUDE_SESSION_ID` | Claude Code session id — **required for mutations** |
| `--project <path>`  | `LER_PROJECT_PATH`    | Originating project / cwd (recorded in audit log)  |
| `--tool-use-id <id>`| `LER_TOOL_USE_ID`     | Optional tool-use correlation id                   |
| `--db <path>`       | `LER_DB`              | SQLite database file                               |

---

## REST API

Start: `npm start` (or `node bin/ler.js serve`). Default port 4100 (override
with `LER_PORT`). Bound to `0.0.0.0` by default — set `LER_HOST=127.0.0.1` to
restrict to loopback.

`:ref` accepts numeric `id` or `uid`.

### Read endpoints — no session required

| Method | Endpoint                              | Purpose                                                       |
|--------|---------------------------------------|---------------------------------------------------------------|
| GET    | `/api/health`                         | Liveness + table row counts                                   |
| GET    | `/api/meta`                           | Valid node types, statuses, edge types                        |
| GET    | `/api/assets`                         | Distinct assets with node counts                              |
| GET    | `/api/nodes`                          | List nodes — filters: `type`, `asset`, `status`, `limit`, `offset`, `sort` (`updated_at`/`created_at`/`name`/`type`/`status`/`eta_date`), `order` |
| GET    | `/api/nodes/:ref`                     | Detail bundle: node + sources + edges (in/out) + history      |
| GET    | `/api/edges`                          | List all edges — filters: `type`, `limit`                     |
| GET    | `/api/sources`                        | List all sources — filter: `type`                             |
| GET    | `/api/search?q=…`                     | FTS5 search — filters: `type`, `asset`, `status`, `limit`     |
| GET    | `/api/graph/:ref?depth=2`             | Neighborhood (nodes + edges) reachable in `depth` hops        |
| GET    | `/api/deps/:ref`                      | Dependency tree rooted at this node                           |
| GET    | `/api/updates`                        | Audit-log entries — filters: `limit`, `offset`, `sessionId`, `actor`, `sort`, `order` |
| GET    | `/api/updates/:entityType/:entityId`  | Full audit history for one entity                             |
| GET    | `/api/sessions`                       | Sessions that mutated data — paginated. Params: `limit`, `offset`, `sort` (`last_seen`/`first_seen`/`update_count`/`nodes_touched`/`session_id`), `order` (`asc`/`desc`) |
| GET    | `/api/sessions/:sessionId`            | Summary + breakdown (by change_type + entity_type) + nodes touched + paginated update timeline. Same `limit`/`offset`/`sort`/`order` |
| GET    | `/api/nodes/:ref/sessions`            | All sessions that have touched this node (touches, first/last seen, change types) |

### Mutating endpoints — `X-Claude-Session-Id` REQUIRED

Calls without the header (or a `sessionId` field in the body/query) return
**`400 SESSION_REQUIRED`** with a hint on how to fix.

| Method | Endpoint                       | Body shape                                                          |
|--------|--------------------------------|---------------------------------------------------------------------|
| POST   | `/api/nodes`                   | `{uid, type, name, asset?, body_md?, status?, certainty?, …}`       |
| PATCH  | `/api/nodes/:ref`              | Any subset of node fields (`name`, `body_md`, `status`, `props`, …) |
| POST   | `/api/nodes/:ref/status`       | `{status, reason?}`                                                 |
| DELETE | `/api/nodes/:ref`              | (none) — optional `?reason=…`                                       |
| POST   | `/api/edges`                   | `{src, dst, type, weight?, props?, reason?}`                        |
| DELETE | `/api/edges`                   | `{src, dst, type, reason?}`                                         |
| POST   | `/api/sources`                 | `{citation, url?, source_type?, trust_level?, notes?}`              |
| POST   | `/api/sources/:sourceId/attach`| `{node, evidence?}`                                                 |

### Request headers (audit context)

| Header                   | Required?            | Purpose                                                  |
|--------------------------|----------------------|----------------------------------------------------------|
| `X-Claude-Session-Id`    | **yes (mutations)**  | Stable session ID — e.g. lm-assist `exec-…`, Claude Code session id |
| `X-Claude-Project`       | optional             | Originating project / cwd                                |
| `X-Claude-Tool-Use-Id`   | optional             | Correlation id for a specific tool invocation            |
| `X-Claude-Actor`         | optional             | Display label (default: `session:<id>`)                  |
| `Content-Type`           | `application/json` for POST/PATCH | —                                            |

Body / query fields `sessionId`, `projectPath`, `toolUseId`, `actor` are
accepted as fallbacks if you cannot set headers.

### Examples

Successful mutation (writes audit row attributed to the session):

```bash
curl -X POST http://localhost:4100/api/nodes \
  -H "Content-Type: application/json" \
  -H "X-Claude-Session-Id: exec-1773287494272" \
  -H "X-Claude-Project: /home/ubuntu/lm-unified-trade" \
  -d '{"uid":"brent-oil:2026-05-14:event:new","type":"event","name":"…","reason":"trade-monitor run"}'
# → 201 Created
```

Missing the session header on a mutation:

```bash
curl -X POST http://localhost:4100/api/nodes \
  -H "Content-Type: application/json" \
  -d '{"uid":"x","type":"event","name":"y"}'
# → 400 SESSION_REQUIRED
# {"error":"SESSION_REQUIRED",
#  "message":"Mutating requests must include an X-Claude-Session-Id header...",
#  "hint":"Set X-Claude-Session-Id to your Claude Code session id..."}
```

Read endpoints are unaffected:

```bash
curl http://localhost:4100/api/nodes?type=driver        # → 200 OK
curl http://localhost:4100/api/search?q=hormuz          # → 200 OK
curl http://localhost:4100/api/sessions                 # → 200 OK (list of attributed sessions)
```

---

## Web UI

`/` (index.html) hosts a single-page browser with:

- **Home** — dashboard tiles for total nodes/edges/sources/audit entries + recent activity
- Full-text search box with type / asset / status filters
- **Nodes** tab — browse by type (events, factors, sub-factors, drivers, monitors, scenarios); sortable columns + paginated
- **Node detail** — three-card grid: details + sources + audit history on the left; *sessions that touched this node* + outgoing edges + incoming edges + dependency neighborhood on the right. Every update row in the history links to the session that made the change.
- **Recent updates** — sortable + paginated timeline of every mutation
- **Sessions** tab — sortable + paginated list of every Claude Code (or other) session that has mutated data; click into a session for a dashboard view:
  - Tile grid: total mutations, breakdown by change-type and entity-type (mini bar charts), active window
  - Nodes touched (sorted by how many times this session touched each, with a count badge)
  - **Activity grouped by entity** — instead of a flat log, see one tile per touched entity showing the timeline of changes that session made to it
  - Full sortable + paginated audit timeline
- **Stats** — counts by type / status / asset

Zero build step — vanilla HTML, CSS, JS served by Express. Open
`http://localhost:4100/` after `npm start`. The UI is read-only; mutations
still require the `X-Claude-Session-Id` header if you call the API directly.

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

**`--session-id` is REQUIRED.** The importer is a script, but a Claude Code
session operates it — that session is recorded against every node, edge, and
source it creates. Use `$LER_SESSION_ID` or `$CLAUDE_SESSION_ID` in the env
to avoid repeating the flag.

```bash
# Via the CLI wrapper
ler import-lmut --session-id $LER_SESSION_ID /home/ubuntu/lm-unified-trade/analyses --dry-run
ler import-lmut --session-id $LER_SESSION_ID /home/ubuntu/lm-unified-trade/analyses \
    --asset brent-oil --date 2026-05-13

# Or directly via the script (same enforcement)
node scripts/import-lmut.js /home/ubuntu/lm-unified-trade/analyses \
    --session-id $LER_SESSION_ID \
    --asset brent-oil --date 2026-05-13
```

Rows the importer writes are labelled `actor = importer:<sessionId>` so they
can be distinguished from the same session's manual CLI / API mutations.

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

See `migrations/001_init.sql` and `migrations/002_session_tracking.sql` for the
canonical SQL. High-level:

```
nodes        (uid, type, name, asset, body_md, status, certainty,
              significance, direction, magnitude, temporal, props_json,
              valid_from, valid_to, occurred_at, eta_date,
              created_at, updated_at)
edges        (src_id, dst_id, type, weight, props_json, created_at)
sources      (citation, url, source_type, trust_level, notes)
node_sources (node_id, source_id, evidence)
updates      (entity_type, entity_id, change_type, before_json, after_json,
              reason, actor,
              session_id, project_path, tool_use_id,   ← migration 002
              created_at)
tags         (node_id, tag)
nodes_fts    — FTS5 virtual table over (name, body_md, asset, type)
schema_version (version, applied_at)
```

`nodes_fts` is kept in sync by triggers on `nodes`, so `INSERT`/`UPDATE` of
nodes automatically re-indexes. Migrations are applied incrementally by
version number — `node bin/ler.js init` reads `schema_version` and runs only
the missing files.

---

## License

MIT
