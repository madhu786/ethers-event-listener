'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventStore } = require('../src/store');
const { createApp } = require('../src/server');

let server;
let base;

before(async () => {
  const store = new EventStore();
  store.add({
    eventName: 'Transfer',
    signature: 'Transfer(address,address,uint256)',
    address: '0x00000000000000000000000000000000000000AA',
    blockNumber: 100,
    blockHash: '0xblock',
    transactionHash: '0xtx1',
    logIndex: 0,
    args: { value: '10' },
  });
  store.add({
    eventName: 'Approval',
    signature: 'Approval(address,address,uint256)',
    address: '0x00000000000000000000000000000000000000AA',
    blockNumber: 101,
    blockHash: '0xblock',
    transactionHash: '0xtx2',
    logIndex: 0,
    args: { value: '5' },
  });
  server = createApp(store).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('GET /health reports ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /events lists all events and honours the eventName filter', async () => {
  const all = await (await fetch(`${base}/events`)).json();
  assert.equal(all.total, 2);
  const transfers = await (await fetch(`${base}/events?eventName=Transfer`)).json();
  assert.equal(transfers.total, 1);
  assert.equal(transfers.events[0].eventName, 'Transfer');
});

test('GET /events/:id returns one record and 404s on unknown ids', async () => {
  const one = await fetch(`${base}/events/1`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).eventName, 'Transfer');
  const missing = await fetch(`${base}/events/999`);
  assert.equal(missing.status, 404);
});

test('GET /stats summarises the store', async () => {
  const stats = await (await fetch(`${base}/stats`)).json();
  assert.equal(stats.count, 2);
  assert.deepEqual(stats.byEvent, { Transfer: 1, Approval: 1 });
  assert.equal(stats.firstBlock, 100);
  assert.equal(stats.lastBlock, 101);
});

test('unknown routes 404 as JSON', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not found');
});
