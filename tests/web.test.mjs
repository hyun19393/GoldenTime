import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_FILES } from '../scripts/build-web.mjs';

test('웹앱이 쓰는 계산 코드 복사본이 원본과 같다', () => {
  for (const f of ENGINE_FILES) {
    assert.equal(readFileSync(join('docs/engine', f), 'utf8'), readFileSync(join('engine', f), 'utf8'), f);
  }
});
