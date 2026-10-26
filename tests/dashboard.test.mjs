// 현황판 재구성 시험: 날짜별 기록 파일, 원인 코드 풀이, 정확도 점검, 계산 단계(steps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDay, main as buildHistory } from '../scripts/build-history.mjs';
import { regularStart } from '../scripts/load.mjs';
import { causeCode, causeText, parseAttempts } from '../engine/causes.mjs';
import { evaluateSplit } from '../engine/validate.mjs';
import { buildModel, explainPoint, explainBase, makeRejectProb, bedBucket, hourBin } from '../engine/model.mjs';
import { parseKST } from '../engine/time.mjs';

const H = '﻿collected_at,hpid,dutyName,hvidate,hvec,hvs01\n';
const row = (t, id, hvec, hv) => `${t},${id},병원${id},${hv},${hvec},10\n`;

test('날짜별 기록: 10분 칸 판정(성공·실패·실행 없음·시작 전), 행렬, 요약', () => {
  const beds = [
    { collected_at: '2026-10-26 00:00:30', hpid: 'A', dutyName: '가', hvidate: '20261026000000', hvec: '0', hvs01: '10' },
    { collected_at: '2026-10-26 00:00:30', hpid: 'B', dutyName: '나', hvidate: '20261025220000', hvec: '5', hvs01: '10' },
    { collected_at: '2026-10-26 00:20:30', hpid: 'A', dutyName: '가', hvidate: '20261026001500', hvec: '2', hvs01: '10' },
  ];
  const runs = [
    { started_at: '2026-10-26 00:00:30', op: 'beds', ok: '1', ms: '1400' },
    { started_at: '2026-10-26 00:10:25', op: 'beds', ok: '0', ms: '40500', error: '경기도: fetch failed' },
    { started_at: '2026-10-26 00:20:30', op: 'beds', ok: '1', ms: '1400' },
  ];
  const { summary, data } = buildDay('2026-10-26', beds, runs, {}, { firstAt: parseKST('2026-10-26 00:00:00'), nowAt: parseKST('2026-10-26 00:45:00') });
  assert.equal(data.slots.slice(0, 5).join(''), 'ofom-'); // 00:30 칸은 기록 없음, 00:40 칸은 아직 안 끝남
  assert.equal(data.slots.filter((s) => s === '-').length, 140);
  assert.deepEqual(data.times, ['00:00:30', '00:20:30']);
  const a = data.hospitals.findIndex((h) => h.hpid === 'A'), b = data.hospitals.findIndex((h) => h.hpid === 'B');
  assert.equal(data.hvec[0][a], 0);
  assert.equal(data.hvec[1][b], null); // B는 두 번째 수집에 없음
  assert.equal(data.age[0][b], 121); // 22:00:00 입력, 00:00:30 수집 → 120.5분 → 반올림 121분
  assert.equal(data.runs[1].cause, 'LEGACY_CONNECT'); // 예전 기록 원인 추정
  assert.deepEqual([summary.okSlots, summary.failSlots, summary.missSlots, summary.expected, summary.fullMax, summary.everFull], [2, 1, 1, 4, 1, 1]);
  assert.equal(summary.staleShare, 1 / 3);
});

test('날짜별 기록: 원본이 그대로인 지난 날짜는 다시 만들지 않는다', () => {
  const d = mkdtempSync(join(tmpdir(), 'hist-'));
  mkdirSync(join(d, 'beds'));
  let a = H, b = H;
  for (let m = 0; m < 60; m += 10) a += row(`2026-10-25 23:${String(m).padStart(2, '0')}:20`, 'A', 3, '20261025230000');
  for (let m = 0; m < 30; m += 10) b += row(`2026-10-26 00:${String(m).padStart(2, '0')}:20`, 'A', 0, '20261026000000');
  writeFileSync(join(d, 'beds', '2026-10-25.csv'), a);
  writeFileSync(join(d, 'beds', '2026-10-26.csv'), b);
  const out = join(d, 'out');
  buildHistory({ data: d, out, now: '2026-10-26 00:35:00' });
  const idx = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(idx.days.map((x) => x.day), ['2026-10-26', '2026-10-25']); // 최근 날짜가 먼저
  writeFileSync(join(out, '2026-10-25.json'), '{"표시":"다시 만들지 않았음"}');
  buildHistory({ data: d, out, now: '2026-10-26 00:45:00' });
  assert.match(readFileSync(join(out, '2026-10-25.json'), 'utf8'), /다시 만들지 않았음/);
});

test('자동 수집 시작 시각: 시험 수집(띄엄띄엄)은 건너뛴다', () => {
  const t = ['17:17', '17:29', '20:52', '21:28', '21:30', '21:40', '21:50'].map((x) => parseKST(`2026-10-25 ${x}:00`));
  assert.equal(regularStart(t), parseKST('2026-10-25 21:28:00'));
});

test('원인 코드 풀이', () => {
  assert.equal(causeCode({ ok: '0', cause: 'UND_ERR_CONNECT_TIMEOUT,ENOTFOUND' }), 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(causeCode({ ok: '0', error: '경기도: fetch failed', ms: '40500' }), 'LEGACY_CONNECT');
  assert.equal(causeCode({ ok: '0', error: 'resultCode=99', ms: '900' }), 'LEGACY');
  assert.equal(causeCode({ ok: '1' }), '');
  assert.equal(causeText('UND_ERR_CONNECT_TIMEOUT')[0], '연결 시간 초과');
  assert.equal(causeText('HTTP_503')[0], '서버 오류(HTTP 503)');
  assert.deepEqual(parseAttempts('https:UND_ERR_CONNECT_TIMEOUT:10.0|http:ECONNRESET:0.3'), [
    { proto: 'https', cause: 'UND_ERR_CONNECT_TIMEOUT', sec: 10 }, { proto: 'http', cause: 'ECONNRESET', sec: 0.3 },
  ]);
});

// 두 병원, 10분 간격 하루치 가짜 기록 (A는 자주 꽉 참, B는 늘 여유)
function fakeRows() {
  const rows = [];
  const t0 = parseKST('2026-10-26 00:00:00');
  for (let i = 0; i < 144; i++) {
    const t = t0 + i * 600e3;
    rows.push({ t, hpid: 'A', name: '가', hvec: Math.floor(i / 6) % 3 === 0 ? 0 : 2, ageMin: 5 });
    rows.push({ t, hpid: 'B', name: '나', hvec: 12, ageMin: 5 });
  }
  return rows;
}

test('계산 단계(steps)의 마지막 값 = 앱이 쓰는 확률, 단계끼리 앞뒤가 이어진다', () => {
  const model = buildModel(fakeRows());
  const rp = makeRejectProb(model);
  for (const hpid of ['A', 'B']) for (const hvec of [0, 2, 12]) for (const L of model.leads) {
    const ex = explainPoint(model, { hpid, b: bedBucket(hvec), L, hb: hourBin(13) });
    assert.equal(ex.steps.at(-1).value, ex.p);
    for (let i = 1; i < ex.steps.length; i++) if (ex.steps[i].how === 'shrink') assert.equal(ex.steps[i].prior, ex.steps[i - 1].value);
    assert.ok(Math.abs(rp({ hpid, hvec, ageMin: 5, leadMin: L, hourKST: 13 }).p - ex.p) < 1e-12);
  }
  const base = explainBase(model, { hpid: 'A', hb: 3 });
  assert.equal(base.steps.at(-1).value, base.p);
});

test('정확도 점검: 시간 순서로 나누고, 짝 수와 점수가 맞게 나온다', () => {
  const v = evaluateSplit(fakeRows(), { split: 0.5 });
  assert.ok(v.cutoff > v.range[0] && v.cutoff < v.range[1]);
  assert.equal(v.trainRows + v.testRows, 288);
  for (const L of [10, 20, 30]) {
    const R = v.byLead[L];
    assert.ok(R.n > 0);
    for (const m of ['ours', 'nowOnly', 'avgOnly']) assert.ok(R.brier[m] >= 0 && R.brier[m] <= 1);
  }
  assert.equal(v.calib.reduce((s, c) => s + c.n, 0), v.byLead[20].n); // 모든 짝이 어느 한 구간에 들어감
});
