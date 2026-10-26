// 수집 실패 원인 코드 → 쉬운 말 (수집기가 runs.csv의 cause 칸에 남기는 값)
// 연결 단계 오류는 Node.js(undici)의 오류 코드, 응답 오류는 공공데이터포털 resultCode(API_숫자)다.
export const CAUSES = {
  UND_ERR_CONNECT_TIMEOUT: ['연결 시간 초과', '공공데이터 서버가 10초 안에 연결 요청에 답하지 않았어요(서버까지 연결조차 안 됨).'],
  ECONNREFUSED: ['연결 거부', '서버가 연결을 거절했어요.'],
  ECONNRESET: ['연결 끊김', '연결 도중 서버 쪽에서 끊었어요.'],
  UND_ERR_SOCKET: ['연결 끊김', '데이터를 받는 도중 연결이 끊겼어요.'],
  ENOTFOUND: ['주소 찾기 실패', '서버 주소(DNS)를 찾지 못했어요.'],
  EAI_AGAIN: ['주소 찾기 실패', '서버 주소(DNS) 확인이 일시적으로 안 됐어요.'],
  ETIMEDOUT: ['네트워크 시간 초과', '네트워크에서 응답이 오지 않았어요.'],
  EHOSTUNREACH: ['네트워크 도달 불가', '서버까지 가는 길이 없었어요.'],
  ENETUNREACH: ['네트워크 도달 불가', '실행 컴퓨터의 네트워크가 서버에 닿지 않았어요.'],
  TIMEOUT: ['응답 시간 초과', '연결은 됐지만 20초 안에 응답이 끝나지 않았어요.'],
  GATEWAY: ['공공데이터포털 일시 오류', '포털 게이트웨이가 일시 오류를 돌려줬어요.'],
  TRUNCATED: ['응답 잘림', '전체 개수는 있는데 항목이 비어 있었어요.'],
  BUDGET: ['시간 부족', '한 번 실행에 쓸 수 있는 시간(5.5분)을 넘겨 다음 실행으로 넘겼어요.'],
  SKIPPED: ['건너뜀', '앞에서 가용병상이 같은 서버에 연결하지 못해 이번 실행에서는 부르지 않았어요.'],
  LEGACY_CONNECT: ['연결 시간 초과(추정)', '원인 코드를 남기기 전 기록이에요. 3번 시도에 약 40초가 걸려, 시도마다 약 10초 만에 연결 시간 초과된 것으로 봐요.'],
  LEGACY: ['원인 미기록', '원인 코드를 남기기 전 기록이에요.'],
  API_01: ['포털 응답 오류(01)', 'APPLICATION_ERROR: 제공 기관 시스템 오류'],
  API_02: ['포털 응답 오류(02)', 'DB_ERROR: 제공 기관 데이터베이스 오류'],
  API_03: ['데이터 없음(03)', 'NODATA_ERROR'],
  API_04: ['포털 응답 오류(04)', 'HTTP_ERROR'],
  API_05: ['포털 응답 오류(05)', 'SERVICETIME_OUT: 제공 기관 응답 시간 초과'],
  API_10: ['요청 값 오류(10)', '요청 변수가 잘못됐어요.'],
  API_11: ['요청 값 빠짐(11)', '꼭 필요한 요청 변수가 없어요.'],
  API_12: ['서비스 없음(12)', '해당 오픈 API 서비스가 없거나 폐기됐어요.'],
  API_20: ['접근 거부(20)', '서비스 접근이 거부됐어요(활용 승인 확인).'],
  API_21: ['인증키 일시 정지(21)', '인증키가 일시적으로 사용 중지됐어요.'],
  API_22: ['요청 한도 초과(22)', '하루 요청 한도를 넘었어요.'],
  API_30: ['인증키 오류(30)', '등록되지 않은 인증키예요.'],
  API_31: ['인증키 기한 만료(31)', '활용 기간이 끝났어요.'],
  API_32: ['등록되지 않은 IP(32)', '등록되지 않은 IP에서 불렀어요.'],
  API_99: ['기타 오류(99)', '알 수 없는 오류예요.'],
};

// runs.csv 한 줄 → 원인 코드. 예전 기록(원인 칸 없음)은 오류 글과 걸린 시간으로 추정한다.
export function causeCode(run) {
  if (run.cause) return run.cause.split(',')[0];
  if (run.ok === '1') return '';
  const ms = Number(run.ms);
  if (/fetch failed/.test(run.error ?? '') && ms >= 30000 && ms <= 50000) return 'LEGACY_CONNECT';
  return 'LEGACY';
}

export function causeText(code) {
  if (!code) return ['', ''];
  if (CAUSES[code]) return CAUSES[code];
  const http = /^HTTP_(\d+)$/.exec(code);
  if (http) return [`서버 오류(HTTP ${http[1]})`, http[1].startsWith('5') ? '서버 쪽 오류예요.' : '요청이 거절됐어요.'];
  return [code, ''];
}

// attempts 칸 'https:UND_ERR_CONNECT_TIMEOUT:10.0|http:…' → [{ proto, cause, sec }]
export const parseAttempts = (s) => (s ? s.split('|').map((a) => { const [proto, cause, sec] = a.split(':'); return { proto, cause, sec: Number(sec) }; }) : []);
