import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';

const dir = mkdtempSync(join(tmpdir(), 'budget-'));
process.env.SERVICE_KEY = 'test-key';
process.env.DATA_DIR = dir;
process.env.RETRY_UNIT_MS = '1';
process.env.BUDGET_MS = '300'; // 0.3초만 허용
const { main } = await import('../collector/collect.mjs?budget');

const wrap = (items) =>
  `<response><header><resultCode>00</resultCode></header><body><items>${items
    .map((o) => '<item>' + Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join('') + '</item>')
    .join('')}</items><totalCount>${items.length}</totalCount></body></response>`;

test('시간이 모자라면 가용병상은 지키고 나머지는 다음 실행으로 넘긴다', async () => {
  globalThis.fetch = async (url) => {
    const op = new URL(url).pathname.split('/').pop();
    if (op === 'getEmrrmRltmUsefulSckbdInfoInqire') {
      await new Promise((r) => setTimeout(r, 400)); // 가용병상 응답이 느려서 시간을 다 씀
      return new Response(wrap([{ hpid: 'A1', dutyName: '가', hvec: '3' }]));
    }
    return new Response(wrap([{ hpid: 'A1', dutyName: '가' }]));
  };
  const res = await main();
  assert.deepEqual(res, [['beds', true], ['severe', null], ['messages', null]]);
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  assert.equal(parseCSV(readFileSync(join(dir, 'beds', `${today}.csv`), 'utf8')).length, 1);
  process.exitCode = 0;
});
