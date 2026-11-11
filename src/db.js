import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      league TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      market_key TEXT NOT NULL,
      market_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event, starts_at, market_key)
    );
    CREATE TABLE IF NOT EXISTS odds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL,
      bookmaker TEXT NOT NULL,
      odds REAL NOT NULL CHECK(odds > 1),
      is_reference INTEGER NOT NULL DEFAULT 0,
      estimated_probability REAL,
      captured_at TEXT NOT NULL,
      UNIQUE(market_id, outcome, bookmaker, odds, captured_at)
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      bankroll REAL NOT NULL DEFAULT 1000,
      fixed_stake REAL NOT NULL DEFAULT 20,
      surebet_stake REAL NOT NULL DEFAULT 20,
      ev_stake_mode TEXT NOT NULL DEFAULT 'kelly',
      ev_fixed_stake REAL NOT NULL DEFAULT 20,
      kelly_fraction REAL NOT NULL DEFAULT 0.25,
      max_exposure_pct REAL NOT NULL DEFAULT 2,
      min_ev_pct REAL NOT NULL DEFAULT 2
    );
    INSERT OR IGNORE INTO settings(id) VALUES (1);
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      market_id INTEGER REFERENCES markets(id) ON DELETE SET NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      settled_profit REAL,
      settled_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS footy_matches (
      league TEXT NOT NULL,
      season TEXT NOT NULL,
      kickoff INTEGER NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      stats TEXT NOT NULL,
      PRIMARY KEY (league, season, kickoff, home_team, away_team)
    );
    CREATE INDEX IF NOT EXISTS footy_matches_teams ON footy_matches(league, season, kickoff DESC);
    CREATE TABLE IF NOT EXISTS footy_csv_records (
      league TEXT NOT NULL,
      season TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('teams', 'teams2', 'players')),
      record_key TEXT NOT NULL,
      record_data TEXT NOT NULL,
      PRIMARY KEY (league, season, kind, record_key)
    );
    CREATE TABLE IF NOT EXISTS bet_slips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league TEXT NOT NULL,
      season TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      kickoff TEXT NOT NULL,
      fixture_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bet_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_id INTEGER NOT NULL REFERENCES bet_slips(id) ON DELETE CASCADE,
      selection TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS oddspapi_fixtures (
      fixture_id TEXT PRIMARY KEY,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      tournament TEXT NOT NULL DEFAULT '',
      seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  migrateDatabase(db);
  return db;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  return true;
}

function migrateDatabase(db) {
  addColumn(db, 'markets', 'expected_outcomes TEXT');
  const addedSurebetStake = addColumn(db, 'settings', 'surebet_stake REAL NOT NULL DEFAULT 20');
  addColumn(db, 'settings', "ev_stake_mode TEXT NOT NULL DEFAULT 'kelly'");
  const addedEvFixedStake = addColumn(db, 'settings', 'ev_fixed_stake REAL NOT NULL DEFAULT 20');
  addColumn(db, 'history', "status TEXT NOT NULL DEFAULT 'open'");
  addColumn(db, 'history', 'settled_profit REAL');
  addColumn(db, 'history', 'settled_at TEXT');
  if (addedSurebetStake) db.exec('UPDATE settings SET surebet_stake = fixed_stake');
  if (addedEvFixedStake) db.exec('UPDATE settings SET ev_fixed_stake = fixed_stake');
}

export function importRows(db, rows) {
  const marketInsert = db.prepare(`
    INSERT INTO markets(sport, league, event, starts_at, market_key, market_name, source, is_demo, expected_outcomes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event, starts_at, market_key) DO UPDATE SET
      sport=excluded.sport, league=excluded.league, market_name=excluded.market_name,
      source=excluded.source, is_demo=MIN(markets.is_demo, excluded.is_demo),
      expected_outcomes=COALESCE(excluded.expected_outcomes, markets.expected_outcomes)
  `);
  const marketFind = db.prepare('SELECT id FROM markets WHERE event=? AND starts_at=? AND market_key=?');
  const oddsInsert = db.prepare(`
    INSERT OR IGNORE INTO odds(market_id, outcome, bookmaker, odds, is_reference, estimated_probability, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  let duplicates = 0;
  const marketResults = new Map();
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      marketInsert.run(row.sport, row.league, row.event, row.starts_at, row.market_key, row.market_name, row.source, row.is_demo, row.expected_outcomes ?? null);
      const marketId = marketFind.get(row.event, row.starts_at, row.market_key).id;
      const result = oddsInsert.run(marketId, row.outcome, row.bookmaker, row.odds, row.is_reference, row.estimated_probability, row.captured_at);
      const marketResult = marketResults.get(marketId) ?? {
        marketId, event:row.event, startsAt:row.starts_at, marketKey:row.market_key,
        inserted:0, duplicates:0
      };
      if (Number(result.changes) === 1) {
        inserted += 1;
        marketResult.inserted += 1;
      } else {
        duplicates += 1;
        marketResult.duplicates += 1;
      }
      marketResults.set(marketId, marketResult);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    inserted, duplicates,
    marketIds:[...marketResults.keys()],
    marketResults:[...marketResults.values()]
  };
}

export function listMarkets(db) {
  const markets = db.prepare('SELECT * FROM markets ORDER BY starts_at ASC, id ASC').all();
  const quoteStatement = db.prepare(`SELECT id, market_id, outcome, bookmaker, odds, is_reference, estimated_probability, captured_at
    FROM (
      SELECT odds.*, ROW_NUMBER() OVER (
        PARTITION BY market_id, outcome, bookmaker ORDER BY captured_at DESC, id DESC
      ) AS quote_rank
      FROM odds WHERE market_id=?
    ) WHERE quote_rank=1 ORDER BY outcome, odds DESC`);
  return markets.map((market) => ({ ...market, quotes: quoteStatement.all(market.id) }));
}

export function getMarket(db, id) {
  const market = db.prepare('SELECT * FROM markets WHERE id=?').get(id);
  if (!market) return null;
  const quotes = db.prepare(`SELECT id, market_id, outcome, bookmaker, odds, is_reference, estimated_probability, captured_at
    FROM (
      SELECT odds.*, ROW_NUMBER() OVER (
        PARTITION BY market_id, outcome, bookmaker ORDER BY captured_at DESC, id DESC
      ) AS quote_rank
      FROM odds WHERE market_id=?
    ) WHERE quote_rank=1 ORDER BY outcome, odds DESC`).all(id);
  return { ...market, quotes };
}

export function saveHistory(db, kind, marketId, payload) {
  const result = db.prepare('INSERT INTO history(kind, market_id, payload) VALUES (?, ?, ?)').run(kind, marketId, JSON.stringify(payload));
  return Number(result.lastInsertRowid);
}

export function seedDemo(db, rows) {
  const count = Number(db.prepare('SELECT COUNT(*) AS total FROM odds').get().total);
  if (count === 0) return importRows(db, rows);
  return { inserted: 0, duplicates: 0 };
}
