// 웹앱(docs/app.html)이 읽을 파일을 만든다. 수집할 때마다 GitHub Actions에서 실행된다.
//   docs/model.json   거절 확률 통계표 (지금까지 모은 가용병상 기록 전체)
//   docs/travel.json  응급실 사이 도로 이동 시간 (시간대별 가장 최근 값) + 표에 없는 짝의 추정 계수
//   docs/engine/      계산 코드(engine/)를 브라우저에서 그대로 쓰도록 복사
// 사용법: node scripts/build-web.mjs [--data data] [--out docs]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSnapshots } from './load.mjs';
import { buildModel } from '../engine/model.mjs';
import { parseCSV } from '../engine/csv.mjs';
import { haversineM } from './travel-matrix.mjs';

export const ENGINE_FILES = ['model.mjs', 'effective.mjs', 'time.mjs'];

// 시간대(8·13·18·23시)별로 가장 최근 파일의 값을 쓴다. 같은 짝이 여러 번 있으면 최근 값.
export function buildTravel(dataDir) {
  const dir = join(dataDir, 'travel');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}\.csv$/.test(f)).sort() : [];
  const slots = {};
  for (const f of files) {
    const hour = Number(f.slice(11, 13));
    const s = (slots[hour] ??= { file: '', t: {} });
    s.file = f.slice(0, 13);
    for (const r of parseCSV(readFileSync(join(dir, f), 'utf8'))) {
      const sec = Number(r.duration_s);
      if (!r.from || !r.to || !Number.isFinite(sec)) continue;
      (s.t[r.from] ??= {})[r.to] = sec;
    }
  }

  // 표에 없는 짝은 직선 거리로 추정: 실제 도로 시간 / 직선 거리의 중앙값 (초/미터)
  const pos = {};
  if (existsSync(join(dataDir, 'hospitals.csv'))) {
    for (const r of parseCSV(readFileSync(join(dataDir, 'hospitals.csv'), 'utf8'))) {
      const lat = Number(r.wgs84Lat), lon = Number(r.wgs84Lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) pos[r.hpid] = { lat, lon };
    }
  }
  const ratios = [];
  for (const s of Object.values(slots)) {
    for (const [a, row] of Object.entries(s.t)) {
      for (const [b, sec] of Object.entries(row)) {
        if (!pos[a] || !pos[b]) continue;
        const m = haversineM(pos[a], pos[b]);
        if (m > 500) ratios.push(sec / m);
      }
    }
  }
  ratios.sort((x, y) => x - y);
  const secPerM = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0.15; // 기록이 없으면 약 시속 24km
  return { slots, estimate: { secPerM, samples: ratios.length } };
}

export function main(args = {}) {
  const DATA = args.data ?? 'data';
  const OUT = args.out ?? 'docs';
  mkdirSync(join(OUT, 'engine'), { recursive: true });

  const { rows } = loadSnapshots(join(DATA, 'beds'));
  const model = buildModel(rows, { source: 'data/beds' });
  writeFileSync(join(OUT, 'model.json'), JSON.stringify(model));

  const travel = buildTravel(DATA);
  writeFileSync(join(OUT, 'travel.json'), JSON.stringify(travel));

  for (const f of ENGINE_FILES) copyFileSync(join('engine', f), join(OUT, 'engine', f));

  const pairs = Object.values(travel.slots).reduce((n, s) => n + Object.values(s.t).reduce((k, r) => k + Object.keys(r).length, 0), 0);
  console.log(`web: 짝지은 사례 ${model.pairs}건, 이동 시간 ${Object.keys(travel.slots).length}개 시간대 ${pairs}쌍 → ${OUT}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  main(Object.fromEntries(a.flatMap((x, i) => (x.startsWith('--') ? [[x.slice(2), a[i + 1]]] : []))));
}
