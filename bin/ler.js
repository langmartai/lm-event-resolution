#!/usr/bin/env node
const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { db, nodes, edges, sources, updates, search, graph } = require('../lib');

const program = new Command();

program
  .name('ler')
  .description('lm-event-resolution — local SQLite event/relationship repository with FTS search')
  .option('--db <path>', 'Path to SQLite database file (overrides $LER_DB)')
  .option('--session-id <id>', 'Claude Code session id (REQUIRED for mutating commands; falls back to $LER_SESSION_ID or $CLAUDE_SESSION_ID)')
  .option('--project <path>', 'Originating project / cwd to record in the audit log')
  .option('--tool-use-id <id>', 'Tool-use correlation id (optional)')
  .hook('preAction', (cmd) => {
    const opts = cmd.optsWithGlobals();
    if (opts.db) process.env.LER_DB = path.resolve(opts.db);
  });

// Mutating commands MUST identify the Claude Code session that operates them.
// Resolution order: --session-id flag → $LER_SESSION_ID → $CLAUDE_SESSION_ID.
// If unset, the command exits non-zero. This applies even to scripted callers
// (e.g. the importer) — every change goes into the audit log with attribution.
function resolveAuditContext(cmd, { required = true } = {}) {
  const opts = cmd.optsWithGlobals();
  const sessionId = opts.sessionId || process.env.LER_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  if (required && (!sessionId || !sessionId.trim())) {
    console.error('ERROR: --session-id is required for this command.');
    console.error('       Provide it via --session-id <id>, $LER_SESSION_ID, or $CLAUDE_SESSION_ID.');
    console.error('       Every mutation is recorded against the originating Claude Code session.');
    process.exit(2);
  }
  return {
    sessionId,
    projectPath: opts.project || process.env.LER_PROJECT_PATH || process.cwd(),
    toolUseId: opts.toolUseId || process.env.LER_TOOL_USE_ID || null,
    actor: opts.actor || `cli:${sessionId || 'anon'}`,
  };
}

// ----- init / migrate -----
program.command('init')
  .description('Initialize / migrate the database')
  .action(() => {
    db.open();
    const applied = db.migrate();
    console.log(`Migrations applied: ${applied}`);
    console.log(`Database: ${db.open().name}`);
  });

// ----- node -----
const node = program.command('node').description('Manage nodes (events, sub-factors, drivers, monitors, scenarios, outcomes, factors)');

node.command('add')
  .description('Create a node')
  .requiredOption('--uid <uid>', 'Stable unique ID')
  .requiredOption('--type <type>', 'Node type: event | factor | sub_factor | driver | monitor | scenario | outcome')
  .requiredOption('--name <name>', 'Display name')
  .option('--asset <slug>', 'Asset slug (e.g. brent-oil)')
  .option('--body <md>', 'Markdown body (or use --body-file)')
  .option('--body-file <path>', 'Read markdown body from file')
  .option('--status <s>', 'active | confirmed | registered | projected | invalidated | superseded | resolved | pending', 'active')
  .option('--certainty <l>', 'L1 | L2 | L3 | L4 | L5')
  .option('--significance <s>', 'high | medium | low')
  .option('--direction <d>', 'bullish | bearish | neutral')
  .option('--magnitude <m>', 'major | moderate | minor')
  .option('--temporal <t>', 'past | present | future')
  .option('--valid-from <date>', 'ISO date — temporal validity start')
  .option('--valid-to <date>', 'ISO date — temporal validity end')
  .option('--occurred-at <iso>', 'ISO datetime — when event occurred')
  .option('--eta-date <date>', 'ISO date — expected resolution date')
  .option('--props <json>', 'JSON object of extra props')
  .option('--reason <text>', 'Reason for the change (audit log)')
  .option('--actor <name>', 'Actor label (audit log; defaults to cli:<sessionId>)')
  .action(function (opts) {
    const audit = resolveAuditContext(this);
    const body_md = opts.bodyFile ? fs.readFileSync(opts.bodyFile, 'utf8') : opts.body;
    const props = opts.props ? JSON.parse(opts.props) : undefined;
    const created = nodes.create({
      uid: opts.uid, type: opts.type, name: opts.name, asset: opts.asset,
      body_md, status: opts.status, certainty: opts.certainty,
      significance: opts.significance, direction: opts.direction, magnitude: opts.magnitude,
      temporal: opts.temporal, valid_from: opts.validFrom, valid_to: opts.validTo,
      occurred_at: opts.occurredAt, eta_date: opts.etaDate, props,
    }, { ...audit, reason: opts.reason });
    console.log(JSON.stringify(created, null, 2));
  });

node.command('get <ref>')
  .description('Fetch a node by id or uid')
  .action((ref) => {
    const n = nodes.getByIdOrUid(ref);
    if (!n) { console.error('Not found'); process.exit(1); }
    console.log(JSON.stringify(n, null, 2));
  });

node.command('update <ref>')
  .description('Update fields on a node')
  .option('--name <name>')
  .option('--body <md>')
  .option('--body-file <path>')
  .option('--status <s>')
  .option('--certainty <l>')
  .option('--significance <s>')
  .option('--direction <d>')
  .option('--magnitude <m>')
  .option('--temporal <t>')
  .option('--valid-from <date>')
  .option('--valid-to <date>')
  .option('--occurred-at <iso>')
  .option('--eta-date <date>')
  .option('--props <json>')
  .option('--reason <text>')
  .option('--actor <name>')
  .action(function (ref, opts) {
    const audit = resolveAuditContext(this);
    const patch = {};
    if (opts.name) patch.name = opts.name;
    if (opts.body) patch.body_md = opts.body;
    if (opts.bodyFile) patch.body_md = fs.readFileSync(opts.bodyFile, 'utf8');
    if (opts.status) patch.status = opts.status;
    if (opts.certainty) patch.certainty = opts.certainty;
    if (opts.significance) patch.significance = opts.significance;
    if (opts.direction) patch.direction = opts.direction;
    if (opts.magnitude) patch.magnitude = opts.magnitude;
    if (opts.temporal) patch.temporal = opts.temporal;
    if (opts.validFrom) patch.valid_from = opts.validFrom;
    if (opts.validTo) patch.valid_to = opts.validTo;
    if (opts.occurredAt) patch.occurred_at = opts.occurredAt;
    if (opts.etaDate) patch.eta_date = opts.etaDate;
    if (opts.props) patch.props = JSON.parse(opts.props);
    const updated = nodes.update(ref, patch, { ...audit, reason: opts.reason });
    console.log(JSON.stringify(updated, null, 2));
  });

node.command('status <ref> <new_status>')
  .description('Set status: active | invalidated | superseded | resolved | confirmed | projected | registered | pending')
  .option('--reason <text>')
  .option('--actor <name>')
  .action(function (ref, newStatus, opts) {
    const audit = resolveAuditContext(this);
    const updated = nodes.setStatus(ref, newStatus, { ...audit, reason: opts.reason });
    console.log(`${updated.uid}: status → ${updated.status}`);
  });

node.command('list')
  .description('List nodes')
  .option('--type <t>')
  .option('--asset <a>')
  .option('--status <s>')
  .option('--limit <n>', '', '50')
  .option('--format <fmt>', 'table | json', 'table')
  .action((opts) => {
    const rows = nodes.list({
      type: opts.type, asset: opts.asset, status: opts.status,
      limit: Number(opts.limit),
    });
    if (opts.format === 'json') {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (!rows.length) { console.log('(no rows)'); return; }
    console.log('ID  TYPE         STATUS        ASSET           UID');
    console.log('--  -----------  ------------  --------------  -----');
    for (const r of rows) {
      console.log([
        String(r.id).padStart(2),
        (r.type || '').padEnd(11),
        (r.status || '').padEnd(12),
        (r.asset || '-').padEnd(14),
        r.uid,
      ].join('  '));
    }
  });

node.command('remove <ref>')
  .description('Delete a node (audit-logged)')
  .option('--reason <text>')
  .option('--actor <name>')
  .action(function (ref, opts) {
    const audit = resolveAuditContext(this);
    const ok = nodes.remove(ref, { ...audit, reason: opts.reason });
    console.log(ok ? 'deleted' : 'not found');
  });

// ----- edge -----
const edge = program.command('edge').description('Manage edges (typed relationships)');

edge.command('link <src> <dst> <type>')
  .description('Link two nodes. type: derives_from | supports | contradicts | supersedes | gates | resolves_to | monitors | parent_of | projects_to | causes | depends_on | cross_refs')
  .option('--weight <n>')
  .option('--props <json>')
  .option('--reason <text>')
  .option('--actor <name>')
  .action(function (src, dst, type, opts) {
    const audit = resolveAuditContext(this);
    const e = edges.link(src, dst, type, {
      ...audit,
      weight: opts.weight,
      props: opts.props ? JSON.parse(opts.props) : undefined,
      reason: opts.reason,
    });
    console.log(JSON.stringify(e, null, 2));
  });

edge.command('unlink <src> <dst> <type>')
  .description('Remove an edge')
  .option('--reason <text>')
  .option('--actor <name>')
  .action(function (src, dst, type, opts) {
    const audit = resolveAuditContext(this);
    const ok = edges.unlink(src, dst, type, { ...audit, reason: opts.reason });
    console.log(ok ? 'unlinked' : 'edge not found');
  });

edge.command('list <ref>')
  .description('List edges in or out of a node')
  .option('--dir <d>', 'out | in | both', 'both')
  .option('--type <t>')
  .action((ref, opts) => {
    const out = ['out', 'both'].includes(opts.dir) ? edges.listOut(ref, { type: opts.type }) : [];
    const inc = ['in', 'both'].includes(opts.dir) ? edges.listIn(ref, { type: opts.type }) : [];
    console.log(JSON.stringify({ out, in: inc }, null, 2));
  });

// ----- source -----
const source = program.command('source').description('Manage sources (citations)');

source.command('add')
  .requiredOption('--citation <text>')
  .option('--url <url>')
  .option('--type <t>', 'news | official | agency | llm-search | api | analyst')
  .option('--trust <n>', '1-5')
  .option('--notes <text>')
  .action(function (opts) {
    const audit = resolveAuditContext(this);
    const s = sources.upsert({
      citation: opts.citation, url: opts.url,
      source_type: opts.type, trust_level: opts.trust, notes: opts.notes,
    }, audit);
    console.log(JSON.stringify(s, null, 2));
  });

source.command('attach <node_ref> <source_id>')
  .description('Attach a source to a node with optional evidence quote')
  .option('--evidence <text>')
  .action(function (nodeRef, sourceId, opts) {
    const audit = resolveAuditContext(this);
    const link = sources.attach(nodeRef, Number(sourceId), { ...audit, evidence: opts.evidence });
    console.log(link ? JSON.stringify(link, null, 2) : 'already attached');
  });

source.command('list')
  .option('--type <t>')
  .action((opts) => {
    const rows = sources.list({ source_type: opts.type });
    console.log(JSON.stringify(rows, null, 2));
  });

// ----- search -----
program.command('search <query>')
  .description('Full-text search across nodes')
  .option('--type <t>')
  .option('--asset <a>')
  .option('--status <s>')
  .option('--limit <n>', '', '20')
  .action((query, opts) => {
    const hits = search.search(query, {
      type: opts.type, asset: opts.asset, status: opts.status,
      limit: Number(opts.limit),
    });
    if (!hits.length) { console.log('(no matches)'); return; }
    for (const h of hits) {
      console.log(`\n[${h.type} | ${h.status} | score=${h.score.toFixed(2)}]  ${h.uid}`);
      console.log(`  ${h.name}`);
      if (h.snippet) console.log(`  …${h.snippet.replace(/<mark>/g, '«').replace(/<\/mark>/g, '»')}…`);
    }
  });

// ----- graph -----
program.command('graph <ref>')
  .description('Show the neighborhood of a node (incoming + outgoing edges)')
  .option('--depth <n>', '', '2')
  .option('--types <list>', 'comma-separated edge types to follow')
  .action((ref, opts) => {
    const types = opts.types ? opts.types.split(',').map(s => s.trim()) : undefined;
    const result = graph.fetchNeighborhood(ref, { depth: Number(opts.depth), types });
    console.log(JSON.stringify(result, null, 2));
  });

program.command('deps <ref>')
  .description('Render the dependency chain rooted at a node')
  .action((ref) => {
    const tree = graph.dependencyChain(ref);
    if (!tree) { console.error('Not found'); process.exit(1); }
    function render(n, depth = 0) {
      const indent = '  '.repeat(depth);
      const tag = n.edge_type ? ` <${n.edge_type}>` : '';
      console.log(`${indent}- [${n.type}] ${n.name}${tag}  (${n.uid})`);
      for (const c of n.children || []) render(c, depth + 1);
    }
    render(tree);
  });

// ----- updates -----
program.command('history <ref>')
  .description('Show update audit trail for a node')
  .option('--limit <n>', '', '50')
  .action((ref, opts) => {
    const n = nodes.getByIdOrUid(ref);
    if (!n) { console.error('Not found'); process.exit(1); }
    const rows = updates.listForEntity('node', n.id).slice(0, Number(opts.limit));
    for (const r of rows) {
      console.log(`\n[${r.created_at}] ${r.change_type} by ${r.actor || 'unknown'}`);
      if (r.reason) console.log(`  reason: ${r.reason}`);
      if (r.before && r.after) {
        const diff = diffObjects(r.before, r.after);
        for (const [k, v] of Object.entries(diff)) {
          console.log(`  ${k}: ${truncate(v.before)} → ${truncate(v.after)}`);
        }
      } else if (!r.before && r.after) {
        console.log(`  status: ${r.after.status}  type: ${r.after.type}`);
      }
    }
  });

function diffObjects(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const av = (a || {})[k];
    const bv = (b || {})[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) out[k] = { before: av, after: bv };
  }
  return out;
}

function truncate(v) {
  if (v == null) return '(null)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

// ----- importer -----
program.command('import-lmut <analyses_dir>')
  .description('Import lm-unified-trade analyses/{asset}/{date}/fundamental into the repo. Requires a session id even from scripted callers — the importer is operated BY a Claude Code session, and that session is recorded against every row it creates.')
  .option('--asset <slug>', 'Restrict to a single asset')
  .option('--date <YYYY-MM-DD>', 'Restrict to a single date')
  .option('--dry-run', 'Report what would be imported, do not write')
  .action(async function (analysesDir, opts) {
    const audit = resolveAuditContext(this);
    const importer = require('../scripts/import-lmut');
    const stats = await importer.run({
      analysesDir: path.resolve(analysesDir),
      asset: opts.asset, date: opts.date, dryRun: !!opts.dryRun,
      audit,
    });
    console.log(JSON.stringify(stats, null, 2));
  });

// ----- serve -----
program.command('serve')
  .description('Start the HTTP server + web UI')
  .option('--port <n>', '', '4100')
  .action((opts) => {
    process.env.LER_PORT = opts.port;
    require('../server/server');
  });

program.parseAsync(process.argv).catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
