'use strict';

const express = require('express');

/**
 * REST API over an EventStore.
 *
 *   GET /health        → { status: "ok" }
 *   GET /stats         → counts by event, covered block range
 *   GET /events        → filters: eventName, address, fromBlock, toBlock,
 *                        limit, offset → { total, events }
 *   GET /events/:id    → one stored record, or 404
 *
 * The app factory takes the store so tests can run it against a fresh
 * in-memory store on an ephemeral port, with no chain connection.
 */
function createApp(store) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/stats', (_req, res) => {
    res.json(store.stats());
  });

  app.get('/events', (req, res) => {
    const { eventName, address, fromBlock, toBlock, limit, offset } = req.query;
    res.json(
      store.query({
        eventName,
        address,
        fromBlock: fromBlock === undefined ? undefined : Number(fromBlock),
        toBlock: toBlock === undefined ? undefined : Number(toBlock),
        limit: limit === undefined ? undefined : Number(limit),
        offset: offset === undefined ? undefined : Number(offset),
      }),
    );
  });

  app.get('/events/:id', (req, res) => {
    const record = store.getById(req.params.id);
    if (!record) return res.status(404).json({ error: 'event not found' });
    return res.json(record);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

module.exports = { createApp };
