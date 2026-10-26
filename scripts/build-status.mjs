// 수집 현황판(docs/)에서 읽을 요약 파일 docs/status.json을 만든다.
// 수집할 때마다 GitHub Actions에서 실행된다.
// 사용법: node scripts/build-status.mjs [--data data] [--out docs/status.json] [--days 7] [--window 14]
// 수집 기록이 계속 쌓여도 빨리 끝나도록 병상 기록은 최근 --window일(기본 14일)만 읽는다.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';
import { parseKST, parseHvidate, formatKST, kstHour } from '../engine/time.mjs';
import { normFlag, SEVERE } from '../engine/codes.mjs';
import { causeCode } from '../engine/causes.mjs';
import { regularStart } from './load.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const DATA = args.data ?? 'data';
const OUT = args.out ?? 'docs/status.json';
const DAYS = Number(args.days ?? 7);
const WINDOW = Number(args.window ?? 14);

const readDir = (sub, lastN = Infinity) => {
  const dir = join(DATA, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .sort()
    .slice(-lastN)
    .map((f) => ({ day: f.slice(0, 10), rows: parseCSV(readFileSync(join(dir, f), 'utf8')) }));
};
const readTable = (f) => (existsSync(join(DATA, f)) ? parseCSV(readFileSync(join(DATA, f), 'utf8')) : []);

// ---- 기관 정보
const list = readTable('hospitals.csv');
const info = Object.fromEntries(readTable('hospital_info.csv').map((r) => [r.hpid, r]));
const sigungu = (addr = '') => addr.split(/\s+/)[1] ?? '';
const hosp = Object.fromEntries(
  list.map((r) => [
    r.hpid,
    {
      hpid: r.hpid,
      name: r.dutyName,
      cls: r.dutyEmclsName,
      si: sigungu(r.dutyAddr),
      addr: r.dutyAddr,
      tel: r.dutyTel3 || r.dutyTel1,
      lat: Number(r.wgs84Lat),
      lon: Number(r.wgs84Lon),
      erBeds: info[r.hpid]?.hperyn ? Number(info[r.hpid].hperyn) : null,
    },
  ]),
);

// ---- 가용병상 기록
const bedDays = readDir('beds', WINDOW);
const snaps = new Map(); // collected_at -> rows
let totalRows = 0;
for (const { rows } of bedDays) {
  for (const r of rows) {
    totalRows++;
    if (!snaps.has(r.collected_at)) snaps.set(r.collected_at, []);
    snaps.get(r.collected_at).push(r);
  }
}
const times = [...snaps.keys()].sort();
const latestAt = times.at(-1);
const latest = latestAt ? snaps.get(latestAt) : [];
const num = (v) => (v === '' || v == null ? null : Number(v));

// 병원별 누적: 기록 수, 꽉 찬 횟수, 입력 경과(수집 시각 - 병원 입력 시각)
const perHosp = {};
for (const t of times) {
  const tm = parseKST(t);
  for (const r of snaps.get(t)) {
    const v = num(r.hvec);
    if (v == null) continue;
    const p = (perHosp[r.hpid] ??= { n: 0, full: 0, name: r.dutyName, ages: [] });
    p.n++;
    if (v <= 0) p.full++;
    const hv = parseHvidate(r.hvidate);
    if (hv != null) p.ages.push((tm - hv) / 60e3);
  }
}
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

// 시간대별(0~23시) 꽉 찬 비율 (전체 기간)
const byHour = Array.from({ length: 24 }, () => ({ n: 0, full: 0 }));
for (const t of times) {
  const h = kstHour(parseKST(t));
  for (const r of snaps.get(t)) {
    const v = num(r.hvec);
    if (v == null) continue;
    byHour[h].n++;
    if (v <= 0) byHour[h].full++;
  }
}

// 최근 DAYS일 시계열: 수집 시각마다 꽉 찬 곳 / 1~2개 남은 곳
const since = latestAt ? parseKST(latestAt) - DAYS * 86400e3 : 0;
const timeline = times
  .filter((t) => parseKST(t) >= since)
  .map((t) => {
    let full = 0, low = 0, n = 0;
    for (const r of snaps.get(t)) {
      const v = num(r.hvec);
      if (v == null) continue;
      n++;
      if (v <= 0) full++;
      else if (v <= 2) low++;
    }
    return [t.slice(5, 16), full, low, n];
  });

// ---- 중증질환 (가장 최근 수집)
const sevDays = readDir('severe', 1);
const sevLatestRows = (() => {
  const all = sevDays.at(-1)?.rows ?? [];
  const last = all.at(-1)?.collected_at;
  return all.filter((r) => r.collected_at === last);
})();
const sevBy = Object.fromEntries(
  sevLatestRows.map((r) => {
    const no = [];
    for (const k of Object.keys(SEVERE)) if (normFlag(r[k]) === 'N') no.push(SEVERE[k]);
    return [r.hpid, { no, erClosed: normFlag(r.MKioskTy28) === 'N' }];
  }),
);

// ---- 메시지 (지금 걸려 있는 것)
const nowMs = latestAt ? parseKST(latestAt) : Date.now();
// 지금 걸려 있는 목록(messages_now.csv)이 있으면 그것을 쓴다. 해제된 메시지가 남지 않는다.
// 없으면(예전 기록) 최근 2일 기록에서 기간으로만 거른다.
const nowMsgs = readTable('messages_now.csv');
const msgRows = nowMsgs.length ? nowMsgs : readDir('messages', 2).flatMap((d) => d.rows);
const messagesAt = nowMsgs[0]?.collected_at ?? null;
const seenMsg = new Set();
const activeMsgs = [];
for (const m of msgRows) {
  const key = [m.hpid, m.symTypCod, m.symBlkSttDtm, m.symBlkMsg].join('|');
  if (seenMsg.has(key)) continue;
  seenMsg.add(key);
  const st = parseHvidate(m.symBlkSttDtm);
  const en = parseHvidate(m.symBlkEndDtm);
  if (st != null && st > nowMs) continue;
  if (en != null && en < nowMs) continue;
  activeMsgs.push({
    hpid: m.hpid,
    name: m.dutyName,
    type: m.symTypCodMag || m.symTypCod,
    kind: m.symBlkMsgTyp, // 응급(진료과·조건 제한) / 중증(질환별 불가)
    dept: m.trtPrtCodMag,
    msg: m.symBlkMsg,
    start: st ? formatKST(st).slice(5, 16) : '',
    end: en ? formatKST(en).slice(5, 16) : '',
  });
}

// ---- 지금 상태 (병원별)
const hospitalsNow = latest.map((r) => {
  const h = hosp[r.hpid] ?? { hpid: r.hpid, name: r.dutyName };
  const hv = parseHvidate(r.hvidate);
  const p = perHosp[r.hpid];
  return {
    ...h,
    name: h.name ?? r.dutyName,
    hvec: num(r.hvec),
    base: num(r.hvs01),
    ageMin: hv ? Math.round((parseKST(r.collected_at) - hv) / 60e3) : null,
    fullRate: p && p.n ? p.full / p.n : null,
    records: p?.n ?? 0,
    // 입력 신선도: 병원 입력이 60분 넘게 지난 기록의 비율, 입력 경과 중앙값·최대(분)
    staleRate: p && p.ages.length ? p.ages.filter((a) => a > 60).length / p.ages.length : null,
    ageMedian: p && p.ages.length ? Math.round(median(p.ages)) : null,
    ageMax: p && p.ages.length ? Math.round(Math.max(...p.ages)) : null,
    severeNo: sevBy[r.hpid]?.no ?? [],
    erClosed: sevBy[r.hpid]?.erClosed ?? false,
    messages: activeMsgs.filter((m) => m.hpid === r.hpid).length,
  };
});

// ---- 시군별
const bySi = {};
for (const h of hospitalsNow) {
  const s = (bySi[h.si || '미상'] ??= { si: h.si || '미상', er: 0, full: 0, rateSum: 0, rateN: 0 });
  s.er++;
  if (h.hvec != null && h.hvec <= 0) s.full++;
  if (h.fullRate != null) { s.rateSum += h.fullRate; s.rateN++; }
}
const siList = Object.values(bySi)
  .map((s) => ({ si: s.si, er: s.er, fullNow: s.full, avgFullRate: s.rateN ? s.rateSum / s.rateN : null }))
  .sort((a, b) => b.er - a.er || a.si.localeCompare(b.si, 'ko'));
const GYEONGGI = ['수원시', '성남시', '의정부시', '안양시', '부천시', '광명시', '평택시', '동두천시', '안산시', '고양시', '과천시', '구리시', '남양주시', '오산시', '시흥시', '군포시', '의왕시', '하남시', '용인시', '파주시', '이천시', '안성시', '김포시', '화성시', '광주시', '양주시', '포천시', '여주시', '연천군', '가평군', '양평군'];
const noEr = GYEONGGI.filter((s) => !bySi[s]);
// 실시간 병상을 알리는 응급실이 없는 시군에도, 병상 정보를 내지 않는 응급실운영신고기관이 있을 수 있다
const noErOther = Object.fromEntries(noEr.map((s) => [s, list.filter((r) => sigungu(r.dutyAddr) === s).map((r) => `${r.dutyName}(${r.dutyEmclsName})`)]));
const excludedRows = list.filter((r) => !latest.some((b) => b.hpid === r.hpid)); // 목록에는 있지만 실시간 병상을 내지 않는 기관
const notReporting = excludedRows.length;
const excluded = excludedRows
  .map((r) => ({ name: r.dutyName, cls: r.dutyEmclsName, si: sigungu(r.dutyAddr) }))
  .sort((a, b) => a.si.localeCompare(b.si, 'ko') || a.name.localeCompare(b.name, 'ko'));

// ---- 수집 실행 기록
const runs = readTable('runs.csv');
const day = 86400e3;
const recent = runs.filter((r) => parseKST(r.started_at) >= nowMs - day);
const runStats = {};
for (const r of recent) {
  const s = (runStats[r.op] ??= { ok: 0, fail: 0, lastError: '' });
  if (r.ok === '1') s.ok++;
  else { s.fail++; s.lastError = r.error; }
}

// ---- 수집 상태 자세히 (수집 상태 탭)
const OPS_ALL = ['beds', 'severe', 'messages', 'hospitals', 'hospital_info'];
const opStats = (since) => Object.fromEntries(OPS_ALL.map((op) => {
  const rs = runs.filter((r) => r.op === op && parseKST(r.started_at) >= since);
  const skip = rs.filter((r) => r.ok !== '1' && r.cause === 'SKIPPED').length;
  const ok = rs.filter((r) => r.ok === '1').length;
  return [op, { ok, fail: rs.length - ok - skip, skip }];
}));
// 10분 칸 기준 가용병상 수집률: 기간 안의 10분 칸 중 가용병상 기록이 있는 칸의 비율
const SLOT = 10 * 60e3;
// 자동 수집이 자리 잡기 전(시험 수집)은 수집률 계산에서 뺀다
const regularMs = regularStart(times.map(parseKST)) ?? nowMs;
const firstMs = regularMs;
const slotCover = (since) => {
  const from = Math.max(since, Math.floor(firstMs / SLOT) * SLOT);
  const to = Math.floor(nowMs / SLOT) * SLOT; // 마지막(지금) 칸까지
  const got = new Set(times.map((t) => Math.floor(parseKST(t) / SLOT)).filter((k) => k * SLOT >= from && k * SLOT <= to));
  return { expected: Math.max(0, Math.round((to - from) / SLOT) + 1), got: got.size };
};
const week = nowMs - 7 * day;
const windows = {
  '24h': { label: '최근 24시간', ops: opStats(nowMs - day), slots: slotCover(nowMs - day + SLOT) },
  '7d': { label: '최근 7일', ops: opStats(week), slots: slotCover(week + SLOT) },
  all: { label: '전체', ops: opStats(-Infinity), slots: slotCover(-Infinity) },
};
// 실패 기록 (최근 7일): 같은 실행(3분 안)의 실패를 한 줄로 묶고, 그 뒤 처음 성공한 가용병상 수집을 '뒤처리'로 붙인다
const bedOk = runs.filter((r) => r.op === 'beds' && r.ok === '1').map((r) => ({ t: parseKST(r.started_at), redo: r.run === 'redo' })).sort((a, b) => a.t - b.t);
const failRows = runs.filter((r) => r.ok !== '1' && parseKST(r.started_at) >= week).sort((a, b) => parseKST(a.started_at) - parseKST(b.started_at));
const failures = [];
for (const r of failRows) {
  const t = parseKST(r.started_at);
  let g = failures.at(-1);
  if (!g || t - g.t > 3 * 60e3 || g.redo !== (r.run === 'redo')) {
    g = { t, at: r.started_at, redo: r.run === 'redo', ops: [] };
    failures.push(g);
  }
  g.ops.push({ op: r.op, cause: causeCode(r), attempts: r.attempts ?? '', ms: num(r.ms), error: (r.error ?? '').slice(0, 120) });
}
for (const g of failures) {
  const next = bedOk.find((b) => b.t > g.t);
  g.recovered = next ? { at: formatKST(next.t), redo: next.redo, afterMin: Math.round((next.t - g.t) / 60e3) } : null;
  delete g.t;
}
// 수집 간격 (최근 7일, 가용병상 기록 기준)
const recentTimes = times.map(parseKST).filter((t) => t >= week);
const gapsAll = recentTimes.slice(1).map((t, i) => (t - recentTimes[i]) / 60e3);
const sortedGaps = [...gapsAll].sort((a, b) => a - b);
const q = (p) => (sortedGaps.length ? sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(p * sortedGaps.length))] : null);
const gaps = recentTimes.slice(1).map((t, i) => ({ from: formatKST(recentTimes[i]), to: formatKST(t), min: Math.round((t - recentTimes[i]) / 60e3) })).filter((g) => g.min > 15);
// 마지막 실행: 가장 최근 가용병상 기록(성공이든 실패든)과 3분 안의 다른 기능 기록
const lastBeds = [...runs].reverse().find((r) => r.op === 'beds');
const lastRun = lastBeds ? {
  at: lastBeds.started_at,
  redo: lastBeds.run === 'redo',
  ops: runs.filter((r) => Math.abs(parseKST(r.started_at) - parseKST(lastBeds.started_at)) <= 3 * 60e3 && r.run === lastBeds.run)
    .map((r) => ({ op: r.op, ok: r.ok === '1', cause: causeCode(r), ms: num(r.ms) })),
} : null;
const collect = {
  regularFrom: formatKST(regularMs),
  lastRun,
  windows,
  failures: failures.reverse(),
  intervals: { median: q(0.5), p90: q(0.9), max: sortedGaps.at(-1) ?? null, n: gapsAll.length },
  gaps,
};

const status = {
  generatedAt: formatKST(Date.now()),
  latestAt,
  firstAt: times[0] ?? null,
  snapshots: times.length,
  days: bedDays.length,
  rows: totalRows,
  summary: {
    er: hospitalsNow.length,
    fullNow: hospitalsNow.filter((h) => h.hvec != null && h.hvec <= 0).length,
    lowNow: hospitalsNow.filter((h) => h.hvec != null && h.hvec >= 1 && h.hvec <= 2).length,
    okNow: hospitalsNow.filter((h) => h.hvec != null && h.hvec >= 3).length,
    activeMessages: activeMsgs.length,
  },
  hospitals: hospitalsNow,
  byHour: byHour.map((h, i) => ({ hour: i, n: h.n, rate: h.n ? h.full / h.n : null })),
  timeline,
  bySi: siList,
  noEr,
  noErOther,
  notReporting,
  excluded,
  collect,
  messages: activeMsgs.sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, 200),
  messagesAt,
  runs24h: runStats,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(status));
console.log(`status: 수집 ${times.length}회, 응급실 ${hospitalsNow.length}곳, 메시지 ${activeMsgs.length}건 → ${OUT}`);
