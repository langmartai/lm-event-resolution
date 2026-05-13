// End-to-end smoke test exercising lib/CLI surfaces.
// Uses an isolated temp database so it does not touch data/ler.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const tmpDb = path.join(os.tmpdir(), `ler-smoke-${Date.now()}.db`);
process.env.LER_DB = tmpDb;

const { db, nodes, edges, sources, updates, search, graph } = require('../lib');

test('migration creates schema', () => {
  const applied = db.migrate();
  assert.ok(applied >= 1);
});

test('node create + audit', () => {
  const n = nodes.create({
    uid: 'test:event:1',
    type: 'event', name: 'Hormuz blockade event',
    asset: 'brent-oil', body_md: 'IRGC laid mines.',
    direction: 'bullish', magnitude: 'major',
  }, { actor: 'test', sessionId: 'smoke-test-session', intent: 'smoke test' });
  assert.equal(n.uid, 'test:event:1');
  const h = updates.listForEntity('node', n.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].change_type, 'create');
});

test('status change is audited as status_change', () => {
  const n = nodes.create({
    uid: 'test:event:2', type: 'event', name: 'Iran V1 proposal',
  }, { actor: 'test', sessionId: 'smoke-test-session', intent: 'smoke test' });
  nodes.setStatus(n.uid, 'invalidated', { actor: 'test', sessionId: 'smoke-test-session', intent: 'smoke test', reason: 'Trump rejected May 2' });
  const h = updates.listForEntity('node', n.id);
  assert.equal(h.length, 2);
  assert.equal(h[0].change_type, 'status_change');
  assert.equal(h[0].after.status, 'invalidated');
});

test('edge link + traverse', () => {
  const ctx = { sessionId: 'smoke-test-session', intent: 'smoke test' };
  const e1 = nodes.create({ uid: 'test:event:3', type: 'event', name: 'Bombing' }, ctx);
  const sf = nodes.create({ uid: 'test:sub:1', type: 'sub_factor', name: 'IRGC mine arsenal intact' }, ctx);
  const dr = nodes.create({ uid: 'test:drv:1', type: 'driver', name: 'RD-test' }, ctx);

  edges.link(sf.uid, e1.uid, 'derives_from', { actor: 'test', sessionId: 'smoke-test-session', intent: 'smoke test' });
  edges.link(sf.uid, dr.uid, 'supports', { weight: 0.4, actor: 'test', sessionId: 'smoke-test-session', intent: 'smoke test' });

  const out = edges.listOut(sf.uid);
  assert.equal(out.length, 2);
  const nbh = graph.fetchNeighborhood(sf.uid, { depth: 2 });
  assert.ok(nbh.nodes.length >= 3);
  assert.ok(nbh.edges.length >= 2);
});

test('sources upsert + attach', () => {
  const ctx = { sessionId: 'smoke-test-session', intent: 'smoke test' };
  const n = nodes.create({ uid: 'test:event:4', type: 'event', name: 'CPI release' }, ctx);
  const s = sources.upsert({
    citation: 'BLS May 12 2026', source_type: 'agency', trust_level: 5,
  }, ctx);
  sources.attach(n.uid, s.id, { ...ctx, evidence: '3.8% YoY headline' });
  const list = sources.listForNode(n.uid);
  assert.equal(list.length, 1);
  assert.equal(list[0].evidence, '3.8% YoY headline');
});

test('FTS5 search hits markdown body', () => {
  nodes.create({
    uid: 'test:event:5', type: 'event', name: 'Brent rally',
    body_md: 'Brent traded up 2.9% on Hormuz tail re-pricing.',
  }, { sessionId: 'smoke-test-session', intent: 'smoke test' });
  const hits = search.search('hormuz');
  const found = hits.find(h => h.uid === 'test:event:5');
  assert.ok(found, 'expected to find test:event:5 in search results');
});

test('FTS5 type filter works', () => {
  const hits = search.search('hormuz', { type: 'driver' });
  for (const h of hits) assert.equal(h.type, 'driver');
});

test('session_id is persisted on every mutation', () => {
  const n = nodes.create({
    uid: 'test:session:1', type: 'event', name: 'session-tracked event',
  }, {
    actor: 'test',
    sessionId: 'exec-test-session-42',
    intent: 'session test',
    projectPath: '/tmp/lm-event-resolution',
    toolUseId: 'toolu_xyz',
  });
  nodes.update(n.uid, { status: 'confirmed' }, {
    actor: 'test',
    sessionId: 'exec-test-session-42',
    intent: 'session test',
    projectPath: '/tmp/lm-event-resolution',
  });
  const h = updates.listForEntity('node', n.id);
  assert.equal(h.length, 2);
  for (const row of h) {
    assert.equal(row.session_id, 'exec-test-session-42');
    assert.equal(row.project_path, '/tmp/lm-event-resolution');
    assert.equal(row.intent, 'session test');
  }
});

test('listSessions groups by session_id, returns paginated envelope', () => {
  // Add a second session's activity so we have >1 row to group.
  nodes.create({
    uid: 'test:session:2', type: 'event', name: 'second session event',
  }, {
    actor: 'test', sessionId: 'exec-other-session-99', intent: 'session test',
  });
  const page = updates.listSessions({ limit: 10 });
  assert.ok(Array.isArray(page.items));
  assert.ok(page.total >= 2);
  const seen = new Set(page.items.map(r => r.session_id));
  assert.ok(seen.has('exec-test-session-42'));
  assert.ok(seen.has('exec-other-session-99'));
});

test('listSessions supports sort by update_count desc', () => {
  // Create another mutation on exec-test-session-42 so it has more updates than -99.
  nodes.create({
    uid: 'test:session:3', type: 'event', name: 'third event',
  }, { actor: 'test', sessionId: 'exec-test-session-42', intent: 'session test' });
  const page = updates.listSessions({ sort: 'update_count', order: 'desc' });
  // We can't assert which session is #1 — earlier tests created many nodes
  // under smoke-test-session, so it likely tops the chart. But we CAN assert
  // that exec-test-session-42 (3 updates) comes before exec-other-session-99
  // (1 update) in the sorted output.
  const i42 = page.items.findIndex(r => r.session_id === 'exec-test-session-42');
  const i99 = page.items.findIndex(r => r.session_id === 'exec-other-session-99');
  assert.ok(i42 >= 0 && i99 >= 0, 'both sessions present');
  assert.ok(i42 < i99, `exec-test-session-42 (idx ${i42}) should come before exec-other-session-99 (idx ${i99}) when sorted by update_count desc`);
});

test('listSessionsForNode returns sessions that touched a node', () => {
  // Created in earlier test by exec-test-session-42 + updated by same session
  const n = nodes.getByUid('test:session:1');
  const list = updates.listSessionsForNode(n.id);
  assert.ok(list.length >= 1);
  assert.equal(list[0].session_id, 'exec-test-session-42');
  assert.ok(list[0].touches >= 2);  // create + update
});

test('getSessionDetail returns nodes touched + update timeline', () => {
  const d = updates.getSessionDetail('exec-test-session-42');
  assert.equal(d.session_id, 'exec-test-session-42');
  assert.ok(d.summary.update_count >= 2);
  assert.ok(d.nodes.some(n => n.uid === 'test:session:1'));
  assert.ok(d.updates.every(u => u.session_id === 'exec-test-session-42'));
});

test('GET endpoints do NOT write to updates (no session pollution from reads)', () => {
  // Confirm by comparing update counts before/after a series of reads.
  const beforeCount = db.open().prepare('SELECT COUNT(*) AS n FROM updates').get().n;
  nodes.list({ type: 'event' });
  nodes.getByUid('test:session:1');
  search.search('event');
  updates.listSessions();
  const afterCount = db.open().prepare('SELECT COUNT(*) AS n FROM updates').get().n;
  assert.equal(beforeCount, afterCount, 'reads must not write to updates table');
});

test('mutations WITHOUT intent throw INTENT_REQUIRED', () => {
  assert.throws(() => {
    nodes.create({ uid: 'test:nointent:1', type: 'event', name: 'has session, no intent' },
      { actor: 'test', sessionId: 'sess-x' });
  }, /intent is required/i);
});

test('FTS5 search hits props (search "L1" finds certainty=L1 sub_factors)', () => {
  nodes.create({
    uid: 'test:fts:1', type: 'sub_factor', name: 'certainty test',
    certainty: 'L1', props: { credibility_type: 'physical', evidence: 'arithmetic verified' },
  }, { actor: 'test', sessionId: 'smoke-test-session', intent: 'smoke test' });
  const hits = search.search('L1', { type: 'sub_factor' });
  assert.ok(hits.find(h => h.uid === 'test:fts:1'), 'should find via certainty value');
  // Also: search by evidence text in props
  const hits2 = search.search('arithmetic');
  assert.ok(hits2.find(h => h.uid === 'test:fts:1'), 'should find via props evidence text');
});

test('mutations WITHOUT sessionId throw SESSION_REQUIRED', () => {
  // create
  assert.throws(() => {
    nodes.create({ uid: 'test:nosession:1', type: 'event', name: 'no session' }, { actor: 'test' });
  }, /sessionId is required/i);

  // update — first create a node with session, then attempt update without
  const n = nodes.create({
    uid: 'test:nosession:2', type: 'event', name: 'has session',
  }, { actor: 'test', sessionId: 'sess-tmp', intent: 'session test' });
  assert.throws(() => {
    nodes.update(n.uid, { name: 'changed' }, { actor: 'test' });
  }, /sessionId is required/i);

  // edge link
  const a = nodes.create({ uid: 'test:nosession:3', type: 'event', name: 'a' },
    { actor: 'test', sessionId: 'sess-tmp', intent: 'session test' });
  const b = nodes.create({ uid: 'test:nosession:4', type: 'event', name: 'b' },
    { actor: 'test', sessionId: 'sess-tmp', intent: 'session test' });
  assert.throws(() => {
    edges.link(a.uid, b.uid, 'derives_from', { actor: 'test' });
  }, /sessionId is required/i);

  // source upsert (the audit row write fails when no sessionId)
  assert.throws(() => {
    sources.upsert({ citation: 'X-no-session', source_type: 'news' }, { actor: 'test' });
  }, /sessionId is required/i);
});

test('cleanup', () => {
  db.close();
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
  for (const ext of ['-wal', '-shm', '-journal']) {
    const p = tmpDb + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});
