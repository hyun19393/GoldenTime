import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../engine/effective.mjs';
import { buildModel, makeRejectProb, bedBucket } from '../engine/model.mjs';
import { parseCSV, toCSVLine } from '../engine/csv.mjs';
import { parseHvidate, parseKST, kstHour, formatKST } from '../engine/time.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('실효 도착 시간: 손계산 예시 (병원 2곳)', () => {
  // A: 10분, 거절 60% / B: 15분, 거절 10% / A↔B 12분 / 확인 지연 0분
  const cands = [{ id: 'A', travelMin: 10 }, { id: 'B', travelMin: 15 }];
  const between = () => 12;
  const prob = { A: 0.6, B: 0.1 };
  const r = evaluate(cands, between, (id) => prob[id], { delayMin: 0, depth: 2 });
  const A = r.find((x) => x.id === 'A');
  const B = r.find((x) => x.id === 'B');
  close(A.effectiveMin, 10 + 0.6 * 12); // 17.2
  close(B.effectiveMin, 15 + 0.1 * 12); // 16.2
  assert.equal(r[0].id, 'B'); // 가까운 A보다 B가 실효 시간이 짧다
  close(A.unresolved, 0.6 * 0.1);
});

test('실효 도착 시간: 3단계까지 이어지는 거절과 확인 지연', () => {
  const cands = [
    { id: 'A', travelMin: 5 },
    { id: 'B', travelMin: 9 },
    { id: 'C', travelMin: 20 },
  ];
  const m = { A: { B: 4, C: 15 }, B: { A: 4, C: 12 }, C: { A: 15, B: 12 } };
  const between = (a, b) => m[a][b];
  const prob = { A: 0.5, B: 0.5, C: 0 };
  const d = 2;
  const r = evaluate(cands, between, (id) => prob[id], { delayMin: d, depth: 3 });
  // A부터: A 거절 -> (A에서) B 또는 C 중 기대 시간이 작은 쪽
  //   A->B: 4 + 0.5*(2 + 12) = 11,  A->C: 15 + 0 = 15  => B 선택(11)
  //   E(A) = 5 + 0.5*(2 + 11) = 11.5
  const A = r.find((x) => x.id === 'A');
  close(A.effectiveMin, 11.5);
  assert.deepEqual(A.chain.map((s) => s.id), ['A', 'B', 'C']);
  close(A.unresolved, 0.5 * 0.5 * 0);
});

test('확률이 도착 시간에 따라 달라지는 경우 lead가 누적되어 전달된다', () => {
  const seen = [];
  const cands = [{ id: 'A', travelMin: 10 }, { id: 'B', travelMin: 30 }];
  evaluate(cands, () => 7, (id, lead) => { seen.push([id, lead]); return 0.5; }, { delayMin: 3, depth: 2 });
  // A(10분) 거절 -> 3분 지연 -> B까지 7분 => B 도착은 출발 후 20분
  assert.ok(seen.some(([id, lead]) => id === 'B' && lead === 20));
  // B(30분) 거절 -> 3분 -> A까지 7분 => A 도착은 40분
  assert.ok(seen.some(([id, lead]) => id === 'A' && lead === 40));
});

test('통계표: 지금 상태와 n분 뒤 상태를 짝지어 센다', () => {
  const t0 = parseKST('2026-10-10 12:00:00');
  const row = (min, hvec) => ({ t: t0 + min * 60e3, hpid: 'H1', name: '병원', hvec, ageMin: 5 });
  // 0분: 1개, 10분: 0개, 20분: 3개, 30분: 0개
  const rows = [row(0, 1), row(10, 0), row(20, 3), row(30, 0)];
  const model = buildModel(rows, { leads: [10, 20] });
  const c = model.hospitals.H1.counts;
  // 지금 1개(12시대 = 3번 구간) -> 10분 뒤 0개 (거절 상태)
  assert.deepEqual(c['1|10|3'], { n: 1, k: 1 });
  // 지금 1개 -> 20분 뒤 3개 (가능)
  assert.deepEqual(c['1|20|3'], { n: 1, k: 0 });
  // 10분 시점 0개 -> 10분 뒤(20분) 3개: 가능 / 20분 뒤(30분) 0개: 거절 상태
  // 30분 시점 0개 -> 그 뒤 기록이 없어 세지 않음
  assert.deepEqual(c['le0|10|3'], { n: 1, k: 0 });
  assert.deepEqual(c['le0|20|3'], { n: 1, k: 1 });
  // 20분 시점 3개 -> 10분 뒤 0개
  assert.deepEqual(c['3-4|10|3'], { n: 1, k: 1 });
  assert.equal(model.pairs, 5);
});

test('확률 함수: 도착 0분은 지금 상태 그대로, 기록이 없는 병원은 전체 통계 사용', () => {
  const t0 = parseKST('2026-10-10 12:00:00');
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ t: t0 + i * 10 * 60e3, hpid: 'H1', name: 'a', hvec: i % 2 ? 0 : 1, ageMin: 5 });
  const model = buildModel(rows, { leads: [10, 20] });
  const rp = makeRejectProb(model);
  assert.equal(rp({ hpid: 'H1', hvec: 0, leadMin: 0, hourKST: 12 }).p, 1);
  assert.equal(rp({ hpid: 'H1', hvec: 3, leadMin: 0, hourKST: 12 }).p, 0);
  // 지금 1개 -> 10분 뒤는 항상 0개였던 기록 => 거의 1
  assert.ok(rp({ hpid: 'H1', hvec: 1, leadMin: 10, hourKST: 12 }).p > 0.9);
  // 처음 보는 병원도 값이 나온다 (전체 통계)
  const q = rp({ hpid: 'NEW', hvec: 1, leadMin: 10, hourKST: 12 }).p;
  assert.ok(q > 0.5 && q <= 1);
  // 5분 도착이면 0분(0)과 10분 값의 중간
  const p5 = rp({ hpid: 'H1', hvec: 1, leadMin: 5, hourKST: 12 }).p;
  const p10 = rp({ hpid: 'H1', hvec: 1, leadMin: 10, hourKST: 12 }).p;
  close(p5, p10 / 2);
  // 입력이 오래된 상태는 평균 통계로
  assert.match(rp({ hpid: 'H1', hvec: 1, ageMin: 999, leadMin: 10, hourKST: 12 }).basis, /모름/);
});

test('도구 함수', () => {
  assert.equal(bedBucket(-3), 'le0');
  assert.equal(bedBucket(4), '3-4');
  assert.equal(bedBucket(12), '10+');
  assert.equal(parseHvidate('20261009235516'), parseKST('2026-10-09 23:55:16'));
  assert.equal(parseHvidate('bad'), null);
  assert.equal(kstHour(parseKST('2026-10-10 00:30:00')), 0);
  assert.equal(formatKST(parseKST('2026-10-10 07:05:09')), '2026-10-10 07:05:09');
  const rows = parseCSV('﻿a,b\n1,"x, ""y"""\n2,\n');
  assert.deepEqual(rows, [{ a: '1', b: 'x, "y"' }, { a: '2', b: '' }]);
  assert.equal(toCSVLine(['a,b', 'c"d', 3]), '"a,b","c""d",3');
});

test('활용가이드 코드표', async () => {
  const { normFlag, SEVERE, MSG_TO_SEVERE } = await import('../engine/codes.mjs');
  assert.equal(normFlag('Y '), 'Y');
  assert.equal(normFlag('불가능'), 'N');
  assert.equal(normFlag('N'), 'N');
  assert.equal(normFlag('정보미제공'), null);
  assert.equal(Object.keys(SEVERE).length, 28);
  for (const v of Object.values(MSG_TO_SEVERE)) assert.ok(SEVERE[v], v);
});

test('모든 도착 시간 칸이 10분 간격 기록으로 채워진다 (45분처럼 빈 칸이 없음)', async () => {
  const { buildModel, LEADS } = await import('../engine/model.mjs');
  const t0 = Date.parse('2026-10-25T10:00:00+09:00');
  const rows = Array.from({ length: 13 }, (_, i) => ({ t: t0 + i * 600e3 + (i % 2) * 40e3, hpid: 'X', name: 'X', hvec: i % 3, ageMin: 5 }));
  const m = buildModel(rows);
  for (const L of LEADS) {
    const n = Object.entries(m.pooled).filter(([k]) => k.split('|')[1] === String(L) && k.endsWith('|all')).reduce((s, [, c]) => s + c.n, 0);
    assert.ok(n > 0, `${L}분 칸이 비어 있음`);
  }
});

test('계산 과정 설명(explainPoint)의 최종값이 앱이 쓰는 확률과 같다', async () => {
  const { buildModel, makeRejectProb, explainPoint, explainBase, bedBucket, hourBin, LEADS } = await import('../engine/model.mjs');
  const t0 = parseKST('2026-10-10 00:00:00');
  const rows = [];
  // 병원 3곳, 이틀 치, 병상 수가 시간에 따라 오르내림
  for (const [j, id] of ['A', 'B', 'C'].entries()) {
    for (let i = 0; i < 288; i++) rows.push({ t: t0 + i * 600e3 + j * 7e3, hpid: id, name: id, hvec: ((i + j * 5) % 9) - 2, ageMin: 5 });
  }
  const model = buildModel(rows);
  const rp = makeRejectProb(model);
  for (const id of ['A', 'B', 'NEW']) {
    for (const hvec of [-2, 0, 1, 3, 6, 12]) {
      for (const hour of [1, 9, 15, 22]) {
        for (const L of LEADS) {
          const ex = explainPoint(model, { hpid: id, b: bedBucket(hvec), L, hb: hourBin(hour) });
          close(ex.p, rp({ hpid: id, hvec, leadMin: L, hourKST: hour }).p);
          if (ex.method === 'class') {
            // v2 2단계: 같은 등급 병원 → 이 병원, 병원 비중 = n/(n+30)
            assert.ok(ex.prior > 0 && ex.prior < 1);
            assert.equal(ex.steps.length, 2);
            if (ex.hospCell) close(ex.hospWeight, ex.hospCell.n / (ex.hospCell.n + 30));
            else assert.equal(ex.p, ex.prior);
          } else if (!ex.fallback) {
            // v1 3단계(등급이 없는 병원): 전체 → 시간대 → 병원
            assert.ok(ex.all > 0 && ex.all < 1);
            if (ex.hospCell) close(ex.hospWeight, ex.hospCell.n / (ex.hospCell.n + 30));
            else assert.equal(ex.p, ex.hour);
          }
        }
      }
    }
    close(explainBase(model, { hpid: id, hb: 3 }).p, rp({ hpid: id, hvec: NaN, leadMin: 10, hourKST: 13 }).p);
  }
});

test('거리: 직선(하버사인)', async () => {
  const { haversineM } = await import('../engine/geo.mjs');
  const a = { lat: 37.3248, lon: 127.1076 };
  const north = { lat: a.lat + 1000 / 111195, lon: a.lon }; // 남북으로 1km
  assert.ok(Math.abs(haversineM(a, north) - 1000) < 2);
  const kmLon = 1000 / (111195 * Math.cos((a.lat * Math.PI) / 180));
  const diag = { lat: a.lat + 1000 / 111195, lon: a.lon + kmLon }; // 동서 1km + 남북 1km
  assert.ok(Math.abs(haversineM(a, diag) - Math.SQRT2 * 1000) < 3);
  assert.equal(haversineM(a, a), 0);
});

test('순위와 스피어먼 순위 상관', async () => {
  const { ranks, pearson, spearman } = await import('../engine/stats.mjs');
  assert.deepEqual(ranks([30, 10, 20]), [3, 1, 2]);
  assert.deepEqual(ranks([5, 1, 5, 2]), [3.5, 1, 3.5, 2]); // 같은 값은 순위 평균
  close(pearson([1, 2, 3], [2, 4, 6]), 1);
  close(pearson([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  close(spearman([1, 2, 3, 4], [10, 20, 30, 1000]), 1); // 순서만 같으면 1
  close(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 2], [1, 2]), null);
  // 손으로 계산: d = (0, 1, -1, 0) → 1 - 6·2/(4·15) = 0.8
  close(spearman([1, 2, 3, 4], [1, 3, 2, 4]), 0.8);
});

test('질환별 거절 확률: 불가능 표시·병상 0 이하를 거절로, 정보미제공은 확인 필요', async () => {
  const { buildDiseaseModels, makeDiseaseRejectProb, explainDiseasePoint } = await import('../engine/severe.mjs');
  const t0 = parseKST('2026-10-10 12:00:00');
  const beds = [], sev = new Map();
  for (let i = 0; i < 60; i++) {
    const t = t0 + i * 600e3;
    beds.push({ t, hpid: 'A', name: 'A', hvec: 5, ageMin: 5 }, { t, hpid: 'B', name: 'B', hvec: 5, ageMin: 5 }, { t, hpid: 'C', name: 'C', hvec: 5, ageMin: 5 });
    sev.set(`${t}|A`, { MKioskTy2: i < 30 ? 'Y' : '불가능' }); // 중간부터 계속 불가능
    sev.set(`${t}|B`, { MKioskTy2: 'Y' });
    sev.set(`${t}|C`, { MKioskTy2: '정보미제공' });
  }
  const dm = buildDiseaseModels(beds, sev, { diseases: ['MKioskTy2'] });
  assert.ok(!dm.diseases.MKioskTy2.hospitals.C); // 정보미제공은 통계에 넣지 않음
  assert.equal(dm.diseases.MKioskTy2.hospitals.A.lastFlag, 'N');
  const rp = makeDiseaseRejectProb(dm, 'MKioskTy2');
  const pN = rp({ hpid: 'A', hvec: 5, flag: 'N', leadMin: 20, hourKST: 13 }).p;
  const pY = rp({ hpid: 'B', hvec: 5, flag: 'Y', leadMin: 20, hourKST: 13 }).p;
  assert.ok(pN > 0.9, `지금 불가능이면 20분 뒤에도 거의 불가능: ${pN}`);
  assert.ok(pY < 0.2, `계속 가능했던 병원은 낮음: ${pY}`);
  assert.equal(rp({ hpid: 'C', hvec: 5, flag: null, leadMin: 20, hourKST: 13 }).p, null);
  assert.equal(rp({ hpid: 'B', hvec: 0, flag: 'Y', leadMin: 0, hourKST: 13 }).p, 1); // 병상 0 이하도 거절
  close(explainDiseasePoint(dm, { disease: 'MKioskTy2', hpid: 'A', b: 'dN', L: 20, hb: 3 }).p, pN);
});

test('병원 등급(v2): 꽉 찬 적 없는 병원은 늘 꽉 찬 병원에 끌려가지 않는다', async () => {
  const { buildModel, explainPoint, hospitalClass, bedBucket, hourBin } = await import('../engine/model.mjs');
  const t0 = parseKST('2026-10-10 00:00:00');
  const rows = [];
  for (let i = 0; i < 288; i++) {
    const t = t0 + i * 600e3;
    rows.push({ t, hpid: 'BIG', name: '늘 꽉 참', hvec: i % 4 === 0 ? 1 : -3, ageMin: 5 }); // 꽉 찬 비율 75%
    rows.push({ t, hpid: 'CALM', name: '가끔 1개', hvec: i % 12 === 0 ? 1 : 5, ageMin: 5 }); // 한 번도 꽉 차지 않음
    rows.push({ t, hpid: 'MID', name: '가끔 꽉 참', hvec: i % 10 === 0 ? 0 : 3, ageMin: 5 }); // 10%
  }
  const model = buildModel(rows);
  assert.deepEqual(['BIG', 'CALM', 'MID'].map((h) => model.hospitals[h].cls), ['C', 'A', 'B']);
  assert.equal(hospitalClass({ 0: { n: 10, k: 0 } }), null); // 기록이 모자라면 등급 없음
  // CALM이 지금 1개 남았을 때: 같은 등급(A) 기록만 기준으로 써서, BIG의 '1개 → 곧 꽉 참'에 끌려가지 않는다
  const ex = explainPoint(model, { hpid: 'CALM', b: bedBucket(1), L: 20, hb: hourBin(12) });
  assert.equal(ex.method, 'class');
  assert.ok(ex.p < 0.05, `CALM 20분 뒤 ${ex.p}`);
  const big = explainPoint(model, { hpid: 'BIG', b: bedBucket(1), L: 20, hb: hourBin(12) });
  assert.ok(big.p > 0.5, `BIG 20분 뒤 ${big.p}`);
});

test('빠른 열 읽기(readColumns)는 parseCSV로 읽고 열을 고른 것과 같다 (쉼표·따옴표·칸 안 줄바꿈·\\r·빈 줄)', async () => {
  const { parseCSV, readColumns, toCSVLine } = await import('../engine/csv.mjs');
  const head = ['collected_at', 'hpid', 'dutyName', 'hvec', '_extra'];
  const rows = [
    ['2026-10-28 01:00:00', 'A1', '가병원', '3', ''],
    ['2026-10-28 01:00:00', 'A2', '나, 다 병원', '-2', '{"x":"1,2"}'],
    ['2026-10-28 01:00:00', 'A3', '줄\n바꿈 "병원"', '0', ''],
    ['2026-10-28 01:00:00', 'A4', '', '', ''],
  ];
  const text = '﻿' + [head, ...rows].map(toCSVLine).join('\r\n') + '\r\n\n';
  const cols = ['collected_at', 'hpid', 'dutyName', 'hvec', 'missing'];
  const want = parseCSV(text).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? ''])));
  assert.deepEqual(readColumns(text, cols), want);
  assert.equal(want.length, 4);
  assert.equal(want[2].dutyName, '줄\n바꿈 "병원"');
});
