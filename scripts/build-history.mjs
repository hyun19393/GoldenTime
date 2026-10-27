// 수집 현황판의 '날짜별 기록' 파일을 만든다. 수집할 때마다 GitHub Actions에서 실행된다.
//   docs/history/index.json        날짜 목록과 날짜별 요약
//   docs/history/YYYY-MM-DD.json   그날의 모든 수집 시각 × 응급실별 남은 병상·입력 경과, 10분 칸별 수집 결과, 실행 기록
// 이미 만든 날짜는 원본(가용병상 CSV 크기, 그날 실행 기록 수)이 바뀌지 않았으면 다시 만들지 않는다(보통 오늘만 다시 만듦).
// 사용법: node scripts/build-history.mjs [--data data] [--out docs/history]
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCSV, readColumns } from '../engine/csv.mjs';
import { parseKST, parseHvidate, formatKST } from '../engine/time.mjs';
import { causeCode } from '../engine/causes.mjs';
import { regularStart, BED_COLS } from './load.mjs';

export const SLOT_MIN = 10;
const SLOTS = (24 * 60) / SLOT_MIN; // 144칸
// 칸 기호: o 정시 수집 성공 · r 새 실행으로 다시 받음 · f 실패 · m 실행 기록 없음(호출이 안 옴)
//         - 자동 수집 시작 전(시험 수집 기간)이거나 아직 안 온 시각
const slotOf = (hms) => Math.floor((Number(hms.slice(0, 2)) * 60 + Number(hms.slice(3, 5))) / SLOT_MIN);
const num = (v) => (v === '' || v == null ? null : Number(v));

export function buildDay(day, bedRows, runRows, info, { firstAt, nowAt }) {
  // 수집 시각 목록과 응급실 목록
  const times = [...new Set(bedRows.map((r) => r.collected_at))].sort();
  const hp = new Map();
  for (const r of bedRows) hp.set(r.hpid, { hpid: r.hpid, name: r.dutyName, si: info[r.hpid]?.si ?? '', cls: info[r.hpid]?.cls ?? '', base: num(r.hvs01) });
  const hospitals = [...hp.values()].sort((a, b) => a.si.localeCompare(b.si, 'ko') || a.name.localeCompare(b.name, 'ko'));
  const col = new Map(hospitals.map((h, i) => [h.hpid, i]));
  const ti = new Map(times.map((t, i) => [t, i]));
  const hvec = times.map(() => hospitals.map(() => null));
  const age = times.map(() => hospitals.map(() => null));
  for (const r of bedRows) {
    const i = ti.get(r.collected_at), j = col.get(r.hpid);
    hvec[i][j] = num(r.hvec);
    const hv = parseHvidate(r.hvidate);
    age[i][j] = hv == null ? null : Math.round((parseKST(r.collected_at) - hv) / 60e3);
  }

  // 그날의 실행 기록 (모든 기능)
  const runs = runRows.map((r) => ({
    at: r.started_at.slice(11), op: r.op, ok: r.ok === '1', cause: causeCode(r), attempts: r.attempts ?? '', redo: r.run === 'redo',
    ms: num(r.ms), items: num(r.items), error: (r.error ?? '').slice(0, 120),
  }));

  // 10분 칸별 가용병상 수집 결과
  const slots = Array(SLOTS).fill('m');
  const dayStart = parseKST(`${day} 00:00:00`);
  for (let s = 0; s < SLOTS; s++) {
    const t0 = dayStart + s * SLOT_MIN * 60e3;
    if (t0 + SLOT_MIN * 60e3 <= firstAt || t0 + SLOT_MIN * 60e3 > nowAt) slots[s] = '-'; // 자동 수집 시작 전이거나 아직 끝나지 않은 칸
  }
  for (const r of runs.filter((x) => x.op === 'beds' && !x.ok)) slots[slotOf(r.at)] = 'f';
  for (const t of times) slots[slotOf(t.slice(11))] = 'o';
  for (const r of runs.filter((x) => x.op === 'beds' && x.ok && x.redo)) slots[slotOf(r.at)] = 'r';

  // 요약
  const fullCounts = hvec.map((row) => row.filter((v) => v != null && v <= 0).length);
  const lowCounts = hvec.map((row) => row.filter((v) => v != null && v >= 1 && v <= 2).length);
  const maxFull = Math.max(0, ...fullCounts);
  const everFull = hospitals.filter((_, j) => hvec.some((row) => row[j] != null && row[j] <= 0)).length;
  let staleN = 0, cellN = 0;
  for (const row of age) for (const a of row) { if (a == null) continue; cellN++; if (a > 60) staleN++; }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const count = (c) => slots.filter((x) => x === c).length;
  const summary = {
    day,
    snapshots: times.length,
    expected: SLOTS - count('-'),
    okSlots: count('o') + count('r'),
    redoSlots: count('r'),
    failSlots: count('f'),
    missSlots: count('m'),
    hospitals: hospitals.length,
    fullAvg: avg(fullCounts),
    fullMax: maxFull,
    fullMaxAt: maxFull ? times[fullCounts.indexOf(maxFull)].slice(11, 16) : null,
    lowAvg: avg(lowCounts),
    everFull,
    staleShare: cellN ? staleN / cellN : null,
  };
  return { summary, data: { day, regularFrom: formatKST(firstAt), hospitals, times: times.map((t) => t.slice(11)), hvec, age, slots, runs, summary } };
}

export function main(args = {}) {
  const DATA = args.data ?? 'data';
  const OUT = args.out ?? 'docs/history';
  mkdirSync(OUT, { recursive: true });
  const bedDir = join(DATA, 'beds');
  const days = existsSync(bedDir) ? readdirSync(bedDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).map((f) => f.slice(0, 10)).sort() : [];
  if (!days.length) return console.log('history: 기록 없음');

  const info = {};
  if (existsSync(join(DATA, 'hospitals.csv'))) {
    for (const r of parseCSV(readFileSync(join(DATA, 'hospitals.csv'), 'utf8'))) info[r.hpid] = { si: (r.dutyAddr ?? '').split(/\s+/)[1] ?? '', cls: r.dutyEmclsName ?? '' };
  }
  const runs = existsSync(join(DATA, 'runs.csv')) ? parseCSV(readFileSync(join(DATA, 'runs.csv'), 'utf8')) : [];
  const runsByDay = {};
  for (const r of runs) (runsByDay[r.started_at.slice(0, 10)] ??= []).push(r);

  const idxFile = join(OUT, 'index.json');
  const prev = existsSync(idxFile) ? JSON.parse(readFileSync(idxFile, 'utf8')) : { days: [] };
  const prevBy = Object.fromEntries((prev.days ?? []).map((d) => [d.day, d]));
  // 자동 수집이 자리 잡은 시각 (첫 이틀의 수집 시각으로 찾는다). 그 전은 시험 수집 기간
  const firstRows = readColumns(readFileSync(join(bedDir, `${days[0]}.csv`), 'utf8'), BED_COLS);
  const early = new Set(firstRows.map((r) => r.collected_at));
  if (days[1]) for (const r of readColumns(readFileSync(join(bedDir, `${days[1]}.csv`), 'utf8'), BED_COLS)) early.add(r.collected_at);
  const firstAt = regularStart([...early].sort().map(parseKST)) ?? parseKST(`${days[0]} 00:00:00`);
  let nowAt = Date.now();
  if (args.now) nowAt = parseKST(args.now);

  const out = [];
  let rebuilt = 0;
  for (const day of days) {
    const sig = `${statSync(join(bedDir, `${day}.csv`)).size}|${(runsByDay[day] ?? []).length}`;
    const old = prevBy[day];
    // 오늘은 시간이 흐르면 '아직 안 온 칸'이 줄어드므로, 원본이 같아도 마지막 날은 늘 다시 만든다
    if (old && old.sig === sig && day !== days.at(-1) && existsSync(join(OUT, `${day}.json`))) { out.push(old); continue; }
    const rows = day === days[0] ? firstRows : readColumns(readFileSync(join(bedDir, `${day}.csv`), 'utf8'), BED_COLS);
    const { summary, data } = buildDay(day, rows, runsByDay[day] ?? [], info, { firstAt, nowAt });
    writeFileSync(join(OUT, `${day}.json`), JSON.stringify(data));
    out.push({ ...summary, sig });
    rebuilt++;
  }
  writeFileSync(idxFile, JSON.stringify({ generatedAt: formatKST(Date.now()), slotMin: SLOT_MIN, days: out.reverse() }));
  console.log(`history: ${days.length}일 (다시 만든 날 ${rebuilt}) → ${OUT}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  main(Object.fromEntries(a.flatMap((x, i) => (x.startsWith('--') ? [[x.slice(2), a[i + 1]]] : []))));
}
