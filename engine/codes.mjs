// 활용가이드(V13)에 나온 코드표

// 중증질환자 수용가능정보 조회(getSrsillDissAceptncPosblInfoInqire)의 MKioskTy 항목
// 값: Y(가능), N 또는 '불가능'(불가), '정보미제공'(모름)
export const SEVERE = {
  MKioskTy28: '응급실 (Emergency gate keeper)',
  MKioskTy1: '[재관류중재술] 심근경색',
  MKioskTy2: '[재관류중재술] 뇌경색',
  MKioskTy3: '[뇌출혈수술] 거미막하출혈',
  MKioskTy4: '[뇌출혈수술] 거미막하출혈 외',
  MKioskTy5: '[대동맥응급] 흉부',
  MKioskTy6: '[대동맥응급] 복부',
  MKioskTy7: '[담낭담관질환] 담낭질환',
  MKioskTy8: '[담낭담관질환] 담도포함질환',
  MKioskTy9: '[복부응급수술] 비외상',
  MKioskTy10: '[장중첩/폐색] 영유아',
  MKioskTy11: '[응급내시경] 성인 위장관',
  MKioskTy12: '[응급내시경] 영유아 위장관',
  MKioskTy13: '[응급내시경] 성인 기관지',
  MKioskTy14: '[응급내시경] 영유아 기관지',
  MKioskTy15: '[저체중출생아] 집중치료',
  MKioskTy16: '[산부인과응급] 분만',
  MKioskTy17: '[산부인과응급] 산과수술',
  MKioskTy18: '[산부인과응급] 부인과수술',
  MKioskTy19: '[중증화상] 전문치료',
  MKioskTy20: '[사지접합] 수족지접합',
  MKioskTy21: '[사지접합] 수족지접합 외',
  MKioskTy22: '[응급투석] HD',
  MKioskTy23: '[응급투석] CRRT',
  MKioskTy24: '[정신과적응급] 폐쇄병동입원',
  MKioskTy25: '[안과적수술] 응급',
  MKioskTy26: '[영상의학혈관중재] 성인',
  MKioskTy27: '[영상의학혈관중재] 영유아',
};

// 응급실 및 중증질환 메시지 조회(getEmrrmSrsillDissMsgInqire)의 symTypCod -> 중증질환자 수용가능정보 항목
export const MSG_TO_SEVERE = {
  Y000: 'MKioskTy28', // 응급실
  Y0010: 'MKioskTy1', Y0020: 'MKioskTy2', Y0031: 'MKioskTy3', Y0032: 'MKioskTy4',
  Y0041: 'MKioskTy5', Y0042: 'MKioskTy6', Y0051: 'MKioskTy7', Y0052: 'MKioskTy8',
  Y0060: 'MKioskTy9', Y0070: 'MKioskTy10', Y0081: 'MKioskTy11', Y0082: 'MKioskTy12',
  Y0091: 'MKioskTy13', Y0092: 'MKioskTy14', Y0100: 'MKioskTy15', Y0111: 'MKioskTy16',
  Y0112: 'MKioskTy17', Y0113: 'MKioskTy18', Y0120: 'MKioskTy19', Y0131: 'MKioskTy20',
  Y0132: 'MKioskTy21', Y0141: 'MKioskTy22', Y0142: 'MKioskTy23', Y0150: 'MKioskTy24',
  Y0160: 'MKioskTy25', Y0171: 'MKioskTy26', Y0172: 'MKioskTy27',
};

// 수용 가능 표시 값을 가능(Y) / 불가(N) / 모름(null)으로 정리
export function normFlag(v) {
  const s = String(v ?? '').trim();
  if (s === 'Y' || s === '가능') return 'Y';
  if (s === 'N' || s === '불가' || s === '불가능') return 'N';
  return null; // '정보미제공', 빈 값 등
}

// 실시간 가용병상(getEmrrmRltmUsefulSckbdInfoInqire)에서 주로 쓰는 항목
export const BED_LABEL = {
  hvec: '응급실 일반병상 (가용)',
  hvs01: '응급실 일반병상 (기준)',
  hv28: '응급실 소아 병상 (가용)',
  hvs02: '응급실 소아 병상 (기준)',
  hv29: '응급실 음압격리 병상 (가용)',
  hv30: '응급실 일반격리 병상 (가용)',
  hvidate: '병원 입력 일시',
};
