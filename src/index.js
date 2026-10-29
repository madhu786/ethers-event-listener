'use strict';

/**
 * Entry point: wire a provider, an EventListener and the REST API.
 *
 * Configuration (environment):
 *   RPC_URL           JSON-RPC (http) or WebSocket (ws) endpoint — required
 *   CONTRACT_ADDRESS  contract to watch — required
 *   CONTRACT_ABI      path to a JSON ABI file — required
 *   FROM_BLOCK        first block to backfill (default: latest block)
 *   POLL_INTERVAL_MS  polling cadence when not subscribed (default 5000)
 *   PORT              API port (default 3000)
 *   DATABASE_PATH     SQLite file for persistent storage; when unset the
 *                     store is in-memory and a restart re-backfills
 *                     (see src/sqlite-store.js)
 *
 * Flow: backfill [FROM_BLOCK, latest] once, then keep up either by live
 * subscription (WebSocket provider) or by polling passes that advance a
 * block cursor only after a successful scan.
 */

const fs = require('node:fs');
const { JsonRpcProvider, WebSocketProvider } = require('ethers');
const { EventStore } = require('./store');
const { SqliteEventStore } = require('./sqlite-store');
const { EventListener } = require('./listener');
const { createApp } = require('./server');

function loadConfig(env = process.env) {
  const { RPC_URL, CONTRACT_ADDRESS, CONTRACT_ABI } = env;
  if (!RPC_URL || !CONTRACT_ADDRESS || !CONTRACT_ABI) {
    throw new Error('RPC_URL, CONTRACT_ADDRESS and CONTRACT_ABI are all required (see .env.example)');
  }
  return {
    rpcUrl: RPC_URL,
    address: CONTRACT_ADDRESS,
    abi: JSON.parse(fs.readFileSync(CONTRACT_ABI, 'utf8')),
    fromBlock: env.FROM_BLOCK ? Number(env.FROM_BLOCK) : null,
    pollIntervalMs: env.POLL_INTERVAL_MS ? Number(env.POLL_INTERVAL_MS) : 5000,
    port: env.PORT ? Number(env.PORT) : 3000,
    databasePath: env.DATABASE_PATH || null,
  };
}

function createProvider(rpcUrl) {
  return rpcUrl.startsWith('ws') ? new WebSocketProvider(rpcUrl) : new JsonRpcProvider(rpcUrl);
}

async function main() {
  const config = loadConfig();
  const provider = createProvider(config.rpcUrl);
  const store = config.databasePath
    ? new SqliteEventStore({ path: config.databasePath })
    : new EventStore();
  const listener = new EventListener({
    provider,
    address: config.address,
    abi: config.abi,
    store,
  });

  const latest = await provider.getBlockNumber();
  const fromBlock = config.fromBlock ?? latest;
  const backfill = await listener.pollOnce(fromBlock, latest);
  console.log(
    `backfill blocks ${backfill.fromBlock}-${backfill.toBlock}: ` +
      `${backfill.stored} stored, ${backfill.duplicates} duplicates, ${backfill.skipped} skipped`,
  );

  let cursor = latest + 1;
  const timer = setInterval(async () => {
    try {
      const head = await provider.getBlockNumber();
      if (head < cursor) return;
      const pass = await listener.pollOnce(cursor, head);
      cursor = head + 1;
      console.log(`poll ${pass.fromBlock}-${pass.toBlock}: ${pass.stored} stored`);
    } catch (err) {
      // Keep the cursor where it is: the failed range is retried next tick.
      console.error('poll failed, will retry:', err.message);
    }
  }, config.pollIntervalMs);

  const app = createApp(store);
  const server = app.listen(config.port, () => {
    console.log(`ethers-event-listener API on http://localhost:${config.port}`);
  });

  const shutdown = () => {
    clearInterval(timer);
    listener.stop();
    server.close(() => {
      if (typeof store.close === 'function') store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { loadConfig, createProvider };
