// 예시: 실제 수집 데이터로 만든 통계표 + 예시 이동 시간으로 실효 도착 시간을 계산해 본다.
// 이동 시간은 길찾기 API를 연결하기 전이라 '예시 값'이다.
// 사용법: node scripts/demo.mjs --data <가용병상 CSV 폴더> [--hour 15] [--delay 5]
import { loadSnapshots } from './load.mjs';
import { buildModel, makeRejectProb } from '../engine/model.mjs';
import { evaluate } from '../engine/effective.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const hour = Number(args.hour ?? 15);
const delayMin = Number(args.delay ?? 3);

const { rows } = loadSnapshots(args.data);
const rejectProb = makeRejectProb(buildModel(rows));

// 예시 병원 (병원별 기록 없이 전체 통계를 쓰도록 가상의 ID 사용)
const hospitals = [
  { id: 'A', name: 'A병원', hvec: 1, travelMin: 10 },
  { id: 'B', name: 'B병원', hvec: 5, travelMin: 12 },
  { id: 'C', name: 'C병원', hvec: 3, travelMin: 15 },
  { id: 'D', name: 'D병원', hvec: 0, travelMin: 6 },
];
const M = {
  A: { B: 8, C: 9, D: 7 },
  B: { A: 8, C: 6, D: 9 },
  C: { A: 9, B: 6, D: 11 },
  D: { A: 7, B: 9, C: 11 },
};
const state = Object.fromEntries(hospitals.map((h) => [h.id, h]));
const probAt = (id, leadMin) =>
  rejectProb({ hpid: `demo-${id}`, hvec: state[id].hvec, ageMin: 5, leadMin, hourKST: hour }).p;

const result = evaluate(hospitals, (a, b) => M[a][b], probAt, { delayMin, depth: 3 });
const pct = (x) => (x * 100).toFixed(1) + '%';
console.log(`출발 ${hour}시, 확인 지연 ${delayMin}분 (예시 이동 시간)`);
for (const r of result) {
  const h = state[r.id];
  console.log(
    `${r.name} | 남은 병상 ${h.hvec} | 이동 ${r.travelMin}분 | 도착 시 거절 ${pct(r.pReject)} | 추가 +${r.extraMin.toFixed(1)}분 | 실효 ${r.effectiveMin.toFixed(1)}분 | 거절 시 순서 ${r.chain.map((c) => c.name).join(' → ')} | 끝까지 거절 ${pct(r.unresolved)}`,
  );
}
const nearest = [...hospitals].sort((a, b) => a.travelMin - b.travelMin)[0];
const nearestWithBed = [...hospitals].filter((h) => h.hvec >= 1).sort((a, b) => a.travelMin - b.travelMin)[0];
const get = (id) => result.find((r) => r.id === id);
console.log(`\n가장 가까운 병원: ${nearest.name} → 실효 ${get(nearest.id).effectiveMin.toFixed(1)}분`);
console.log(`지금 병상이 있는 가장 가까운 병원(기존 앱 방식): ${nearestWithBed.name} → 실효 ${get(nearestWithBed.id).effectiveMin.toFixed(1)}분`);
console.log(`실효 도착 시간 기준 추천: ${result[0].name} → 실효 ${result[0].effectiveMin.toFixed(1)}분`);
