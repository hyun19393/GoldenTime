// 수집 데이터 -> "도착 시점 거절(수용 불가) 확률" 통계표
//
// 거절 상태의 정의 (v1): 공공데이터상 응급실 가용병상(hvec)이 0 이하인 상태.
//   음수는 정원을 넘겨 운영 중(과밀)이라는 뜻이라 함께 '수용 곤란'으로 본다.
//   전문의 부재 등 데이터에 없는 거절 사유는 반영하지 않는다(한계).
//
// 통계표의 한 칸 = (지금 남은 병상 구간, 몇 분 뒤 도착, 관측 시간대)
//   n = 그런 상황이 몇 번 있었나, k = 그중 도착 시점에 거절 상태였던 횟수

import { kstHour } from './time.mjs';

export const LEADS = [10, 20, 30, 45, 60]; // 분
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
export function buildModel(rows, { leads = LEADS, toleranceMin = 3, source = '', isReject = isRejectState } = {}) {
  const byHospital = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.hvec) || !Number.isFinite(r.t)) continue;
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

      if (s.ageMin > STALE_MIN) continue; // 오래된 입력은 '지금 상태'로 쓰지 않음
      const b = bedBucket(s.hvec);
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
    pairs,
    pooled,
    hospitals,
  };
}

// 칸의 기록이 적을수록 상위 평균(prior) 쪽으로 당겨서 쓴다. m = 당기는 힘(가상의 관측 수)
const shrink = (cell, prior, m) => (cell ? (cell.k + m * prior) / (cell.n + m) : prior);
const rate = (cell) => (cell && cell.n ? (cell.k + 0.5) / (cell.n + 1) : null);

/**
 * 통계표 -> 확률 함수
 * rejectProb({ hpid, hvec, ageMin, leadMin, hourKST }) -> { p, basis }
 *   hourKST: 출발(= 상태를 확인한) 시각의 시(0~23)
 *   leadMin: 출발부터 그 병원 도착까지 걸리는 분
 */
export function makeRejectProb(model, { m = 30 } = {}) {
  const P = model.pooled;

  const baseAt = (hpid, hb) => {
    const prior = rate(P[`base|${hb}`]) ?? 0.1;
    return shrink(model.hospitals[hpid]?.base[String(hb)], prior, m);
  };

  const pointAt = (hpid, b, L, hb) => {
    const all = rate(P[`${b}|${L}|all`]);
    if (all == null) return baseAt(hpid, hb);
    const pooledHour = shrink(P[`${b}|${L}|${hb}`], all, m);
    return shrink(model.hospitals[hpid]?.counts[`${b}|${L}|${hb}`], pooledHour, m);
  };

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
export function makeAverageOnlyProb(model, { m = 30 } = {}) {
  const P = model.pooled;
  return ({ hpid, hourKST }) => {
    const hb = hourBin(hourKST);
    const prior = rate(P[`base|${hb}`]) ?? 0.1;
    return { p: shrink(model.hospitals[hpid]?.base[String(hb)], prior, m), basis: '병원 시간대 평균' };
  };
}
