'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const { EventListener } = require('../src/listener');
const { EventStore } = require('../src/store');

const ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];
const CONTRACT = '0x00000000000000000000000000000000000000AA';
const FROM = '0x0000000000000000000000000000000000000001';
const TO = '0x0000000000000000000000000000000000000002';

function makeLog(iface, name, args, overrides = {}) {
  const encoded = iface.encodeEventLog(iface.getEvent(name), args);
  return {
    address: CONTRACT,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 100,
    blockHash: '0xblock100',
    transactionHash: '0xtx1',
    index: 0,
    ...overrides,
  };
}

function fakeProvider(logs) {
  return {
    calls: [],
    async getLogs(filter) {
      this.calls.push(filter);
      return logs.filter(
        (log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock,
      );
    },
    on() {},
    off() {},
  };
}

test('decodeLog parses a Transfer log into a JSON-safe record', () => {
  const iface = new Interface(ABI);
  const listener = new EventListener({ provider: fakeProvider([]), address: CONTRACT, abi: ABI, store: new EventStore() });
  const decoded = listener.decodeLog(makeLog(iface, 'Transfer', [FROM, TO, 2500n]));
  assert.equal(decoded.eventName, 'Transfer');
  assert.equal(decoded.args.from, FROM);
  assert.equal(decoded.args.to, TO);
  assert.equal(decoded.args.value, '2500'); // bigint normalised to string
  assert.equal(decoded.logIndex, 0);
  assert.doesNotThrow(() => JSON.stringify(decoded));
});

test('decodeLog returns null for a log that does not match the ABI', () => {
  const other = new Interface(['event Paused(address account)']);
  const listener = new EventListener({ provider: fakeProvider([]), address: CONTRACT, abi: ABI, store: new EventStore() });
  const foreign = makeLog(other, 'Paused', [FROM]);
  assert.equal(listener.decodeLog(foreign), null);
});

test('ingestLogs counts stored, duplicates and skipped', () => {
  const iface = new Interface(ABI);
  const store = new EventStore();
  const listener = new EventListener({ provider: fakeProvider([]), address: CONTRACT, abi: ABI, store });
  const transfer = makeLog(iface, 'Transfer', [FROM, TO, 1n]);
  const foreign = makeLog(new Interface(['event Paused(address account)']), 'Paused', [FROM], { transactionHash: '0xtx9' });

  assert.deepEqual(listener.ingestLogs([transfer, foreign]), { stored: 1, duplicates: 0, skipped: 1 });
  assert.deepEqual(listener.ingestLogs([transfer]), { stored: 0, duplicates: 1, skipped: 0 });
  assert.equal(store.stats().count, 1);
});

test('pollOnce queries the requested range and stores matching logs', async () => {
  const iface = new Interface(ABI);
  const inRange = makeLog(iface, 'Approval', [FROM, TO, 7n], { blockNumber: 101, transactionHash: '0xtx2' });
  const outOfRange = makeLog(iface, 'Transfer', [FROM, TO, 7n], { blockNumber: 140, transactionHash: '0xtx3' });
  const provider = fakeProvider([inRange, outOfRange]);
  const store = new EventStore();
  const listener = new EventListener({ provider, address: CONTRACT, abi: ABI, store });

  const result = await listener.pollOnce(100, 110);
  assert.deepEqual(
    { fromBlock: result.fromBlock, toBlock: result.toBlock, stored: result.stored },
    { fromBlock: 100, toBlock: 110, stored: 1 },
  );
  assert.equal(provider.calls[0].address, CONTRACT);
  assert.equal(store.query({ eventName: 'Approval' }).total, 1);
});

test('constructor requires provider, address and store', () => {
  assert.throws(() => new EventListener({ address: CONTRACT, abi: ABI, store: new EventStore() }), TypeError);
  assert.throws(() => new EventListener({ provider: fakeProvider([]), abi: ABI, store: new EventStore() }), TypeError);
  assert.throws(() => new EventListener({ provider: fakeProvider([]), address: CONTRACT, abi: ABI }), TypeError);
});
