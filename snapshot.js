// snapshot.js
// Render Cron Job — runs daily at 23:50 UTC.
// Commits snapshot files back to GitHub via PAT.
//
// Required environment variables in Render:
//   GITHUB_TOKEN   — Personal Access Token with repo write access
//   GITHUB_REPO    — defipatriot/ampcapa-data_2026
//   GITHUB_BRANCH  — main (or master)
//
// File model in the repo:
//   snapshots/daily/monday.json          ← 7 files, overwritten each week
//   snapshots/daily/tuesday.json
//   ...
//   snapshots/daily/sunday.json
//
//   snapshots/weekly/epoch-180-2026-04-13.json   ← permanent, one per epoch end
//   snapshots/weekly/epoch-181-2026-04-20.json
//
//   snapshots/monthly/2026-04-30.json    ← permanent, one per month end
//   snapshots/monthly/2026-05-31.json
//
//   snapshots/index.json                 ← lightweight index for the dashboard

import fetch from 'node-fetch';

// ── Config ────────────────────────────────────────────────────────────────────
const LCD              = 'https://terra-lcd.publicnode.com';
const STAKING_CONTRACT = 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y';
const VE3_CONTRACT     = 'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx';
const VOTING_MODULE    = 'terra1juj3ymejnug9p92upphcq0prq4e0hpw6rcu20njf8tk7n9sl2wxqldr0mt';
const AMPCAPA_DENOM    = 'factory/terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y/ampCAPA';
const EPOCH_SCHEDULE_URL = 'https://raw.githubusercontent.com/defipatriot/tla_json_storage/main/epoch_1-300_date.json';

// Render env vars
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO  || 'defipatriot/ampcapa-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!GITHUB_TOKEN) { console.error('ERROR: GITHUB_TOKEN env var not set'); process.exit(1); }

// ── Utilities ─────────────────────────────────────────────────────────────────
const pad2    = n   => String(n).padStart(2, '0');
const b64     = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
const fmtDate = d   => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function isLastDayOfMonth(date) {
  const tomorrow = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return tomorrow.getUTCMonth() !== date.getUTCMonth();
}

// ── GitHub API helpers ────────────────────────────────────────────────────────
const GH_API = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

async function ghGet(filePath) {
  const res = await fetch(`${GH_API}/${filePath}?ref=${GITHUB_BRANCH}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${filePath}: ${res.status}`);
  return res.json();
}

async function ghPut(filePath, content, message, sha = null) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${GH_API}/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${filePath}: ${res.status} — ${err.slice(0, 200)}`);
  }
  return res.json();
}

// Read existing file SHA (needed to overwrite a file via GitHub API)
async function getFileSha(filePath) {
  const existing = await ghGet(filePath);
  return existing?.sha || null;
}

// ── Epoch schedule ────────────────────────────────────────────────────────────
async function fetchEpochSchedule() {
  const res = await fetch(EPOCH_SCHEDULE_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Epoch schedule fetch: ${res.status}`);
  return res.json();
}

function findEpochEndingOn(schedule, dateStr) {
  return schedule.find(e => e.end_time.slice(0, 10) === dateStr) || null;
}

function findCurrentEpoch(schedule, date) {
  const t = date.getTime();
  return schedule.find(e => {
    const s = new Date(e.start_time).getTime();
    const en = new Date(e.end_time).getTime();
    return t >= s && t < en;
  }) || null;
}

// ── LCD queries ───────────────────────────────────────────────────────────────
async function queryContract(address, query) {
  const url = `${LCD}/cosmwasm/wasm/v1/contract/${address}/smart/${b64(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`LCD ${res.status} — ${address}`);
  const j = await res.json();
  return j.data !== undefined ? j.data : j;
}

async function fetchRates() {
  console.log('Fetching exchange rates…');
  const state       = await queryContract(STAKING_CONTRACT, { state: {} });
  const rateStaking = parseFloat(state.exchange_rate);
  const ve3q        = { exchange_rates: { assets: [['single', { native: AMPCAPA_DENOM }]], limit: 1 } };
  const ve3         = await queryContract(VE3_CONTRACT, ve3q);
  const rates       = ve3[0]?.exchange_rates;
  if (!rates?.length) throw new Error('No ve3 rate returned');
  const lat         = rates.sort((a, b) => b[0] - a[0])[0];
  const rateVe3     = parseFloat(lat[1].exchange_rate);
  console.log(`  ampCAPA→CAPA: ${rateStaking}  |  ampLP→ampCAPA: ${rateVe3}`);
  return { rateStaking, rateVe3 };
}

async function fetchAllStakers(rateStaking, rateVe3) {
  console.log('Fetching all stakers…');
  const all = [];
  let startAfter = null;
  const LIMIT = 30;

  for (let page = 1; ; page++) {
    const q     = startAfter
      ? { list_stakers: { limit: LIMIT, start_after: startAfter } }
      : { list_stakers: { limit: LIMIT } };
    const data  = await queryContract(VOTING_MODULE, q);
    const batch = data.stakers || [];
    console.log(`  Page ${page}: ${batch.length} stakers (total: ${all.length + batch.length})`);
    for (const s of batch) {
      const raw     = parseFloat(s.balance);
      const ampLP   = raw / 1_000_000;
      const ampCapa = ampLP * rateVe3;
      const capa    = ampCapa * rateStaking;
      all.push({ address: s.address, rawBalance: raw,
        ampLP:   parseFloat(ampLP.toFixed(6)),
        ampCapa: parseFloat(ampCapa.toFixed(6)),
        capa:    parseFloat(capa.toFixed(6)) });
    }
    if (batch.length < LIMIT) break;
    startAfter = batch[batch.length - 1].address;
  }

  all.sort((a, b) => b.capa - a.capa);
  const totalRaw = all.reduce((s, m) => s + m.rawBalance, 0);
  all.forEach(m => { m.vpPct = totalRaw > 0 ? parseFloat(((m.rawBalance / totalRaw) * 100).toFixed(4)) : 0; });
  return all;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now     = new Date();
  const dateStr = fmtDate(now);
  const dow     = now.getUTCDay();   // 0=Sun … 6=Sat
  const dayName = DAY_NAMES[dow];

  console.log(`\n=== DAO Member Snapshot — ${now.toISOString()} ===`);
  console.log(`    Date: ${dateStr}  |  Day: ${dayName}  |  Repo: ${GITHUB_REPO}`);

  // Load epoch schedule
  console.log('\nFetching epoch schedule…');
  const epochSchedule = await fetchEpochSchedule();
  const currentEpoch  = findCurrentEpoch(epochSchedule, now);
  console.log(`  Current epoch: ${currentEpoch?.epoch ?? 'unknown'}`);

  // Fetch blockchain data
  const { rateStaking, rateVe3 } = await fetchRates();
  const members = await fetchAllStakers(rateStaking, rateVe3);

  const snapshot = {
    meta: {
      timestamp:  now.toISOString(),
      date:       dateStr,
      dayName,
      epoch:      currentEpoch?.epoch ?? null,
      epochStart: currentEpoch?.start_time ?? null,
      epochEnd:   currentEpoch?.end_time ?? null,
    },
    rates: { rateStaking, rateVe3 },
    summary: {
      totalMembers:  members.length,
      activeStakers: members.filter(m => m.rawBalance > 0).length,
      totalCapa:     parseFloat(members.reduce((s, m) => s + m.capa, 0).toFixed(2)),
    },
    members,
  };

  // Load current index
  const indexFile    = 'snapshots/index.json';
  const indexExisting = await ghGet(indexFile);
  const index = indexExisting
    ? JSON.parse(Buffer.from(indexExisting.content, 'base64').toString('utf8'))
    : { latest_daily: null, daily: {}, weekly: [], monthly: [] };

  const filesToWrite = [];

  // ── 1. Daily — overwrite day-of-week file ─────────────────────────────────
  const dailyPath = `snapshots/daily/${dayName}.json`;
  const dailySha  = await getFileSha(dailyPath);
  filesToWrite.push({ path: dailyPath, data: snapshot, sha: dailySha,
    msg: `snapshot: daily ${dayName} (${dateStr})` });
  index.daily[dayName] = dateStr;
  index.latest_daily   = dateStr;
  console.log(`\n→ Daily:   ${dailyPath}  (overwrites last ${dayName})`);

  // ── 2. Weekly — permanent, on Sunday, named by epoch + date ───────────────
  if (dow === 0) {
    const endingEpoch = findEpochEndingOn(epochSchedule, dateStr);
    const epochNum    = endingEpoch?.epoch ?? currentEpoch?.epoch ?? 'unknown';
    const weeklyKey   = `epoch-${epochNum}-${dateStr}`;
    const weeklyPath  = `snapshots/weekly/${weeklyKey}.json`;
    filesToWrite.push({ path: weeklyPath, data: { ...snapshot, meta: { ...snapshot.meta, type: 'weekly', weeklyKey } }, sha: null,
      msg: `snapshot: weekly epoch-${epochNum} (${dateStr})` });
    if (!index.weekly.includes(weeklyKey)) index.weekly.push(weeklyKey);
    console.log(`→ Weekly:  ${weeklyPath}  (epoch ${epochNum})`);
  }

  // ── 3. Monthly — permanent, on last day of month ──────────────────────────
  if (isLastDayOfMonth(now)) {
    const monthlyPath = `snapshots/monthly/${dateStr}.json`;
    filesToWrite.push({ path: monthlyPath, data: { ...snapshot, meta: { ...snapshot.meta, type: 'monthly' } }, sha: null,
      msg: `snapshot: monthly end (${dateStr})` });
    if (!index.monthly.includes(dateStr)) index.monthly.push(dateStr);
    console.log(`→ Monthly: ${monthlyPath}`);
  }

  // ── 4. Write all files to GitHub ──────────────────────────────────────────
  console.log('\nWriting files to GitHub…');
  for (const f of filesToWrite) {
    await ghPut(f.path, f.data, f.msg, f.sha);
    console.log(`  ✓ ${f.path}`);
  }

  // ── 5. Update index ────────────────────────────────────────────────────────
  await ghPut(indexFile, index, `snapshot: update index (${dateStr})`, indexExisting?.sha || null);
  console.log(`  ✓ ${indexFile}`);

  console.log(`\nDone. Members: ${snapshot.summary.totalMembers} | Total CAPA: ${snapshot.summary.totalCapa.toLocaleString()}`);
}

main().catch(err => { console.error('\nSnapshot failed:', err.message); process.exit(1); });
