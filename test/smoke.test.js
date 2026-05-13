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
  }, { actor: 'test' });
  assert.equal(n.uid, 'test:event:1');
  const h = updates.listForEntity('node', n.id);
  assert.equal(h.length, 1);
  assert.equal(h[0].change_type, 'create');
});

test('status change is audited as status_change', () => {
  const n = nodes.create({
    uid: 'test:event:2', type: 'event', name: 'Iran V1 proposal',
  }, { actor: 'test' });
  nodes.setStatus(n.uid, 'invalidated', { actor: 'test', reason: 'Trump rejected May 2' });
  const h = updates.listForEntity('node', n.id);
  assert.equal(h.length, 2);
  assert.equal(h[0].change_type, 'status_change');
  assert.equal(h[0].after.status, 'invalidated');
});

test('edge link + traverse', () => {
  const e1 = nodes.create({ uid: 'test:event:3', type: 'event', name: 'Bombing' });
  const sf = nodes.create({ uid: 'test:sub:1', type: 'sub_factor', name: 'IRGC mine arsenal intact' });
  const dr = nodes.create({ uid: 'test:drv:1', type: 'driver', name: 'RD-test' });

  edges.link(sf.uid, e1.uid, 'derives_from', { actor: 'test' });
  edges.link(sf.uid, dr.uid, 'supports', { weight: 0.4, actor: 'test' });

  const out = edges.listOut(sf.uid);
  assert.equal(out.length, 2);
  const nbh = graph.fetchNeighborhood(sf.uid, { depth: 2 });
  assert.ok(nbh.nodes.length >= 3);
  assert.ok(nbh.edges.length >= 2);
});

test('sources upsert + attach', () => {
  const n = nodes.create({ uid: 'test:event:4', type: 'event', name: 'CPI release' });
  const s = sources.upsert({
    citation: 'BLS May 12 2026', source_type: 'agency', trust_level: 5,
  });
  sources.attach(n.uid, s.id, { evidence: '3.8% YoY headline' });
  const list = sources.listForNode(n.uid);
  assert.equal(list.length, 1);
  assert.equal(list[0].evidence, '3.8% YoY headline');
});

test('FTS5 search hits markdown body', () => {
  nodes.create({
    uid: 'test:event:5', type: 'event', name: 'Brent rally',
    body_md: 'Brent traded up 2.9% on Hormuz tail re-pricing.',
  });
  const hits = search.search('hormuz');
  const found = hits.find(h => h.uid === 'test:event:5');
  assert.ok(found, 'expected to find test:event:5 in search results');
});

test('FTS5 type filter works', () => {
  const hits = search.search('hormuz', { type: 'driver' });
  for (const h of hits) assert.equal(h.type, 'driver');
});

test('cleanup', () => {
  db.close();
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
  for (const ext of ['-wal', '-shm', '-journal']) {
    const p = tmpDb + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});
