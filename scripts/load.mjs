// 수집한 가용병상 CSV(날짜별 파일)를 읽어 통계에 쓰는 형태로 바꾼다.
// 필요한 열: collected_at, hpid, dutyName, hvidate, hvec
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCSV } from '../engine/csv.mjs';
import { parseKST, parseHvidate } from '../engine/time.mjs';

export function loadSnapshots(dir) {
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();
  const rows = [];
  for (const f of files) {
    for (const r of parseCSV(readFileSync(join(dir, f), 'utf8'))) {
      const t = parseKST(r.collected_at);
      const hv = parseHvidate(r.hvidate);
      const hvec = r.hvec === '' ? NaN : Number(r.hvec);
      rows.push({
        t,
        hpid: r.hpid,
        name: r.dutyName,
        hvec,
        hvs01: r.hvs01 === '' || r.hvs01 == null ? NaN : Number(r.hvs01),
        ageMin: hv == null ? Infinity : (t - hv) / 60e3,
      });
    }
  }
  return { files, rows };
}

// 중증질환 수용가능정보 CSV → `${수집 시각(ms)}|${hpid}` 로 찾는 표 (가용병상과 같은 실행에서 같은 시각으로 저장된다)
export function loadSevereByKey(dir) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x)).sort()) {
    for (const r of parseCSV(readFileSync(join(dir, f), 'utf8'))) map.set(`${parseKST(r.collected_at)}|${r.hpid}`, r);
  }
  return map;
}
