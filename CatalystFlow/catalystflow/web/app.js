'use strict';
/* CatalystFlow 화면. 업무 규칙은 서버(services.py)에 있고 여기서는 보여주고 입력만 받는다. */

const TOKEN = document.querySelector('meta[name="cf-token"]').content;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nowStr = () => { const d = new Date(); return `${todayStr()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const hms = () => new Date().toTimeString().slice(0, 8);
const enc = encodeURIComponent;
const J = o => esc(JSON.stringify(o));

// ---------------------------------------------------------------- API
class ApiError extends Error {
  constructor(status, body) { super(body.error || '오류'); this.status = status; this.body = body; }
}
async function req(method, path, body) {
  let r;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  try {
    r = await fetch('/api/' + path, {
      method, body: payload, keepalive: !!payload && payload.length < 60000,
      headers: { 'Content-Type': 'application/json', 'X-CF-Token': TOKEN },
    });
  } catch (e) {
    throw new ApiError(0, { error: '앱 내부 저장 엔진에 연결하지 못했습니다. 입력 내용은 그대로 있습니다. 잠시 후 다시 저장하세요.' });
  }
  const data = await r.json().catch(() => ({ error: '응답을 읽지 못했습니다.' }));
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}
const api = {
  get: p => req('GET', p),
  post: (p, b) => req('POST', p, b || {}),
  cmd: (name, payload, op) => req('POST', 'cmd/' + name, { payload, op_id: op }),
};

// ---------------------------------------------------------------- 표시 도우미
const KIND = { measured: '실측', estimated: '추정', calculated: '계산', planned: '계획', unknown: '미측정' };
const BASIS = { slurry_total: '슬러리 전체', wet: '습윤', dry: '건조', as_is: '그대로', unspecified: '기준 미지정' };
const STEP_ST = { planned: '계획', in_progress: '진행 중', paused: '보류', done: '완료', cancelled: '기록 취소' };
const BR_KIND = { production: '생산', research: '연구', exception: '예외' };
const BR_ST = { active: '진행', done: '완료', paused: '보류', dropped: '중단' };
const QC_ST = { planned: '미의뢰', requested: '의뢰됨', received: '결과 수령', cancelled: '취소' };
const PURPOSE = { ship: '출하', qc: 'QC', internal: '내부 측정', research: '연구 실험', reprocess: '재처리', adjust: '정정' };
const DEC = { pass: '합격', fail: '불합격', hold: '보류' };
const ROLE = { in: '투입', out: '산출', through: '제자리 처리' };
const fmtNum = q => Number(q).toLocaleString('ko-KR', { maximumFractionDigits: 3 });
function g(q, kind) {
  if (q === null || q === undefined) return '<span class="muted">미측정</span>';
  const s = fmtNum(q) + ' g';
  return kind && kind !== 'measured' ? `${s} <span class="badge">${KIND[kind] || kind}</span>` : s;
}
const badge = (t, cls = '') => `<span class="badge ${cls}">${esc(t)}</span>`;
const dtxt = v => v ? esc(String(v).replace('T', ' ').slice(0, 16)) : '<span class="muted">미기록</span>';
const btnOpen = (label, f, args, cls = 'btn sm') => `<button class="${cls}" data-act="open" data-f="${f}" data-args="${J(args)}">${label}</button>`;

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 5000 : 2600);
}
function confirmBox(html, okLabel = '확인', danger = false) {
  return new Promise(res => {
    const m = $('#modal');
    m.innerHTML = `<div class="box"><div>${html}</div><div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn" data-x="no">취소</button><button class="btn ${danger ? 'bad' : 'pri'}" data-x="yes">${esc(okLabel)}</button></div></div>`;
    m.hidden = false;
    m.onclick = e => {
      const x = e.target.closest('[data-x]'); if (!x) return;
      m.hidden = true; m.onclick = null; res(x.dataset.x === 'yes');
    };
  });
}
function errHtml(e) {
  const b = e.body || {};
  const det = (b.details || []).map(d => `<li>${esc(d)}</li>`).join('');
  return `<div class="errbox"><b>저장되지 않았습니다.</b> ${esc(b.error || e.message)}${det ? `<ul>${det}</ul>` : ''}</div>`;
}

// ---------------------------------------------------------------- 라우팅 & 이동
const routes = [
  [/^#?\/?$/, pageHome, 'home'], [/^#\/batches$/, pageBatches, 'batches'], [/^#\/batch\/(\d+)$/, pageBatch, 'batches'],
  [/^#\/raw$/, pageRaw, 'raw'], [/^#\/products$/, pageProducts, 'products'], [/^#\/qc$/, pageQC, 'qc'],
  [/^#\/records$/, pageRecords, 'records'],
];
let renderSeq = 0;
async function render(keepScroll = false) {
  const h = location.hash || '#/';
  const view = $('#view');
  const st = view.scrollTop;
  const seq = ++renderSeq;
  for (const [re, fn, nav] of routes) {
    const m = h.match(re);
    if (m) {
      $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === nav));
      try {
        const html = await fn(...m.slice(1));
        if (seq !== renderSeq) return;
        view.innerHTML = html;
        if (keepScroll) view.scrollTop = st; else view.scrollTop = 0;
        afterRender();
      } catch (e) {
        view.innerHTML = errHtml(e);
      }
      return;
    }
  }
  view.innerHTML = '<p>없는 화면입니다.</p>';
}
const refresh = () => render(true);
window.addEventListener('hashchange', () => render(false));

// ---------------------------------------------------------------- 폼 + 초안
const FORMS = {};          // 이름 → 여는 함수(args)  (초안에서 다시 열 수 있도록 이름으로 등록)
let CUR = null;            // 현재 열린 입력 패널
const draftKey = k => `b${k.batch || '-'}|br${k.branch || '-'}|s${k.step || 'new'}|${k.action}`;

async function openF(name, args) {
  if (!FORMS[name]) return toast('알 수 없는 입력 화면입니다.', true);
  try { await FORMS[name](args || {}); } catch (e) { toast(e.body?.error || e.message, true); }
}

async function openForm(spec) {
  if (CUR) await CUR.close({ keepPanel: true });
  const f = new Form(spec);
  CUR = f;
  await f.mount();
  return f;
}

class Form {
  constructor(spec) {
    this.spec = spec;
    this.key = draftKey(spec.key);
    this.op = uid();
    this.dirty = false;
    this.timer = null;
    this.saving = false;
    this.handles = {};
    this.hadDraft = false;
  }
  async mount() {
    const s = this.spec;
    const p = $('#panel');
    p.hidden = false;
    p.innerHTML = `<div class="panel-head"><div class="t">${esc(s.title)}</div>${s.subtitle ? `<div class="sub">${s.subtitle}</div>` : ''}</div>
      <div class="panel-body"><div class="msgs"></div><div class="fields"></div></div>
      <div class="panel-foot"><span class="save-state">새 입력 · 아직 등록되지 않음</span>
        <button class="btn" data-x="close" title="초안은 남겨둡니다">닫기</button>
        <button class="btn pri" data-x="submit">${esc(s.submitLabel || '등록')} <span class="small">(Ctrl+S)</span></button></div>`;
    let init = {};
    for (const f of s.fields) if (f.default !== undefined) init[f.name] = f.default;
    Object.assign(init, s.initial || {});
    let d = null;
    try { d = await api.get('draft?key=' + enc(this.key)); } catch (e) { /* 초안 조회 실패해도 입력은 가능 */ }
    if (CUR !== this) return;
    if (d && d.payload && d.payload.values) {
      this.hadDraft = true;
      init = { ...init, ...d.payload.values };
      if (d.payload.op) this.op = d.payload.op;
      $('.msgs', p).innerHTML = `<div class="draftbox">작성하던 초안을 불러왔습니다 (${esc(d.updated_at)}). 아직 등록되지 않은 내용입니다.
        <button class="btn sm" data-x="discard">초안 버리고 새로 작성</button></div>`;
      this.setState('draft', `초안 자동저장됨 ${esc(d.updated_at.slice(11, 19))} · 아직 등록되지 않음`);
    }
    this.renderFields(init);
    p.oninput = p.onchange = e => { if (!e.target.closest('.fields')) return; this.onChange(); };
    p.onclick = e => {
      const x = e.target.closest('[data-x]'); if (!x) return;
      if (x.dataset.x === 'close') this.close();
      if (x.dataset.x === 'submit') this.submit();
      if (x.dataset.x === 'discard') this.discard();
    };
    this.refreshVisibility();
    s.onChange && s.onChange(this.collect(), this);
    const first = $('.fields input, .fields textarea, .fields select', p);
    if (first && !this.hadDraft) first.focus();
  }
  renderFields(values) {
    const wrap = $('.fields', $('#panel'));
    wrap.innerHTML = '';
    let adv = null;
    for (const f of this.spec.fields) {
      const h = renderField(f, values[f.name], this);
      this.handles[f.name] = h;
      h.box.dataset.field = f.name;
      if (f.adv) {
        if (!adv) {
          adv = document.createElement('details'); adv.className = 'adv';
          adv.innerHTML = `<summary>${esc(this.spec.advLabel || '더 입력하기 (선택)')}</summary>`;
          if (this.spec.fields.some(x => x.adv && values[x.name] !== undefined && values[x.name] !== '' && values[x.name] !== null && x.default === undefined)) adv.open = true;
        }
        adv.appendChild(h.box);
      } else {
        if (adv) { wrap.appendChild(adv); adv = null; }
        wrap.appendChild(h.box);
      }
    }
    if (adv) wrap.appendChild(adv);
  }
  collect() {
    const v = {};
    for (const [k, h] of Object.entries(this.handles)) v[k] = h.get();
    return v;
  }
  refreshVisibility() {
    const v = this.collect();
    for (const f of this.spec.fields) {
      if (f.show) this.handles[f.name].box.hidden = !f.show(v);
      if (f.type === 'info' && typeof f.html === 'function') this.handles[f.name].box.innerHTML = f.html(v);
    }
  }
  setState(cls, html) {
    const el = $('.save-state', $('#panel'));
    if (el) { el.className = 'save-state ' + cls; el.innerHTML = html; }
    const ind = $('#draft-indicator');
    if (cls === 'draft') { ind.hidden = false; ind.textContent = '초안 자동저장됨 · 등록 전'; }
    else ind.hidden = true;
  }
  onChange() {
    if (this.closed) return;
    this.dirty = true;
    this.refreshVisibility();
    this.setState('draft', '입력 중… (초안 자동저장 대기)');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveDraft(), 500);
    this.spec.onChange && this.spec.onChange(this.collect(), this);
  }
  async saveDraft() {
    this.timer = null;
    if (this.closed) return;
    const s = this.spec;
    try {
      await api.post('draft', {
        key: this.key, action: s.key.action, batch_id: s.key.batch || null, branch_id: s.key.branch || null,
        step_ref: s.key.step ? String(s.key.step) : null, title: s.title,
        payload: { values: this.collect(), op: this.op, form: s.form, args: s.args },
      });
      if (CUR === this && !this.saving) this.setState('draft', `초안 자동저장됨 ${hms()} · <b>아직 등록되지 않음</b>`);
    } catch (e) {
      if (CUR === this) this.setState('err', '초안 저장 실패 — 입력은 화면에 남아 있습니다');
    }
  }
  retire() {   // 이 폼은 더 이상 초안을 쓰지 않는다(늦게 도착한 입력 이벤트 무시)
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    const p = $('#panel'); p.oninput = p.onchange = null;
    if (CUR === this) CUR = null;
  }
  async flush() {
    if (this.timer) { clearTimeout(this.timer); await this.saveDraft(); }
  }
  async discard() {
    if (!await confirmBox('이 초안을 버리고 새로 작성할까요? (등록된 실제 기록에는 영향이 없습니다)', '초안 버리기', true)) return;
    this.retire();
    await api.post('draft/delete', { key: this.key }).catch(() => { });
    await openForm({ ...this.spec, initial: this.spec.initial });
  }
  async close(opts = {}) {
    await this.flush();
    if (!this.dirty && !this.hadDraft) await api.post('draft/delete', { key: this.key }).catch(() => { });
    this.closed = true;
    if (CUR === this) CUR = null;
    if (!opts.keepPanel) { const p = $('#panel'); p.hidden = true; p.innerHTML = ''; $('#draft-indicator').hidden = true; }
  }
  showError(e) {
    const m = $('.msgs', $('#panel'));
    let extra = '';
    if (e.status === 409 && this.spec.form) extra = `<button class="btn sm" data-x="reload">최신 내용으로 다시 열기</button>`;
    m.innerHTML = errHtml(e) + extra;
    const rl = $('[data-x="reload"]', m);
    if (rl) rl.onclick = async () => { this.retire(); await api.post('draft/delete', { key: this.key }).catch(() => { }); openF(this.spec.form, this.spec.args); };
    m.scrollIntoView({ block: 'nearest' });
  }
  async submit() {
    if (this.saving) return;            // 중복 클릭 방지(서버도 op_id로 한 번만 처리)
    const v = this.collect();
    const msg = this.spec.validate && this.spec.validate(v);
    if (msg) { this.showError({ body: { error: msg } }); return; }
    this.saving = true;
    const btn = $('[data-x="submit"]', $('#panel'));
    btn.disabled = true; btn.textContent = '등록 중…';
    this.setState('', '실제 기록을 저장하는 중…');
    await this.flush();
    try {
      const res = await this.spec.submit(v, this.op);
      this.closed = true;                       // 이후 들어오는 입력 이벤트로 초안이 되살아나지 않게
      clearTimeout(this.timer); this.timer = null;
      const pnl = $('#panel'); pnl.oninput = pnl.onchange = null;
      await api.post('draft/delete', { key: this.key }).catch(() => { });
      this.setState('saved', `✓ 등록 완료 ${hms()} (DB 저장됨)`);
      $('.msgs', $('#panel')).innerHTML = '';
      toast(this.spec.doneMsg || '등록 완료 ✓');
      if (res && res.warning) setTimeout(() => toast(res.warning, true), 1200);
      if (CUR === this) { CUR = null; const p = $('#panel'); p.hidden = true; p.innerHTML = ''; $('#draft-indicator').hidden = true; }
      BV.sel.clear();  // 선택은 방금 기록에 사용되었으므로 해제
      if (this.spec.done) await this.spec.done(res, v); else await refresh();
    } catch (e) {
      this.saving = false;
      btn.disabled = false; btn.innerHTML = `${esc(this.spec.submitLabel || '등록')} <span class="small">(Ctrl+S)</span>`;
      this.setState('err', '저장 실패 — 입력 내용은 그대로 있습니다(초안 유지)');
      this.showError(e);
      return;
    }
    this.saving = false;
  }
}

// --- 필드
function fieldBox(f) {
  const box = document.createElement('div');
  box.className = 'f';
  if (f.label) box.innerHTML = `<label class="l">${esc(f.label)}${f.required ? ' <span style="color:#b3261e">*</span>' : ''}</label>`;
  return box;
}
function addHint(box, f) { if (f.hint) box.insertAdjacentHTML('beforeend', `<div class="hint">${f.hint}</div>`); }
function renderField(f, val, form) {
  const box = fieldBox(f);
  const t = f.type || 'text';
  let get, set;
  if (t === 'info') {
    box.innerHTML = typeof f.html === 'function' ? '' : f.html;
    return { box, get: () => undefined, set: () => { } };
  }
  if (t === 'custom') {
    const h = f.custom(f, val, form);
    box.appendChild(h.el);
    addHint(box, f);
    return { box, get: h.get, set: h.set || (() => { }) };
  }
  if (t === 'text' || t === 'num' || t === 'date' || t === 'dt' || t === 'suggest') {
    const inp = document.createElement('input');
    inp.type = t === 'num' ? 'number' : t === 'date' ? 'date' : t === 'dt' ? 'datetime-local' : 'text';
    if (t === 'num') { inp.step = 'any'; inp.min = '0'; }
    inp.placeholder = f.placeholder || (t === 'dt' || t === 'date' ? '' : '');
    inp.name = f.name;
    const row = document.createElement('div'); row.className = 'inline'; row.appendChild(inp);
    if (t === 'suggest') {
      const id = 'dl-' + f.name + Math.random().toString(36).slice(2, 6);
      const dl = document.createElement('datalist'); dl.id = id;
      dl.innerHTML = (f.options || []).map(o => `<option value="${esc(o)}">`).join('');
      inp.setAttribute('list', id); row.appendChild(dl);
    }
    if (t === 'num' && f.unit) row.insertAdjacentHTML('beforeend', `<span class="muted">${esc(f.unit)}</span>`);
    if (t === 'dt' || t === 'date') {
      const now = document.createElement('button'); now.type = 'button'; now.className = 'btn sm';
      now.textContent = t === 'dt' ? '지금' : '오늘';
      now.onclick = () => { inp.value = t === 'dt' ? nowStr().replace(' ', 'T') : todayStr(); inp.dispatchEvent(new Event('input', { bubbles: true })); };
      const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'btn sm ghost'; clr.textContent = '비우기';
      clr.onclick = () => { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); };
      row.append(now, clr);
    }
    box.appendChild(row);
    if (t === 'dt' && !f.hint) f = { ...f, hint: '비워두면 <b>미기록</b>으로 남습니다. 과거 작업은 실제 시각을 입력하세요.' };
    addHint(box, f);
    get = () => {
      const v = inp.value.trim();
      if (v === '') return null;
      if (t === 'num') return Number(v);
      if (t === 'dt') return v.replace('T', ' ');
      return v;
    };
    set = v => { inp.value = v === null || v === undefined ? '' : (t === 'dt' ? String(v).replace(' ', 'T').slice(0, 16) : v); };
    set(val);
    return { box, get, set };
  }
  if (t === 'textarea') {
    const ta = document.createElement('textarea'); ta.name = f.name; ta.placeholder = f.placeholder || '';
    box.appendChild(ta); addHint(box, f);
    get = () => ta.value; set = v => { ta.value = v ?? ''; }; set(val);
    return { box, get, set };
  }
  if (t === 'select') {
    const sel = document.createElement('select'); sel.name = f.name;
    sel.innerHTML = f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    box.appendChild(sel); addHint(box, f);
    get = () => sel.value === '' ? null : sel.value; set = v => { if (v !== undefined && v !== null) sel.value = String(v); }; set(val);
    return { box, get, set };
  }
  if (t === 'seg') {
    const seg = document.createElement('div'); seg.className = 'seg';
    let cur = val ?? f.options[0][0];
    seg.innerHTML = f.options.map(([v, l]) => `<button type="button" data-v="${esc(v)}">${esc(l)}</button>`).join('');
    const paint = () => $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.v === String(cur)));
    seg.onclick = e => { const b = e.target.closest('button'); if (!b) return; cur = b.dataset.v; paint(); seg.dispatchEvent(new Event('change', { bubbles: true })); };
    box.appendChild(seg); addHint(box, f); paint();
    get = () => cur; set = v => { if (v !== undefined && v !== null) { cur = String(v); paint(); } };
    return { box, get, set };
  }
  if (t === 'check') {
    box.innerHTML = `<label><input type="checkbox"> ${esc(f.text || f.label)}</label>`;
    const cb = $('input', box); addHint(box, f);
    get = () => cb.checked; set = v => { cb.checked = !!v; }; set(val);
    return { box, get, set };
  }
  throw new Error('unknown field ' + t);
}

// --- 맞춤 필드: 투입 물질 선택
function inputsPicker(materials, branches, opts = {}) {
  return (f, val, form) => {
    const el = document.createElement('div');
    const avail = materials.filter(m => m.status === 'active' && !m.product && !(opts.exclude || []).includes(m.id));
    const brName = Object.fromEntries(branches.map(b => [b.id, b.name]));
    const byBr = {};
    avail.forEach(m => (byBr[m.branch_id] = byBr[m.branch_id] || []).push(m));
    if (!avail.length) { el.innerHTML = '<div class="empty">선택할 수 있는 활성 물질이 없습니다.</div>'; return { el, get: () => [] }; }
    const defRole = opts.defaultRole || 'full';
    el.innerHTML = `<div class="row small" style="margin-bottom:4px"><span class="muted">선택한 물질만 이 공정에 들어갑니다.</span>
      <span class="spacer"></span>모두 <select data-allrole><option value="">방식 일괄 변경…</option><option value="full">전량 투입</option><option value="through">제자리 처리</option></select></div>
      <div class="picklist">${Object.entries(byBr).map(([bid, ms]) => `
        <div class="grp"><label><input type="checkbox" data-grp="${bid}"> ${esc(brName[bid] || '')}</label><span class="muted">${ms.length}개</span></div>
        ${ms.map(m => `<div class="it" data-mid="${m.id}"><input type="checkbox" data-pick>
          <span class="lb">${esc(m.label)} <span class="muted small">${m.qty_g == null ? '미측정' : fmtNum(m.qty_g) + ' g' + (m.qty_kind !== 'measured' ? '(' + KIND[m.qty_kind] + ')' : '')}${m.tag ? ' · ' + esc(m.tag) : ''}</span></span>
          <select data-role><option value="full">전량 투입</option><option value="part">일부 사용</option><option value="through">제자리 처리</option></select>
          <input type="number" step="any" min="0" placeholder="g" data-qty hidden></div>`).join('')}`).join('')}</div>`;
    const rows = () => $$('.it', el);
    const syncRow = r => { $('[data-qty]', r).hidden = $('[data-role]', r).value !== 'part'; };
    rows().forEach(r => { $('[data-role]', r).value = defRole; syncRow(r); });
    el.addEventListener('change', e => {
      if (e.target.dataset.grp !== undefined) {
        $$(`.it`, el).filter(r => avail.find(m => m.id == r.dataset.mid).branch_id == e.target.dataset.grp)
          .forEach(r => { $('[data-pick]', r).checked = e.target.checked; });
      }
      if (e.target.matches('[data-allrole]') && e.target.value) {
        rows().forEach(r => { $('[data-role]', r).value = e.target.value; syncRow(r); }); e.target.value = '';
      }
      if (e.target.matches('[data-role]')) syncRow(e.target.closest('.it'));
    });
    const get = () => rows().filter(r => $('[data-pick]', r).checked).map(r => {
      const role = $('[data-role]', r).value;
      const o = { material_id: Number(r.dataset.mid) };
      if (role === 'through') o.role = 'through';
      else if (role === 'part') { o.role = 'in'; o.full_use = false; const q = $('[data-qty]', r).value; o.qty_g = q === '' ? null : Number(q); }
      else { o.role = 'in'; o.full_use = true; }
      return o;
    });
    const set = v => {
      (v || []).forEach(o => {
        const r = rows().find(r => r.dataset.mid == o.material_id); if (!r) return;
        $('[data-pick]', r).checked = true;
        $('[data-role]', r).value = o.role === 'through' ? 'through' : (o.full_use === false ? 'part' : 'full');
        if (o.qty_g != null) $('[data-qty]', r).value = o.qty_g;
        syncRow(r);
      });
    };
    set(val);
    return { el, get, set };
  };
}

// --- 맞춤 필드: 산출 물질 행
function outputsEditor(defaults = {}) {
  return (f, val, form) => {
    const el = document.createElement('div');
    el.innerHTML = `<div class="outrows"></div><button type="button" class="btn sm" data-add>+ 산출 물질 추가</button>
      <div class="hint">질량을 모르면 비워두세요(미측정). 0과 다릅니다.</div>`;
    const list = $('.outrows', el);
    const addRow = (o = {}) => {
      const r = document.createElement('div'); r.className = 'outrow';
      r.innerHTML = `<input data-k="label" placeholder="이름 (예: 세척 케이크)"><input data-k="form" placeholder="상태 (분말…)">
        <select data-k="mass_basis">${Object.entries(BASIS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <input data-k="qty_g" type="number" step="any" min="0" placeholder="g (미측정)">
        <button type="button" class="btn sm ghost" data-del>✕</button>`;
      const o2 = { ...defaults, ...o };
      $$('[data-k]', r).forEach(i => { if (o2[i.dataset.k] !== undefined && o2[i.dataset.k] !== null) i.value = o2[i.dataset.k]; });
      list.appendChild(r);
    };
    el.addEventListener('click', e => {
      if (e.target.closest('[data-add]')) { addRow(); el.dispatchEvent(new Event('input', { bubbles: true })); }
      if (e.target.closest('[data-del]')) { e.target.closest('.outrow').remove(); el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    const get = () => $$('.outrow', list).map(r => {
      const o = {}; $$('[data-k]', r).forEach(i => { o[i.dataset.k] = i.value.trim(); });
      o.qty_g = o.qty_g === '' ? null : Number(o.qty_g);
      o.qty_kind = o.qty_g === null ? 'unknown' : 'measured';
      return o;
    }).filter(o => o.label || o.form || o.qty_g !== null);
    (val && val.length ? val : (f.startRows || [])).forEach(addRow);
    return { el, get };
  };
}

// --- 맞춤 필드: 원료 Lot 투입 행
function rawLinesEditor(raw) {
  const lots = [];
  raw.forEach(rm => rm.lots.forEach(l => { if (!l.deleted_at) lots.push({ ...l, raw_name: rm.name }); }));
  return (f, val) => {
    const el = document.createElement('div');
    if (!lots.length) { el.innerHTML = '<div class="warnbox">입고된 원료 Lot이 없습니다. 원료 화면에서 먼저 입고를 등록하세요.</div>'; return { el, get: () => [] }; }
    el.innerHTML = `<div class="rl"></div><button type="button" class="btn sm" data-add>+ Lot 추가</button>`;
    const list = $('.rl', el);
    const addRow = (o = {}) => {
      const r = document.createElement('div'); r.className = 'inline'; r.style.marginBottom = '4px';
      r.innerHTML = `<select data-k="lot_id">${lots.map(l => `<option value="${l.id}">${esc(l.raw_name)} · ${esc(l.lot_code)} (잔량 ${fmtNum(l.remaining_g)} g)</option>`).join('')}</select>
        <input data-k="qty_g" type="number" step="any" min="0" placeholder="실제 투입 g" style="max-width:130px"><span class="muted">g</span>
        <button type="button" class="btn sm ghost" data-del>✕</button>`;
      if (o.lot_id) $('[data-k=lot_id]', r).value = o.lot_id;
      if (o.qty_g != null) $('[data-k=qty_g]', r).value = o.qty_g;
      list.appendChild(r);
    };
    el.addEventListener('click', e => {
      if (e.target.closest('[data-add]')) addRow();
      if (e.target.closest('[data-del]')) { e.target.closest('.inline').remove(); el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    (val && val.length ? val : [{}]).forEach(addRow);
    const get = () => $$('.inline', list).map(r => ({ lot_id: Number($('[data-k=lot_id]', r).value), qty_g: $('[data-k=qty_g]', r).value === '' ? null : Number($('[data-k=qty_g]', r).value) }));
    return { el, get };
  };
}

// ---------------------------------------------------------------- 데이터 캐시
async function loadBatch(id) { return api.get('batch/' + id); }
function findStep(d, id) { return d.steps.find(s => s.id == id); }

const STEP_NAMES = ['열처리', '세척', '여과·세척', '동결건조', '건조', '분쇄', '체거름', '혼합', '합치기', '교반', '숙성', '하소', '환원'];
const QC_TESTS = ['XRD', 'BET', '과전압', 'pH', 'TGA', 'XRF', 'PSA', 'ICP', 'SEM', 'TEM', 'XPS', 'CV', 'EIS'];
const timeFields = (adv = true) => [
  { name: 'actual_start', label: '실제 시작', type: 'dt', adv },
  { name: 'actual_end', label: '실제 완료', type: 'dt', adv },
];

// ================================================================= 입력 화면들
FORMS.newBatch = async () => {
  const d = new Date();
  const code = `B-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  await openForm({
    form: 'newBatch', args: {}, key: { action: 'new-batch' }, title: '새 배치', submitLabel: '배치 등록',
    subtitle: '생산 가지가 함께 만들어집니다. 연구·예외 가지는 나중에 추가합니다.',
    fields: [
      { name: 'code', label: '배치 번호', required: true, default: code },
      { name: 'title', label: '배치 이름', placeholder: '예: IrOx 250 g 배치' },
      { name: 'common_conditions', label: '공통 제조 조건', type: 'textarea', adv: true, placeholder: '모든 가지에 공통인 전구체 조건 등' },
      { name: 'purpose', label: '목적', adv: true },
      { name: 'first_branch_name', label: '첫 가지 이름', default: '생산', adv: true },
    ],
    validate: v => !v.code && '배치 번호를 입력하세요.',
    submit: (v, op) => api.cmd('create_batch', v, op),
    done: res => { location.hash = '#/batch/' + res.id; },
  });
};

FORMS.editBatch = async ({ batch_id }) => {
  const d = await loadBatch(batch_id); const b = d.batch;
  await openForm({
    form: 'editBatch', args: { batch_id }, key: { batch: batch_id, action: 'edit-batch' }, title: `배치 수정 · ${b.code}`, submitLabel: '수정 저장',
    fields: [
      { name: 'code', label: '배치 번호' }, { name: 'title', label: '배치 이름' },
      { name: 'common_conditions', label: '공통 제조 조건', type: 'textarea' },
      { name: 'purpose', label: '목적' }, { name: 'note', label: '메모', type: 'textarea' },
      { name: 'reason', label: '수정 사유', adv: true },
    ],
    initial: b,
    submit: (v, op) => api.cmd('update_batch', { batch_id, version: b.version, ...v }, op),
  });
};

FORMS.addBranch = async ({ batch_id, kind }) => {
  await openForm({
    form: 'addBranch', args: { batch_id, kind }, key: { batch: batch_id, action: 'add-branch' }, title: '가지 추가', submitLabel: '가지 만들기',
    subtitle: '가지를 만드는 것은 물질을 나누는 것과 다릅니다. 물질은 소분하거나 가지로 옮겨서 넣습니다.',
    fields: [
      { name: 'name', label: '가지 이름', required: true, placeholder: '예: 잔여 슬러리 연구' },
      { name: 'kind', label: '종류', type: 'seg', options: [['research', '연구'], ['exception', '예외'], ['production', '생산']], default: kind || 'research' },
      { name: 'condition_diff', label: '공통 조건과 달라진 조건', type: 'textarea', placeholder: '예: 히팅맨틀 열처리, 스터링 유/무 비교' },
      { name: 'note', label: '메모', type: 'textarea', adv: true },
    ],
    validate: v => !v.name && '가지 이름을 입력하세요.',
    submit: (v, op) => api.cmd('add_branch', { batch_id, ...v }, op),
  });
};

FORMS.editBranch = async ({ batch_id, branch_id }) => {
  const d = await loadBatch(batch_id); const br = d.branches.find(b => b.id == branch_id);
  await openForm({
    form: 'editBranch', args: { batch_id, branch_id }, key: { batch: batch_id, branch: branch_id, action: 'edit-branch' }, title: `가지 수정 · ${br.name}`, submitLabel: '수정 저장',
    subtitle: '생산 가지를 완료해도 다른 가지는 계속 진행됩니다.',
    fields: [
      { name: 'name', label: '가지 이름' },
      { name: 'status', label: '상태', type: 'seg', options: [['active', '진행'], ['paused', '보류'], ['done', '완료'], ['dropped', '중단']] },
      { name: 'condition_diff', label: '공통 조건과 달라진 조건', type: 'textarea' },
      { name: 'note', label: '메모', type: 'textarea' },
    ],
    initial: br,
    submit: (v, op) => api.cmd('update_branch', { branch_id, version: br.version, ...v }, op),
  });
};

FORMS.charge = async ({ batch_id, branch_id }) => {
  const [d, raw] = await Promise.all([loadBatch(batch_id), api.get('raw')]);
  branch_id = branch_id || d.branches[0].id;
  await openForm({
    form: 'charge', args: { batch_id, branch_id }, key: { batch: batch_id, branch: branch_id, step: 'new-charge', action: 'record' },
    title: `원료 투입 · ${d.batch.code}`, submitLabel: '투입 기록',
    subtitle: '원료 재고는 이 기록에서만 차감됩니다. 이후 소분·열처리는 원료를 다시 차감하지 않습니다.',
    fields: [
      { name: 'raw_lines', label: '투입한 원료 Lot · 실제 투입량', type: 'custom', custom: rawLinesEditor(raw) },
      { name: 'out_label', label: '만들어진 물질', default: '전구체 슬러리' },
      { name: 'out_qty', label: '만들어진 물질의 질량(슬러리 전체)', type: 'num', unit: 'g',
        hint: '원료 투입량(예: 250 g)과 다릅니다. 측정하지 않았으면 비워두세요 → 미측정.' },
      { name: 'out_kind', label: '질량 종류', type: 'seg', options: [['measured', '실측'], ['estimated', '추정']], show: v => v.out_qty !== null },
      { name: 'out_form', label: '상태', default: '슬러리', adv: true },
      { name: 'out_basis', label: '질량 기준', type: 'select', options: Object.entries(BASIS), default: 'slurry_total', adv: true },
      ...timeFields(),
      { name: 'operator', label: '작업자', adv: true }, { name: 'equipment', label: '장비·위치', adv: true },
      { name: 'actual_conditions', label: '실제 조건', type: 'textarea', adv: true },
      { name: 'observations', label: '관찰·이상', type: 'textarea', adv: true },
    ],
    validate: v => (!v.raw_lines.length || v.raw_lines.some(l => !l.qty_g)) && 'Lot과 실제 투입량을 입력하세요.',
    submit: (v, op) => api.cmd('charge_raw', {
      batch_id, branch_id, raw_lines: v.raw_lines,
      output: v.out_label ? { label: v.out_label, form: v.out_form, mass_basis: v.out_basis, qty_g: v.out_qty, qty_kind: v.out_kind } : null,
      actual_start: v.actual_start, actual_end: v.actual_end, operator: v.operator, equipment: v.equipment,
      actual_conditions: v.actual_conditions, observations: v.observations,
    }, op),
  });
};

FORMS.step = async ({ batch_id, branch_id, inputs, kind }) => {
  const d = await loadBatch(batch_id);
  branch_id = branch_id || d.branches[0].id;
  const merge = kind === 'merge';
  const br = d.branches.find(b => b.id == branch_id);
  await openForm({
    form: 'step', args: { batch_id, branch_id, kind }, key: { batch: batch_id, branch: branch_id, step: merge ? 'new-merge' : 'new-process', action: 'record' },
    title: `${merge ? '합치기' : '공정 기록'} · ${br.name}`, submitLabel: '기록',
    subtitle: '짧게 끝난 작업은 "완료로 바로 기록", 시간이 걸리는 작업은 "지금 시작" 또는 "계획만".',
    fields: [
      { name: 'status', label: '기록 방식', type: 'seg', options: [['done', '완료로 바로 기록'], ['in_progress', '시작(진행 중)'], ['planned', '계획만']], default: 'done' },
      { name: 'name', label: '공정명', type: 'suggest', options: STEP_NAMES, required: true, default: merge ? '합치기' : '' },
      { name: 'scheduled_date', label: '작업 예정일', type: 'date', show: v => v.status === 'planned' },
      { name: 'expected_hours', label: '예상 소요시간', type: 'num', unit: '시간', show: v => v.status === 'planned' },
      { name: 'planned_conditions', label: '계획 조건', type: 'textarea', show: v => v.status === 'planned' },
      { name: 'inputs', label: '투입 물질', type: 'custom', show: v => v.status !== 'planned',
        custom: inputsPicker(d.materials, d.branches, { defaultRole: merge ? 'full' : 'full' }),
        hint: '열처리처럼 물질이 그대로 남으면 <b>제자리 처리</b>, 다른 물질로 바뀌거나 합쳐지면 <b>전량 투입</b>.' },
      { name: 'outputs', label: merge ? '합쳐서 만들어진 물질' : '산출 물질 (없으면 비워두기)', type: 'custom', show: v => v.status !== 'planned',
        custom: outputsEditor({ mass_basis: 'unspecified' }), startRows: merge ? [{ label: '' }] : [] },
      { name: 'after_form', label: '처리 후 상태 (제자리 처리 물질)', placeholder: '예: 소성 분말', show: v => v.status !== 'planned' && (v.inputs || []).some(i => i.role === 'through') },
      { name: 'after_qty_reset', label: '', type: 'check', text: '처리 후 질량을 미측정으로 표시 (열처리로 질량이 변함)', show: v => v.status !== 'planned' && (v.inputs || []).some(i => i.role === 'through') },
      { name: 'equipment', label: '장비·위치' },
      { name: 'actual_conditions', label: '실제 조건', type: 'textarea', show: v => v.status !== 'planned' },
      { name: 'observations', label: '관찰·이상 사항', type: 'textarea', show: v => v.status !== 'planned' },
      { name: 'actual_start', label: '실제 시작', type: 'dt', adv: true },
      { name: 'actual_end', label: '실제 완료', type: 'dt', adv: true },
      { name: 'operator', label: '작업자', adv: true },
    ],
    initial: inputs ? { inputs } : {},
    validate: v => {
      if (!v.name) return '공정명을 입력하세요.';
      if (merge && v.status !== 'planned' && (v.inputs || []).length < 2) return '합칠 물질을 2개 이상 선택하세요.';
      if (v.status !== 'planned' && (v.outputs || []).some(o => !o.label)) return '산출 물질 이름을 입력하세요.';
      return null;
    },
    submit: (v, op) => {
      const p = { batch_id, branch_id, kind: merge ? 'merge' : 'process', status: v.status, name: v.name, equipment: v.equipment, operator: v.operator };
      if (v.status === 'planned') Object.assign(p, { scheduled_date: v.scheduled_date, expected_hours: v.expected_hours, planned_conditions: v.planned_conditions });
      else Object.assign(p, {
        inputs: v.inputs, outputs: (v.outputs || []).map(o => ({ ...o, branch_id })), actual_conditions: v.actual_conditions, observations: v.observations,
        actual_start: v.actual_start, actual_end: v.status === 'done' ? v.actual_end : null,
        after_state: { form: v.after_form, qty_reset: v.after_qty_reset },
      });
      return api.cmd('record_step', p, op);
    },
  });
};

FORMS.split = async ({ batch_id, material_id }) => {
  const d = await loadBatch(batch_id);
  const m = d.materials.find(x => x.id == material_id);
  const brOpts = d.branches.map(b => [String(b.id), b.name]);
  await openForm({
    form: 'split', args: { batch_id, material_id }, key: { batch: batch_id, branch: m.branch_id, step: 'split-' + material_id, action: 'split' },
    title: `소분 · ${m.label}`, submitLabel: '소분 완료 기록',
    subtitle: `현재 ${m.qty_g == null ? '미측정' : fmtNum(m.qty_g) + ' g (' + KIND[m.qty_kind] + ')'} · ${BASIS[m.mass_basis]} · 상태·질량 기준은 원본을 이어받습니다.`,
    fields: [
      { name: 'varied', label: '', type: 'check', text: '용기마다 양이 다름 (상세 입력)' },
      { name: 'count', label: '용기 수', type: 'num', unit: '개', show: v => !v.varied },
      { name: 'per_qty_g', label: '용기당 실측량', type: 'num', unit: 'g', show: v => !v.varied },
      { name: 'quantities', label: '용기별 양 (한 줄에 하나, g)', type: 'textarea', show: v => v.varied, placeholder: '50\n49.8\n50.3' },
      { name: 'label_prefix', label: '용기 이름', type: 'suggest', options: ['도가니', '석영 비커', '바이알', '보틀', '트레이'], default: '도가니' },
      { name: 'preview', type: 'info', html: '' },
      { name: 'target_branch_id', label: '소분한 용기를 둘 가지', type: 'select', options: brOpts, default: String(m.branch_id), adv: true },
      { name: 'start_index', label: '시작 번호', type: 'num', default: 1, adv: true },
      { name: 'qty_kind', label: '용기당 양의 종류', type: 'seg', options: [['measured', '실측'], ['planned', '계획']], default: 'measured', adv: true },
      { name: 'actual_start', label: '작업 시각', type: 'dt', adv: true },
      { name: 'operator', label: '작업자', adv: true },
      { name: 'observations', label: '메모', type: 'textarea', adv: true },
    ],
    onChange: debounce(async (v, form) => {
      const box = form.handles.preview && form.handles.preview.box; if (!box) return;
      const qs = v.varied ? (v.quantities || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : null;
      if ((!v.varied && (!v.count || !v.per_qty_g)) || (v.varied && !qs.length)) { box.innerHTML = '<div class="preview muted">용기 수와 용기당 양을 넣으면 미리보기가 나옵니다.</div>'; return; }
      try {
        const p = await api.get(`preview_split?source=${material_id}` + (qs ? `&quantities=${enc(JSON.stringify(qs))}` : `&count=${v.count}&per=${v.per_qty_g}`));
        const start = Number(v.start_index || 1), pre = v.label_prefix || '용기', w = Math.max(2, String(start + p.count - 1).length);
        box.innerHTML = `<div class="preview"><div class="big">${p.count}개 · 총 ${fmtNum(p.total_g)} g</div>
          <div>${esc(pre)} ${String(start).padStart(w, '0')} ~ ${esc(pre)} ${String(start + p.count - 1).padStart(w, '0')} 자동 생성</div>
          <div>원본 남는 양: ${p.remaining_g == null ? '<b>계산하지 않음</b>' : `<b>${fmtNum(p.remaining_g)} g</b> (${KIND[p.remaining_kind]})`}</div>
          ${p.note ? `<div class="small muted">${esc(p.note)}</div>` : ''}${p.error ? `<div class="errbox">${esc(p.error)}</div>` : ''}</div>`;
      } catch (e) { box.innerHTML = errHtml(e); }
    }, 250),
    validate: v => {
      if (v.varied) return !(v.quantities || '').trim() && '용기별 양을 입력하세요.';
      if (!v.count || !v.per_qty_g) return '용기 수와 용기당 양을 입력하세요.';
      return null;
    },
    submit: (v, op) => api.cmd('split_material', {
      source_material_id: material_id, label_prefix: v.label_prefix, start_index: v.start_index || 1,
      target_branch_id: Number(v.target_branch_id), qty_kind: v.qty_kind, actual_start: v.actual_start, operator: v.operator,
      observations: v.observations,
      ...(v.varied ? { quantities: v.quantities.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) } : { count: v.count, per_qty_g: v.per_qty_g }),
    }, op),
    doneMsg: '소분 완료 기록 ✓',
  });
};

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

FORMS.start = async ({ batch_id, step_id }) => {
  const d = await loadBatch(batch_id); const s = findStep(d, step_id);
  await openForm({
    form: 'start', args: { batch_id, step_id }, key: { batch: batch_id, branch: s.branch_id, step: step_id, action: 'start' },
    title: `시작 기록 · ${s.name}`, submitLabel: '시작 기록', subtitle: s.planned_conditions ? '계획 조건: ' + esc(s.planned_conditions) : '',
    fields: [
      { name: 'actual_start', label: '실제 시작 시각', type: 'dt' },
      { name: 'inputs', label: '투입·처리 물질', type: 'custom', custom: inputsPicker(d.materials, d.branches, { defaultRole: 'through' }) },
      { name: 'after_form', label: '처리 후 상태 (선택)', adv: true },
      { name: 'operator', label: '작업자', adv: true }, { name: 'equipment', label: '장비·위치', default: s.equipment, adv: true },
    ],
    submit: (v, op) => api.cmd('start_step', { step_id, version: s.version, actual_start: v.actual_start, inputs: v.inputs, operator: v.operator, equipment: v.equipment, after_state: { form: v.after_form } }, op),
  });
};

FORMS.complete = async ({ batch_id, step_id }) => {
  const d = await loadBatch(batch_id); const s = findStep(d, step_id);
  const linked = s.io.filter(i => i.role !== 'out').map(i => i.material_id);
  await openForm({
    form: 'complete', args: { batch_id, step_id }, key: { batch: batch_id, branch: s.branch_id, step: step_id, action: 'complete' },
    title: `완료 기록 · ${s.name}`, submitLabel: '완료 기록',
    subtitle: `${STEP_ST[s.status]} · 이미 연결된 투입 ${linked.length}개`,
    fields: [
      { name: 'actual_end', label: '실제 완료 시각', type: 'dt' },
      ...(s.actual_start ? [] : [{ name: 'actual_start', label: '실제 시작 시각', type: 'dt' }]),
      { name: 'outputs', label: '산출 물질 (없으면 비워두기)', type: 'custom', custom: outputsEditor({ mass_basis: 'unspecified' }) },
      { name: 'observations', label: '관찰·이상 사항', type: 'textarea', default: s.observations },
      { name: 'actual_conditions', label: '실제 조건', type: 'textarea', default: s.actual_conditions },
      { name: 'inputs', label: '추가로 투입한 물질', type: 'custom', adv: true, custom: inputsPicker(d.materials, d.branches, { exclude: linked }) },
      { name: 'after_form', label: '처리 후 상태 (제자리 처리 물질)', adv: true },
      { name: 'after_qty_reset', label: '', type: 'check', text: '처리 후 질량을 미측정으로 표시', adv: true },
    ],
    validate: v => (v.outputs || []).some(o => !o.label) && '산출 물질 이름을 입력하세요.',
    submit: (v, op) => api.cmd('complete_step', {
      step_id, version: s.version, actual_end: v.actual_end, actual_start: v.actual_start, outputs: (v.outputs || []).map(o => ({ ...o, branch_id: s.branch_id })),
      observations: v.observations, actual_conditions: v.actual_conditions, inputs: v.inputs, after_state: { form: v.after_form, qty_reset: v.after_qty_reset },
    }, op),
  });
};

for (const [name, cmd, title] of [['pause', 'pause_step', '보류'], ['resume', 'resume_step', '재개']]) {
  FORMS[name] = async ({ batch_id, step_id }) => {
    const d = await loadBatch(batch_id); const s = findStep(d, step_id);
    await openForm({
      form: name, args: { batch_id, step_id }, key: { batch: batch_id, branch: s.branch_id, step: step_id, action: name },
      title: `${title} 기록 · ${s.name}`, submitLabel: `${title} 기록`,
      fields: [{ name: 'at', label: `${title} 시각`, type: 'dt' }, { name: 'note', label: '사유·메모', type: 'textarea' }],
      submit: (v, op) => api.cmd(cmd, { step_id, version: s.version, ...v }, op),
    });
  };
}

FORMS.editStep = async ({ batch_id, step_id }) => {
  const d = await loadBatch(batch_id); const s = findStep(d, step_id);
  await openForm({
    form: 'editStep', args: { batch_id, step_id }, key: { batch: batch_id, branch: s.branch_id, step: step_id, action: 'edit' },
    title: `공정 수정 · ${s.name}`, submitLabel: '수정 저장',
    subtitle: `${STEP_ST[s.status]} 공정 · 수정 전·후 값은 변경 이력에 남습니다. 투입·산출 연결은 <a href="#" data-act="open" data-f="correctIO" data-args="${J({ batch_id, step_id })}">연결 정정</a>에서 바꿉니다.`,
    fields: [
      { name: 'name', label: '공정명', type: 'suggest', options: STEP_NAMES },
      { name: 'branch_id', label: '가지', type: 'select', options: d.branches.map(b => [String(b.id), b.name]) },
      { name: 'status', label: '상태', type: 'seg', options: [['planned', '계획'], ['in_progress', '진행 중'], ['paused', '보류'], ['done', '완료']] },
      { name: 'actual_start', label: '실제 시작', type: 'dt' }, { name: 'actual_end', label: '실제 완료', type: 'dt' },
      { name: 'equipment', label: '장비·위치' }, { name: 'operator', label: '작업자' },
      { name: 'actual_conditions', label: '실제 조건', type: 'textarea' }, { name: 'observations', label: '관찰·이상 사항', type: 'textarea' },
      { name: 'scheduled_date', label: '작업 예정일', type: 'date', adv: true }, { name: 'expected_hours', label: '예상 소요시간(시간)', type: 'num', adv: true },
      { name: 'planned_conditions', label: '계획 조건', type: 'textarea', adv: true },
      { name: 'reason', label: '수정 사유 (선택)' },
    ],
    initial: { ...s, branch_id: String(s.branch_id) },
    submit: (v, op) => {
      const p = { step_id, version: s.version, ...v, branch_id: Number(v.branch_id) };
      if (v.status === s.status) delete p.status;
      return api.cmd('update_step', p, op);
    },
    doneMsg: '수정 저장 ✓',
  });
};

FORMS.correctIO = async ({ batch_id, step_id }) => {
  const d = await loadBatch(batch_id); const s = findStep(d, step_id);
  const linked = s.io.map(i => i.material_id);
  const ioList = (f) => {
    const el = document.createElement('div');
    el.innerHTML = (s.io.length ? `<div class="picklist">${s.io.map(i => `<div class="it"><label class="lb"><input type="checkbox" data-io="${i.id}"> 제외: ${badge(ROLE[i.role])} ${esc(i.label)}
      <span class="muted small">${i.qty_g == null ? '' : fmtNum(i.qty_g) + ' g'}${i.role === 'in' && !i.full_use ? ' (일부 사용)' : ''}</span></label></div>`).join('')}</div>` : '<div class="empty">연결된 물질이 없습니다.</div>')
      + (s.raw.length ? `<h3>원료 투입</h3><div class="picklist">${s.raw.map(r => `<div class="it"><label class="lb"><input type="checkbox" data-raw="${r.id}" ${r.voided_at ? 'disabled' : ''}>
        투입 취소: ${esc(r.raw_name)} ${esc(r.lot_code)} ${fmtNum(-r.delta_g)} g ${r.voided_at ? badge('이미 취소됨') : ''}</label></div>`).join('')}</div>` : '');
    return {
      el, get: () => ({
        remove_io_ids: $$('[data-io]', el).filter(c => c.checked).map(c => Number(c.dataset.io)),
        void_raw_ids: $$('[data-raw]', el).filter(c => c.checked).map(c => Number(c.dataset.raw)),
      }),
      set: v => { (v?.remove_io_ids || []).forEach(id => { const c = $(`[data-io="${id}"]`, el); if (c) c.checked = true; }); (v?.void_raw_ids || []).forEach(id => { const c = $(`[data-raw="${id}"]`, el); if (c) c.checked = true; }); },
    };
  };
  await openForm({
    form: 'correctIO', args: { batch_id, step_id }, key: { batch: batch_id, branch: s.branch_id, step: step_id, action: 'correct-io' },
    title: `연결 정정 · ${s.name}`, submitLabel: '정정 저장',
    subtitle: '잘못 선택한 투입을 빼거나 빠진 물질을 더합니다. 전체가 한 번에 저장되거나, 하나라도 막히면 아무것도 바뀌지 않습니다.',
    fields: [
      { name: 'cur', label: '현재 연결 — 뺄 항목 선택', type: 'custom', custom: (f, val) => { const h = ioList(f); h.set(val); return h; } },
      { name: 'add_inputs', label: '추가할 투입 물질', type: 'custom', adv: true, custom: inputsPicker(d.materials, d.branches, { exclude: linked }) },
      { name: 'add_outputs', label: '추가할 산출 물질', type: 'custom', adv: true, custom: outputsEditor() },
      { name: 'reason', label: '정정 사유', required: true, placeholder: '예: 잔여 슬러리는 세척에 넣지 않았음' },
    ],
    validate: v => !v.reason && '정정 사유를 입력하세요(변경 이력에 남습니다).',
    submit: (v, op) => api.cmd('correct_step_io', {
      step_id, version: s.version, remove_io_ids: v.cur.remove_io_ids, void_raw_ids: v.cur.void_raw_ids,
      add_inputs: v.add_inputs, add_outputs: (v.add_outputs || []).map(o => ({ ...o, branch_id: s.branch_id })), reason: v.reason,
    }, op),
    doneMsg: '연결 정정 저장 ✓',
  });
};

FORMS.cancelStep = async ({ batch_id, step_id }) => {
  const d = await loadBatch(batch_id); const s = findStep(d, step_id);
  await openForm({
    form: 'cancelStep', args: { batch_id, step_id }, key: { batch: batch_id, branch: s.branch_id, step: step_id, action: 'cancel' },
    title: `기록 취소 · ${s.name}`, submitLabel: '기록 취소',
    subtitle: '잘못 입력한 기록을 없던 것으로 되돌립니다(투입 물질 복원, 산출 물질 취소, 원료 투입 취소). 실제로 쓰고 남은 원료를 돌려놓은 것이라면 원료 화면의 "실물 반환"을 쓰세요.',
    fields: [{ name: 'reason', label: '취소 사유', required: true }],
    validate: v => !v.reason && '취소 사유를 입력하세요.',
    submit: (v, op) => api.cmd('cancel_step', { step_id, version: s.version, reason: v.reason }, op),
  });
};

FORMS.move = async ({ batch_id, material_ids }) => {
  const d = await loadBatch(batch_id);
  const names = d.materials.filter(m => material_ids.includes(m.id)).map(m => m.label);
  await openForm({
    form: 'move', args: { batch_id, material_ids }, key: { batch: batch_id, step: 'mv-' + material_ids.join('-').slice(0, 60), action: 'move' },
    title: `가지로 옮기기 · ${material_ids.length}개`, submitLabel: '옮기기',
    subtitle: `${esc(names.slice(0, 6).join(', '))}${names.length > 6 ? ' 외' : ''} — 새로 소분하는 것이 아니라 같은 물질의 소속만 바꿉니다.`,
    fields: [
      { name: 'target', label: '옮길 곳', type: 'select', options: [['new', '+ 새 가지 만들기'], ...d.branches.map(b => [String(b.id), `${b.name} (${BR_KIND[b.kind]})`])], default: 'new' },
      { name: 'new_name', label: '새 가지 이름', default: '확인군', show: v => v.target === 'new' },
      { name: 'new_kind', label: '새 가지 종류', type: 'seg', options: [['exception', '예외'], ['research', '연구'], ['production', '생산']], show: v => v.target === 'new' },
      { name: 'reason', label: '사유·관찰', type: 'textarea', placeholder: '예: 열처리 중 노란 기체가 머무는 것 관찰' },
    ],
    validate: v => v.target === 'new' && !v.new_name && '새 가지 이름을 입력하세요.',
    submit: (v, op) => api.cmd('move_materials', {
      material_ids, reason: v.reason,
      ...(v.target === 'new' ? { new_branch: { name: v.new_name, kind: v.new_kind } } : { to_branch_id: Number(v.target) }),
    }, op),
    done: async () => { BV.sel.clear(); await refresh(); },
  });
};

FORMS.material = async ({ batch_id, material_id }) => {
  const d = await loadBatch(batch_id); const m = d.materials.find(x => x.id == material_id);
  await openForm({
    form: 'material', args: { batch_id, material_id }, key: { batch: batch_id, step: 'mat-' + material_id, action: 'edit-material' },
    title: `물질 · ${m.label}`, submitLabel: '저장', subtitle: '실측 질량 입력, 이름·메모·태그 수정',
    fields: [
      { name: 'qty_g', label: '질량', type: 'num', unit: 'g', hint: '비우면 미측정' },
      { name: 'qty_kind', label: '질량 종류', type: 'seg', options: [['measured', '실측'], ['estimated', '추정'], ['calculated', '계산'], ['planned', '계획']] },
      { name: 'mass_basis', label: '질량 기준', type: 'select', options: Object.entries(BASIS) },
      { name: 'label', label: '이름' }, { name: 'form', label: '상태' }, { name: 'tag', label: '태그', placeholder: '예: 정상군 / 확인군' },
      { name: 'note', label: '메모', type: 'textarea' }, { name: 'reason', label: '수정 사유', adv: true },
    ],
    initial: { ...m, qty_kind: m.qty_kind === 'unknown' ? 'measured' : m.qty_kind },
    submit: (v, op) => api.cmd('update_material', { material_id, version: m.version, ...v }, op),
  });
};

FORMS.product = async ({ batch_id, material_id }) => {
  const d = await loadBatch(batch_id); const m = d.materials.find(x => x.id == material_id);
  const dd = new Date(); const code = `P-${String(dd.getFullYear()).slice(2)}${String(dd.getMonth() + 1).padStart(2, '0')}${String(dd.getDate()).padStart(2, '0')}-${String(d.products.length + 1).padStart(2, '0')}`;
  const firm = m.qty_g != null && ['measured', 'calculated'].includes(m.qty_kind);
  await openForm({
    form: 'product', args: { batch_id, material_id }, key: { batch: batch_id, step: 'prod-' + material_id, action: 'register-product' },
    title: `제품 재고 등록 · ${m.label}`, submitLabel: '제품 등록',
    subtitle: '이 물질을 제품 재고로 등록합니다. 같은 물질은 한 번만 등록됩니다. 필수 QC 6종(XRD·BET·과전압·pH·TGA·XRF)이 계획으로 만들어집니다.',
    fields: [
      { name: 'code', label: '제품 코드', default: code, required: true }, { name: 'name', label: '제품명', default: m.label },
      { name: 'qty_g', label: '제품량', type: 'num', unit: 'g', default: firm ? m.qty_g : undefined, hint: '모르면 비워두고 나중에 실측값을 입력하세요.' },
      { name: 'registered_date', label: '등록일', type: 'date' },
      { name: 'psa', label: '', type: 'check', text: 'PSA 분석도 추가', adv: true },
      { name: 'note', label: '메모', type: 'textarea', adv: true },
    ],
    validate: v => !v.code && '제품 코드를 입력하세요.',
    submit: (v, op) => api.cmd('register_product', { material_id, code: v.code, name: v.name, qty_g: v.qty_g, qty_kind: 'measured', registered_date: v.registered_date, note: v.note, extra_tests: v.psa ? ['PSA'] : [] }, op),
  });
};

async function loadProduct(product_id) { const ps = await api.get('products'); const p = ps.find(x => x.id == product_id); if (!p) throw new ApiError(404, { error: '제품을 찾을 수 없습니다.' }); return p; }

FORMS.editProduct = async ({ product_id }) => {
  const p = await loadProduct(product_id);
  await openForm({
    form: 'editProduct', args: { product_id }, key: { step: 'p-' + product_id, action: 'edit-product' }, title: `제품 수정 · ${p.code}`, submitLabel: '저장',
    fields: [
      { name: 'initial_qty_g', label: '제품량 (등록 시점 실측)', type: 'num', unit: 'g', hint: '비우면 미측정' },
      { name: 'name', label: '제품명' }, { name: 'registered_date', label: '등록일', type: 'date' }, { name: 'note', label: '메모', type: 'textarea' },
      { name: 'reason', label: '수정 사유', adv: true },
    ],
    initial: p,
    submit: (v, op) => api.cmd('update_product', { product_id, version: p.version, ...v, initial_qty_kind: 'measured' }, op),
  });
};

FORMS.use = async ({ product_id }) => {
  const p = await loadProduct(product_id);
  const d = await loadBatch(p.batch_id);
  await openForm({
    form: 'use', args: { product_id }, key: { step: 'p-' + product_id, action: 'use-product' }, title: `제품 사용 · ${p.code}`, submitLabel: '사용 기록',
    subtitle: `잔량 ${p.remaining_g == null ? '미측정' : fmtNum(p.remaining_g) + ' g'}`,
    fields: [
      { name: 'purpose', label: '용도', type: 'seg', options: [['qc', 'QC'], ['internal', '내부 측정'], ['research', '연구 실험'], ['ship', '출하'], ['reprocess', '재처리']] },
      { name: 'qty_g', label: '사용량', type: 'num', unit: 'g', required: true },
      { name: 'used_date', label: '사용일', type: 'date' },
      { name: 'destination', label: '받는 곳·목적', show: v => v.purpose !== 'reprocess' },
      { name: 're_branch', label: '재처리할 가지', type: 'select', options: d.branches.map(b => [String(b.id), b.name]), show: v => v.purpose === 'reprocess' },
      { name: 're_label', label: '재처리분 이름', default: p.code + ' 재처리분', show: v => v.purpose === 'reprocess' },
      { name: 'note', label: '메모', type: 'textarea', adv: true },
    ],
    validate: v => !v.qty_g && '사용량을 입력하세요.',
    submit: (v, op) => api.cmd('use_product', {
      product_id, purpose: v.purpose, qty_g: v.qty_g, used_date: v.used_date, destination: v.destination, note: v.note,
      reprocess: v.purpose === 'reprocess' ? { batch_id: p.batch_id, branch_id: Number(v.re_branch), label: v.re_label } : null,
    }, op),
  });
};

FORMS.voidUsage = async ({ usage_id, label }) => {
  await openForm({
    form: 'voidUsage', args: { usage_id, label }, key: { step: 'u-' + usage_id, action: 'void-usage' }, title: '사용 기록 취소', submitLabel: '취소 기록',
    subtitle: `${esc(label || '')} — 잘못 입력한 사용 기록을 취소합니다. 기록은 지워지지 않고 취소 표시로 남습니다.`,
    fields: [{ name: 'reason', label: '취소 사유', required: true }],
    validate: v => !v.reason && '사유를 입력하세요.',
    submit: (v, op) => api.cmd('void_usage', { usage_id, reason: v.reason }, op),
  });
};

FORMS.qc = async ({ batch_id, qc_id }) => {
  const d = await loadBatch(batch_id); const q = d.qc.find(x => x.id == qc_id);
  await openForm({
    form: 'qc', args: { batch_id, qc_id }, key: { batch: batch_id, step: 'qc-' + qc_id, action: 'qc' },
    title: `${q.test} · ${q.material_label}`, submitLabel: '저장',
    subtitle: q.internal ? '내부 측정: 측정 예정일을 직접 잡습니다.' : '외부 분석: 의뢰일과 회신 예상일 중심으로 관리합니다. 모르면 비워두세요(미정).',
    fields: [
      { name: 'status', label: '진행', type: 'seg', options: [['planned', '계획'], ['requested', q.internal ? '측정 진행' : '의뢰함'], ['received', '결과 수령'], ['cancelled', '취소']] },
      { name: 'scheduled_date', label: '측정 예정일', type: 'date', show: () => !!q.internal },
      { name: 'requested_date', label: '의뢰일', type: 'date', show: v => !q.internal && v.status !== 'planned' },
      { name: 'expected_date', label: '회신 예상일', type: 'date', show: v => !q.internal && v.status !== 'planned' },
      { name: 'result_summary', label: '결과 요약', type: 'textarea', show: v => v.status === 'received' },
      { name: 'evidence_path', label: '근거 파일 위치', placeholder: '예: D:\\분석\\XRD\\B-261110.raw', show: v => v.status === 'received',
        hint: '원본 파일은 복사하지 않고 위치만 기록합니다. 분석은 Pattern Seeker에서.' },
      { name: 'received_date', label: '결과 수령일', type: 'date', show: v => v.status === 'received' },
      { name: 'measured_date', label: '실제 측정일 (확인된 경우)', type: 'date', show: v => v.status !== 'planned' },
      { name: 'representative', label: '최종 산물 대표성', type: 'seg', options: [['', '미확인'], ['1', '대표함'], ['0', '대표 아님']], show: v => v.status === 'received' && !!q.product_id },
      { name: 'representative_note', label: '대표성 근거', show: v => v.status === 'received' && !!q.product_id },
      { name: 'note', label: '메모', type: 'textarea', adv: true },
    ],
    initial: { ...q, representative: q.representative == null ? '' : String(q.representative) },
    validate: v => v.status === 'received' && !v.result_summary && !v.evidence_path && '결과 요약이나 근거 파일 위치를 입력하세요.',
    submit: (v, op) => api.cmd('update_qc', { qc_id, version: q.version, ...v, representative: v.representative === '' ? null : Number(v.representative) }, op),
  });
};

FORMS.addQC = async ({ batch_id, material_id, product_id }) => {
  const d = await loadBatch(batch_id); const m = d.materials.find(x => x.id == material_id);
  await openForm({
    form: 'addQC', args: { batch_id, material_id, product_id }, key: { batch: batch_id, step: 'qcadd-' + material_id, action: 'add-qc' },
    title: `분석 항목 추가 · ${m.label}`, submitLabel: '추가',
    fields: [
      { name: 'tests', label: '분석 항목 (쉼표로 여러 개)', type: 'suggest', options: QC_TESTS, placeholder: '예: XRD, BET' },
      { name: 'note', label: '메모', adv: true },
    ],
    validate: v => !v.tests && '분석 항목을 입력하세요.',
    submit: async (v, op) => {
      const tests = v.tests.split(',').map(s => s.trim()).filter(Boolean);
      let last; for (const [i, t] of tests.entries()) last = await api.cmd('add_qc', { material_id, product_id, test: t, note: v.note }, op + '-' + i);
      return last;
    },
  });
};

FORMS.decide = async ({ product_id }) => {
  const p = await loadProduct(product_id);
  const st = p.qc_state;
  await openForm({
    form: 'decide', args: { product_id }, key: { step: 'p-' + product_id, action: 'decide' }, title: `합불 판정 · ${p.code}`, submitLabel: '판정 저장',
    subtitle: '앱은 수치로 자동 합격시키지 않습니다. 필수 결과와 대표성 확인이 끝나야 합격을 선택할 수 있습니다.',
    fields: [
      { name: 'state', type: 'info', html: `<div class="${st.ready ? 'infobox' : 'warnbox'}">필수 QC ${st.required_received}/${st.required_total} 수령
        ${st.missing.length ? '<ul>' + st.missing.map(m => `<li>${esc(m)}</li>`).join('') + '</ul>' : ' · 모두 확인됨'}</div>
        <table>${p.qc.map(q => `<tr><td>${esc(q.test)}${q.required ? '' : ' <span class="muted small">(선택)</span>'}</td><td>${badge(QC_ST[q.status], q.status)}</td><td>${esc(q.result_summary)}</td></tr>`).join('')}</table>` },
      { name: 'decision', label: '판정', type: 'seg', options: [['hold', '보류'], ['pass', '합격'], ['fail', '불합격']] },
      { name: 'reason', label: '판정 근거', type: 'textarea', required: true, placeholder: '예: 필수 6종 기준 충족, 기존 양품과 XRD·BET 동등' },
      { name: 'decided_date', label: '판정일', type: 'date' },
    ],
    validate: v => !v.reason && '판정 근거를 입력하세요.',
    submit: (v, op) => api.cmd('decide_product', { product_id, ...v }, op),
  });
};

FORMS.adopt = async ({ product_id, source_qc_id, label }) => {
  await openForm({
    form: 'adopt', args: { product_id, source_qc_id, label }, key: { step: 'p-' + product_id + '-q' + source_qc_id, action: 'adopt-qc' },
    title: '이전 결과를 이 제품 결과로 인정', submitLabel: '대표 결과로 인정',
    subtitle: `${esc(label || '')} — 분리·병합·재처리 후의 새 산물에는 결과가 자동으로 이어지지 않습니다. 대표한다고 판단한 근거를 남기세요. 원래 결과는 그대로 보존됩니다.`,
    fields: [{ name: 'representative_note', label: '대표성 근거', type: 'textarea', required: true }],
    validate: v => !v.representative_note && '근거를 입력하세요.',
    submit: (v, op) => api.cmd('adopt_qc_result', { product_id, source_qc_id, ...v }, op),
  });
};

// --- 원료
FORMS.receiveLot = async ({ raw_material_id }) => {
  const raw = await api.get('raw');
  await openForm({
    form: 'receiveLot', args: { raw_material_id }, key: { action: 'receive-lot' }, title: '원료 입고', submitLabel: '입고 등록',
    fields: [
      { name: 'raw_material_id', label: '원료', type: 'select', options: raw.map(r => [String(r.id), r.name]), default: raw_material_id ? String(raw_material_id) : undefined },
      { name: 'lot_code', label: 'Lot 번호', required: true }, { name: 'received_qty_g', label: '입고량', type: 'num', unit: 'g', required: true },
      { name: 'received_date', label: '입고일', type: 'date' },
      { name: 'supplier', label: '공급처', adv: true }, { name: 'note', label: '메모', type: 'textarea', adv: true },
    ],
    validate: v => (!v.lot_code || !v.received_qty_g) && 'Lot 번호와 입고량을 입력하세요.',
    submit: (v, op) => api.cmd('receive_lot', { ...v, raw_material_id: Number(v.raw_material_id) }, op),
  });
};
FORMS.addRaw = async () => {
  await openForm({
    form: 'addRaw', args: {}, key: { action: 'add-raw' }, title: '원료 종류 추가', submitLabel: '추가',
    fields: [{ name: 'name', label: '원료 이름', required: true, placeholder: '예: H₂IrCl₆' }, { name: 'note', label: '메모' }],
    submit: (v, op) => api.cmd('add_raw_material', v, op),
  });
};
async function findLot(lot_id) { const raw = await api.get('raw?deleted=1'); for (const r of raw) for (const l of r.lots) if (l.id == lot_id) return { ...l, raw_name: r.name, raw }; throw new ApiError(404, { error: 'Lot 없음' }); }
FORMS.correctLot = async ({ lot_id }) => {
  const l = await findLot(lot_id);
  await openForm({
    form: 'correctLot', args: { lot_id }, key: { step: 'lot-' + lot_id, action: 'correct-lot' }, title: `실측 잔량 정정 · ${l.raw_name} ${l.lot_code}`, submitLabel: '정정 기록',
    subtitle: `현재 계산 잔량 ${fmtNum(l.remaining_g)} g. 차이만큼 정정 기록이 남고, 기존 투입 기록은 바뀌지 않습니다.`,
    fields: [{ name: 'measured_remaining_g', label: '실측 잔량', type: 'num', unit: 'g', required: true }, { name: 'at', label: '측정일', type: 'date' }, { name: 'note', label: '메모' }],
    validate: v => v.measured_remaining_g === null && '실측 잔량을 입력하세요.',
    submit: (v, op) => api.cmd('correct_lot_remaining', { lot_id, ...v }, op),
  });
};
FORMS.editLot = async ({ lot_id }) => {
  const l = await findLot(lot_id);
  await openForm({
    form: 'editLot', args: { lot_id }, key: { step: 'lot-' + lot_id, action: 'edit-lot' }, title: `Lot 수정 · ${l.lot_code}`, submitLabel: '저장',
    fields: [{ name: 'lot_code', label: 'Lot 번호' }, { name: 'received_qty_g', label: '입고량', type: 'num', unit: 'g' }, { name: 'received_date', label: '입고일', type: 'date' },
      { name: 'supplier', label: '공급처' }, { name: 'note', label: '메모', type: 'textarea' }, { name: 'reason', label: '수정 사유', adv: true }],
    initial: l,
    submit: (v, op) => api.cmd('update_lot', { lot_id, version: l.version, ...v }, op),
  });
};
FORMS.reassign = async ({ ledger_id, lot_id }) => {
  const l = await findLot(lot_id);
  const rm = l.raw.find(r => r.lots.some(x => x.id == lot_id));
  await openForm({
    form: 'reassign', args: { ledger_id, lot_id }, key: { step: 'led-' + ledger_id, action: 'reassign' }, title: '투입 Lot 변경', submitLabel: '변경',
    subtitle: '중복 입고된 Lot을 정리할 때 투입 기록을 올바른 Lot으로 옮깁니다.',
    fields: [{ name: 'new_lot_id', label: '옮길 Lot', type: 'select', options: rm.lots.filter(x => x.id != lot_id && !x.deleted_at).map(x => [String(x.id), `${x.lot_code} (잔량 ${fmtNum(x.remaining_g)} g)`]) },
      { name: 'reason', label: '사유', required: true }],
    validate: v => (!v.new_lot_id && '옮길 Lot이 없습니다.') || (!v.reason && '사유를 입력하세요.'),
    submit: (v, op) => api.cmd('reassign_consumption', { ledger_id, new_lot_id: Number(v.new_lot_id), reason: v.reason }, op),
  });
};
FORMS.voidLedger = async ({ ledger_id }) => {
  await openForm({
    form: 'voidLedger', args: { ledger_id }, key: { step: 'led-' + ledger_id, action: 'void-ledger' }, title: '투입 기록 취소', submitLabel: '기록 취소',
    subtitle: '실제로 투입하지 않았는데 잘못 입력한 경우입니다. 쓰고 남은 원료를 돌려놓았다면 "실물 반환"을 쓰세요.',
    fields: [{ name: 'reason', label: '사유', required: true }],
    validate: v => !v.reason && '사유를 입력하세요.',
    submit: (v, op) => api.cmd('void_raw_consumption', { ledger_id, reason: v.reason }, op),
  });
};
FORMS.returnRaw = async ({ ledger_id }) => {
  await openForm({
    form: 'returnRaw', args: { ledger_id }, key: { step: 'led-' + ledger_id, action: 'return-raw' }, title: '실물 반환', submitLabel: '반환 기록',
    subtitle: '투입하려고 꺼냈다가 실제로 Lot에 돌려놓은 양을 기록합니다. 원래 투입 기록은 그대로 남습니다.',
    fields: [{ name: 'qty_g', label: '반환량', type: 'num', unit: 'g', required: true }, { name: 'at', label: '반환일', type: 'date' }, { name: 'note', label: '메모' }],
    submit: (v, op) => api.cmd('return_raw', { ledger_id, ...v }, op),
  });
};

// --- 정보 패널(저장 없음)
async function infoPanel(title, html) {
  if (CUR) await CUR.close({ keepPanel: true });
  const p = $('#panel'); p.hidden = false;
  p.innerHTML = `<div class="panel-head"><div class="t">${esc(title)}</div></div><div class="panel-body">${html}</div>
    <div class="panel-foot"><span class="save-state muted">보기 전용</span><button class="btn" data-x="close">닫기</button></div>`;
  p.onclick = e => { if (e.target.closest('[data-x="close"]')) { p.hidden = true; p.innerHTML = ''; } };
  p.oninput = p.onchange = null;
}
FORMS.lineage = async ({ material_id }) => {
  const L = await api.get('lineage/' + material_id); const m = L.material;
  const anc = L.ancestors.map(a => `<div class="node">← <b>${esc(a.step.name)}</b> ${a.inputs.map(i => esc(i.label)).join(', ')}
      ${a.raw.map(r => `${esc(r.name)} ${esc(r.lot_code)} ${fmtNum(-r.delta_g)} g`).join(', ')}</div>`).join('') || '<div class="muted">원본(시작 물질)</div>';
  const des = L.descendants.map(x => `<div class="node">→ <b>${esc(x.step.name)}</b> (${ROLE[x.step.role]}) ${x.outputs.length ? '⇒ ' + x.outputs.map(o => esc(o.label)).join(', ') : ''}</div>`).join('') || '<div class="muted">아직 후속 공정 없음</div>';
  await infoPanel(`계보 · ${m.label}`, `<div class="kv"><div class="k">질량</div><div>${g(m.qty_g, m.qty_kind)} · ${BASIS[m.mass_basis]}</div>
      <div class="k">상태</div><div>${esc(m.form) || '-'} · ${m.status === 'active' ? '사용 가능' : m.status === 'consumed' ? '전량 투입됨' : '취소'}</div></div>
    <h3>어디서 왔나</h3><div class="lin">${anc}</div><h3>어디로 갔나</h3><div class="lin">${des}</div>
    <h3>가지 이동</h3>${L.moves.map(mv => `<div class="small">${esc(mv.at)} ${esc(mv.from_name)} → ${esc(mv.to_name)} ${esc(mv.reason)}</div>`).join('') || '<div class="muted small">없음</div>'}
    <h3>QC</h3>${L.qc.map(q => `<div class="small">${esc(q.test)} ${badge(QC_ST[q.status], q.status)} ${esc(q.result_summary)}</div>`).join('') || '<div class="muted small">없음</div>'}
    <h3>변경 이력</h3>${historyTable(L.history)}`);
};
FORMS.history = async ({ batch_id, entity, entity_id, title }) => {
  const qs = new URLSearchParams(); if (batch_id) qs.set('batch_id', batch_id); if (entity) qs.set('entity', entity); if (entity_id) qs.set('entity_id', entity_id);
  const rows = await api.get('audit?' + qs);
  await infoPanel(title || '변경 이력', historyTable(rows));
};
const ACTION_KO = { create: '생성', update: '수정', start: '시작', pause: '보류', resume: '재개', complete: '완료', cancel: '기록 취소', move: '가지 이동', link_input: '투입 연결', unlink: '연결 제외', void: '취소', trash: '휴지통', restore: '복원', archive: '아카이브', unarchive: '아카이브 해제', consume: '원료 투입', correct_remaining: '잔량 정정', reassign_lot: 'Lot 변경', decide: '판정', adopt: '결과 인정', physical_return: '실물 반환' };
function historyTable(rows) {
  if (!rows.length) return '<div class="muted small">이력 없음</div>';
  return `<table class="small"><tr><th>시각</th><th>대상</th><th>동작</th><th>변경 전 → 후</th></tr>${rows.map(r => {
    const b = r.before_json ? JSON.parse(r.before_json) : null, a = r.after_json ? JSON.parse(r.after_json) : null;
    let diff = '';
    if (b && a) diff = Object.keys(a).map(k => `${k}: ${fmtv(b[k])} → ${fmtv(a[k])}`).join('\n');
    else if (a) diff = Object.entries(a).filter(([k, v]) => v !== null && v !== '' && !['created_at', 'updated_at'].includes(k)).slice(0, 6).map(([k, v]) => `${k}: ${fmtv(v)}`).join('\n');
    else if (b) diff = Object.entries(b).map(([k, v]) => `${k}: ${fmtv(v)}`).join('\n');
    return `<tr><td>${esc(r.at)}</td><td>${esc(r.entity)} #${r.entity_id ?? ''}</td><td>${esc(ACTION_KO[r.action] || r.action)}${r.reason ? `<div class="muted">${esc(r.reason)}</div>` : ''}</td><td class="diff">${esc(diff)}</td></tr>`;
  }).join('')}</table>`;
}
const fmtv = v => v === null || v === undefined || v === '' ? '(없음)' : String(v);

// ================================================================= 화면들
async function pageHome() {
  const D = await api.get('dashboard');
  const allNext = [];
  D.batches.forEach(b => b.next_actions.forEach(a => allNext.push({ ...a, batch: b.batch })));
  const waiting = D.qc.waiting, toReq = D.qc.to_request;
  const decideN = D.products.filter(p => p.qc_state.ready && !p.qc_state.decision).length;
  const inProg = D.batches.reduce((n, b) => n + b.lanes.filter(l => l.current).length, 0);
  return `<div class="row"><h1>현황</h1><span class="spacer"></span>${btnOpen('+ 새 배치', 'newBatch', {}, 'btn pri')}</div>
  <div class="kpi">
    <div class="k"><div class="v">${D.batches.length}</div><div class="n">진행 중인 배치</div></div>
    <div class="k"><div class="v">${inProg}</div><div class="n">진행·보류 중 공정</div></div>
    <div class="k"><div class="v">${toReq.length}</div><div class="n">QC 의뢰 필요</div></div>
    <div class="k"><div class="v">${waiting.length}</div><div class="n">QC 결과 대기</div></div>
    <div class="k"><div class="v">${decideN}</div><div class="n">합불 판정 대기</div></div>
  </div>
  ${D.drafts.length ? `<div class="card" style="margin-top:12px"><h3>작성 중인 초안 (아직 등록 안 됨)</h3><ul class="list-plain">${D.drafts.slice(0, 6).map(dr => `<li>${badge('초안', 'draft')} ${esc(dr.title)} <span class="muted small">${esc(dr.updated_at)}</span><span class="spacer"></span><button class="btn sm" data-act="resumeDraft" data-key="${esc(dr.draft_key)}">이어서 작성</button></li>`).join('')}</ul></div>` : ''}
  <div class="grid g2" style="margin-top:12px">
    <div class="card"><h2>다음에 할 일</h2>${allNext.length ? `<ul class="list-plain">${allNext.slice(0, 12).map(a => `<li><a href="#/batch/${a.batch.id}">${esc(a.batch.code)}</a> ${esc(a.label)}<span class="spacer"></span>${nextBtn(a, a.batch.id, 'btn sm')}</li>`).join('')}</ul>` : '<div class="empty">할 일이 없습니다.</div>'}</div>
    <div class="card"><h2>작업 일정</h2>${scheduleList(D)}</div>
  </div>
  <h2>진행 중인 배치</h2>
  ${D.batches.length ? `<div class="grid g2">${D.batches.map(b => `<div class="card"><div class="row"><a href="#/batch/${b.batch.id}"><b>${esc(b.batch.code)}</b></a> ${esc(b.batch.title)}<span class="spacer"></span><a class="btn sm" href="#/batch/${b.batch.id}">열기</a></div>
      <table class="small" style="margin-top:6px">${b.lanes.map(l => `<tr><td>${badge(BR_KIND[l.branch.kind], l.branch.kind)} ${esc(l.branch.name)} ${l.branch.status !== 'active' ? badge(BR_ST[l.branch.status]) : ''}</td>
        <td>${l.current ? `${badge(STEP_ST[l.current.status], l.current.status)} ${esc(l.current.name)}` : l.last_done ? `<span class="muted">최근:</span> ${esc(l.last_done.name)}` : '<span class="muted">기록 없음</span>'}
        ${l.next_planned ? `<div class="muted">다음: ${esc(l.next_planned.name)}${l.next_planned.scheduled_date ? ' (' + esc(l.next_planned.scheduled_date) + ')' : ''}</div>` : ''}</td>
        <td class="num">${l.active_materials}개</td></tr>`).join('')}</table></div>`).join('')}</div>` : `<div class="card empty">진행 중인 배치가 없습니다. ${btnOpen('+ 새 배치', 'newBatch', {}, 'btn pri')}</div>`}
  <div class="grid g2" style="margin-top:12px">
    <div class="card"><h2>QC 현황</h2>${qcWaitingList(waiting)}<h3>의뢰 필요</h3>${qcToRequest(toReq)}</div>
    <div class="card"><h2>재고</h2>${rawSummary(D.raw)}<h3>제품</h3>${productSummary(D.products)}</div>
  </div>`;
}
function nextBtn(a, batch_id, cls = 'btn sm', full = false) {
  const map = {
    charge: ['charge', { batch_id, branch_id: a.branch_id }], complete: ['complete', { batch_id, step_id: a.step_id }],
    resume: ['resume', { batch_id, step_id: a.step_id }], start: ['start', { batch_id, step_id: a.step_id }],
    process: ['step', { batch_id, branch_id: a.branch_id }], decide: ['decide', { product_id: a.product_id }],
  };
  if (a.kind === 'qc_request') return `<a class="${cls}" href="#/qc">QC 화면</a>`;
  const [f, args] = map[a.kind] || [];
  if (!f) return '';
  const lbl = full ? esc(a.label) : { charge: '원료 투입', complete: '완료 기록', resume: '재개', start: '시작', process: '공정 기록', decide: '판정' }[a.kind];
  return btnOpen(lbl, f, args, cls);
}
function scheduleList(D) {
  const items = [...D.schedule.map(s => ({ ...s, date: s.scheduled_date, what: `${s.name}`, where: `${s.batch_code} · ${s.branch_name}` })),
  ...D.qc_schedule.map(q => ({ ...q, date: q.scheduled_date, what: `${q.test} 측정 (내부)`, where: `${q.batch_code} · ${q.material_label}` }))]
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  if (!items.length) return '<div class="empty">예정된 작업이 없습니다. 공정을 "계획만"으로 등록하면 여기 나옵니다.</div>';
  return `<ul class="list-plain">${items.map(i => `<li><span style="min-width:86px">${i.date ? esc(i.date) : '<span class="muted">날짜 미정</span>'}</span>
    ${i.overdue ? badge('지남', 'overdue') : ''} ${i.type === 'step' ? badge(STEP_ST[i.status], i.status) : ''} <b>${esc(i.what)}</b> <span class="muted small">${esc(i.where)}</span>
    <span class="spacer"></span><a class="btn sm ghost" href="#/batch/${i.batch_id}">열기</a></li>`).join('')}</ul>`;
}
function qcWaitingList(rows) {
  if (!rows.length) return '<div class="empty">결과 대기 중인 분석이 없습니다.</div>';
  return `<table class="small"><tr><th>분석</th><th>대상</th><th>의뢰일</th><th>회신 예상</th><th class="num">경과</th><th></th></tr>${rows.map(q => `<tr>
    <td><b>${esc(q.test)}</b> ${q.long_wait ? badge('장기 분석', 'warn') : ''}</td><td>${esc(q.batch_code)} · ${esc(q.product_code || q.material_label)}</td>
    <td>${q.requested_date ? esc(q.requested_date) : '<span class="muted">미정</span>'}</td><td>${q.expected_date ? esc(q.expected_date) : '<span class="muted">미정</span>'} ${q.overdue ? badge('예상일 지남', 'overdue') : ''}</td>
    <td class="num">${q.days_waiting == null ? '' : q.days_waiting + '일'}</td><td>${btnOpen('결과 입력', 'qc', { batch_id: q.batch_id, qc_id: q.id })}</td></tr>`).join('')}</table>`;
}
function qcToRequest(rows) {
  if (!rows.length) return '<div class="empty">없음</div>';
  const grp = {};
  rows.forEach(q => { const k = `${q.batch_code} · ${q.product_code || q.material_label}`; (grp[k] = grp[k] || []).push(q); });
  return `<ul class="list-plain">${Object.entries(grp).map(([k, qs]) => `<li><span>${esc(k)}</span> ${qs.map(q => `<button class="btn sm" data-act="open" data-f="qc" data-args="${J({ batch_id: q.batch_id, qc_id: q.id })}">${esc(q.test)}${q.internal && q.scheduled_date ? ' ' + esc(q.scheduled_date.slice(5)) : ''}</button>`).join(' ')}</li>`).join('')}</ul>`;
}
function rawSummary(raw) {
  return `<table class="small">${raw.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="num"><b>${fmtNum(r.total_remaining_g)} g</b></td>
    <td class="muted">${r.lots.filter(l => !l.deleted_at).map(l => `${esc(l.lot_code)} ${fmtNum(l.remaining_g)} g`).join(' · ') || 'Lot 없음'}</td></tr>`).join('')}</table>`;
}
function decisionBadge(st) {
  if (st.decision) return badge(DEC[st.decision.decision], st.decision.decision);
  if (st.ready) return badge('판정 대기', 'warn');
  return badge(`QC ${st.required_received}/${st.required_total}`);
}
function productSummary(ps) {
  if (!ps.length) return '<div class="empty">제품 재고가 없습니다.</div>';
  return `<table class="small">${ps.map(p => `<tr><td><b>${esc(p.code)}</b> <span class="muted">${esc(p.batch_code)}</span></td><td class="num">${g(p.remaining_g, p.remaining_g == null ? 'unknown' : null)}</td><td>${decisionBadge(p.qc_state)}</td></tr>`).join('')}</table>`;
}

async function pageBatches() {
  const [act, arc] = await Promise.all([api.get('batches?status=active'), api.get('batches?status=archived')]);
  const tbl = rows => rows.length ? `<table><tr><th>배치</th><th>이름</th><th>가지</th><th>등록</th></tr>${rows.map(b => `<tr><td><a href="#/batch/${b.id}"><b>${esc(b.code)}</b></a></td><td>${esc(b.title)}</td><td>${b.branch_count}</td><td class="muted">${esc(b.created_at.slice(0, 10))}</td></tr>`).join('')}</table>` : '<div class="empty">없음</div>';
  return `<div class="row"><h1>배치</h1><span class="spacer"></span>${btnOpen('+ 새 배치', 'newBatch', {}, 'btn pri')}</div>
    <div class="card"><h2>진행 목록</h2>${tbl(act)}</div><div class="card" style="margin-top:12px"><h2>아카이브</h2>${tbl(arc)}</div>
    <p class="muted small">휴지통은 기록·백업 화면에 있습니다.</p>`;
}

// --- 배치 화면
const BV = { id: null, data: null, sel: new Set(), last: null, showUsed: {} };
async function pageBatch(id) {
  id = Number(id);
  if (BV.id !== id) { BV.id = id; BV.sel = new Set(); BV.showUsed = {}; }
  const d = await loadBatch(id);
  BV.data = d;
  for (const mid of [...BV.sel]) { const m = d.materials.find(x => x.id === mid); if (!m || m.status !== 'active') BV.sel.delete(mid); }
  const b = d.batch;
  const na = d.next_actions;
  const lanes = d.branches.map(br => laneHtml(d, br)).join('');
  const nonProdQC = d.qc.filter(q => !q.product_id);
  return `<div class="row"><h1>${esc(b.code)} <span class="muted" style="font-weight:400">${esc(b.title)}</span></h1>
      ${b.status !== 'active' ? badge(b.status === 'archived' ? '아카이브' : '휴지통', 'warn') : ''}<span class="spacer"></span>
      ${btnOpen('배치 수정', 'editBatch', { batch_id: id })} ${btnOpen('+ 가지', 'addBranch', { batch_id: id })}
      ${btnOpen('변경 이력', 'history', { batch_id: id, title: b.code + ' 변경 이력' })}
      ${b.status === 'active' ? `<button class="btn sm" data-act="batchStatus" data-id="${id}" data-a="archive">아카이브</button>` : b.status === 'archived' ? `<button class="btn sm" data-act="batchStatus" data-id="${id}" data-a="unarchive">진행으로 되돌리기</button>` : ''}
      ${b.status !== 'trashed' ? `<button class="btn sm bad" data-act="batchStatus" data-id="${id}" data-a="trash">휴지통</button>` : `<button class="btn sm" data-act="batchStatus" data-id="${id}" data-a="restore">복원</button>`}</div>
    ${b.common_conditions ? `<div class="muted small">공통 조건: ${esc(b.common_conditions)}</div>` : ''}
    <div class="next-bar"><span class="lbl">다음 행동</span>${na.length ? `<span>${nextBtn(na[0], id, 'btn pri big')}</span><span class="small" style="margin-right:10px">${esc(na[0].label)}</span>` + na.slice(1, 4).map(a => nextBtn(a, id, 'btn', true)).join('') : '<span class="muted">제안할 작업이 없습니다. 아래 가지에서 직접 기록하세요.</span>'}
      ${na.length > 1 ? `<details style="flex-basis:100%"><summary class="small">모든 제안 ${na.length}개</summary><ul class="list-plain">${na.map(a => `<li>${esc(a.label)}<span class="spacer"></span>${nextBtn(a, id)}</li>`).join('')}</ul></details>` : ''}</div>
    <div class="lanes">${lanes}</div>
    ${d.products.length ? `<h2>제품 재고</h2><div class="card">${productTable(d.products)}</div>` : ''}
    ${nonProdQC.length ? `<h2>분석 (연구·확인 시료)</h2><div class="card"><table class="small"><tr><th>분석</th><th>시료</th><th>상태</th><th>의뢰·회신</th><th>결과</th><th></th></tr>
      ${nonProdQC.map(q => `<tr><td><b>${esc(q.test)}</b></td><td>${esc(q.material_label)}</td><td>${badge(QC_ST[q.status], q.status)}</td><td>${esc(q.requested_date || '')} ${q.expected_date ? '→ ' + esc(q.expected_date) : ''}</td><td>${esc(q.result_summary)}${q.evidence_path ? `<div class="muted">${esc(q.evidence_path)}</div>` : ''}</td><td>${btnOpen('입력', 'qc', { batch_id: id, qc_id: q.id })}</td></tr>`).join('')}</table></div>` : ''}
    ${selBar(d)}`;
}
function laneHtml(d, br) {
  const id = d.batch.id;
  const steps = d.steps.filter(s => s.branch_id === br.id);
  const mats = d.materials.filter(m => m.branch_id === br.id);
  const active = mats.filter(m => m.status === 'active');
  const used = mats.filter(m => m.status !== 'active');
  return `<div class="card lane ${br.kind} ${br.status}">
    <div class="lane-head"><span class="name">${esc(br.name)}</span>${badge(BR_KIND[br.kind], br.kind)}${br.status !== 'active' ? badge(BR_ST[br.status], br.status === 'done' ? 'done' : 'warn') : ''}
      <span class="spacer"></span>${btnOpen('가지 설정', 'editBranch', { batch_id: id, branch_id: br.id }, 'btn sm ghost')}</div>
    ${br.condition_diff ? `<div class="small muted">달라진 조건: ${esc(br.condition_diff)}</div>` : ''}
    <ul class="steps">${steps.map(s => stepHtml(d, s)).join('') || '<li class="muted small">아직 공정 기록이 없습니다.</li>'}</ul>
    <div class="row">${btnOpen('+ 공정 기록', 'step', { batch_id: id, branch_id: br.id }, 'btn sm pri')}
      ${br.kind === 'production' || !d.steps.some(s => s.kind === 'charge') ? btnOpen('원료 투입', 'charge', { batch_id: id, branch_id: br.id }) : ''}</div>
    <h3 style="margin-top:10px">물질 <span class="muted small">${active.length}개 사용 가능 · 클릭해서 선택(Shift: 범위), 더블클릭: 계보</span></h3>
    ${active.length ? `<div class="row small"><button class="btn sm ghost" data-act="selAll" data-br="${br.id}">이 가지 전체 선택</button></div>` : ''}
    <div class="mats">${active.map(m => matChip(m)).join('') || '<span class="muted small">없음</span>'}</div>
    ${used.length ? `<details ${BV.showUsed[br.id] ? 'open' : ''} data-act-toggle="${br.id}"><summary class="small muted">투입·취소된 물질 ${used.length}개</summary><div class="mats">${used.map(m => `<span class="mat" style="opacity:.6" data-act="lin" data-id="${m.id}">${esc(m.label)} <span class="q">${m.status === 'voided' ? '취소' : '투입됨'}</span></span>`).join('')}</div></details>` : ''}
  </div>`;
}
function matChip(m) {
  return `<span class="mat ${BV.sel.has(m.id) ? 'sel' : ''} ${m.product ? 'product' : ''}" data-mat="${m.id}" title="${esc(m.form)} · ${BASIS[m.mass_basis]}${m.note ? ' · ' + esc(m.note) : ''}">
    ${esc(m.label)} <span class="q">${m.qty_g == null ? '미측정' : fmtNum(m.qty_g) + 'g' + (m.qty_kind !== 'measured' ? '·' + KIND[m.qty_kind] : '')}</span>
    ${m.tag ? badge(m.tag) : ''}${m.product ? badge(m.product.code, 'ok') : ''}</span>`;
}
function stepHtml(d, s) {
  const id = d.batch.id;
  const ins = s.io.filter(i => i.role === 'in'), thr = s.io.filter(i => i.role === 'through'), outs = s.io.filter(i => i.role === 'out');
  const summ = [];
  if (s.raw.length) summ.push(s.raw.map(r => `${esc(r.raw_name)} ${esc(r.lot_code)} ${fmtNum(-r.delta_g)} g${r.voided_at ? ' (취소)' : ''}`).join(', ') + ' 투입');
  if (ins.length) summ.push(`투입 ${ins.length > 3 ? ins.length + '개' : ins.map(i => esc(i.label) + (i.full_use ? '' : ` ${fmtNum(i.qty_g)} g`)).join(', ')}`);
  if (thr.length) summ.push(`처리 ${thr.length > 3 ? thr.length + '개' : thr.map(i => esc(i.label)).join(', ')}`);
  if (outs.length) summ.push(`산출 ${outs.length > 3 ? esc(outs[0].label) + ' 외 ' + (outs.length - 1) + '개' : outs.map(i => esc(i.label)).join(', ')}`);
  const btns = [];
  if (s.status === 'planned') btns.push(btnOpen('시작', 'start', { batch_id: id, step_id: s.id }), btnOpen('완료', 'complete', { batch_id: id, step_id: s.id }));
  if (s.status === 'in_progress') btns.push(btnOpen('완료 기록', 'complete', { batch_id: id, step_id: s.id }, 'btn sm pri'), btnOpen('보류', 'pause', { batch_id: id, step_id: s.id }));
  if (s.status === 'paused') btns.push(btnOpen('재개', 'resume', { batch_id: id, step_id: s.id }), btnOpen('완료', 'complete', { batch_id: id, step_id: s.id }));
  if (s.status !== 'cancelled') btns.push(btnOpen('수정', 'editStep', { batch_id: id, step_id: s.id }), btnOpen('연결 정정', 'correctIO', { batch_id: id, step_id: s.id }, 'btn sm ghost'), btnOpen('기록 취소', 'cancelStep', { batch_id: id, step_id: s.id }, 'btn sm ghost bad'));
  btns.push(btnOpen('이력', 'history', { entity: 'step', entity_id: s.id, title: s.name + ' 이력' }, 'btn sm ghost'));
  const when = s.status === 'planned' ? (s.scheduled_date ? `예정 ${esc(s.scheduled_date)}` : '날짜 미정') :
    `${dtxt(s.actual_start)} → ${s.status === 'done' ? dtxt(s.actual_end) : '…'}`;
  return `<li style="${s.status === 'cancelled' ? 'opacity:.5' : ''}"><div class="step-line">${badge(STEP_ST[s.status], s.status)}<span class="nm">${esc(s.name)}</span><span class="small muted">${when}</span></div>
    <div class="step-meta">${summ.join(' · ')}${s.equipment ? ' · ' + esc(s.equipment) : ''}</div>
    ${s.actual_conditions ? `<div class="step-meta">조건: ${esc(s.actual_conditions)}</div>` : s.planned_conditions ? `<div class="step-meta">계획: ${esc(s.planned_conditions)}</div>` : ''}
    ${s.observations ? `<div class="step-meta" style="color:#7a4400">관찰: ${esc(s.observations)}</div>` : ''}
    <div class="row" style="margin-top:3px">${btns.join('')}</div></li>`;
}
function selBar(d) {
  const n = BV.sel.size;
  if (!n) return '';
  const ids = [...BV.sel]; const one = n === 1 ? d.materials.find(m => m.id === ids[0]) : null;
  const brs = new Set(ids.map(i => d.materials.find(m => m.id === i)?.branch_id));
  const br = brs.size === 1 ? [...brs][0] : d.branches[0].id;
  const inputs = ids.map(i => ({ material_id: i, role: 'in', full_use: true }));
  const id = d.batch.id;
  return `<div class="selbar"><b>${n}개 선택</b>
    ${btnOpen('공정 기록', 'step', { batch_id: id, branch_id: br, inputs }, 'btn sm pri')}
    ${n === 1 ? btnOpen('같은 양으로 소분', 'split', { batch_id: id, material_id: ids[0] }) : btnOpen('합치기', 'step', { batch_id: id, branch_id: br, inputs, kind: 'merge' })}
    ${btnOpen('가지로 옮기기', 'move', { batch_id: id, material_ids: ids })}
    ${one ? btnOpen('질량·정보', 'material', { batch_id: id, material_id: one.id }) + btnOpen('계보', 'lineage', { material_id: one.id }) + btnOpen('분석 추가', 'addQC', { batch_id: id, material_id: one.id }) + (one.product ? '' : btnOpen('제품 등록', 'product', { batch_id: id, material_id: one.id })) : ''}
    <span class="spacer"></span><button class="btn sm" data-act="selClear">선택 해제</button></div>`;
}
function productTable(ps) {
  return `<table class="small"><tr><th>제품</th><th>물질</th><th class="num">잔량</th><th>QC</th><th>판정</th><th></th></tr>${ps.map(p => `<tr>
    <td><b>${esc(p.code)}</b>${p.batch_code ? ` <a class="muted" href="#/batch/${p.batch_id}">${esc(p.batch_code)}</a>` : ''}</td><td>${esc(p.material_label || p.name)}</td>
    <td class="num">${p.remaining_g == null ? '<span class="muted">미측정</span>' : fmtNum(p.remaining_g) + ' g'}</td>
    <td>${p.qc_state.required_received}/${p.qc_state.required_total}${p.qc_state.missing.length ? `<div class="muted">${esc(p.qc_state.missing.slice(0, 3).join(', '))}${p.qc_state.missing.length > 3 ? ' …' : ''}</div>` : ''}</td>
    <td>${decisionBadge(p.qc_state)}</td>
    <td class="row">${btnOpen('사용', 'use', { product_id: p.id })}${btnOpen('판정', 'decide', { product_id: p.id })}${btnOpen('제품량·정보', 'editProduct', { product_id: p.id }, 'btn sm ghost')}<a class="btn sm ghost" href="#/products">QC·사용 내역</a></td></tr>`).join('')}</table>`;
}

// --- 제품
const PV = { open: new Set() };
async function pageProducts() {
  const ps = await api.get('products');
  const rows = await Promise.all(ps.map(async p => ({ p, anc: PV.open.has(p.id) ? await api.get('ancestor_qc/' + p.id) : [] })));
  return `<h1>제품 재고</h1>${ps.length ? rows.map(({ p, anc }) => `<div class="card" style="margin-bottom:10px">
    <div class="row"><b style="font-size:15px">${esc(p.code)}</b> ${esc(p.name)} <a href="#/batch/${p.batch_id}" class="muted">${esc(p.batch_code)}</a> ${decisionBadge(p.qc_state)}
      <span class="spacer"></span>잔량 <b>${p.remaining_g == null ? '미측정' : fmtNum(p.remaining_g) + ' g'}</b>
      ${btnOpen('사용 기록', 'use', { product_id: p.id }, 'btn sm pri')}${btnOpen('판정', 'decide', { product_id: p.id })}${btnOpen('제품량·정보', 'editProduct', { product_id: p.id })}
      <button class="btn sm ghost" data-act="pToggle" data-id="${p.id}">${PV.open.has(p.id) ? '접기' : '자세히'}</button></div>
    <div class="row small" style="margin-top:6px">${p.qc.map(q => `<button class="btn sm" data-act="open" data-f="qc" data-args="${J({ batch_id: p.batch_id, qc_id: q.id })}">${esc(q.test)} ${badge(QC_ST[q.status], q.status)}${q.status === 'received' && q.representative !== 1 && q.required ? ' ' + badge('대표성?', 'warn') : ''}</button>`).join('')}
      ${btnOpen('+ 분석', 'addQC', { batch_id: p.batch_id, material_id: p.material_id, product_id: p.id }, 'btn sm ghost')}</div>
    ${PV.open.has(p.id) ? `<div class="grid g2" style="margin-top:8px"><div><h3>사용 내역</h3>${p.usages.length ? `<table class="small">${p.usages.map(u => `<tr style="${u.voided_at ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${esc(u.used_date || '')}</td><td>${PURPOSE[u.purpose]}</td><td class="num">${fmtNum(u.qty_g)} g</td><td>${esc(u.destination)}</td>
        <td>${u.voided_at ? '취소: ' + esc(u.void_reason) : btnOpen('취소', 'voidUsage', { usage_id: u.id, label: `${PURPOSE[u.purpose]} ${fmtNum(u.qty_g)} g` }, 'btn sm ghost bad')}</td></tr>`).join('')}</table>` : '<div class="empty">없음</div>'}</div>
      <div><h3>QC 결과</h3><table class="small">${p.qc.map(q => `<tr><td>${esc(q.test)}</td><td>${badge(QC_ST[q.status], q.status)}</td><td>${esc(q.result_summary)}${q.source_qc_id ? '<div class="muted">이전 산물 결과를 인정: ' + esc(q.representative_note) + '</div>' : ''}${q.evidence_path ? `<div class="muted">${esc(q.evidence_path)}</div>` : ''}</td></tr>`).join('')}</table>
      <h3>계보상 이전 산물의 결과 (자동 승계 안 됨)</h3>${anc.length ? `<table class="small">${anc.map(a => `<tr><td>${esc(a.test)}</td><td>${esc(a.material_label)}</td><td>${esc(a.result_summary)}</td><td>${btnOpen('이 제품 결과로 인정', 'adopt', { product_id: p.id, source_qc_id: a.id, label: `${a.test} · ${a.material_label}` })}</td></tr>`).join('')}</table>` : '<div class="muted small">없음</div>'}</div></div>` : ''}
  </div>`).join('') : '<div class="card empty">제품 재고가 없습니다. 배치 화면에서 최종 산물을 선택하고 "제품 등록"을 누르세요.</div>'}`;
}

// --- QC
async function pageQC() {
  const Q = await api.get('qc');
  return `<h1>QC</h1><div class="card"><h2>결과 대기</h2>${qcWaitingList(Q.waiting)}</div>
    <div class="card" style="margin-top:12px"><h2>의뢰·측정 필요</h2>${Q.to_request.length ? `<table class="small"><tr><th>분석</th><th>대상</th><th>구분</th><th>측정 예정</th><th></th></tr>${Q.to_request.map(q => `<tr><td><b>${esc(q.test)}</b> ${q.required ? '' : '<span class="muted">(선택)</span>'}</td>
      <td>${esc(q.batch_code)} · ${esc(q.product_code || q.material_label)} <span class="muted">${esc(q.branch_name)}</span></td><td>${q.internal ? '내부 측정' : '외부 의뢰'}</td>
      <td>${q.internal ? (q.scheduled_date ? esc(q.scheduled_date) : '<span class="muted">미정</span>') : ''}</td><td>${btnOpen(q.internal ? '일정·결과' : '의뢰 기록', 'qc', { batch_id: q.batch_id, qc_id: q.id })}</td></tr>`).join('')}</table>` : '<div class="empty">없음</div>'}</div>
    <p class="muted small">XRD·BET 등의 과학적 분석은 Pattern Seeker에서 합니다. 여기서는 결과 요약과 파일 위치만 기록합니다.</p>`;
}

// --- 원료
const RV = { deleted: false };
async function pageRaw() {
  const raw = await api.get('raw' + (RV.deleted ? '?deleted=1' : ''));
  return `<div class="row"><h1>원료</h1><span class="spacer"></span>${btnOpen('+ 입고 등록', 'receiveLot', {}, 'btn pri')}${btnOpen('원료 종류 추가', 'addRaw', {})}
    <label class="small"><input type="checkbox" data-act="rawDeleted" ${RV.deleted ? 'checked' : ''}> 휴지통 Lot 보기</label></div>
    ${raw.map(r => `<div class="card" style="margin-bottom:10px"><div class="row"><h2 style="margin:0">${esc(r.name)}</h2><span class="muted">총 잔량</span> <b>${fmtNum(r.total_remaining_g)} g</b>
      <span class="spacer"></span>${btnOpen('입고', 'receiveLot', { raw_material_id: r.id })}</div>
      ${r.lots.length ? `<table class="small" style="margin-top:6px"><tr><th>Lot</th><th>입고일</th><th class="num">입고량</th><th class="num">잔량</th><th>사용 내역</th><th></th></tr>
      ${r.lots.map(l => `<tr style="${l.deleted_at ? 'opacity:.55' : ''}"><td><b>${esc(l.lot_code)}</b>${l.deleted_at ? ' ' + badge('휴지통') : ''}<div class="muted">${esc(l.supplier)}</div></td><td>${esc(l.received_date || '')}</td>
        <td class="num">${fmtNum(l.received_qty_g)} g</td><td class="num"><b>${fmtNum(l.remaining_g)} g</b></td>
        <td>${l.ledger.map(e => `<div style="${e.voided_at ? 'text-decoration:line-through;opacity:.6' : ''}">${e.kind === 'consume' ? `투입 ${fmtNum(-e.delta_g)} g · <a href="#/batch/${e.batch_id}">${esc(e.batch_code)}</a>` : `${esc(e.note)} ${e.delta_g > 0 ? '+' : ''}${fmtNum(e.delta_g)} g`} <span class="muted">${esc(e.at || '')}</span>
          ${e.kind === 'consume' && !e.voided_at ? `${btnOpen('Lot 변경', 'reassign', { ledger_id: e.id, lot_id: l.id }, 'btn sm ghost')}${btnOpen('실물 반환', 'returnRaw', { ledger_id: e.id }, 'btn sm ghost')}${btnOpen('기록 취소', 'voidLedger', { ledger_id: e.id }, 'btn sm ghost bad')}` : ''}${e.voided_at ? ' 취소: ' + esc(e.void_reason) : ''}</div>`).join('') || '<span class="muted">없음</span>'}</td>
        <td class="row">${l.deleted_at ? `<button class="btn sm" data-act="lotRestore" data-id="${l.id}">복원</button>` : `${btnOpen('잔량 정정', 'correctLot', { lot_id: l.id })}${btnOpen('수정', 'editLot', { lot_id: l.id }, 'btn sm ghost')}<button class="btn sm ghost bad" data-act="lotTrash" data-id="${l.id}">휴지통</button>`}</td></tr>`).join('')}</table>` : '<div class="empty">입고된 Lot이 없습니다.</div>'}</div>`).join('')}`;
}

// --- 기록·백업
async function pageRecords() {
  const [info, backups, trash, audit, drafts] = await Promise.all([api.get('info'), api.get('backups'), api.get('batches?status=trashed'), api.get('audit'), api.get('drafts')]);
  return `<h1>기록·백업</h1>
  <div class="grid g2"><div class="card"><h2>백업</h2>
    <div class="small muted">운영 데이터: ${esc(info.db_path)}</div>
    <div class="f" style="margin-top:8px"><label class="l">백업 저장 위치 (폴더 또는 파일)</label><div class="inline"><input type="text" id="bk-path" value="${esc(info.user_backup_dir)}"><button class="btn pri" data-act="backup">지금 백업</button></div>
      <div class="hint">USB나 다른 드라이브 경로를 적어도 됩니다. 앱을 시작할 때 하루 한 번 자동 백업도 합니다.</div></div>
    <h3>복원</h3><div class="f"><div class="inline"><input type="text" id="rs-path" placeholder="복원할 .cfdb 파일 경로"><button class="btn" data-act="restorePath">복원</button></div>
      <div class="hint">복원 직전 현재 데이터를 자동으로 안전 백업하고, 파일을 검사한 뒤에만 교체합니다. 실패하면 현재 데이터는 그대로입니다.</div></div>
    <table class="small">${backups.slice(0, 15).map(b => `<tr><td>${esc(b.name)}<div class="muted">${esc(b.path)}</div></td><td>${esc(b.mtime)}</td><td class="num">${Math.round(b.size / 1024)} KB</td><td><button class="btn sm" data-act="restore" data-path="${esc(b.path)}">복원</button></td></tr>`).join('')}</table></div>
  <div class="card"><h2>작성 중인 초안</h2>${drafts.length ? `<ul class="list-plain">${drafts.map(dr => `<li>${badge('초안', 'draft')} ${esc(dr.title)} <span class="muted small">${esc(dr.updated_at)}</span><span class="spacer"></span><button class="btn sm" data-act="resumeDraft" data-key="${esc(dr.draft_key)}">이어서 작성</button><button class="btn sm ghost bad" data-act="dropDraft" data-key="${esc(dr.draft_key)}">버리기</button></li>`).join('')}</ul>` : '<div class="empty">없음</div>'}
    <h2>휴지통 (배치)</h2>${trash.length ? `<ul class="list-plain">${trash.map(b => `<li><a href="#/batch/${b.id}">${esc(b.code)}</a> ${esc(b.title)}<span class="spacer"></span><button class="btn sm" data-act="batchStatus" data-id="${b.id}" data-a="restore">복원</button></li>`).join('')}</ul>` : '<div class="empty">비어 있음</div>'}
    <p class="small muted">버전 ${esc(info.version)} · 인터넷 연결 없이 동작합니다.</p></div></div>
  <div class="card" style="margin-top:12px"><h2>최근 변경 이력</h2>${historyTable(audit.slice(0, 120))}</div>`;
}

// ================================================================= 이벤트
const ACTS = {
  open: d => openF(d.f, JSON.parse(d.args)),
  back: () => history.back(),
  forward: () => history.forward(),
  selClear: () => { BV.sel.clear(); refresh(); },
  selAll: d => { BV.data.materials.filter(m => m.branch_id == d.br && m.status === 'active').forEach(m => BV.sel.add(m.id)); refresh(); },
  lin: d => openF('lineage', { material_id: Number(d.id) }),
  pToggle: d => { const id = Number(d.id); PV.open.has(id) ? PV.open.delete(id) : PV.open.add(id); refresh(); },
  rawDeleted: () => { RV.deleted = !RV.deleted; refresh(); },
  lotTrash: async d => {
    if (!await confirmBox('이 Lot을 휴지통으로 옮길까요? (나중에 복원할 수 있습니다)', '휴지통으로', true)) return;
    try { await api.cmd('trash_lot', { lot_id: Number(d.id), reason: '' }, uid()); toast('휴지통으로 옮김'); refresh(); }
    catch (e) { showErrModal(e); }
  },
  lotRestore: async d => { await api.cmd('restore_lot', { lot_id: Number(d.id) }, uid()); toast('복원됨'); refresh(); },
  batchStatus: async d => {
    const lbl = { archive: '아카이브로 보관', unarchive: '진행 목록으로 되돌리기', trash: '휴지통으로 이동', restore: '복원' }[d.a];
    const extra = d.a === 'trash' ? '<p class="small">휴지통으로 옮겨도 원료 투입 기록은 유지됩니다. 실제로 투입하지 않은 잘못된 기록이라면 원료 투입을 먼저 "기록 취소"하세요.</p>' : '';
    if (!await confirmBox(`이 배치를 ${lbl}할까요?${extra}`, lbl, d.a === 'trash')) return;
    try { await api.cmd('set_batch_status', { batch_id: Number(d.id), action: d.a }, uid()); toast(lbl + ' 완료'); refresh(); } catch (e) { showErrModal(e); }
  },
  backup: async () => {
    try { const r = await api.post('backup', { path: $('#bk-path').value.trim() }); toast('백업 완료'); await confirmBox(`백업 파일을 저장했습니다.<br><code>${esc(r.path)}</code>`, '확인'); refresh(); }
    catch (e) { showErrModal(e); }
  },
  restore: d => doRestore(d.path),
  restorePath: () => doRestore($('#rs-path').value.trim()),
  resumeDraft: async d => {
    const dr = await api.get('draft?key=' + enc(d.key));
    if (!dr || !dr.payload.form) return toast('이 초안을 열 수 없습니다.', true);
    if (dr.payload.args && dr.payload.args.batch_id && !location.hash.startsWith('#/batch/' + dr.payload.args.batch_id)) location.hash = '#/batch/' + dr.payload.args.batch_id;
    openF(dr.payload.form, dr.payload.args);
  },
  dropDraft: async d => { if (await confirmBox('이 초안을 버릴까요? 실제 기록에는 영향이 없습니다.', '버리기', true)) { await api.post('draft/delete', { key: d.key }); refresh(); } },
};
async function doRestore(path) {
  if (!path) return toast('복원할 파일을 선택하세요.', true);
  if (CUR) await CUR.flush();
  if (!await confirmBox(`이 백업으로 복원할까요?<br><code>${esc(path)}</code><p class="small">복원 직전 현재 데이터를 자동으로 안전 백업합니다.</p>`, '복원', true)) return;
  try { const r = await api.post('restore', { path }); await confirmBox(`복원했습니다.<br>복원 전 데이터는 여기 보관됨:<br><code>${esc(r.safety_backup)}</code>`, '확인'); location.hash = '#/'; render(); }
  catch (e) { showErrModal(e); }
}
function showErrModal(e) { confirmBox(errHtml(e), '확인'); }

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a && !(a.tagName === 'INPUT' && a.type === 'checkbox')) {
    if (a.tagName === 'A') e.preventDefault();
    const fn = ACTS[a.dataset.act]; if (fn) fn(a.dataset, a, e);
    return;
  }
  const chip = e.target.closest('[data-mat]');
  if (chip && BV.data) {
    const id = Number(chip.dataset.mat);
    if (e.shiftKey && BV.last) {
      const chips = $$('[data-mat]'); const i1 = chips.findIndex(c => c.dataset.mat == BV.last), i2 = chips.indexOf(chip);
      chips.slice(Math.min(i1, i2), Math.max(i1, i2) + 1).forEach(c => BV.sel.add(Number(c.dataset.mat)));
    } else { BV.sel.has(id) ? BV.sel.delete(id) : BV.sel.add(id); }
    BV.last = id;
    // 선택만 바뀌면 전체를 다시 그리지 않고 칩과 선택바만 갱신
    $$('[data-mat]').forEach(c => c.classList.toggle('sel', BV.sel.has(Number(c.dataset.mat))));
    const old = $('.selbar'); if (old) old.remove();
    $('#view').insertAdjacentHTML('beforeend', selBar(BV.data));
  }
});
document.addEventListener('change', e => { const a = e.target.closest('[data-act="rawDeleted"]'); if (a) ACTS.rawDeleted(); });
document.addEventListener('toggle', e => { const t = e.target; if (t.dataset && t.dataset.actToggle) BV.showUsed[t.dataset.actToggle] = t.open; }, true);
document.addEventListener('dblclick', e => { const chip = e.target.closest('[data-mat]'); if (chip) openF('lineage', { material_id: Number(chip.dataset.mat) }); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (CUR) CUR.submit(); else toast('열려 있는 입력이 없습니다.'); }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); history.back(); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); history.forward(); }
});
// 종료 직전 초안 저장
window.cfBeforeClose = () => (CUR ? CUR.flush() : Promise.resolve()).then(() => true);
window.addEventListener('beforeunload', () => { if (CUR && CUR.timer) CUR.flush(); });
window.addEventListener('pagehide', () => { if (CUR && CUR.timer) CUR.flush(); });
function afterRender() { }

render();
