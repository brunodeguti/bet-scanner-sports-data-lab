import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDatabase, seedDemo } from './db.js';
import { validateImportRows } from './importer.js';
import { importFootyCsv } from './footyCsv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'portfolio-demo.db');
const db = openDatabase(dbPath);

if (process.env.SEED_DEMO !== 'false') {
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'demo-odds.json'), 'utf8'));
  seedDemo(db, validateImportRows(demo));
  if (!db.prepare("SELECT 1 FROM footy_matches WHERE league='demo-sports' LIMIT 1").get()) {
    const filename = 'demo-sports-matches-2026-to-2027-stats.csv';
    importFootyCsv(db, filename, fs.readFileSync(path.join(__dirname, '..', 'examples', filename), 'utf8'));
  }
}

const app = createApp({ db });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Bet Scanner MVP em http://localhost:${port}`);
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
