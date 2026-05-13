# Organize runbook — periodic review of auto-registered vocabulary

You are an agent operating on the `lm-event-resolution` repository. Your task is to
**review the queue of auto-registered vocabulary entries** and either:

- Merge near-duplicate concepts into one canonical entry
- Move concepts under a more appropriate category
- Mark entries as reviewed (when they're fine as-is)

This runbook is intended to be run periodically (manually or on a cron) after
the bootstrap is complete and after live sources have been inline-registering
new vocabulary.

---

## Mandatory session + intent attribution

Every mutation you make MUST carry these headers — without them the API returns
`400 SESSION_REQUIRED` or `400 INTENT_REQUIRED`:

| Header | Value |
|---|---|
| `X-Claude-Session-Id` | Your own lm-assist execution id (in the runtime parameters). Do NOT use the parent's. |
| `X-Claude-Intent` | `"vocab-review"` for the high-level intent; refine per call. Example: `"merge concept:brent-oil:hormuz-blockade-2 into concept:brent-oil:hormuz-blockade"`. |
| `X-Claude-Parent-Session-Id` | The triggering session (in runtime parameters). |
| `X-Claude-Project` | `/home/ubuntu/lm-event-resolution` |
| `Content-Type` | `application/json` |

---

## Goal

Process the pending-review queue and improve the vocabulary quality without
losing observations. Specifically:

1. **Find near-duplicate concepts** — semantically equivalent labels that were
   registered separately by different sources / sessions.
2. **Decide which one is canonical** (keep the most-cited or most-descriptive name).
3. **Merge** — all observations re-point automatically; the loser's status
   becomes `merged` and `merged_into_id` points to the winner.
4. **Recategorize** — if a concept is under a wrong parent (or no parent),
   move it to the right category.
5. **Mark-reviewed** — for entries that are fine as-is, mark them so they leave
   the pending queue.

---

## Strategy

1. **Get the merge-suggestion candidates** the server has pre-computed:
   ```
   GET /api/organizer/suggestions?type=concept&limit=100
   ```
   This returns pairs of concepts whose labels overlap on a token or are prefixes
   of one another. It's a heuristic — you must still make the judgement call.

2. **For each suggested pair**:
   - Read both entries: `GET /api/vocabulary/<key>`
   - Look at their observation lists (the response includes `observations`)
   - Decide:
     - **Same concept different wording** → merge. Use
       `POST /api/organizer/merge { "winner": "<key-a>", "loser": "<key-b>", "reason": "..." }`
     - **Related but distinct** → don't merge; mark both reviewed with
       `POST /api/organizer/mark-reviewed { "key": "<key>", "reason": "kept distinct from <other>" }`
     - **One should be a child of the other** → recategorize:
       `POST /api/organizer/recategorize { "key": "<child>", "parent": "<parent>", "reason": "..." }`

3. **Walk the pending-review queue** (entries that weren't in any suggestion):
   ```
   GET /api/organizer/pending?limit=100
   ```
   For each entry decide what to do as above. If nothing needs to change,
   mark-reviewed so the queue shrinks.

4. **Don't lose observations.** Merging is non-destructive — `nodes.concept_id`
   gets re-pointed to the winner. But you should still spot-check by reading
   the winner's observation list after the merge to confirm.

---

## Quality bar

- **Be conservative on merges.** A bad merge is hard to undo because observation
  rows have been re-pointed. When unsure, leave both entries and mark them reviewed
  with a note explaining why.
- **Don't over-categorize.** A flat TOC is often fine. Only nest categories when
  there are 3+ siblings at a level — otherwise just leave the concept at the scope root.
- **Use aliases** to capture wording variants you decided not to merge as separate
  concepts: `POST /api/vocabulary/<key>/aliases { "alias": "..." }`.

---

## Endpoints you'll use

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/organizer/pending` | All auto_registered entries not yet reviewed |
| GET | `/api/organizer/suggestions` | Heuristic merge candidates |
| GET | `/api/vocabulary/<key>` | One entry + observations + children |
| GET | `/api/vocabulary/related?text=<text>` | FTS suggestions if you want to look up similar entries by hand |
| POST | `/api/organizer/merge` | Consolidate two concepts |
| POST | `/api/organizer/recategorize` | Move an entry under a different parent |
| POST | `/api/organizer/mark-reviewed` | Approve an entry as-is |
| POST | `/api/vocabulary/<key>/aliases` | Add an alias |

---

## Output

When you finish, return a JSON summary:

```json
{
  "type": "concept",
  "scanned": 142,
  "merged": 8,
  "recategorized": 15,
  "marked_reviewed": 119,
  "kept_distinct_with_note": [
    { "a": "concept:brent-oil:hormuz-blockade", "b": "concept:brent-oil:hormuz-shipping", "reason": "..." }
  ],
  "notes": "..."
}
```

---

## Failure handling

- A 400 on `/api/organizer/merge` means the keys are invalid or you're trying
  to merge an entry into itself — read the error and skip the pair.
- If the same concept appears multiple times in suggestions, only the first
  merge will succeed; subsequent will return "winner not found" or similar because
  the loser is now status=merged. Skip silently and move on.
- If you accidentally merge two entries that should stay separate, surface this
  in your output `notes` field so the human knows; the human can use
  `ler vocab` CLI commands to recover (manual update).
