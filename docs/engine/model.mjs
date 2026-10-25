// 수집 데이터 -> "도착 시점 거절(수용 불가) 확률" 통계표
//
// 거절 상태의 정의 (v1): 공공데이터상 응급실 가용병상(hvec)이 0 이하인 상태.
//   음수는 정원을 넘겨 운영 중(과밀)이라는 뜻이라 함께 '수용 곤란'으로 본다.
//   전문의 부재 등 데이터에 없는 거절 사유는 반영하지 않는다(한계).
//
// 통계표의 한 칸 = (지금 남은 병상 구간, 몇 분 뒤 도착, 관측 시간대)
//   n = 그런 상황이 몇 번 있었나, k = 그중 도착 시점에 거절 상태였던 횟수

import { kstHour } from './time.mjs';

// 수집 간격(10분)의 배수로 둔다. 10분 간격 기록에서는 45분 뒤 같은 칸이 생기지 않아(허용 오차 3분) 통계가 비게 된다.
export const LEADS = [10, 20, 30, 40, 50, 60]; // 분
export const BUCKETS = ['le0', '1', '2', '3-4', '5-9', '10+'];
export const BUCKET_LABEL = {
  le0: '0 이하',
  1: '1개',
  2: '2개',
  '3-4': '3~4개',
  '5-9': '5~9개',
  '10+': '10개 이상',
};
export const HOUR_BIN_LABEL = ['0~4시', '4~8시', '8~12시', '12~16시', '16~20시', '20~24시'];
export const STALE_MIN = 60; // 병원 입력 시각이 이보다 오래되면 '현재 상태 모름'으로 본다

export const isRejectState = (row) => row.hvec <= 0;

export function bedBucket(hvec) {
  if (!Number.isFinite(hvec)) return null;
  if (hvec <= 0) return 'le0';
  if (hvec === 1) return '1';
  if (hvec === 2) return '2';
  if (hvec <= 4) return '3-4';
  if (hvec <= 9) return '5-9';
  return '10+';
}

export const hourBin = (hour) => Math.floor(hour / 4); // 0..5

// 정렬된 시각 배열에서 target에 가장 가까운 칸 (from 이후에서 찾음)
function nearestIndex(ts, target, from) {
  let lo = from;
  let hi = ts.length - 1;
  if (hi < lo) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > from && Math.abs(ts[lo - 1] - target) <= Math.abs(ts[lo] - target)) return lo - 1;
  return lo;
}

function inc(obj, key, hit) {
  const c = obj[key] ?? (obj[key] = { n: 0, k: 0 });
  c.n++;
  if (hit) c.k++;
}

/**
 * rows: [{ t(ms), hpid, name, hvec, ageMin }]
 *   ageMin = 수집 시각 - 병원 입력 시각(hvidate), 분
 */
export function buildModel(rows, { leads = LEADS, toleranceMin = 3, source = '', isReject = isRejectState, bucketOf = (r) => bedBucket(r.hvec) } = {}) {
  const byHospital = new Map();
  let used = 0; // 통계에 쓴 기록 수
  let stale = 0; // 병원 입력이 오래돼 '지금 상태'로 쓰지 않은 기록 수
  for (const r of rows) {
    if (!Number.isFinite(r.hvec) || !Number.isFinite(r.t)) continue;
    used++;
    if (!byHospital.has(r.hpid)) byHospital.set(r.hpid, []);
    byHospital.get(r.hpid).push(r);
  }

  const pooled = {};
  const hospitals = {};
  const tol = toleranceMin * 60e3;
  let tMin = Infinity;
  let tMax = -Infinity;
  let pairs = 0;

  for (const [hpid, series] of byHospital) {
    series.sort((a, b) => a.t - b.t);
    const h = (hospitals[hpid] = { name: series.at(-1).name ?? '', counts: {}, base: {} });
    const ts = series.map((s) => s.t);

    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      if (s.t < tMin) tMin = s.t;
      if (s.t > tMax) tMax = s.t;
      const hb = hourBin(kstHour(s.t));
      // 병원별·시간대별 평균 거절 상태 비율 (현재 상태를 모를 때 쓰는 값)
      inc(h.base, String(hb), isReject(s));
      inc(pooled, `base|${hb}`, isReject(s));

      if (s.ageMin > STALE_MIN) { stale++; continue; } // 오래된 입력은 '지금 상태'로 쓰지 않음
      const b = bucketOf(s);
      for (const L of leads) {
        const target = s.t + L * 60e3;
        const j = nearestIndex(ts, target, i + 1);
        if (j < 0 || Math.abs(ts[j] - target) > tol) continue;
        const hit = isReject(series[j]);
        inc(h.counts, `${b}|${L}|${hb}`, hit);
        inc(pooled, `${b}|${L}|${hb}`, hit);
        inc(pooled, `${b}|${L}|all`, hit);
        pairs++;
      }
    }
  }

  return {
    version: 1,
    source,
    createdAt: new Date().toISOString(),
    rejectDefinition: 'hvec <= 0',
    leads,
    toleranceMin,
    range: [tMin, tMax],
    rows: used,
    staleRows: stale,
    pairs,
    pooled,
    hospitals,
  };
}

// 칸의 기록이 적을수록 상위 평균(prior) 쪽으로 당겨서 쓴다. m = 당기는 힘(가상의 관측 수)
export const SHRINK_M = 30;
export const shrink = (cell, prior, m) => (cell ? (cell.k + m * prior) / (cell.n + m) : prior);
export const rate = (cell) => (cell && cell.n ? (cell.k + 0.5) / (cell.n + 1) : null);
const weightOf = (cell, m) => (cell ? cell.n / (cell.n + m) : 0); // 그 칸 자신의 기록이 차지하는 비중

// ---- 계산 과정을 단계별로 돌려주는 함수 (앱 계산과 현황판 설명이 같은 코드를 쓴다)

// 지금 상태를 모를 때: 병원의 시간대 평균 거절 비율을 전체 병원의 시간대 평균 쪽으로 당긴다
export function explainBase(model, { hpid, hb, m = SHRINK_M }) {
  const allCell = model.pooled[`base|${hb}`] ?? null;
  const prior = rate(allCell) ?? 0.1;
  const hospCell = model.hospitals[hpid]?.base[String(hb)] ?? null;
  return { allCell, prior, hospCell, hospWeight: weightOf(hospCell, m), p: shrink(hospCell, prior, m) };
}

// 한 칸(지금 병상 구간 b, 도착까지 L분, 시간대 hb)의 확률: 전체 병원·전체 시간대 → 같은 시간대 → 이 병원 순으로 3단계
export function explainPoint(model, { hpid, b, L, hb, m = SHRINK_M }) {
  const P = model.pooled;
  const allCell = P[`${b}|${L}|all`] ?? null;
  const all = rate(allCell);
  if (all == null) {
    const base = explainBase(model, { hpid, hb, m });
    return { fallback: base, p: base.p }; // 이 병상 구간·도착 시간 기록이 아예 없으면 평균값을 쓴다
  }
  const hourCell = P[`${b}|${L}|${hb}`] ?? null;
  const hour = shrink(hourCell, all, m);
  const hospCell = model.hospitals[hpid]?.counts[`${b}|${L}|${hb}`] ?? null;
  const p = shrink(hospCell, hour, m);
  return { allCell, all, hourCell, hourWeight: weightOf(hourCell, m), hour, hospCell, hospWeight: weightOf(hospCell, m), p };
}

/**
 * 통계표 -> 확률 함수
 * rejectProb({ hpid, hvec, ageMin, leadMin, hourKST }) -> { p, basis }
 *   hourKST: 출발(= 상태를 확인한) 시각의 시(0~23)
 *   leadMin: 출발부터 그 병원 도착까지 걸리는 분
 */
export function makeRejectProb(model, { m = SHRINK_M } = {}) {
  const baseAt = (hpid, hb) => explainBase(model, { hpid, hb, m }).p;
  const pointAt = (hpid, b, L, hb) => explainPoint(model, { hpid, b, L, hb, m }).p;

  return function rejectProb({ hpid, hvec, ageMin = 0, leadMin, hourKST }) {
    const hb = hourBin(hourKST);
    if (!Number.isFinite(hvec) || ageMin > STALE_MIN) {
      return { p: baseAt(hpid, hb), basis: '현재 상태 모름: 병원 시간대 평균' };
    }
    const b = bedBucket(hvec);
    const p0 = hvec <= 0 ? 1 : 0;
    if (leadMin <= 0) return { p: p0, basis: '지금 상태' };
    let prevL = 0;
    let prevP = p0;
    for (const L of model.leads) {
      const pL = pointAt(hpid, b, L, hb);
      if (leadMin <= L) {
        const w = (leadMin - prevL) / (L - prevL);
        return { p: prevP + w * (pL - prevP), basis: '현재 상태 + 도착까지 시간' };
      }
      prevL = L;
      prevP = pL;
    }
    return { p: prevP, basis: '현재 상태 + 도착까지 시간(최대 구간)' };
  };
}

// 병원별 평균 통계만 쓰는 비교용 예측 (현재 상태를 보지 않음)
export function makeAverageOnlyProb(model, { m = SHRINK_M } = {}) {
  return ({ hpid, hourKST }) => ({ p: explainBase(model, { hpid, hb: hourBin(hourKST), m }).p, basis: '병원 시간대 평균' });
}
