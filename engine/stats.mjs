// 간단한 통계 함수 (웹앱의 거리 비교에 쓴다)

// 작은 값부터 1, 2, 3 … 순위. 같은 값은 순위의 평균을 준다 (예: 2등이 둘이면 둘 다 2.5)
export function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

// 피어슨 상관계수 (-1 ~ 1). 값이 모두 같아 계산할 수 없으면 null
export function pearson(a, b) {
  const n = a.length;
  if (n < 2 || b.length !== n) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

// 스피어먼 순위 상관: 순위끼리의 피어슨 상관. 두 기준의 '가까운 순서'가 얼마나 같은지 (1이면 완전히 같음)
export function spearman(a, b) {
  if (a.length < 3) return null;
  return pearson(ranks(a), ranks(b));
}
