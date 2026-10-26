// 정확도 점검: 앞부분 기간의 기록으로만 통계표를 만들고, 뒷부분 기간에 실제로 어땠는지와 비교한다.
// (미래를 보고 맞히는 반칙이 없도록 시간 순서대로 나눈다)
// 비교 대상
//   ours     우리 방식: 지금 상태 + 도착까지 시간 + 시간대 + 병원 기록
//   nowOnly  지금 상태만 보기 (일반 병상 앱처럼 지금 0 이하면 거절, 아니면 받아줌)
//   avgOnly  평균만 보기 (병원의 시간대 평균 거절 비율, 지금 상태는 안 봄)
// 점수: Brier 점수 = (예측 확률 - 실제 결과 0 또는 1)²의 평균. 0에 가까울수록 정확하다.
import { buildModel, makeRejectProb, makeAverageOnlyProb, isRejectState, bedBucket, STALE_MIN, BUCKETS } from './model.mjs';
import { kstHour } from './time.mjs';

export const CALIB_EDGES = [0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.9, 1];

export function evaluateSplit(rows, { split = 0.7, leads = [10, 20, 30], calibLead = 20, toleranceMin = 3, build = buildModel, makeProb = makeRejectProb } = {}) {
  const valid = rows.filter((r) => Number.isFinite(r.hvec) && Number.isFinite(r.t));
  if (!valid.length) return null;
  const tMin = valid.reduce((m, r) => Math.min(m, r.t), Infinity);
  const tMax = valid.reduce((m, r) => Math.max(m, r.t), -Infinity);
  const cutoff = tMin + split * (tMax - tMin);
  const train = valid.filter((r) => r.t < cutoff);
  const test = valid.filter((r) => r.t >= cutoff);
  const model = build(train);
  const ours = makeProb(model);
  const avgOnly = makeAverageOnlyProb(model);

  const series = new Map();
  for (const r of test) {
    if (!series.has(r.hpid)) series.set(r.hpid, []);
    series.get(r.hpid).push(r);
  }
  const methods = ['ours', 'nowOnly', 'avgOnly'];
  const byLead = Object.fromEntries(leads.map((L) => [L, { n: 0, brier: Object.fromEntries(methods.map((m) => [m, 0])), appMiss: { n: 0, k: 0, pSum: 0 } }]));
  const calib = CALIB_EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: CALIB_EDGES[i + 1], n: 0, pSum: 0, k: 0 }));
  const bucket = Object.fromEntries(BUCKETS.map((b) => [b, { n: 0, pSum: 0, k: 0 }]));
  const tol = toleranceMin * 60e3;

  for (const [hpid, s] of series) {
    s.sort((a, b) => a.t - b.t);
    const ts = s.map((x) => x.t);
    for (let i = 0; i < s.length; i++) {
      const now = s[i];
      if (now.ageMin > STALE_MIN) continue;
      const hour = kstHour(now.t);
      for (const L of leads) {
        const target = now.t + L * 60e3;
        let lo = i + 1, hi = ts.length - 1;
        if (lo > hi) continue;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < target) lo = mid + 1; else hi = mid; }
        let j = lo;
        if (j > i + 1 && Math.abs(ts[j - 1] - target) <= Math.abs(ts[j] - target)) j--;
        if (Math.abs(ts[j] - target) > tol) continue;
        const y = isRejectState(s[j]) ? 1 : 0;
        const p = {
          ours: ours({ hpid, hvec: now.hvec, ageMin: now.ageMin, leadMin: L, hourKST: hour }).p,
          nowOnly: now.hvec <= 0 ? 1 : 0,
          avgOnly: avgOnly({ hpid, hourKST: hour }).p,
        };
        const R = byLead[L];
        R.n++;
        for (const m of methods) R.brier[m] += (p[m] - y) ** 2;
        if (now.hvec >= 1) { R.appMiss.n++; R.appMiss.k += y; R.appMiss.pSum += p.ours; }
        if (L === calibLead) {
          const c = calib.find((c, x) => p.ours >= c.lo && (p.ours < c.hi || x === calib.length - 1));
          c.n++; c.pSum += p.ours; c.k += y;
          const bb = bucket[bedBucket(now.hvec)];
          bb.n++; bb.pSum += p.ours; bb.k += y;
        }
      }
    }
  }
  for (const R of Object.values(byLead)) for (const m of methods) R.brier[m] = R.n ? R.brier[m] / R.n : null;
  return {
    split, range: [tMin, tMax], cutoff, trainRows: train.length, testRows: test.length, calibLead,
    byLead, calib, bucket,
  };
}
