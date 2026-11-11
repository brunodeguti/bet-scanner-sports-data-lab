import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importRows, listMarkets, openDatabase } from '../src/db.js';

test('scanner usa somente a cotação mais recente de cada casa e resultado', () => {
  const db = openDatabase(':memory:');
  const base = {
    sport:'Futebol', league:'Teste', event:'A x B', starts_at:'2026-10-01T20:00:00Z',
    market_key:'h2h', market_name:'Vencedor', source:'teste', is_demo:0, is_reference:0,
    estimated_probability:null
  };
  importRows(db, [
    {...base,outcome:'A',bookmaker:'Casa',odds:3,captured_at:'2026-09-22T10:00:00Z'},
    {...base,outcome:'A',bookmaker:'Casa',odds:1.8,captured_at:'2026-09-22T11:00:00Z'},
    {...base,outcome:'B',bookmaker:'Outra',odds:2,captured_at:'2026-09-22T11:00:00Z'}
  ]);
  const [market] = listMarkets(db);
  assert.equal(market.quotes.length, 2);
  assert.equal(market.quotes.find((quote) => quote.outcome === 'A').odds, 1.8);
  db.close();
});

test('migra banco antigo preservando configurações e histórico', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-scanner-migration-'));
  const file = path.join(directory, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY, bankroll REAL, fixed_stake REAL, kelly_fraction REAL, max_exposure_pct REAL, min_ev_pct REAL);
    INSERT INTO settings VALUES (1, 500, 50, 0.25, 2, 2);
    CREATE TABLE markets (id INTEGER PRIMARY KEY, sport TEXT, league TEXT, event TEXT, starts_at TEXT, market_key TEXT, market_name TEXT, source TEXT, is_demo INTEGER, created_at TEXT);
    CREATE TABLE history (id INTEGER PRIMARY KEY, kind TEXT, market_id INTEGER, payload TEXT, created_at TEXT);
    INSERT INTO history VALUES (1, 'ev', NULL, '{"suggestedStake":10}', CURRENT_TIMESTAMP);
  `);
  old.close();
  const migrated = openDatabase(file);
  const settings = migrated.prepare('SELECT * FROM settings WHERE id=1').get();
  const history = migrated.prepare('SELECT * FROM history WHERE id=1').get();
  assert.equal(settings.surebet_stake, 50);
  assert.equal(settings.ev_fixed_stake, 50);
  assert.equal(settings.ev_stake_mode, 'kelly');
  assert.equal(history.status, 'open');
  assert.equal(history.payload, '{"suggestedStake":10}');
  migrated.close();
  fs.rmSync(directory, {recursive:true});
});
