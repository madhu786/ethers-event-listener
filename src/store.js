'use strict';

/**
 * In-memory store for decoded contract events.
 *
 * Records are keyed by `${transactionHash}:${logIndex}`, which uniquely
 * identifies a log on-chain, so re-delivered logs (a poll overlapping a
 * subscription, a restart re-scanning a block range) are de-duplicated
 * instead of stored twice.
 *
 * The store is deliberately behind a small class: swapping this for a
 * SQLite/Postgres implementation only requires the same methods
 * (add, getById, query, stats, clear).
 */
class EventStore {
  constructor() {
    this._byId = new Map();
    this._nextId = 1;
  }

  /**
   * Insert a decoded event. Returns the stored record, or `null` when the
   * log was already present (duplicate delivery).
   */
  add(event) {
    if (!event || !event.transactionHash || event.logIndex == null) {
      throw new TypeError('event requires transactionHash and logIndex');
    }
    const key = `${event.transactionHash}:${event.logIndex}`;
    if (this._byId.has(key)) return null;

    const record = { id: this._nextId++, key, ...event };
    this._byId.set(key, record);
    return record;
  }

  getById(id) {
    for (const record of this._byId.values()) {
      if (record.id === Number(id)) return record;
    }
    return null;
  }

  /**
   * Query stored events. Filters are all optional and combine with AND:
   *  - eventName: exact decoded event name, e.g. "Transfer"
   *  - address:   emitting contract address (case-insensitive)
   *  - fromBlock / toBlock: inclusive block-number range
   * Results are ordered by (blockNumber, logIndex) — chain order — and
   * paginated with `limit` (default 100, max 500) and `offset`.
   */
  query({ eventName, address, fromBlock, toBlock, limit = 100, offset = 0 } = {}) {
    const wantedAddress = address ? address.toLowerCase() : null;
    const matches = [];
    for (const record of this._byId.values()) {
      if (eventName && record.eventName !== eventName) continue;
      if (wantedAddress && (!record.address || record.address.toLowerCase() !== wantedAddress)) continue;
      if (fromBlock != null && record.blockNumber < Number(fromBlock)) continue;
      if (toBlock != null && record.blockNumber > Number(toBlock)) continue;
      matches.push(record);
    }
    matches.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return { total: matches.length, events: matches.slice(safeOffset, safeOffset + safeLimit) };
  }

  stats() {
    const byEvent = {};
    let firstBlock = null;
    let lastBlock = null;
    for (const record of this._byId.values()) {
      byEvent[record.eventName] = (byEvent[record.eventName] || 0) + 1;
      if (firstBlock === null || record.blockNumber < firstBlock) firstBlock = record.blockNumber;
      if (lastBlock === null || record.blockNumber > lastBlock) lastBlock = record.blockNumber;
    }
    return { count: this._byId.size, byEvent, firstBlock, lastBlock };
  }

  clear() {
    this._byId.clear();
    this._nextId = 1;
  }
}

module.exports = { EventStore };
