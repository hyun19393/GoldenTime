import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTravel, ENGINE_FILES } from '../scripts/build-web.mjs';

test('이동 시간표: 시간대별 최근 파일 값, 직선 거리 추정 계수', () => {
  const d = mkdtempSync(join(tmpdir(), 'gt-'));
  mkdirSync(join(d, 'travel'));
  writeFileSync(join(d, 'hospitals.csv'), 'hpid,wgs84Lat,wgs84Lon\nA,37.30,127.10\nB,37.31,127.10\n');
  const h = 'computed_at,from,to,duration_s,distance_m,method\n';
  writeFileSync(join(d, 'travel', '2026-10-24_08.csv'), h + 'x,A,B,100,1,multi\n');
  writeFileSync(join(d, 'travel', '2026-10-25_08.csv'), h + 'x,A,B,222,1,multi\n');
  writeFileSync(join(d, 'travel', '2026-10-25_18.csv'), h + 'x,B,A,300,1,multi\nx,B,C,bad,1,multi\n');
  const t = buildTravel(d);
  assert.deepEqual(Object.keys(t.slots).sort(), ['18', '8']);
  assert.equal(t.slots[8].t.A.B, 222);
  assert.equal(t.slots[18].t.B.C, undefined);
  assert.equal(t.estimate.samples, 2);
  const m = 1112; // A~B 직선 약 1.11km
  assert.ok(Math.abs(t.estimate.secPerM - 300 / m) < 0.01);
});

test('웹앱이 쓰는 계산 코드 복사본이 원본과 같다', () => {
  for (const f of ENGINE_FILES) {
    assert.equal(readFileSync(join('docs/engine', f), 'utf8'), readFileSync(join('engine', f), 'utf8'), f);
  }
});
