// 웹앱(docs/app.html)이 읽을 파일을 만든다. 수집할 때마다 GitHub Actions에서 실행된다.
//   docs/model.json   거절 확률 통계표 (지금까지 모은 가용병상 기록 전체)
//   docs/validation.json  정확도 점검 (앞 70% 기간으로 만든 통계표가 뒤 30% 기간을 얼마나 맞히는지)
//   docs/engine/      계산 코드(engine/)를 브라우저에서 그대로 쓰도록 복사
// 사용법: node scripts/build-web.mjs [--data data] [--out docs]
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSnapshots, loadSevereByKey } from './load.mjs';
import { buildDiseaseModels } from '../engine/severe.mjs';
import { buildModel } from '../engine/model.mjs';
import { evaluateSplit } from '../engine/validate.mjs';

// 웹앱(app.html)·현황판(index.html)이 실제로 불러오는 계산 코드만 복사한다. 질환별 계산을 켤 때 severe.mjs·codes.mjs를 다시 넣는다.
export const ENGINE_FILES = ['model.mjs', 'effective.mjs', 'time.mjs', 'geo.mjs', 'stats.mjs', 'causes.mjs'];

export function main(args = {}) {
  const DATA = args.data ?? 'data';
  const OUT = args.out ?? 'docs';
  mkdirSync(join(OUT, 'engine'), { recursive: true });

  const { rows } = loadSnapshots(join(DATA, 'beds'));
  const model = buildModel(rows, { source: 'data/beds' });
  writeFileSync(join(OUT, 'model.json'), JSON.stringify(model));
  const check = evaluateSplit(rows);
  if (check) writeFileSync(join(OUT, 'validation.json'), JSON.stringify({ createdAt: new Date().toISOString(), ...check }));

  // 질환별 통계표(engine/severe.mjs)는 데이터가 충분히 모인 뒤 다시 다듬어 켠다. 지금은 만들지 않는다.
  if (args.severe) {
    writeFileSync(join(OUT, 'model-severe.json'), JSON.stringify(buildDiseaseModels(rows, loadSevereByKey(join(DATA, 'severe')))));
  }

  for (const f of ENGINE_FILES) copyFileSync(join('engine', f), join(OUT, 'engine', f));

  console.log(`web: 짝지은 사례 ${model.pairs}건 → ${OUT}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  main(Object.fromEntries(a.flatMap((x, i) => (x.startsWith('--') ? [[x.slice(2), a[i + 1]]] : []))));
}
