'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventStore } = require('../src/store');

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

test('add stores a record and assigns an incrementing id', () => {
  const store = new EventStore();
  const first = store.add(record());
  const second = store.add(record({ transactionHash: '0xtx2' }));
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(store.stats().count, 2);
});

test('add de-duplicates on transactionHash + logIndex', () => {
  const store = new EventStore();
  assert.ok(store.add(record()));
  assert.equal(store.add(record()), null);
  assert.equal(store.stats().count, 1);
  // Same transaction, different log index is a different log.
  assert.ok(store.add(record({ logIndex: 1 })));
});

test('add rejects records without transactionHash or logIndex', () => {
  const store = new EventStore();
  assert.throws(() => store.add({ logIndex: 0 }), TypeError);
  assert.throws(() => store.add({ transactionHash: '0x1' }), TypeError);
});

test('query filters by event name, address (case-insensitive) and block range', () => {
  const store = new EventStore();
  store.add(record());
  store.add(record({ transactionHash: '0xtx2', eventName: 'Approval', blockNumber: 101 }));
  store.add(
    record({
      transactionHash: '0xtx3',
      blockNumber: 105,
      address: '0x00000000000000000000000000000000000000BB',
    }),
  );

  assert.equal(store.query({ eventName: 'Approval' }).total, 1);
  assert.equal(store.query({ address: '0x00000000000000000000000000000000000000aa' }).total, 2);
  assert.equal(store.query({ fromBlock: 101, toBlock: 104 }).total, 1);
});

test('query returns chain order and paginates', () => {
  const store = new EventStore();
  store.add(record({ transactionHash: '0xb', blockNumber: 102 }));
  store.add(record({ transactionHash: '0xa', blockNumber: 100 }));
  const page = store.query({ limit: 1, offset: 0 });
  assert.equal(page.total, 2);
  assert.equal(page.events[0].blockNumber, 100);
  assert.equal(store.query({ limit: 1, offset: 1 }).events[0].blockNumber, 102);
});

test('stats reports counts by event and block range; empty store is null-ranged', () => {
  const store = new EventStore();
  assert.deepEqual(store.stats(), { count: 0, byEvent: {}, firstBlock: null, lastBlock: null });
  store.add(record());
  store.add(record({ transactionHash: '0xtx2', blockNumber: 99 }));
  const stats = store.stats();
  assert.equal(stats.count, 2);
  assert.deepEqual(stats.byEvent, { Transfer: 2 });
  assert.equal(stats.firstBlock, 99);
  assert.equal(stats.lastBlock, 100);
});
