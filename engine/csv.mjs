// 작은 CSV 읽기/쓰기 도구 (따옴표, 쉼표, 줄바꿈이 들어간 칸도 처리)

export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM 제거
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows;
  return body
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}

export function toCSVLine(values) {
  return values
    .map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    })
    .join(',');
}

// 큰 CSV에서 필요한 열만 빠르게 읽기 (가용병상 기록처럼 열이 많고 줄이 많은 파일용)
//   따옴표가 없는 줄은 쉼표로 바로 나누고, 따옴표가 있는 줄(칸 안의 쉼표·줄바꿈)은 parseCSV로 정확히 읽는다.
//   결과는 parseCSV로 읽은 뒤 cols만 고른 것과 같다(시험으로 확인).
export function readColumns(text, cols) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const nl = text.indexOf('\n');
  if (nl < 0) return [];
  const headLine = text.slice(0, nl).replace(/\r$/, '');
  const header = Object.keys(parseCSV(headLine + '\n_')[0] ?? {}); // 머리글은 parseCSV로 (칸 이름에 따옴표가 있어도 같게)
  const idx = cols.map((c) => header.indexOf(c));
  const pick = (f) => Object.fromEntries(cols.map((c, j) => [c, idx[j] < 0 ? '' : f[idx[j]] ?? '']));
  const out = [];
  const lines = text.slice(nl + 1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.includes('\r')) line = line.replace(/\r/g, ''); // parseCSV처럼 따옴표 밖의 \r은 버린다
    if (!line.includes('"')) {
      if (line) out.push(pick(line.split(',')));
      continue;
    }
    // 따옴표가 짝이 맞을 때까지(칸 안 줄바꿈) 다음 줄을 붙인다
    let chunk = lines[i];
    while ((chunk.match(/"/g) ?? []).length % 2 && i + 1 < lines.length) chunk += '\n' + lines[++i];
    const row = parseCSV(headLine + '\n' + chunk)[0];
    if (row) out.push(Object.fromEntries(cols.map((c) => [c, row[c] ?? ''])));
  }
  return out;
}
