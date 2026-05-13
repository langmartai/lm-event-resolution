# Align runbook — background vocabulary alignment

You are an agent operating on the `lm-event-resolution` repository. The system
now accepts vocabulary on writes **permissively** — sources can use any term
they like, and the server inline-registers it without rejection. Over time
this produces near-duplicate concept entries (e.g. `"Hormuz blockade"`,
`"Strait of Hormuz closure"`, `"Hormuz strait shutdown"`).

Your job is to **align them**: find near-duplicates and link them so that
observations under any one of the wordings surface together under a canonical
entry.

Prefer **alias-link over destructive merge** — only collapse rows when you're
confident they're truly the same concept. When in doubt, leave the rows alone
and mark them reviewed.

---

## Mandatory session + intent attribution

Every mutation MUST carry these headers:

| Header | Value |
|---|---|
| `X-Claude-Session-Id` | Your own lm-assist execution id |
| `X-Claude-Intent` | `"vocab-align"` (refine per call) |
| `X-Claude-Parent-Session-Id` | The triggering session |
| `X-Claude-Project` | `/home/ubuntu/lm-event-resolution` |
| `Content-Type` | `application/json` |

---

## Action vocabulary (in order of preference)

You have FOUR actions to choose from. Use them in this priority:

1. **`mark-reviewed`** — the cheapest action. Use when an entry is fine as-is
   (canonical-quality label, sensible category, no near-duplicates).
2. **`alias-link`** — the safe consolidation. Add the alias label to the
   canonical entry's `aliases_json`, then merge the duplicate row into the
   canonical (so its observations route to canonical). Original wording is
   preserved as a searchable alias on the canonical row.
3. **`recategorize`** — move under a different parent if categorisation is wrong.
4. **`merge`** — destructive consolidation. Same mechanism as alias-link but
   **without** adding the loser's label to canonical aliases. Use only when the
   loser's label is genuinely useless (e.g. a typo or a temporary one-off term).

In practice you'll mostly emit `mark-reviewed` and `alias-link`.

---

## Strategy

1. **Pull pending entries** (auto-registered, never reviewed):
   ```
   GET /api/organizer/pending?type=concept&limit=100
   GET /api/organizer/pending?type=category&limit=100
   ```

2. **Pull heuristic merge suggestions** (pre-computed by the server based on
   label overlap + same scope+type):
   ```
   GET /api/organizer/suggestions?type=concept&limit=50
   ```

3. **For each candidate pair (a, b)** in the suggestion list:
   - Read both: `GET /api/vocabulary/<key>` (this resolves through any existing
     merged_into_id chain, so you see canonical).
   - Look at their observations + descriptions + scope. Are they semantically
     equivalent?
   - **Yes, equivalent** → emit `alias-link`:
     ```
     POST /api/vocabulary/<winner-key>/aliases  { "alias": "<loser-label>" }
     POST /api/organizer/merge  { "winner": "<winner-key>", "loser": "<loser-key>",
                                  "reason": "alias-link via align agent" }
     ```
     This preserves the loser's label as a searchable alias.
   - **No, different** → emit `mark-reviewed` on both with notes:
     ```
     POST /api/organizer/mark-reviewed { "key": "<key>",
                                         "reason": "kept distinct from <other> because ..." }
     ```

4. **For each lone pending entry** (not in any suggested pair):
   - Use `GET /api/vocabulary/related?text=<label>&type=concept&scope=<scope>&limit=5`
     to do your own FTS lookup. Any high-similarity match? Treat as a pair as above.
   - Otherwise → `mark-reviewed` as canonical.

5. **Re-check after every alias-link**: the canonical now has more aliases
   driving FTS, so subsequent `/related` searches may catch more candidates.
   Iterate until pending count stabilises.

---

## Quality bar

- **Same wording, different scope = different concepts.** "Hormuz blockade" in
  scope `brent-oil` is the same as "Hormuz blockade" in scope `wti-oil`
  semantically, but downstream consumers usually want them separate (per-asset
  rollups). Don't cross-scope merge unless explicitly asked.
- **Same wording, different actor / period = different concepts.** "Hormuz
  blockade by Iran 2026" and "Hormuz blockade by Coalition 1991" are NOT the
  same. Look at description and observation dates.
- **When uncertain, prefer to leave separate.** A bad merge requires
  `ler vocab split` to recover, which is more work than letting two near-duplicates
  coexist for a cycle.
- **The aliases_json field is your friend.** Even if you don't merge, you can
  add an alias to the better-named row to capture the alternate wording for FTS:
  ```
  POST /api/vocabulary/<key>/aliases { "alias": "Strait of Hormuz closure" }
  ```

---

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizer/pending` | Auto-registered entries awaiting review |
| GET | `/api/organizer/suggestions` | Heuristic merge candidates |
| GET | `/api/vocabulary/:key` | Entry + observations + children (follows redirects) |
| GET | `/api/vocabulary/related?text=…` | FTS-based similarity search |
| POST | `/api/vocabulary/:key/aliases` | Add an alias to a canonical entry |
| POST | `/api/organizer/merge` | Consolidate two entries (loser's observations re-point to winner) |
| POST | `/api/organizer/recategorize` | Move an entry under a different parent |
| POST | `/api/organizer/mark-reviewed` | Approve an entry as canonical-as-is |

---

## Output

When done, return JSON summary:

```json
{
  "type": "concept",
  "scanned": 42,
  "alias_linked": 8,     // alias added + merged
  "merged": 0,           // destructive merge (no alias preserved)
  "recategorized": 5,
  "marked_reviewed": 27,
  "skipped_uncertain": 2,
  "notes": "..."
}
```

---

## Failure handling

- `400 winner not found` or `loser not found` — usually means a previous call
  merged the entry you're trying to merge again. Skip and continue.
- `400 cannot merge a vocabulary entry into itself` — your suggestion pointed
  to the same entry; skip.
- If you make a wrong merge, surface it in `notes` so a human can run
  `ler vocab split <observation-uid>` to recover.
