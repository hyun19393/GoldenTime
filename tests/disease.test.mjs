import test from 'node:test';
import assert from 'node:assert/strict';
import { DISEASES, diseaseById, assess, scopeOf, isContact, isNegative, flipProb, SEV_FLIP_PER_MIN, itemLabel } from '../engine/disease.mjs';
import { SEVERE } from '../engine/codes.mjs';

const flags = (set = {}) => Array.from({ length: 28 }, (_, i) => set[i + 1] ?? (i === 27 ? 'Y' : '-')).join('');
const msg = (c, d, t) => ({ c, d, t });

test('질환 목록: 아이디가 겹치지 않고, 항목 번호는 공공데이터 1~27 안, 27개 항목을 모두 고를 수 있다', () => {
  assert.equal(new Set(DISEASES.map((d) => d.id)).size, DISEASES.length);
  const used = new Set(DISEASES.flatMap((d) => d.items));
  for (const n of used) assert.ok(SEVERE[`MKioskTy${n}`], `항목 ${n}`);
  assert.equal(used.size, 27);
  assert.equal(itemLabel(3), '[뇌출혈수술] 거미막하출혈');
});

test("표시: 모두 '가능'이면 가능 확인, 하나라도 '불가능'이면 불가, 정보미제공이면 확인 필요", () => {
  const ich = diseaseById.ich;
  assert.equal(assess({ f: flags({ 3: 'Y', 4: 'Y' }) }, ich).tier, 'ok');
  const no = assess({ f: flags({ 3: 'Y', 4: 'N' }) }, ich);
  assert.equal(no.tier, 'no');
  assert.deepEqual(no.noItems, [4]);
  const part = assess({ f: flags({ 3: 'Y' }) }, ich);
  assert.equal(part.tier, 'check');
  assert.deepEqual(part.why, ['일부 항목 정보 없음']);
  assert.deepEqual(assess({ f: flags() }, ich).why, ['질환 정보 없음']);
  assert.equal(assess(undefined, ich).tier, 'check'); // 질환 정보에 없는 병원
  assert.equal(assess({ f: flags({ 3: 'Y', 4: 'Y', 28: 'N' }) }, ich).tier, 'no'); // 응급실 불가능
});

test('고르지 않으면 표시와 상관없이 병상만: 응급실 전체 메시지가 없으면 가능 확인', () => {
  assert.equal(assess({ f: flags() }, diseaseById.none).tier, 'ok');
  assert.equal(assess(undefined, diseaseById.none).tier, 'ok');
});

test('그 질환 항목의 메시지가 있으면 표시가 가능이어도 확인 필요', () => {
  const r = assess({ f: flags({ 1: 'Y' }), m: [msg('Y0010', '', '08:30-13:30 심근경색 재관류 불가')] }, diseaseById.mi);
  assert.equal(r.tier, 'check');
  assert.deepEqual(r.why, ['이 질환 메시지 1건']);
  assert.equal(assess({ f: flags({ 2: 'Y' }), m: [msg('Y0010', '', 'x 불가')] }, diseaseById.stroke).tier, 'ok'); // 다른 항목의 메시지
});

test('사전 연락 글: 전문의의 문의에 속지 않고, 전원만 말하는 글은 뺀다', () => {
  for (const t of ['산부인과 사전 연락 후 수용여부 결정', '119 구급대원께서는 문의 후 이송 부탁드립니다.', '119 : Pre KTAS 1~2 환자 통보(고지) 후 내원',
    '[위장관 응급내시경(성인)] 반드시 수용 여부 사전 확인', 'f/u 은 미리 전화 부탁드립니다.', '환자 수용여부 확인 부탁드립니다.', '(필요 시 문의바랍니다.)'])
    assert.equal(isContact(t), true, t);
  for (const t of ['담당 전문의 부재로 angio 불가', '신경외과 전문의 부재', '전원 문의는 핫라인 무선전화(휴대폰)를 통해 연락 바랍니다.', '이송 및 전원에 참고 바랍니다.', '응급실 포화', '소아청소년과 : 24시간 진료 가능'])
    assert.equal(isContact(t), false, t);
});

test('받기 어렵다는 글과 안내 글 구분', () => {
  for (const t of ['응급실 포화', 'CPR 외 수용불가', '중환자실 full bed', '상시시간(외래진료가능시간)만 진료가능', '응급실 인력부족으로 경증환자 수용자제']) assert.equal(isNegative(t), true, t);
  for (const t of ['소아청소년과 : 24시간 진료 가능', '자해, 자살, 약물중독 환자 : 적극 수용', '소아 외상환자 수용가능']) assert.equal(isNegative(t), false, t);
});

test('메시지 범위: 응급실 전체 · 관련 진료과 · 낱말 · 관계없음', () => {
  const { ich, mi, none, trauma, abd } = diseaseById;
  assert.equal(scopeOf(msg('Y000', '응급실', '응급실 포화'), none), 'er');
  assert.equal(scopeOf(msg('Y000', '병상 또는 장비', '중환자실 full bed'), ich), 'er');
  assert.equal(scopeOf(msg('Y000', '응급실', '[안과] 응급 안과 적출에 준하는 상황의 경우, 안과 당직 문의 후 수용 여부 확인'), ich), null); // 응급실 칸이지만 안과 이야기
  assert.equal(scopeOf(msg('Y000', '신경외과', '신경외과 진료불가'), ich), 'dept');
  assert.equal(scopeOf(msg('Y000', '응급실', '[뇌출혈수술] 중환자실 여부에 따라 수용 가능 (필요 시 문의 바랍니다.)'), ich), 'word');
  assert.equal(scopeOf(msg('Y000', '감염내과', '감염내과 - 신환 수용 불가'), mi), null); // '감염내과'를 '내과'로 잡지 않는다
  assert.equal(scopeOf(msg('Y000', '응급실', '금일 내과 당직의 부재로 내과환자는 입원 불가합니다.'), mi), 'dept');
  assert.equal(scopeOf(msg('Y000', '성형외과', '성형외과 진료 불가능'), ich), null);
  assert.equal(scopeOf(msg('Y000', '응급실', '중증외상불가'), trauma), 'word');
  assert.equal(scopeOf(msg('Y000', '외과', '[복부응급수술(비외상)]Appendicitis 신환 수용 불가'), trauma), null); // '비외상'은 외상이 아니다
  assert.equal(scopeOf(msg('Y000', '외과', '[복부응급수술(비외상)]Appendicitis 신환 수용 불가'), abd), 'word');
});

test('응급실 전체 메시지: 받기 어렵다는 글이면 확인 필요, 안내 글이면 그대로 가능 확인', () => {
  const ok = { f: flags({ 3: 'Y', 4: 'Y' }) };
  assert.equal(assess({ ...ok, m: [msg('Y000', '응급실', '응급실 포화 CPR제외 이송자제')] }, diseaseById.ich).tier, 'check');
  const info = assess({ ...ok, m: [msg('Y000', '응급실', '전원 문의는 핫라인 무선전화(휴대폰)를 통해 연락 바랍니다.')] }, diseaseById.ich);
  assert.equal(info.tier, 'ok');
  assert.equal(info.rel.length, 1);
  const call = assess({ ...ok, m: [msg('Y000', '응급실', '119 구급대원께서는 문의 후 이송 부탁드립니다.'), msg('Y000', '피부과', '피부과 진료 불가')] }, diseaseById.ich);
  assert.equal(call.tier, 'check');
  assert.equal(call.contact.length, 1);
  assert.equal(call.other.length, 1);
  assert.deepEqual(call.why, ['관련 메시지 1건', '사전 연락 필요']);
});

test("심정지: 'CPR만 가능'은 받는다는 글이라 막지 않고, 'CPR 포함 수용불가'는 확인 필요", () => {
  const a = diseaseById.arrest;
  assert.equal(assess({ m: [msg('Y000', '응급실', '침상 및 모니터 부족으로 CPR만 가능합니다')] }, a).tier, 'ok');
  assert.equal(assess({ m: [msg('Y000', '응급실', '병실 및 중환자실 포화로 CPR은 수용 가능, f/u 은 미리 전화 부탁드립니다.')] }, a).contact.length, 0);
  assert.equal(assess({ m: [msg('Y000', '응급실', 'CPR 포함 수용불가 / 응급실 과밀화')] }, a).tier, 'check');
  assert.equal(assess({ m: [msg('Y000', '응급실', '침상 및 모니터 부족으로 CPR만 가능합니다')] }, diseaseById.none).tier, 'check'); // 다른 환자에게는 막는 글
});

test('가능 → 불가능 바뀔 확률: 시간에 비례하고 항목이 많으면 조금 커진다', () => {
  assert.equal(flipProb(0, 1), 0);
  assert.ok(Math.abs(flipProb(60, 1) - 1200 / 2875904) < 1e-12);
  assert.ok(flipProb(30, 2) > flipProb(30, 1) && flipProb(30, 2) < 2 * flipProb(30, 1) + 1e-12);
  assert.equal(flipProb(30, 0), 0);
  assert.ok(SEV_FLIP_PER_MIN > 0 && SEV_FLIP_PER_MIN < 1e-4);
});
