# Bootstrap runbook — migrate existing observations into the controlled vocabulary

You are an agent operating on the `lm-event-resolution` repository. Your task is to
**bootstrap the controlled vocabulary** by registering canonical concepts and
categories for the existing observations (nodes) in the system, then linking
each observation to the vocabulary entries it belongs to.

The system has already been seeded with thousands of nodes from `lm-unified-trade`
analyses (factors, sub-factors, drivers, monitors). Right now their `concept_id`
and `category_id` fields are NULL — you are populating them.

---

## Mandatory session + intent attribution

Every mutation you make MUST carry these headers — without them the API returns
`400 SESSION_REQUIRED` or `400 INTENT_REQUIRED`:

| Header | Value |
|---|---|
| `X-Claude-Session-Id` | Your own lm-assist execution id (provided in the runtime parameters below). Do NOT use the parent's. |
| `X-Claude-Intent` | `"vocab-bootstrap"` for the high-level intent. Refine per call when meaningful, e.g. `"vocab-bootstrap: register concept for Hormuz blockade"`. |
| `X-Claude-Parent-Session-Id` | The parent session that triggered you (in runtime parameters). This is how the audit log preserves lineage. |
| `X-Claude-Project` | `/home/ubuntu/lm-event-resolution` |
| `Content-Type` | `application/json` |

If a request fails because you forgot one of these headers, fix the call and retry.
Do not work around the requirement.

---

## Goal

For each distinct concept that observations refer to (e.g. "Hormuz blockade",
"OPEC+ production policy", "EIA Weekly Petroleum Status Report"):

1. Register a canonical `concept` vocabulary entry with a stable label.
2. Register a canonical `category` if the concept doesn't fit an existing one.
3. Link every observation that refers to this concept by patching its
   `concept_id` and `category_id` (or by re-importing — but the simpler path
   is to use the dedicated migration endpoint, see below).

The bootstrap is **idempotent** — re-running on the same data should not
create duplicate vocabulary entries.

---

## Strategy (recommended)

1. **Read observations for one asset at a time.** Get the asset from the runtime
   parameters. If the parameter is omitted, ask the user to run with `--asset <slug>`
   for one batch at a time.

2. **List existing concepts for that asset** before doing anything:
   ```
   GET /api/vocabulary?type=concept&scope=<asset>&limit=500
   ```
   This is the floor — don't recreate any of these.

3. **Iterate over node types in order: factor → sub_factor → driver → monitor.**
   Factors are the top of the dependency chain; once you have canonical factor
   concepts, sub-factors can be linked under their parent factor, drivers
   reference sub-factors, etc.

4. **For each batch of nodes of one type for one asset:**
   ```
   GET /api/nodes?asset=<asset>&type=factor&limit=200
   ```
   Group results by their `name` (case-insensitive, stripped of trailing
   modifiers like " — Iran selective" so "Hormuz blockade" matches "Hormuz
   blockade — Iran selective"). For each group:
   - If a concept already exists with this label (check via
     `GET /api/vocabulary/related?text=<name>&type=concept&scope=<asset>`), reuse it.
   - Otherwise register one:
     ```
     POST /api/vocabulary
     { "type": "concept", "label": "Hormuz blockade", "scope": "<asset>",
       "description": "Iran-imposed restrictions on the Strait of Hormuz",
       "auto_registered": true }
     ```
   - Decide its category. Common categories for factors:
     - `supply-side` / `demand-side` / `policy` / `geopolitical` / `inventory` / `positioning` / `macro`
   - If the category doesn't exist for this scope, register it too. Place it
     under the appropriate scope-agnostic parent if one already exists.
   - For each node in the group, link via `PATCH /api/nodes/:uid` with body:
     ```
     { "concept_id": <id>, "category_id": <id>, "intent": "link to canonical concept" }
     ```
     (or use `PATCH /api/nodes/:uid` with `concept_key` / `category_key` — the
     server will look up the ids for you).

5. **Repeat for sub_factor / driver / monitor types** in the same asset.

6. **Stop when done with one asset.** Each asset is its own batch. The caller
   will re-invoke this runbook with a different `--asset` value to do the next.

---

## Quality bar

- **Don't over-merge.** "Hormuz blockade" and "Hormuz Strait closure" might be the
  same concept; "Hormuz blockade" and "OPEC+ Hormuz response" are NOT. When in doubt,
  register a separate concept and let the human (or the organize runbook) decide later.
- **Use clear, short canonical labels** — what you'd write on a flashcard. Not the full
  observation row. Examples:
  - ✓ `"Hormuz blockade"`
  - ✗ `"Hormuz blockade — Iran selective + US dual-blockade (with retaliation framework)"`
- **Aliases are your friend.** If multiple observation names should match this concept,
  add them as aliases:
  ```
  POST /api/vocabulary/<key>/aliases
  { "alias": "Strait of Hormuz closure" }
  ```
- **Don't invent new categories aggressively.** Use existing ones first; only register
  a new category when none of the existing ones is a sensible parent.

---

## Endpoints you'll use

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/vocabulary?type=concept&scope=<asset>` | List existing concepts for this scope |
| GET | `/api/vocabulary?type=category&scope=<asset>` | List existing categories |
| GET | `/api/vocabulary/related?text=<text>&type=concept&scope=<asset>` | FTS-based "is there already something close?" |
| GET | `/api/vocabulary/tree?root=<key>` | View the TOC tree under a node |
| POST | `/api/vocabulary` | Register a new concept or category |
| POST | `/api/vocabulary/<key>/aliases` | Add an alias |
| POST | `/api/categories` | Convenience wrapper for registering a category |
| GET | `/api/nodes?asset=<asset>&type=<type>` | List observations to migrate |
| PATCH | `/api/nodes/<uid>` | Link an observation to concept_id / category_id |
| POST | `/api/organizer/mark-reviewed` | Mark a vocab entry as no-longer-pending after a deliberate human-style decision |

---

## Output

When you finish a batch, return a single JSON object summarising what you did,
to stdout. Example:

```json
{
  "asset": "brent-oil",
  "concepts_registered": 23,
  "concepts_reused": 0,
  "categories_registered": 7,
  "observations_linked": 156,
  "review_recommended": [
    "concept:brent-oil:hormuz-blockade",
    "concept:brent-oil:opec-production-policy"
  ],
  "notes": "Two observations had ambiguous names — left auto_registered=true for human review."
}
```

---

## Failure handling

- A 400 from the API means your request was malformed — read the error message
  and fix it. Common causes: missing `X-Claude-Session-Id` / `X-Claude-Intent`,
  referencing a `concept_key` that doesn't exist (use POST first), trying to
  set status to an unrecognised value.
- A 500 means the server crashed — stop and report it.
- If the same name resolves to two clearly different concepts in different
  contexts, register both with distinguishing labels (e.g. `"Hormuz blockade
  (Iran)"` and `"Hormuz blockade (Coalition)"`).

When unsure, lean towards more concepts rather than fewer — the human running
the organize runbook will merge over-fragmentation later. Over-merging is harder
to undo.
