'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * SQLite-backed store for decoded contract events, with the same
 * interface as the in-memory EventStore (add, getById, query, stats,
 * clear) so the two are interchangeable behind EventListener and the
 * REST API.
 *
 * Persistence is the point: with a file path, events survive a restart
 * instead of being re-backfilled from FROM_BLOCK, and the unique key on
 * (transactionHash, logIndex) keeps de-duplication working across
 * restarts exactly as it does within one process.
 *
 * Requires Node 24+ (node:sqlite is built into the runtime — no extra
 * dependency, no native build). `args` are stored as a JSON string so
 * bigint-normalised values round-trip unchanged.
 *
 * @param {object} [opts]
 * @param {string} [opts.path=':memory:']  SQLite file, or ':memory:'
 */
class SqliteEventStore {
  constructor({ path = ':memory:' } = {}) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        eventName TEXT NOT NULL,
        signature TEXT,
        address TEXT,
        blockNumber INTEGER NOT NULL,
        blockHash TEXT,
        transactionHash TEXT NOT NULL,
        logIndex INTEGER NOT NULL,
        args TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_block ON events(blockNumber, logIndex);
      CREATE INDEX IF NOT EXISTS idx_events_name ON events(eventName);
    `);
    this._insert = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (key, eventName, signature, address, blockNumber, blockHash,
         transactionHash, logIndex, args)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._byKey = this.db.prepare('SELECT * FROM events WHERE key = ?');
    this._byId = this.db.prepare('SELECT * FROM events WHERE id = ?');
  }

  static _record(row) {
    if (!row) return null;
    return {
      id: row.id,
      key: row.key,
      eventName: row.eventName,
      signature: row.signature,
      address: row.address,
      blockNumber: row.blockNumber,
      blockHash: row.blockHash,
      transactionHash: row.transactionHash,
      logIndex: row.logIndex,
      args: JSON.parse(row.args),
    };
  }

  /**
   * Insert a decoded event. Returns the stored record, or `null` when the
   * log was already present (duplicate delivery, including across
   * restarts against the same file).
   */
  add(event) {
    if (!event || !event.transactionHash || event.logIndex == null) {
      throw new TypeError('event requires transactionHash and logIndex');
    }
    const key = `${event.transactionHash}:${event.logIndex}`;
    const result = this._insert.run(
      key,
      event.eventName,
      event.signature ?? null,
      event.address ?? null,
      event.blockNumber,
      event.blockHash ?? null,
      event.transactionHash,
      event.logIndex,
      JSON.stringify(event.args ?? {}),
    );
    if (result.changes === 0) return null;
    return SqliteEventStore._record(this._byKey.get(key));
  }

  getById(id) {
    return SqliteEventStore._record(this._byId.get(Number(id)));
  }

  /**
   * Same query semantics as EventStore: optional AND filters, chain
   * order (blockNumber, logIndex), `limit` (default 100, max 500) and
   * `offset` pagination, `{ total, events }` shape.
   */
  query({ eventName, address, fromBlock, toBlock, limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (eventName) {
      clauses.push('eventName = ?');
      params.push(eventName);
    }
    if (address) {
      clauses.push('LOWER(address) = ?');
      params.push(address.toLowerCase());
    }
    if (fromBlock != null) {
      clauses.push('blockNumber >= ?');
      params.push(Number(fromBlock));
    }
    if (toBlock != null) {
      clauses.push('blockNumber <= ?');
      params.push(Number(toBlock));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(...params).n;
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM events ${where} ORDER BY blockNumber ASC, logIndex ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, safeLimit, safeOffset);
    return { total, events: rows.map(SqliteEventStore._record) };
  }

  stats() {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM events').get();
    const byEvent = {};
    for (const row of this.db.prepare('SELECT eventName, COUNT(*) AS n FROM events GROUP BY eventName').all()) {
      byEvent[row.eventName] = row.n;
    }
    const range = this.db.prepare('SELECT MIN(blockNumber) AS firstBlock, MAX(blockNumber) AS lastBlock FROM events').get();
    return { count, byEvent, firstBlock: range.firstBlock, lastBlock: range.lastBlock };
  }

  clear() {
    this.db.exec('DELETE FROM events');
    // Reset the id sequence too, so a cleared store behaves like a fresh one.
    this.db.exec("DELETE FROM sqlite_sequence WHERE name = 'events'");
  }

  close() {
    this.db.close();
  }
}

module.exports = { SqliteEventStore };
