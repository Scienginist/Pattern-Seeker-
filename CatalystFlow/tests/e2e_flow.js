// 실제 화면을 클릭·입력하며 250 g 배치 흐름을 검증한다.
// 사용: node tests/e2e_flow.js http://127.0.0.1:8765 <스크린샷 폴더> <백업 폴더>
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const SHOTS = process.argv[3] || '.';
const BKDIR = process.argv[4] || '/tmp';
const external = [];
const consoleErrors = [];
let step = 0;
const log = m => console.log(`[${String(++step).padStart(2, '0')}] ${m}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  // 15. 인터넷 차단: 127.0.0.1 외 모든 요청을 막고 기록
  await ctx.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return r.continue();
    external.push(u.href); return r.abort();
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  const P = '#panel';
  const field = name => page.locator(`${P} [data-field="${name}"]`);
  const fill = async (name, v) => { await field(name).locator('input,textarea').first().fill(String(v)); };
  const seg = async (name, label) => { await field(name).locator('.seg button', { hasText: label }).first().click(); };
  const save = async () => { await page.keyboard.press('Control+s'); };
  const waitSaved = async () => { await page.locator('#toast:not([hidden])').waitFor(); await page.locator(P).waitFor({ state: 'hidden' }); await page.waitForTimeout(250); };
  const panelError = async () => page.locator(`${P} .errbox`).innerText();
  const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chip = label => page.locator('[data-mat]', { hasText: new RegExp('^\\s*' + reEsc(label) + '\\s') });
  const apiGet = p => page.evaluate(async p => (await fetch('/api/' + p, { headers: { 'X-CF-Token': document.querySelector('meta[name=cf-token]').content } })).json(), p);
  const apiCmd = (n, payload) => page.evaluate(async ([n, payload]) => (await fetch('/api/cmd/' + n, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CF-Token': document.querySelector('meta[name=cf-token]').content }, body: JSON.stringify({ payload, op_id: 'x' + Math.random() }) })).json(), [n, payload]);
  const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false });

  await page.goto(BASE);
  await page.locator('h1', { hasText: '현황' }).waitFor();
  await shot('01-home-empty');
  log('빈 현황 화면 열림');

  // ---- 원료 입고
  await page.click('a[data-nav=raw]');
  await page.click('button:has-text("+ 입고 등록")');
  await fill('lot_code', 'IR-2611-01'); await fill('received_qty_g', 1000);
  await field('received_date').locator('button', { hasText: '오늘' }).click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(`${P} .save-state`).innerText(), /초안 자동저장됨.*아직 등록되지 않음/);
  await save(); await waitSaved();
  assert.match(await page.locator('main').innerText(), /IR-2611-01[\s\S]*1,000 g/);
  log('원료 입고: 초안 상태와 등록 완료가 구분되어 표시됨');

  // ---- 배치 등록
  await page.click('a[data-nav=home]');
  await page.click('main button:has-text("+ 새 배치")');
  await fill('code', 'B-261110'); await fill('title', 'IrOx 250 g 배치');
  await save();
  await page.waitForURL(/#\/batch\/\d+/);
  const batchUrl = page.url();
  const batchId = Number(batchUrl.match(/batch\/(\d+)/)[1]);
  await page.locator('.next-bar .btn.pri', { hasText: '원료 투입' }).waitFor();
  log('배치 등록 → 다음 행동 "원료 투입"이 가장 크게 보임');

  // ---- 원료 250 g 투입 → 전구체 슬러리 1,839 g
  await page.click('.next-bar .btn.pri');
  await field('raw_lines').locator('input[type=number]').fill('250');
  await fill('out_qty', 1839);
  await save(); await waitSaved();
  assert.match(await chip('전구체 슬러리').innerText(), /1,839g/);
  log('원료 250 g 투입, 슬러리 1,839 g(실측) 생성');

  // ---- 31 × 50 g 소분 (검증 1)
  await chip('전구체 슬러리').click();
  await page.click('.selbar button:has-text("같은 양으로 소분")');
  await fill('count', 31); await fill('per_qty_g', 50);
  await page.locator(`${P} .preview .big`).waitFor();
  await page.waitForFunction(() => /1,550/.test(document.querySelector('#panel .preview')?.innerText || ''));
  const pv = await page.locator(`${P} .preview`).innerText();
  assert.match(pv, /31개 · 총 1,550 g/); assert.match(pv, /도가니 01 ~ 도가니 31/); assert.match(pv, /289 g[\s\S]*계산/);
  await shot('02-split-preview');
  await save(); await waitSaved();
  assert.equal(await page.locator('[data-mat]', { hasText: '도가니' }).count(), 31);
  assert.match(await chip('전구체 슬러리').innerText(), /289g·계산/);
  let raw = await apiGet('raw');
  assert.equal(raw[0].lots[0].remaining_g, 750);
  log('검증1: 31 × 50 g = 1,550 g, 도가니 01~31 자동 생성, 잔량 289 g(계산) — 저장 한 번');

  // ---- 열처리 (제자리 처리) — 슬러리는 선택하지 않음
  await page.locator('.lane').first().locator('button:has-text("이 가지 전체 선택")').click();
  await chip('전구체 슬러리').click(); // 잔여 슬러리 제외
  assert.match(await page.locator('.selbar').innerText(), /31개 선택/);
  await page.click('.selbar button:has-text("공정 기록")');
  await fill('name', '열처리');
  await field('inputs').locator('select[data-allrole]').selectOption('through');
  await fill('after_form', '소성 분말');
  await field('after_qty_reset').locator('input').check();
  await fill('equipment', '대형 퍼니스');
  await fill('observations', '도가니 4개에서 노란색 기체가 머무는 것 관찰');
  await save(); await waitSaved();
  raw = await apiGet('raw');
  assert.equal(raw[0].lots[0].remaining_g, 750);
  log('검증2: 열처리 기록 후에도 원료 잔량 750 g (재차감 없음)');

  // ---- 확인군 4개 가지로 옮기기
  await chip('도가니 01').click();
  await chip('도가니 04').click({ modifiers: ['Shift'] });
  assert.match(await page.locator('.selbar').innerText(), /4개 선택/);
  await page.click('.selbar button:has-text("가지로 옮기기")');
  await fill('reason', '열처리 중 노란 기체 머묾');
  await save(); await waitSaved();
  const lanes = page.locator('.lane');
  assert.equal(await lanes.count(), 2);
  assert.equal(await lanes.nth(1).locator('[data-mat]').count(), 4);
  let d = await apiGet('batch/' + batchId);
  assert.equal(d.materials.length, 32);
  log('검증4: 도가니 4개를 확인군 가지로 이동 — 새 물질 생성 없음(총 32개 유지)');

  // ---- 세척을 시작으로 기록하면서 실수로 잔여 슬러리까지 선택 (검증 9용)
  await lanes.first().locator('button:has-text("이 가지 전체 선택")').click();
  assert.match(await page.locator('.selbar').innerText(), /28개 선택/);
  await page.click('.selbar button:has-text("합치기")');
  await fill('name', '세척 (질산→물→물)');
  await seg('status', '시작(진행 중)');
  await fill('equipment', '대형 필터링');
  await save(); await waitSaved();
  assert.equal(await chip('전구체 슬러리').count(), 0);
  log('세척 시작 기록(실수로 잔여 슬러리 포함)');

  // ---- 검증 6: 초안 분리 — 세척 완료 초안 / 소분 수정 초안
  d = await apiGet('batch/' + batchId);
  const wash = d.steps.find(s => s.name.startsWith('세척'));
  const split = d.steps.find(s => s.kind === 'split');
  await page.locator('.steps li', { hasText: '세척 (질산' }).locator('button:has-text("완료 기록")').click();
  await fill('observations', '세척 관찰 A: 여액 맑음');
  await page.waitForTimeout(800);
  const washTitle = await page.locator(`${P} .t`).innerText();
  await page.locator('.steps li', { hasText: '소분' }).locator('button:has-text("수정")').click();
  await page.locator(`${P} .t`, { hasText: '공정 수정' }).waitFor();
  await fill('name', '슬러리 소분 31개 (수정 초안)');
  await page.waitForTimeout(800);
  await page.click(`${P} [data-x=close]`);
  await page.locator('.steps li', { hasText: '세척 (질산' }).locator('button:has-text("완료 기록")').click();
  await page.locator(`${P} .draftbox`).waitFor();
  assert.equal(await page.locator(`${P} .t`).innerText(), washTitle);
  assert.equal(await field('observations').locator('textarea').inputValue(), '세척 관찰 A: 여액 맑음');
  assert.equal(await field('name').count(), 0); // 수정 초안의 필드가 섞이지 않음
  log('검증6: 세척 완료 초안과 소분 수정 초안이 섞이지 않음(제목·공정 ID 유지)');

  // ---- 검증 7: 앱 재실행(페이지 새로고침) 후 초안 복구
  await page.waitForTimeout(700);
  await page.reload();
  await page.goto(BASE + '/#/');
  await page.locator('.card h3', { hasText: '작성 중인 초안' }).waitFor();
  assert.equal(await page.locator('button:has-text("이어서 작성")').count(), 2);
  await shot('03-home-drafts');
  await page.locator('li', { hasText: '완료 기록 · 세척' }).locator('button:has-text("이어서 작성")').click();
  await page.locator(`${P} .draftbox`).waitFor();
  assert.equal(await field('observations').locator('textarea').inputValue(), '세척 관찰 A: 여액 맑음');
  log('검증7: 다시 열어도 마지막 입력 복구, 홈에 "작성 중인 초안" 표시');
  await page.click(`${P} [data-x=close]`);

  // ---- 검증 9: 잘못 포함한 잔여 슬러리만 제외
  await page.locator('.steps li', { hasText: '세척 (질산' }).locator('button:has-text("연결 정정")').click();
  await field('cur').locator('.it', { hasText: '전구체 슬러리' }).locator('input').check();
  await fill('reason', '잔여 슬러리는 세척에 넣지 않았음');
  await save(); await waitSaved();
  assert.match(await chip('전구체 슬러리').innerText(), /289g·계산/);
  d = await apiGet('batch/' + batchId);
  assert.equal(d.steps.find(s => s.id === wash.id).io.filter(i => i.role === 'in').length, 27);
  log('검증9: 연결 정정으로 잔여 슬러리만 제외 → 289 g 복원, 투입 27개');

  // ---- 세척 완료(초안 이어서) → 산출 케이크
  await page.locator('.steps li', { hasText: '세척 (질산' }).locator('button:has-text("완료 기록")').click();
  await page.locator(`${P} .draftbox`).waitFor();
  await field('outputs').locator('button[data-add]').click();
  await field('outputs').locator('[data-k=label]').fill('정상군 세척 케이크');
  await field('outputs').locator('[data-k=mass_basis]').selectOption('wet');
  await save(); await waitSaved();

  // ---- 동결건조 → 분말 205.4 g
  await chip('정상군 세척 케이크').click();
  await page.click('.selbar button:has-text("공정 기록")');
  await fill('name', '동결건조');
  await field('outputs').locator('button[data-add]').click();
  await field('outputs').locator('[data-k=label]').fill('IrOx 분말 (정상군)');
  await field('outputs').locator('[data-k=form]').fill('분말');
  await field('outputs').locator('[data-k=mass_basis]').selectOption('dry');
  await field('outputs').locator('[data-k=qty_g]').fill('205.4');
  // 검증 11: 더블클릭 — 저장 버튼 두 번
  await page.locator(`${P} [data-x=submit]`).dblclick();
  await waitSaved();
  d = await apiGet('batch/' + batchId);
  assert.equal(d.steps.filter(s => s.name === '동결건조').length, 1);
  assert.equal(d.materials.filter(m => m.label === 'IrOx 분말 (정상군)').length, 1);
  log('검증11a: 저장 버튼 더블클릭에도 공정·물질 1번만 생성');

  // ---- 검증 11b: 응답 유실 후 재시도(같은 op_id) → 중복 없음
  await chip('IrOx 분말 (정상군)').click();
  await page.click('.selbar button:has-text("제품 등록")');
  await fill('code', 'P-261120-01');
  let dropped = false;
  await page.route('**/api/cmd/register_product', async r => {
    if (!dropped) { dropped = true; await r.fetch(); return r.abort('connectionreset'); } // 서버는 저장했지만 응답 유실
    return r.continue();
  });
  await save();
  await page.locator(`${P} .errbox`).waitFor();
  assert.match(await panelError(), /연결하지 못했습니다/);
  await save(); await waitSaved();
  await page.unroute('**/api/cmd/register_product');
  const prods = await apiGet('products');
  assert.equal(prods.length, 1);
  assert.equal(prods[0].remaining_g, 205.4);
  log('검증11b: 응답이 끊긴 뒤 다시 저장해도 제품 1건만 등록(같은 op_id 재사용)');

  // ---- 검증 12: 필수 QC 전 합격 불가
  await page.click('a[data-nav=products]');
  await page.click('button:has-text("판정")');
  await seg('decision', '합격'); await fill('reason', '좋아 보임');
  await save();
  await page.locator(`${P} .errbox`).waitFor();
  assert.match(await panelError(), /필수 QC 결과와 대표성 확인/);
  await page.click(`${P} [data-x=close]`);
  // 결과 입력: 6종 수령 + 대표성
  const pr = (await apiGet('products'))[0];
  for (const q of pr.qc) {
    await page.click('a[data-nav=products]');
    await page.locator('.card', { hasText: 'P-261120-01' }).locator(`button:has-text("${q.test} ")`).first().click();
    await seg('status', '결과 수령');
    await fill('result_summary', `${q.test} 기준 충족`);
    if (q.test === 'XRD') await fill('evidence_path', 'D:\\분석\\XRD\\P-261120-01.raw');
    await seg('representative', '대표함');
    await save(); await waitSaved();
  }
  assert.ok((await apiGet('products'))[0].qc_state.ready);
  assert.equal((await apiGet('products'))[0].qc_state.decision, null);
  await page.click('a[data-nav=products]');
  await page.click('button:has-text("판정")');
  await seg('decision', '합격'); await fill('reason', '필수 6종 충족, 기존 양품과 동등');
  await save(); await waitSaved();
  assert.match(await page.locator('main').innerText(), /합격/);
  log('검증12: 필수 결과 전 합격 차단, 결과·대표성 확인 후 사용자가 직접 합격 판정');

  // ---- 제품 사용
  await page.click('button:has-text("사용 기록")');
  await seg('purpose', 'QC'); await fill('qty_g', 2);
  await save(); await waitSaved();
  assert.equal((await apiGet('products'))[0].remaining_g, 203.4);
  log('제품 사용(QC 2 g) → 잔량 203.4 g');

  // ---- 검증 8: 완료 공정 수정 + 이력
  await page.goto(batchUrl);
  await page.locator('.steps li', { hasText: '소분' }).locator('button:has-text("수정")').click();
  await page.locator(`${P} .draftbox`).waitFor(); // 앞서 남긴 수정 초안
  await fill('name', '슬러리 소분 31개');
  await fill('actual_start', '2026-11-10T13:00');
  await save(); await waitSaved();
  await page.locator('.steps li', { hasText: '슬러리 소분 31개' }).locator('button:has-text("이력")').click();
  await page.locator(`${P} table`).waitFor();
  const hist = await page.locator(P).innerText();
  assert.match(hist, /name: 소분 31개 × 50 g → 슬러리 소분 31개/);
  assert.match(hist, /actual_start: \(없음\) → 2026-11-10 13:00/);
  await page.click(`${P} [data-x=close]`);
  log('검증8: 완료 공정 수정, 변경 이력에 수정 전/후 값 표시');

  // ---- 검증 10: 후속 연결 때문에 막힌 정정은 아무것도 바꾸지 않음 + 이유 안내
  const before = JSON.stringify((await apiGet('batch/' + batchId)).materials);
  await page.locator('.steps li', { hasText: '세척 (질산' }).locator('button:has-text("연결 정정")').click();
  await field('cur').locator('.it').first().locator('input').check();
  await field('cur').locator('.it', { hasText: '정상군 세척 케이크' }).locator('input').check();
  await fill('reason', '시험');
  await save();
  await page.locator(`${P} .errbox`).waitFor();
  assert.match(await panelError(), /동결건조/);
  assert.equal(JSON.stringify((await apiGet('batch/' + batchId)).materials), before);
  await shot('04-linked-correction-blocked');
  await page.click(`${P} [data-x=close]`);
  log('검증10: 후속 공정에 연결된 산출 제거 시도 → 이유 안내, 일부 변경도 남지 않음');

  // ---- 검증 13: 생산 가지 완료 후 연구 가지 계속
  await page.locator('.lane').first().locator('button:has-text("가지 설정")').click();
  await seg('status', '완료');
  await save(); await waitSaved();
  await page.click('main button:has-text("+ 가지")');
  await fill('name', '잔여 슬러리 연구'); await fill('condition_diff', '히팅맨틀 열처리, 스터링 유/무 비교');
  await save(); await waitSaved();
  await chip('전구체 슬러리').click();
  await page.click('.selbar button:has-text("같은 양으로 소분")');
  await fill('count', 2); await fill('per_qty_g', 25);
  await fill('label_prefix', '석영 비커 100mL');
  await page.locator(`${P} details.adv summary`).click();
  await field('target_branch_id').locator('select').selectOption({ label: '잔여 슬러리 연구' });
  await page.waitForFunction(() => /239/.test(document.querySelector('#panel .preview')?.innerText || ''));
  await save(); await waitSaved();
  const rlane = page.locator('.lane', { hasText: '잔여 슬러리 연구' });
  assert.equal(await rlane.locator('[data-mat]').count(), 2);
  await chip('석영 비커 100mL 01').click();
  await page.click('.selbar button:has-text("공정 기록")');
  await fill('name', '히팅맨틀 열처리 (스터링 O)');
  await field('inputs').locator('select[data-allrole]').selectOption('through');
  await save(); await waitSaved();
  await rlane.locator('button:has-text("+ 공정 기록")').click();
  await seg('status', '계획만');
  await fill('name', '1 L 석영 비커 확대 (~225 g)');
  await fill('scheduled_date', '2026-12-01');
  await save(); await waitSaved();
  assert.match(await page.locator('.next-bar').innerText(), /1 L 석영 비커 확대/);
  log('검증13: 생산 가지 완료 후에도 연구 가지 소분·공정·계획 진행, 잔량 239 g');
  await shot('05-batch-view');

  // ---- 오래 열린 창 충돌
  await page.locator('.steps li', { hasText: '히팅맨틀' }).locator('button:has-text("수정")').click();
  await fill('equipment', '오래된 창의 값');
  d = await apiGet('batch/' + batchId);
  const hs = d.steps.find(s => s.name.startsWith('히팅맨틀'));
  await apiCmd('update_step', { step_id: hs.id, version: hs.version, equipment: '히팅맨틀 #2' });
  await save();
  await page.locator(`${P} .errbox`).waitFor();
  assert.match(await panelError(), /다른 곳에서 먼저 수정/);
  assert.equal((await apiGet('batch/' + batchId)).steps.find(s => s.id === hs.id).equipment, '히팅맨틀 #2');
  await page.click(`${P} [data-x=reload]`);
  await page.locator(`${P} .errbox`).waitFor({ state: 'detached' });
  await field('equipment').waitFor();
  assert.equal(await page.locator(`${P} .draftbox`).count(), 0);
  assert.equal(await field('equipment').locator('input').inputValue(), '히팅맨틀 #2');
  await page.click(`${P} [data-x=close]`);
  log('오래 열린 창의 저장은 충돌로 막히고, 최신 내용으로 다시 열 수 있음');

  // ---- 홈 대시보드
  await page.click('a[data-nav=home]');
  await page.locator('h2', { hasText: '진행 중인 배치' }).waitFor();
  const home = await page.locator('main').innerText();
  assert.match(home, /B-261110/); assert.match(home, /2026-12-01/); assert.match(home, /IrCl₃[\s\S]*750 g/);
  assert.match(home, /P-261120-01/);
  await shot('06-home-dashboard');
  log('현황: 배치·가지별 현재 작업, 일정(2026-12-01), 원료 750 g, 제품·판정 표시');

  // ---- 검증 14: 백업 → 변경 → 복원
  const snapshot = async () => JSON.stringify({ raw: await apiGet('raw'), p: await apiGet('products'), b: await apiGet('batch/' + batchId), a: (await apiGet('audit')).length, dr: await apiGet('drafts') });
  // 초안 하나 남겨두기
  await page.goto(batchUrl);
  await page.locator('.lane').first().locator('button:has-text("+ 공정 기록")').click();
  await fill('name', '백업 전 초안');
  await page.waitForTimeout(800);
  await page.click(`${P} [data-x=close]`);
  const snapBefore = await snapshot();
  await page.click('a[data-nav=records]');
  await page.fill('#bk-path', BKDIR);
  await page.click('button[data-act=backup]');
  await page.locator('#modal:not([hidden]) code').waitFor();
  const bkPath = await page.locator('#modal code').innerText();
  await page.click('#modal [data-x=yes]');
  await apiCmd('receive_lot', { raw_material_id: 2, lot_code: 'RU-AFTER', received_qty_g: 10 });
  await page.fill('#rs-path', bkPath);
  await page.click('button[data-act=restorePath]');
  await page.click('#modal [data-x=yes]');
  await page.locator('#modal:not([hidden])', { hasText: '복원했습니다' }).waitFor();
  await page.click('#modal [data-x=yes]');
  const snapAfter = await snapshot();
  assert.equal(snapAfter, snapBefore);
  log('검증14: 백업 복원 후 원료·제품·공정·QC·초안·변경 이력 동일, 복원 전 안전 백업 생성');

  // 손상 파일 복원 거부
  await page.click('a[data-nav=records]');
  await page.fill('#rs-path', BKDIR + '/not-a-db.cfdb');
  await page.click('button[data-act=restorePath]');
  await page.click('#modal [data-x=yes]');
  await page.locator('#modal .errbox').waitFor();
  await page.click('#modal [data-x=yes]');
  assert.equal(await snapshot(), snapBefore);
  log('손상된 백업 파일은 거부되고 현재 데이터 유지');

  assert.deepEqual(external, [], '외부 요청 발생: ' + external.join(', '));
  log('검증15: 외부 네트워크 요청 0건(전부 차단 상태에서 전체 흐름 완료)');
  const errs = consoleErrors.filter(e => !/Failed to load resource|ERR_CONNECTION_RESET|net::ERR_FAILED/.test(e));
  assert.deepEqual(errs, [], '콘솔 오류: ' + errs.join('\n'));
  log('콘솔 오류 없음');
  await browser.close();
  console.log('ALL OK');
})().catch(async e => { console.error('FAILED at step', step + 1, '\n', e); process.exit(1); });
