// Markdown importer: read lm-unified-trade analyses/{asset}/{date}/fundamental/
// trees and ingest supply-factors, demand-factors, sub-factors, resolution-drivers,
// and resolution-monitors as nodes + edges in the lm-event-resolution DB.
//
// Idempotent. Re-running for the same asset+date upserts (status/body refresh)
// rather than duplicating.

const fs = require('fs');
const path = require('path');
const { nodes, edges, sources, db } = require('../lib');

async function run({ analysesDir, asset, date, dryRun = false, audit } = {}) {
  db.open();
  db.migrate();

  if (!fs.existsSync(analysesDir)) {
    throw new Error(`analyses dir not found: ${analysesDir}`);
  }

  // The importer is a SCRIPT, but it is OPERATED by a Claude Code session.
  // Record every row it creates against that session AND that session's intent.
  if (!audit || !audit.sessionId) {
    throw new Error('importer requires audit context with sessionId — pass via --session-id (CLI) or audit option (library).');
  }
  if (!audit.intent) {
    throw new Error('importer requires audit context with intent — pass via --intent (CLI) or audit option (library). Describe WHY this import is running.');
  }
  // Attach an importer suffix to the actor label so we can distinguish
  // "session X used the cli" from "session X operated the importer".
  audit = { ...audit, actor: `importer:${audit.sessionId}` };

  const stats = {
    assets_scanned: 0,
    dates_scanned: 0,
    nodes_created: 0,
    nodes_updated: 0,
    edges_created: 0,
    sources_created: 0,
    skipped: 0,
    errors: [],
  };

  const assetDirs = fs.readdirSync(analysesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map(d => d.name);

  for (const a of assetDirs) {
    if (asset && a !== asset) continue;
    stats.assets_scanned++;
    const assetPath = path.join(analysesDir, a);
    const dateDirs = fs.readdirSync(assetPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map(d => d.name);

    for (const dt of dateDirs) {
      if (date && dt !== date) continue;
      stats.dates_scanned++;
      const fundDir = path.join(assetPath, dt, 'fundamental');
      if (!fs.existsSync(fundDir)) { stats.skipped++; continue; }
      try {
        await importOneAnalysis({ asset: a, date: dt, fundDir, stats, dryRun, audit });
      } catch (err) {
        stats.errors.push({ asset: a, date: dt, error: err.message });
      }
    }
  }

  return stats;
}

async function importOneAnalysis({ asset, date, fundDir, stats, dryRun, audit }) {
  // We import in dependency order so edges always have endpoints:
  //   factors → sub_factors (derives_from factors) → drivers (cite sub_factors)
  //   → monitors (monitor drivers)

  const factorIds = {}; // factor name → node uid
  const subFactorIds = {}; // sub_factor name → node uid
  const driverIds = {}; // driver id (RD1...) → node uid

  // --- 1. Supply factors ---
  const supplyPath = path.join(fundDir, 'supply-factors.md');
  if (fs.existsSync(supplyPath)) {
    const rows = parseTableFile(supplyPath);
    for (const r of rows) {
      const uid = buildUid(asset, date, 'factor', r.factor);
      const props = {
        category: 'supply',
        quantified_impact: r.quantified_impact,
        type: r.type,
        impact: r.impact,
        duration: r.duration,
        duration_basis: r.duration_basis,
        capacity_status: r.capacity_status,
        causal_trajectory: r.causal_trajectory,
        resolution_window: r.resolution_window,
        resolution_certainty: r.resolution_certainty,
        notes: r.notes,
      };
      const created = upsertNode({
        uid, type: 'factor', name: r.factor, asset,
        body_md: r.notes || '',
        status: 'active',
        significance: r.significance, direction: r.impact, magnitude: r.magnitude,
        valid_from: date, props,
      }, { asset, date, stats, dryRun, audit });
      factorIds[r.factor] = uid;
      // Attach source citations
      attachSources(uid, r.source_events, { stats, dryRun, audit });
    }
  }

  // --- 2. Demand factors ---
  const demandPath = path.join(fundDir, 'demand-factors.md');
  if (fs.existsSync(demandPath)) {
    const rows = parseTableFile(demandPath);
    for (const r of rows) {
      const uid = buildUid(asset, date, 'factor', r.factor);
      const props = {
        category: 'demand',
        quantified_impact: r.quantified_impact,
        type: r.type,
        impact: r.impact,
        duration: r.duration,
        duration_basis: r.duration_basis,
        capacity_status: r.capacity_status,
        causal_trajectory: r.causal_trajectory,
        resolution_window: r.resolution_window,
        resolution_certainty: r.resolution_certainty,
        notes: r.notes,
      };
      upsertNode({
        uid, type: 'factor', name: r.factor, asset,
        body_md: r.notes || '',
        status: 'active',
        significance: r.significance, direction: r.impact, magnitude: r.magnitude,
        valid_from: date, props,
      }, { asset, date, stats, dryRun, audit });
      factorIds[r.factor] = uid;
      attachSources(uid, r.source_events, { stats, dryRun, audit });
    }
  }

  // --- 3. Sub-factors ---
  const subPath = path.join(fundDir, 'sub-factors.md');
  if (fs.existsSync(subPath)) {
    const rows = parseTableFile(subPath);
    let idx = 0;
    for (const r of rows) {
      idx++;
      const uid = buildUid(asset, date, 'sub', `${idx}-${r.sub_factor}`);
      const props = {
        credibility_type: r.credibility_type,
        verified: r.verified,
        evidence: r.evidence,
        causal_history: r.causal_history,
        projection_basis: r.projection_basis,
        parent_factor_name: r.parent_factor,
      };
      upsertNode({
        uid, type: 'sub_factor', name: r.sub_factor || `Sub-factor ${idx}`, asset,
        body_md: r.evidence || '',
        status: 'active',
        certainty: r.predictive_certainty,
        valid_from: date, props,
      }, { asset, date, stats, dryRun, audit });
      subFactorIds[r.sub_factor] = uid;

      // Edge: sub_factor derives_from parent factor. Sub-factors reference the
      // factor by its short name (e.g. "Hormuz blockade") while the factor row
      // itself often has a fuller name ("Hormuz blockade — Iran selective + US
      // dual-blockade"). Try exact match first, then prefix/contains match.
      const parentUid = findParentFactor(r.parent_factor, factorIds);
      if (parentUid) {
        linkEdge(uid, parentUid, 'derives_from', { stats, dryRun, audit });
      }
      attachSources(uid, r.source_events, { stats, dryRun, audit });
    }
  }

  // --- 4. Resolution drivers (nested heading tree) ---
  const driversPath = path.join(fundDir, 'resolution-drivers.md');
  if (fs.existsSync(driversPath)) {
    const tree = parseDriversTree(driversPath);
    importDriversTree(tree, null, { asset, date, driverIds, subFactorIds, stats, dryRun, audit });
  }

  // --- 5. Resolution monitors ---
  const monitorsPath = path.join(fundDir, 'resolution-monitors.md');
  if (fs.existsSync(monitorsPath)) {
    const rows = parseTableFile(monitorsPath);
    let idx = 0;
    for (const r of rows) {
      idx++;
      const slug = slugify(r.observable_event || r.driver_path || `monitor-${idx}`);
      const uid = buildUid(asset, date, 'monitor', `${idx}-${slug}`);
      const props = {
        driver_path: r.driver_path,
        check_frequency: r.check_frequency,
        next_expected: r.next_expected,
        signal_meaning: r.signal_meaning,
        current_baseline: r.current_baseline,
        last_checked: r.last_checked,
        last_triggered: r.last_triggered,
      };
      upsertNode({
        uid, type: 'monitor', name: r.observable_event || `Monitor ${idx}`,
        asset, body_md: r.signal_meaning || '',
        status: r.status || 'active',
        valid_from: date, props,
      }, { asset, date, stats, dryRun, audit });

      // Attach to driver — best-effort match by RDn prefix in driver_path
      const driverMatch = (r.driver_path || '').match(/RD\d+/);
      if (driverMatch) {
        const driverUid = driverIds[driverMatch[0]];
        if (driverUid) linkEdge(uid, driverUid, 'monitors', { stats, dryRun, audit });
      }
      if (r.source) attachSources(uid, r.source, { stats, dryRun, audit });
    }
  }
}

// ============================================================
// Markdown table parsing
// ============================================================
function parseTableFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Strip frontmatter
  const body = content.replace(/^---[\s\S]*?---\n/, '');
  const lines = body.split('\n');

  // Find the data table — first line with pipes that's not in the Temporal Validity table.
  // The data table is identifiable because it has more than 4 columns (which the validity table doesn't).
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const cells = parseRow(line);
    if (cells.length >= 5 && lines[i + 1] && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
      // Skip the temporal-validity table (has Field/Value)
      if (cells[0] === 'Field' && cells[1] === 'Value') continue;
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const headers = parseRow(lines[headerIdx]).map(h => h.replace(/\W+/g, '_').toLowerCase());
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      if (rows.length > 0 && (line.trim() === '' || !line.includes('|'))) {
        // table ended
        break;
      }
      continue;
    }
    const cells = parseRow(line);
    if (cells.length < 2) continue;
    const row = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = (cells[c] || '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseRow(line) {
  // Strip leading and trailing pipes, then split.
  const trimmed = line.replace(/^\|/, '').replace(/\|\s*$/, '');
  return trimmed.split('|').map(s => s.trim());
}

// ============================================================
// Resolution drivers tree parsing
// ============================================================
function parseDriversTree(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const body = content.replace(/^---[\s\S]*?---\n/, '');
  const lines = body.split('\n');

  const root = { children: [] };
  const stack = [{ depth: 0, node: root }];
  let currentNode = null;
  let bodyLines = [];

  function flushBody() {
    if (currentNode && bodyLines.length) {
      currentNode.body_md = bodyLines.join('\n').trim();
      bodyLines = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (m) {
      flushBody();
      const depth = m[1].length;
      const title = m[2].replace(/^\*+|\*+$/g, '').trim();
      // Skip non-driver section headings. These appear at various depths inside a driver
      // (e.g. `### Past Anchors` under `## RD1`) — they describe the parent driver, not
      // a separate node. Their content gets folded into the parent's body via bodyLines.
      // Skip pure section headings (the `### Past Anchors` style under each driver).
      // Keep `Sub-driver A — ...` — those are real sub-driver nodes.
      const SKIP_HEADINGS = /^(Temporal Validity|Change Log|Driver Index|Notes|Cross-driver Validation|State Change Summary|Past Anchors|Current State|Forward Projection|Resolution Timeline|Probability Shift Impact|Bottleneck|Contradiction|Cross-driver Interaction|Cross-Driver Interaction|Resolution Window Summary|Top \d+ Active Resolutions|Decomposition \()/i;
      if (SKIP_HEADINGS.test(title)) {
        // Keep currentNode pointing at the previous real driver so the body lines
        // (and any further fields) accumulate onto it.
        continue;
      }
      const node = { title, depth, children: [], fields: {}, body_md: '' };
      // Pop stack to find parent
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      const parent = stack[stack.length - 1].node;
      parent.children.push(node);
      stack.push({ depth, node });
      currentNode = node;
      continue;
    }

    if (!currentNode) continue;

    // Field bullets: - **Field:** value (single-line) OR multi-line
    const fieldMatch = line.match(/^\s*-\s+\*\*([^*]+?):\*\*\s*(.*)$/);
    if (fieldMatch) {
      const key = fieldMatch[1].trim().toLowerCase().replace(/\W+/g, '_');
      const value = fieldMatch[2].trim();
      currentNode.fields[key] = value;
      continue;
    }

    bodyLines.push(line);
  }
  flushBody();

  return root;
}

function importDriversTree(node, parentUid, ctx) {
  for (const child of (node.children || [])) {
    const title = child.title || 'driver';
    // Extract driver ID like "RD1" from title — used for monitor linking + downstream cross-refs.
    const idMatch = title.match(/(?:^|\s)(RD\d+|RD-\d+)\b/i);
    const driverKey = idMatch ? idMatch[1].replace('-', '').toUpperCase() : null;
    const slug = slugify(title);
    const uid = buildUid(ctx.asset, ctx.date, 'driver', driverKey ? driverKey.toLowerCase() : slug);
    const props = {
      heading_depth: child.depth,
      ...child.fields,
    };
    upsertNode({
      uid, type: 'driver', name: title, asset: ctx.asset,
      body_md: child.body_md || '',
      status: (child.fields.status || 'active').split(/\s+/)[0],
      certainty: child.fields.uncertainty || null,
      eta_date: extractEtaDate(child.fields.resolution_horizon),
      valid_from: ctx.date, props,
    }, { asset: ctx.asset, date: ctx.date, stats: ctx.stats, dryRun: ctx.dryRun, audit: ctx.audit });

    if (driverKey) ctx.driverIds[driverKey] = uid;

    if (parentUid) {
      linkEdge(uid, parentUid, 'parent_of', { stats: ctx.stats, dryRun: ctx.dryRun, audit: ctx.audit });
    }

    // Source events / monitor references in field text
    if (child.fields.monitor) attachSources(uid, child.fields.monitor, ctx);

    importDriversTree(child, uid, ctx);
  }
}

function extractEtaDate(horizonText) {
  if (!horizonText) return null;
  const m = horizonText.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ============================================================
// Upsert helpers
// ============================================================
function upsertNode(input, { stats, dryRun, audit }) {
  const existing = nodes.getByUid(input.uid);
  if (dryRun) {
    if (existing) stats.nodes_updated++;
    else stats.nodes_created++;
    return existing || input;
  }
  // Markdown analyses sometimes use freeform status strings ("active — CRITICAL",
  // "TRIGGERED-MAJOR-CORRECTION", "watch", etc) that don't match the DB enum.
  // Stash the raw value in props.status_raw and normalise to a valid status so
  // the import doesn't lose a whole analysis to one stray row.
  if (input.status && !nodes.VALID_STATUSES.has(input.status)) {
    const raw = input.status;
    const normalised = normaliseStatus(raw);
    input.props = { ...(input.props || {}), status_raw: raw };
    input.status = normalised;
  }
  const opts = { ...audit, reason: 'lmut markdown import' };
  if (existing) {
    nodes.update(existing.id, input, opts);
    stats.nodes_updated++;
  } else {
    nodes.create(input, opts);
    stats.nodes_created++;
  }
  return input;
}

function normaliseStatus(raw) {
  const s = String(raw).toLowerCase();
  if (s.includes('triggered')) return 'triggered';
  if (s.startsWith('active'))  return 'active';
  if (s.startsWith('armed'))   return 'armed';
  if (s.startsWith('expired')) return 'expired';
  if (s.startsWith('resolved')) return 'resolved';
  if (s.startsWith('invalid')) return 'invalidated';
  if (s.startsWith('supers'))  return 'superseded';
  if (s.startsWith('confirm')) return 'confirmed';
  if (s.startsWith('project')) return 'projected';
  if (s.startsWith('register')) return 'registered';
  if (s.startsWith('pending'))  return 'pending';
  if (s.startsWith('watch'))    return 'armed';   // watch ~ armed monitor
  return 'active';
}

function linkEdge(srcUid, dstUid, type, { stats, dryRun, audit }) {
  if (dryRun) { stats.edges_created++; return; }
  try {
    edges.link(srcUid, dstUid, type, { ...audit, reason: 'lmut markdown import' });
    stats.edges_created++;
  } catch (err) {
    // ignore duplicate-edge errors quietly, but re-throw SESSION_REQUIRED so
    // misconfigured callers don't silently lose attribution.
    if (err && err.code === 'SESSION_REQUIRED') throw err;
  }
}

function attachSources(nodeUid, sourceText, { stats, dryRun, audit }) {
  if (!sourceText) return;
  // Extract citation tokens — split on ;, comma, ' + ', ' and ', or pipe
  const tokens = sourceText.split(/[;|]|,\s+/).map(t => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    if (tok.length > 200) continue; // skip multi-paragraph notes
    if (dryRun) { stats.sources_created++; continue; }
    const source = sources.upsert({
      citation: tok,
      source_type: classifyCitation(tok),
    }, audit);
    sources.attach(nodeUid, source.id, audit);
    stats.sources_created++;
  }
}

function classifyCitation(text) {
  const t = text.toLowerCase();
  if (/cnn|bloomberg|reuters|wsj|wapo|nyt|cnbc|ft|bbc|npr/.test(t)) return 'news';
  if (/eia|api|opec|iea|treasury|fed|bls|bea/.test(t)) return 'agency';
  if (/official|statement|press/.test(t)) return 'official';
  return 'llm-search';
}

function findParentFactor(parentName, factorIds) {
  if (!parentName) return null;
  if (factorIds[parentName]) return factorIds[parentName];
  // Try lowercased contains/prefix match on the factor name.
  const want = String(parentName).toLowerCase().trim();
  // Exact case-insensitive
  for (const [name, uid] of Object.entries(factorIds)) {
    if (name.toLowerCase() === want) return uid;
  }
  // Prefix match (sub-factor's short name is a prefix of full factor name)
  for (const [name, uid] of Object.entries(factorIds)) {
    const n = name.toLowerCase();
    if (n.startsWith(want + ' ') || n.startsWith(want + ' —') || n.startsWith(want + ',')) {
      return uid;
    }
  }
  // Contains match (loose)
  for (const [name, uid] of Object.entries(factorIds)) {
    if (name.toLowerCase().includes(want)) return uid;
  }
  return null;
}

function buildUid(asset, date, kind, slug) {
  return `${asset}:${date}:${kind}:${slugify(slug).slice(0, 80)}`;
}

function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { run };

// CLI entry point: `node scripts/import-lmut.js <analyses_dir> --session-id <id> [--asset X --date Y --dry-run]`
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: import-lmut <analyses_dir> --session-id <id> --intent <text> [--asset X] [--date Y] [--project /path] [--tool-use-id <id>] [--dry-run]');
    process.exit(1);
  }
  const opts = { analysesDir: path.resolve(args[0]) };
  let sessionId = process.env.LER_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  let intent = process.env.LER_INTENT || null;
  let projectPath = process.env.LER_PROJECT_PATH || null;
  let toolUseId = process.env.LER_TOOL_USE_ID || null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--asset') opts.asset = args[++i];
    else if (args[i] === '--date') opts.date = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--session-id') sessionId = args[++i];
    else if (args[i] === '--intent') intent = args[++i];
    else if (args[i] === '--project') projectPath = args[++i];
    else if (args[i] === '--tool-use-id') toolUseId = args[++i];
  }
  if (!sessionId) {
    console.error('ERROR: --session-id is required.');
    console.error('       Pass it as --session-id <id>, or set $LER_SESSION_ID / $CLAUDE_SESSION_ID.');
    process.exit(2);
  }
  if (!intent) {
    console.error('ERROR: --intent is required.');
    console.error('       Pass it as --intent "<text>", or set $LER_INTENT.');
    console.error('       Describe WHY this import is running — e.g. "nightly brent-oil refresh".');
    process.exit(2);
  }
  opts.audit = { sessionId, intent, projectPath: projectPath || process.cwd(), toolUseId, actor: `importer:${sessionId}` };
  run(opts).then(stats => {
    console.log(JSON.stringify(stats, null, 2));
  }).catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}
