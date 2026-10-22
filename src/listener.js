'use strict';

const { Interface } = require('ethers');

/**
 * Decodes raw logs for one contract into plain, JSON-safe records and
 * writes them to an EventStore.
 *
 * The listener talks to any object with the small provider surface it
 * uses (`getLogs`, `getBlockNumber`, `on`/`off`), which is exactly the
 * surface ethers providers expose — and exactly what a test double needs
 * to implement. No network is required to decode or ingest logs.
 *
 * Arguments that are not JSON-native (bigint, Addressable objects) are
 * normalised: bigints become decimal strings so records survive
 * JSON.stringify unchanged.
 */
function normaliseValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normaliseValue);
  return value;
}

class EventListener {
  /**
   * @param {object} opts
   * @param {object} opts.provider  ethers provider (or compatible double)
   * @param {string} opts.address   contract address to watch
   * @param {string[]|object} opts.abi  ABI fragments, or an ethers Interface
   * @param {import('./store').EventStore} opts.store
   */
  constructor({ provider, address, abi, store }) {
    if (!provider) throw new TypeError('provider is required');
    if (!address) throw new TypeError('address is required');
    if (!store) throw new TypeError('store is required');
    this.provider = provider;
    this.address = address;
    this.store = store;
    this.iface = abi instanceof Interface ? abi : new Interface(abi);
    this._subscriptions = [];
  }

  /**
   * Decode one raw log. Returns a plain record, or `null` when the log
   * does not match any event in the ABI (foreign log in the same block /
   * transaction) — mirroring `Interface.parseLog` semantics.
   */
  decodeLog(log) {
    let parsed = null;
    try {
      parsed = this.iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      return null;
    }
    if (!parsed) return null;

    const args = {};
    parsed.fragment.inputs.forEach((input, i) => {
      const name = input.name || `arg${i}`;
      args[name] = normaliseValue(parsed.args[i]);
    });

    return {
      eventName: parsed.name,
      signature: parsed.signature,
      address: log.address || this.address,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash ?? null,
      transactionHash: log.transactionHash,
      logIndex: log.index ?? log.logIndex,
      args,
    };
  }

  /**
   * Decode and store a batch of raw logs. Returns counts so callers can
   * log progress honestly: { stored, duplicates, skipped }.
   */
  ingestLogs(logs) {
    let stored = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const log of logs) {
      const decoded = this.decodeLog(log);
      if (!decoded) {
        skipped += 1;
        continue;
      }
      if (this.store.add(decoded)) stored += 1;
      else duplicates += 1;
    }
    return { stored, duplicates, skipped };
  }

  /**
   * One polling pass over [fromBlock, toBlock]. Returns the ingest counts
   * plus the range scanned, so the caller can advance its cursor only
   * after a successful pass.
   */
  async pollOnce(fromBlock, toBlock) {
    const logs = await this.provider.getLogs({
      address: this.address,
      fromBlock,
      toBlock,
    });
    return { fromBlock, toBlock, ...this.ingestLogs(logs) };
  }

  /**
   * Subscribe to live events via the provider (WebSocket subscriptions
   * when the provider supports them, polling under the hood in ethers
   * otherwise). Each delivered log is decoded and stored.
   * Returns an unsubscribe function.
   */
  subscribe(eventNames) {
    const names = eventNames && eventNames.length ? eventNames : [null];
    const unsubscribers = names.map((name) => {
      const filter = name ? { address: this.address, topics: [this.iface.getEvent(name).topicHash] } : { address: this.address };
      const handler = (log) => this.ingestLogs([log]);
      this.provider.on(filter, handler);
      const off = () => this.provider.off(filter, handler);
      this._subscriptions.push(off);
      return off;
    });
    return () => unsubscribers.forEach((off) => off());
  }

  stop() {
    this._subscriptions.forEach((off) => off());
    this._subscriptions = [];
  }
}

module.exports = { EventListener };
