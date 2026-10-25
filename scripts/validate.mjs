// 검증: 앞부분 기간으로 통계표를 만들고, 뒷부분 기간의 실제 결과를 얼마나 잘 맞히는지 본다.
// 비교 대상
//   1) 현재 상태만 보기 (지금 길찾기·병상 앱 방식): 지금 병상이 있으면 '받아줌', 없으면 '거절'
//   2) 평균 통계만 보기: 병원의 시간대별 평균 거절 상태 비율
//   3) 우리 방식: 현재 상태 + 도착까지 걸리는 시간 + 시간대 + 병원별 기록
// 점수: Brier 점수 = (예측 확률 - 실제 결과(0 또는 1))^2 의 평균. 낮을수록 좋다.
//
// 사용법: node scripts/validate.mjs --data <가용병상 CSV 폴더> [--split 0.7] [--out results.json]
import { writeFileSync } from 'node:fs';
import { loadSnapshots } from './load.mjs';
import { buildModel, makeRejectProb, makeAverageOnlyProb, isRejectState, bedBucket, STALE_MIN, BUCKETS, BUCKET_LABEL } from '../engine/model.mjs';
import { kstHour, formatKST } from '../engine/time.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const dataDir = args.data;
if (!dataDir) {
  console.error('사용법: node scripts/validate.mjs --data <폴더>');
  process.exit(1);
}
const split = Number(args.split ?? 0.7);
const TEST_LEADS = [10, 20, 30];

const { files, rows } = loadSnapshots(dataDir);
const valid = rows.filter((r) => Number.isFinite(r.hvec) && Number.isFinite(r.t));
const tMin = valid.reduce((m, r) => Math.min(m, r.t), Infinity);
const tMax = valid.reduce((m, r) => Math.max(m, r.t), -Infinity);
const cutoff = tMin + split * (tMax - tMin);
const train = valid.filter((r) => r.t < cutoff);
const testRows = valid.filter((r) => r.t >= cutoff);

const model = buildModel(train, { source: dataDir });
const ours = makeRejectProb(model);
const avgOnly = makeAverageOnlyProb(model);

// 평가 기간 데이터를 병원별 시계열로
const series = new Map();
for (const r of testRows) {
  if (!series.has(r.hpid)) series.set(r.hpid, []);
  series.get(r.hpid).push(r);
}
for (const s of series.values()) s.sort((a, b) => a.t - b.t);

const methods = ['nowOnly', 'avgOnly', 'ours'];
const score = {}; // lead -> method -> {sum, n}
const calib = {}; // 우리 방식, 예측 구간별 {pSum, hit, n}
const appMiss = {}; // lead -> {n, k}: 지금 병상 1개 이상(앱이 '가능'으로 보여줌)인데 도착 시 거절 상태
const byBucket = {}; // lead|bucket -> {n,k,pSum}
const BINS = [0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.9, 1.0001];

for (const L of TEST_LEADS) {
  score[L] = Object.fromEntries(methods.map((m) => [m, { sum: 0, n: 0 }]));
  appMiss[L] = { n: 0, k: 0, pSum: 0 };
}

for (const [hpid, s] of series) {
  const ts = s.map((x) => x.t);
  for (let i = 0; i < s.length; i++) {
    const now = s[i];
    if (now.ageMin > STALE_MIN) continue;
    const hour = kstHour(now.t);
    for (const L of TEST_LEADS) {
      const target = now.t + L * 60e3;
      // 가장 가까운 기록 찾기 (3분 이내)
      let lo = i + 1, hi = ts.length - 1;
      if (lo > hi) continue;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < target) lo = mid + 1; else hi = mid; }
      let j = lo;
      if (j > i + 1 && Math.abs(ts[j - 1] - target) <= Math.abs(ts[j] - target)) j = j - 1;
      if (Math.abs(ts[j] - target) > 3 * 60e3) continue;
      const y = isRejectState(s[j]) ? 1 : 0;

      const preds = {
        nowOnly: now.hvec <= 0 ? 1 : 0,
        avgOnly: avgOnly({ hpid, hourKST: hour }).p,
        ours: ours({ hpid, hvec: now.hvec, ageMin: now.ageMin, leadMin: L, hourKST: hour }).p,
      };
      for (const m of methods) {
        score[L][m].sum += (preds[m] - y) ** 2;
        score[L][m].n++;
      }
      if (now.hvec >= 1) {
        appMiss[L].n++;
        appMiss[L].k += y;
        appMiss[L].pSum += preds.ours;
      }
      const bk = `${L}|${bedBucket(now.hvec)}`;
      const cb = byBucket[bk] ?? (byBucket[bk] = { n: 0, k: 0, pSum: 0 });
      cb.n++; cb.k += y; cb.pSum += preds.ours;
      if (L === 20) {
        const bi = BINS.findIndex((b, x) => preds.ours >= b && preds.ours < BINS[x + 1]);
        const c = calib[bi] ?? (calib[bi] = { pSum: 0, hit: 0, n: 0 });
        c.pSum += preds.ours; c.hit += y; c.n++;
      }
    }
  }
}

const pct = (x) => (x * 100).toFixed(1) + '%';
console.log(`데이터: ${files.length}개 파일, ${valid.length.toLocaleString()}행, 병원 ${new Set(valid.map((r) => r.hpid)).size}곳`);
console.log(`기간: ${formatKST(tMin)} ~ ${formatKST(tMax)}`);
console.log(`통계표 만든 기간(앞 ${split * 100}%): ~ ${formatKST(cutoff)} / 평가 기간: 그 이후`);
console.log('\n[Brier 점수: 낮을수록 정확]');
for (const L of TEST_LEADS) {
  const line = methods.map((m) => `${m} ${(score[L][m].sum / score[L][m].n).toFixed(4)}`).join(' | ');
  console.log(`  ${L}분 뒤 도착 (n=${score[L].ours.n.toLocaleString()}): ${line}`);
}
console.log('\n[지금 병상이 1개 이상(앱에서 "가능")인데 도착하면 거절 상태였던 비율]');
for (const L of TEST_LEADS) {
  const a = appMiss[L];
  console.log(`  ${L}분 뒤: 실제 ${pct(a.k / a.n)} / 우리 예측 평균 ${pct(a.pSum / a.n)} (n=${a.n.toLocaleString()})`);
}
console.log('\n[지금 남은 병상별: 실제 vs 우리 예측 (평가 기간)]');
for (const L of TEST_LEADS) {
  const parts = BUCKETS.map((b) => {
    const c = byBucket[`${L}|${b}`];
    return c ? `${BUCKET_LABEL[b]} ${pct(c.k / c.n)}/${pct(c.pSum / c.n)}` : `${BUCKET_LABEL[b]} -`;
  });
  console.log(`  ${L}분 뒤: ${parts.join(' · ')}`);
}
console.log('\n[예측 확률 구간별 실제 비율 (20분 뒤, 우리 방식)]');
Object.keys(calib).sort((a, b) => a - b).forEach((bi) => {
  const c = calib[bi];
  console.log(`  ${pct(BINS[bi])}~${pct(Math.min(1, BINS[+bi + 1]))}: 예측 평균 ${pct(c.pSum / c.n)} / 실제 ${pct(c.hit / c.n)} (n=${c.n.toLocaleString()})`);
});

if (args.out) {
  writeFileSync(
    args.out,
    JSON.stringify(
      {
        dataDir, files: files.length, rows: valid.length, range: [formatKST(tMin), formatKST(tMax)], cutoff: formatKST(cutoff),
        brier: Object.fromEntries(TEST_LEADS.map((L) => [L, Object.fromEntries(methods.map((m) => [m, score[L][m].sum / score[L][m].n]))])),
        n: Object.fromEntries(TEST_LEADS.map((L) => [L, score[L].ours.n])),
        appMiss, byBucket, calib,
      },
      null,
      2,
    ),
  );
}
