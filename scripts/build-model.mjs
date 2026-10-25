// 수집한 가용병상 기록으로 거절 확률 통계표(model.json)를 만든다. 웹앱은 이 파일을 읽어 계산한다.
// 사용법: node scripts/build-model.mjs --data data/beds --out web/model.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSnapshots } from './load.mjs';
import { buildModel } from '../engine/model.mjs';
import { formatKST } from '../engine/time.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const { files, rows } = loadSnapshots(args.data ?? 'data/beds');
const model = buildModel(rows, { source: args.data ?? 'data/beds' });
const out = args.out ?? 'web/model.json';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(model));
console.log(`${files.length}일치, ${rows.length.toLocaleString()}행 → ${out} (짝지은 사례 ${model.pairs.toLocaleString()}건, ${formatKST(model.range[0])} ~ ${formatKST(model.range[1])})`);
