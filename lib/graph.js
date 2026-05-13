const { open } = require('./db');
const nodes = require('./nodes');
const edges = require('./edges');

// BFS outward from a node along outgoing edges.
// Returns { nodes: [...], edges: [...] }.
function traverseOut(rootRef, { depth = 3, types, db = open() } = {}) {
  return traverse(rootRef, { depth, types, direction: 'out', db });
}

function traverseIn(rootRef, { depth = 3, types, db = open() } = {}) {
  return traverse(rootRef, { depth, types, direction: 'in', db });
}

// Bidirectional — gathers everything reachable in `depth` hops.
function neighborhood(rootRef, { depth = 2, types, db = open() } = {}) {
  return traverse(rootRef, { depth, types, direction: 'both', db });
}

function traverse(rootRef, { depth, types, direction, db }) {
  const root = nodes.getByIdOrUid(rootRef, { db });
  if (!root) return { nodes: [], edges: [], root: null };

  const seenNodes = new Map();
  const seenEdges = new Map();
  seenNodes.set(root.id, root);

  let frontier = [root.id];
  const typeFilter = types && types.length ? new Set(types) : null;

  for (let d = 0; d < depth; d++) {
    const nextFrontier = [];
    for (const id of frontier) {
      const outRows = (direction === 'out' || direction === 'both')
        ? db.prepare('SELECT e.*, n.* FROM edges e JOIN nodes n ON n.id = e.dst_id WHERE e.src_id = ?').all(id)
        : [];
      const inRows = (direction === 'in' || direction === 'both')
        ? db.prepare('SELECT e.*, n.* FROM edges e JOIN nodes n ON n.id = e.src_id WHERE e.dst_id = ?').all(id)
        : [];

      for (const row of outRows) {
        if (typeFilter && !typeFilter.has(row.type)) continue;
        recordEdgeAndNode(row, 'out', id, seenNodes, seenEdges, nextFrontier);
      }
      for (const row of inRows) {
        if (typeFilter && !typeFilter.has(row.type)) continue;
        recordEdgeAndNode(row, 'in', id, seenNodes, seenEdges, nextFrontier);
      }
    }
    frontier = nextFrontier;
    if (!frontier.length) break;
  }

  return {
    root,
    nodes: [...seenNodes.values()],
    edges: [...seenEdges.values()],
  };
}

function recordEdgeAndNode(row, dir, anchorId, seenNodes, seenEdges, nextFrontier) {
  // The row has both edge columns and joined node columns. Disambiguate manually.
  const edge = {
    id: row.id,
    src_id: row.src_id,
    dst_id: row.dst_id,
    type: row.type,
    weight: row.weight,
    props: row.props_json ? JSON.parse(row.props_json) : {},
    created_at: row.created_at,
  };
  if (!seenEdges.has(edge.id)) seenEdges.set(edge.id, edge);

  // Reconstruct the joined node — the SELECT * order means the JOIN columns
  // overrode some edge fields, but `id` after the join refers to the node.
  // Better-sqlite3 returns the LAST column's value for duplicates, so `id`
  // is the node id. We use src_id/dst_id to figure out which side.
  const otherId = dir === 'out' ? edge.dst_id : edge.src_id;

  if (!seenNodes.has(otherId)) {
    // Fetch the node fresh to avoid any column-name collision ambiguity.
    seenNodes.set(otherId, null); // placeholder; resolved below
    nextFrontier.push(otherId);
  }
}

// Convenience: render the resolution chain for a node — supersedes, parent_of, derives_from edges
// produce a dependency tree useful for "show me what this depends on".
function dependencyChain(rootRef, { db = open() } = {}) {
  const root = nodes.getByIdOrUid(rootRef, { db });
  if (!root) return null;

  const depTypes = ['depends_on', 'gates', 'derives_from', 'parent_of'];
  const queue = [{ node: root, depth: 0 }];
  const seen = new Set([root.id]);
  const tree = { ...root, children: [] };
  const treeIndex = new Map([[root.id, tree]]);

  while (queue.length) {
    const { node, depth } = queue.shift();
    if (depth > 6) continue;
    for (const t of depTypes) {
      const out = edges.listOut(node.id, { type: t, db });
      for (const edge of out) {
        const target = nodes.getById(edge.dst_id, { db });
        if (!target) continue;
        const child = { ...target, edge_type: edge.type, children: [] };
        treeIndex.get(node.id).children.push(child);
        if (!seen.has(target.id)) {
          seen.add(target.id);
          treeIndex.set(target.id, child);
          queue.push({ node: target, depth: depth + 1 });
        }
      }
    }
  }

  return tree;
}

// Resolve missing nodes in a neighborhood result by fetching them.
function hydrateNodes(graphResult, db = open()) {
  for (const [id, value] of [...graphResult.nodes.entries ? graphResult.nodes.entries() : Object.entries(graphResult.nodes)]) {
    // Map case
    if (value == null) {
      const n = nodes.getById(Number(id), { db });
      if (n) {
        if (typeof graphResult.nodes.set === 'function') graphResult.nodes.set(Number(id), n);
        else graphResult.nodes[id] = n;
      }
    }
  }
  return graphResult;
}

// Simpler version that always returns clean { nodes, edges }.
function fetchNeighborhood(rootRef, { depth = 2, types, db = open() } = {}) {
  const root = nodes.getByIdOrUid(rootRef, { db });
  if (!root) return { root: null, nodes: [], edges: [] };

  const seenNodes = new Map([[root.id, root]]);
  const seenEdges = new Map();
  const typeFilter = types && types.length ? new Set(types) : null;

  let frontier = [root.id];
  for (let d = 0; d < depth; d++) {
    const nextFrontier = [];
    for (const id of frontier) {
      const allEdges = db.prepare('SELECT * FROM edges WHERE src_id = ? OR dst_id = ?').all(id, id);
      for (const e of allEdges) {
        if (typeFilter && !typeFilter.has(e.type)) continue;
        if (seenEdges.has(e.id)) continue;
        seenEdges.set(e.id, {
          id: e.id, src_id: e.src_id, dst_id: e.dst_id, type: e.type,
          weight: e.weight,
          props: e.props_json ? JSON.parse(e.props_json) : {},
          created_at: e.created_at,
        });
        const otherId = e.src_id === id ? e.dst_id : e.src_id;
        if (!seenNodes.has(otherId)) {
          const n = nodes.getById(otherId, { db });
          if (n) {
            seenNodes.set(otherId, n);
            nextFrontier.push(otherId);
          }
        }
      }
    }
    frontier = nextFrontier;
    if (!frontier.length) break;
  }

  return {
    root,
    nodes: [...seenNodes.values()],
    edges: [...seenEdges.values()],
  };
}

module.exports = {
  traverseOut, traverseIn, neighborhood, fetchNeighborhood,
  dependencyChain,
};
