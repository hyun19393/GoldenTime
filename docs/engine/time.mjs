// 한국 시간(KST, UTC+9) 다루기

const KST = 9 * 3600e3;

// "2026-10-10 00:00:00" (한국 시간) -> 밀리초
export function parseKST(s) {
  return Date.parse(s.trim().replace(' ', 'T') + '+09:00');
}

// 공공데이터 hvidate "20261009235516" -> 밀리초 (형식이 다르면 null)
export function parseHvidate(s) {
  if (!/^\d{14}$/.test(String(s ?? '').trim())) return null;
  const x = String(s).trim();
  return Date.parse(
    `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}T${x.slice(8, 10)}:${x.slice(10, 12)}:${x.slice(12, 14)}+09:00`,
  );
}

export function kstHour(ms) {
  return new Date(ms + KST).getUTCHours();
}

// 밀리초 -> "YYYY-MM-DD HH:mm:ss" (한국 시간)
export function formatKST(ms) {
  return new Date(ms + KST).toISOString().slice(0, 19).replace('T', ' ');
}

// 밀리초 -> "YYYY-MM-DD" (한국 날짜)
export function kstDate(ms) {
  return formatKST(ms).slice(0, 10);
}
