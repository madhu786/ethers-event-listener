# ethers-event-listener

A small Node.js service that indexes smart-contract events with
[ethers.js](https://docs.ethers.org/v6/): it backfills a block range,
keeps up with new blocks, decodes every log against the contract ABI,
stores the decoded events, and serves them over a small REST API.

Built as a learning-grade indexer core — the pieces a production indexer
(subgraph, custom backend) is made of, without the infrastructure.

## How it works

```
provider (JSON-RPC / WebSocket)
        │  getLogs + polling passes (or live subscription)
        ▼
EventListener ── decodes logs with ethers Interface.parseLog
        │         foreign logs (not in the ABI) are skipped, as parseLog
        │         returns null for them
        ▼
EventStore ───── in-memory, de-duplicated by transactionHash + logIndex,
        │         queryable by event name, address and block range
        ▼
REST API (Express)
  GET /health · GET /stats · GET /events · GET /events/:id
```

Design notes:

- **Decoding is separate from transport.** `EventListener` only needs the
  small provider surface it actually calls (`getLogs`, `getBlockNumber`,
  `on`/`off`), so it is fully testable with a fake provider and synthetic
  logs — no chain, no network.
- **De-duplication is by log identity** (`transactionHash:logIndex`), so
  an overlapping poll and subscription, or a re-scan after a restart,
  never double-stores an event. Ingest reports honest counts:
  `{ stored, duplicates, skipped }`.
- **JSON-safe records.** `bigint` argument values are stored as decimal
  strings, so an event survives `JSON.stringify` exactly as decoded.
- **The polling cursor advances only after a successful pass** — a failed
  range is retried on the next tick instead of being silently skipped.
- **The store is a class, not a global.** `EventStore` is the seam where a
  SQLite/Postgres implementation would slot in behind the same methods.

## Quick start

```bash
npm install
cp .env.example .env   # set RPC_URL, CONTRACT_ADDRESS, CONTRACT_ABI
npm start
```

An ERC-20 ABI (Transfer/Approval) is bundled at
`examples/erc20-abi.json` to watch any ERC-20 token out of the box.

Then:

```bash
curl localhost:3000/stats
curl "localhost:3000/events?eventName=Transfer&fromBlock=19000000&limit=10"
curl localhost:3000/events/1
```

## Configuration

| Variable           | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `RPC_URL`          | http(s) JSON-RPC or ws(s) WebSocket endpoint (required) |
| `CONTRACT_ADDRESS` | Contract to watch (required)                            |
| `CONTRACT_ABI`     | Path to a JSON ABI file (required)                      |
| `FROM_BLOCK`       | First block to backfill (default: latest block)         |
| `POLL_INTERVAL_MS` | Polling cadence (default: 5000)                         |
| `PORT`             | API port (default: 3000)                                |

## API

| Route           | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| `GET /health`   | `{ status: "ok" }`                                                 |
| `GET /stats`    | Event count, counts by event name, first/last block covered        |
| `GET /events`   | List events; filters `eventName`, `address`, `fromBlock`, `toBlock`; pagination `limit` (max 500) / `offset`; `{ total, events }` in chain order |
| `GET /events/:id` | One stored event, or 404                                         |

## Tests

```bash
npm test
```

16 tests (Node's built-in test runner) cover the store (de-duplication,
filtering, pagination, stats), the listener (decoding a real
`encodeEventLog` round-trip, foreign-log skipping, ingest counts,
poll-range behaviour), and the HTTP API end to end on an ephemeral port.
No chain or network is needed.

## Project structure

```
src/
  index.js     entry point: config, provider, backfill + polling loop, API
  listener.js  EventListener — decode + ingest, pollOnce, subscribe
  store.js     EventStore — in-memory, de-duplicated, queryable
  server.js    createApp(store) — Express REST API
test/
  store.test.js · listener.test.js · server.test.js
examples/
  erc20-abi.json
```

## Limitations / next steps

- Storage is in-memory: a restart re-backfills from `FROM_BLOCK`.
  A persistent store (SQLite) behind `EventStore` is the natural next step.
- One contract per process; multi-contract watching would key listeners
  and stores by address.
- Reorg handling is out of scope for this increment: records are keyed by
  transaction hash, and a production indexer would mark blocks beyond the
  reorg depth as final before serving them as canonical.

## License

MIT — see [LICENSE](LICENSE).
