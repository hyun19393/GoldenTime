// 응급실 사이 도로 이동 시간 표 (카카오모빌리티 길찾기, 실시간 교통 반영)
// 하루 4번(8·13·18·23시) 수집 워크플로 안에서 실행된다. 해당 시간대 파일이 이미 있으면 건너뛴다.
//   10km 안의 응급실: 다중 목적지 길찾기 한 번에 (최대 30곳, 반경 10km 제한)
//   그보다 먼 응급실: 가까운 순으로 FAR_K곳만 자동차 길찾기로 하나씩
// 결과: data/travel/YYYY-MM-DD_HH.csv  (from, to, duration_s, distance_m, method)
// 환경 변수: KAKAO_REST_KEY (GitHub Secret), FORCE=1 이면 시간대와 관계없이 실행
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCSV, toCSVLine } from '../engine/csv.mjs';
import { formatKST, kstDate, kstHour } from '../engine/time.mjs';
import { haversineM } from '../engine/geo.mjs';

export { haversineM }; // 예전 위치에서 불러 쓰는 코드를 위해 그대로 내보낸다

const KEY = process.env.KAKAO_REST_KEY;
const DATA = process.env.DATA_DIR || 'data';
const SLOTS = [8, 13, 18, 23];
const NEAR_M = 9500; // 다중 목적지 반경(10km)보다 조금 안쪽
const FAR_K = 5;
const API = 'https://apis-navi.kakaomobility.com/v1';
const BUDGET_MS = Number(process.env.TRAVEL_BUDGET_MS ?? 4 * 60e3);


// 응급실 목록: 최근 가용병상 기록에 나온 기관 + 좌표
export function loadERs(dir = DATA) {
  const list = Object.fromEntries(parseCSV(readFileSync(join(dir, 'hospitals.csv'), 'utf8')).map((r) => [r.hpid, r]));
  const bedDir = join(dir, 'beds');
  const last = readdirSync(bedDir).filter((f) => f.endsWith('.csv')).sort().at(-1);
  const ids = new Set(parseCSV(readFileSync(join(bedDir, last), 'utf8')).map((r) => r.hpid));
  return [...ids]
    .map((id) => list[id] && { id, name: list[id].dutyName, lat: Number(list[id].wgs84Lat), lon: Number(list[id].wgs84Lon) })
    .filter((h) => h && Number.isFinite(h.lat) && Number.isFinite(h.lon));
}

// 각 응급실에서 계산할 짝: 10km 안은 모두(최대 30), 밖은 가까운 FAR_K곳
export function planPairs(ers) {
  return ers.map((a) => {
    const others = ers.filter((b) => b.id !== a.id).map((b) => ({ ...b, m: haversineM(a, b) })).sort((x, y) => x.m - y.m);
    return { from: a, near: others.filter((b) => b.m <= NEAR_M).slice(0, 30), far: others.filter((b) => b.m > NEAR_M).slice(0, FAR_K) };
  });
}

async function kakao(url, init = {}, attempt = 0) {
  try {
    const r = await fetch(url, { ...init, headers: { Authorization: `KakaoAK ${KEY}`, ...init.headers }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
    return { status: r.status, body: await r.json() };
  } catch (e) {
    if (attempt < 2) { await new Promise((s) => setTimeout(s, 1000 * (attempt + 1))); return kakao(url, init, attempt + 1); }
    throw e;
  }
}

export async function buildMatrix(plan, { deadline = Infinity, concurrency = 4 } = {}) {
  const rows = [];
  let failed = 0;
  const tasks = [];
  for (const p of plan) {
    if (p.near.length) tasks.push(async () => {
      const { body } = await kakao(`${API}/destinations/directions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { x: p.from.lon, y: p.from.lat }, destinations: p.near.map((b) => ({ key: b.id, x: b.lon, y: b.lat })), radius: 10000, priority: 'TIME' }),
      });
      for (const r of body.routes ?? []) {
        if (r.result_code === 0 && r.summary) rows.push([p.from.id, r.key, r.summary.duration, r.summary.distance, 'multi']);
        else failed++;
      }
    });
    for (const b of p.far) tasks.push(async () => {
      const q = new URLSearchParams({ origin: `${p.from.lon},${p.from.lat}`, destination: `${b.lon},${b.lat}`, priority: 'TIME', summary: 'true' });
      const { body } = await kakao(`${API}/directions?${q}`);
      const r = body.routes?.[0];
      if (r?.result_code === 0 && r.summary) rows.push([p.from.id, b.id, r.summary.duration, r.summary.distance, 'single']);
      else failed++;
    });
  }
  let next = 0, skipped = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      if (Date.now() > deadline) { skipped++; continue; }
      try { await t(); } catch { failed++; }
    }
  }));
  return { rows, failed, skipped, calls: tasks.length };
}

export async function main(now = Date.now()) {
  if (!KEY) { console.log('travel: KAKAO_REST_KEY 없음, 건너뜀'); return null; }
  const hour = kstHour(now);
  if (!process.env.FORCE && !SLOTS.includes(hour)) return null;
  const file = join(DATA, 'travel', `${kstDate(now)}_${String(hour).padStart(2, '0')}.csv`);
  if (existsSync(file)) return null;
  const plan = planPairs(loadERs());
  const res = await buildMatrix(plan, { deadline: Date.now() + BUDGET_MS });
  if (!res.rows.length) { console.error(`travel 실패: 성공 0건, 실패 ${res.failed}`); process.exitCode = 1; return res; }
  mkdirSync(join(DATA, 'travel'), { recursive: true });
  const header = ['computed_at', 'from', 'to', 'duration_s', 'distance_m', 'method'];
  writeFileSync(file, '﻿' + [toCSVLine(header), ...res.rows.map((r) => toCSVLine([formatKST(now), ...r]))].join('\n') + '\n');
  console.log(`travel: ${res.rows.length}쌍 저장, 실패 ${res.failed}, 시간 부족 ${res.skipped} (호출 ${res.calls}) → ${file}`);
  return res;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
