import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';

const dir = mkdtempSync(join(tmpdir(), 'regions-'));
process.env.SERVICE_KEY = 'test-key';
process.env.DATA_DIR = dir;
process.env.STAGES = '서울특별시, 경기도,인천광역시';
const { main, STAGES } = await import('../collector/collect.mjs?regions');

const wrap = (items) =>
  `<response><header><resultCode>00</resultCode></header><body><items>${items
    .map((o) => '<item>' + Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join('') + '</item>')
    .join('')}</items><totalCount>${items.length}</totalCount></body></response>`;

test('여러 시도: 시도마다 따로 불러 한 파일에 합치고, 한 곳이 실패해도 나머지는 저장', async () => {
  assert.deepEqual(STAGES, ['서울특별시', '경기도', '인천광역시']);
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const op = u.pathname.split('/').pop();
    const region = u.searchParams.get('STAGE1') ?? u.searchParams.get('Q0');
    if (op === 'getEgytBassInfoInqire') return new Response(wrap([{ hpid: u.searchParams.get('HPID') }]));
    if (region === '인천광역시' && op === 'getEmrrmRltmUsefulSckbdInfoInqire')
      return new Response('<response><header><resultCode>99</resultCode><resultMsg>ERR</resultMsg></header></response>');
    return new Response(wrap([{ hpid: `${region}-1`, dutyName: region, hvec: '2', symTypCod: 'Y000' }]));
  };
  const res = await main();
  assert.deepEqual(res[0], ['beds', false]); // 인천 실패로 실패 표시
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const beds = parseCSV(readFileSync(join(dir, 'beds', `${today}.csv`), 'utf8'));
  assert.deepEqual(beds.map((r) => r.dutyName), ['서울특별시', '경기도']);
  const severe = parseCSV(readFileSync(join(dir, 'severe', `${today}.csv`), 'utf8'));
  assert.equal(severe.length, 3);
  const runs = parseCSV(readFileSync(join(dir, 'runs.csv'), 'utf8'));
  assert.match(runs.find((r) => r.op === 'beds').error, /인천광역시/);
  process.exitCode = 0;
});
