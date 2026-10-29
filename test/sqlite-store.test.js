'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteEventStore } = require('../src/sqlite-store');

function record(overrides = {}) {
  return {
    eventName: 'Transfer',
    signature: 'Transfer(address,address,uint256)',
    address: '0x00000000000000000000000000000000000000AA',
    blockNumber: 100,
    blockHash: '0xblock',
    transactionHash: '0xtx1',
    logIndex: 0,
    args: { value: '10' },
    ...overrides,
  };
}

const tmpFiles = [];
after(() => {
  for (const file of tmpFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already removed or never created; nothing to clean up.
    }
  }
});

function tmpPath() {
  const file = path.join(os.tmpdir(), `eel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tmpFiles.push(file);
  return file;
}

test('add stores a record and de-duplicates on transactionHash + logIndex', () => {
  const store = new SqliteEventStore();
  const first = store.add(record());
  assert.equal(first.id, 1);
  assert.equal(first.key, '0xtx1:0');
  assert.equal(store.add(record()), null);
  assert.ok(store.add(record({ logIndex: 1 })));
  assert.equal(store.stats().count, 2);
  store.close();
});

test('add rejects records without transactionHash or logIndex', () => {
  const store = new SqliteEventStore();
  assert.throws(() => store.add({ logIndex: 0 }), TypeError);
  assert.throws(() => store.add({ transactionHash: '0x1' }), TypeError);
  store.close();
});

test('file-backed store survives close and reopen, including de-duplication', () => {
  const file = tmpPath();
  const first = new SqliteEventStore({ path: file });
  first.add(record());
  first.add(record({ transactionHash: '0xtx2', eventName: 'Approval', blockNumber: 101 }));
  first.close();

  const reopened = new SqliteEventStore({ path: file });
  assert.equal(reopened.stats().count, 2);
  assert.equal(reopened.getById(1).eventName, 'Transfer');
  // A re-delivered log after restart is still a duplicate, not a second row.
  assert.equal(reopened.add(record()), null);
  assert.equal(reopened.stats().count, 2);
  reopened.close();
});

test('query filters, orders by chain order and paginates like the in-memory store', () => {
  const store = new SqliteEventStore();
  store.add(record({ transactionHash: '0xb', blockNumber: 102 }));
  store.add(record({ transactionHash: '0xa', blockNumber: 100 }));
  store.add(record({ transactionHash: '0xc', eventName: 'Approval', blockNumber: 101 }));

  assert.equal(store.query({ eventName: 'Approval' }).total, 1);
  assert.equal(store.query({ address: '0x00000000000000000000000000000000000000aa' }).total, 3);
  assert.equal(store.query({ fromBlock: 101, toBlock: 101 }).total, 1);
  const page = store.query({ limit: 1, offset: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.events[0].blockNumber, 100);
  assert.equal(store.query({ limit: 1, offset: 1 }).events[0].blockNumber, 101);
  store.close();
});

test('stats reports counts by event and block range; empty store is null-ranged', () => {
  const store = new SqliteEventStore();
  assert.deepEqual(store.stats(), { count: 0, byEvent: {}, firstBlock: null, lastBlock: null });
  store.add(record());
  store.add(record({ transactionHash: '0xtx2', blockNumber: 99 }));
  assert.deepEqual(store.stats(), {
    count: 2,
    byEvent: { Transfer: 2 },
    firstBlock: 99,
    lastBlock: 100,
  });
  store.close();
});

test('clear empties the store and resets ids', () => {
  const store = new SqliteEventStore();
  store.add(record());
  store.clear();
  assert.deepEqual(store.stats(), { count: 0, byEvent: {}, firstBlock: null, lastBlock: null });
  assert.equal(store.add(record()).id, 1);
  store.close();
});

test('args round-trip through JSON storage unchanged', () => {
  const store = new SqliteEventStore();
  const stored = store.add(record({ args: { from: '0xabc', value: '12345678901234567890', nested: [1, '2'] } }));
  assert.deepEqual(store.getById(stored.id).args, { from: '0xabc', value: '12345678901234567890', nested: [1, '2'] });
  store.close();
});
