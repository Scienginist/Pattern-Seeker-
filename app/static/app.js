/* Pattern Seeker 공통 모듈: API, DOM 도우미, 모달, 저장 바, 라우터 */
(function (global) {
  'use strict';
  const PS = { meta: null, routes: [], tools: {} };
  // 화면 코드에서 조건부 요소(null/false)와 배열을 그대로 넘길 수 있도록 append 를 보강한다.
  // (기본 동작은 null 을 "null" 글자로 그린다)
  const nativeAppend = Element.prototype.append;
  Element.prototype.append = function (...nodes) {
    return nativeAppend.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  };
  const C = global.PSCalc;

  // ------------------------------------------------------------ DOM
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'value') e.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') e[k] = !!v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      e.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return e;
  }
  PS.h = h;
  PS.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  PS.help = (text) => h('span', { class: 'help', tabindex: 0, 'data-tip': text, 'aria-label': '도움말: ' + text }, '?');
  PS.fmt = C.fmt;
  PS.opt = (value, label, sel) => h('option', { value, selected: sel }, label ?? value);
  PS.select = (options, value, attrs) => h('select', attrs || {}, options.map((o) => (Array.isArray(o) ? PS.opt(o[0], o[1], String(o[0]) === String(value)) : PS.opt(o, o, String(o) === String(value)))));

  // ------------------------------------------------------------ API
  async function req(method, url, body) {
    let res;
    try {
      res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error('서버에 연결할 수 없습니다. Pattern Seeker 창(서버)이 실행 중인지 확인하세요.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 응답 본문 없음 */ }
    if (!res.ok) throw new Error((data && data.error) || `요청 실패 (${res.status})`);
    return data;
  }
  PS.api = {
    get: (u) => req('GET', '/api' + u),
    post: (u, b) => req('POST', '/api' + u, b || {}),
    put: (u, b) => req('PUT', '/api' + u, b || {}),
    del: (u) => req('DELETE', '/api' + u),
  };

  PS.loadMeta = async function () {
    PS.meta = await PS.api.get('/meta');
    PS.types = PS.meta.analysis_types;
    PS.typeMap = Object.fromEntries(PS.types.map((t) => [t.code, t]));
    return PS.meta;
  };
  PS.activeTypes = () => PS.types.filter((t) => t.active);

  // ------------------------------------------------------------ 알림
  PS.toast = function (msg, kind, ms) {
    const t = h('div', { class: 'toast ' + (kind || '') }, msg);
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), ms || (kind === 'bad' ? 7000 : 3000));
  };

  // ------------------------------------------------------------ 모달
  // 실수로 연 모달은 저장 없이 닫을 수 있다. 변경 사항이 있으면 닫기 전에 확인한다.
  PS.modal = function ({ title, body, onSave, saveLabel, wide, cancelLabel, noSave }) {
    return new Promise((resolve) => {
      let dirty = false;
      const err = h('span', { class: 'err' });
      const content = typeof body === 'function' ? body() : body;
      const close = (result) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
      const tryClose = () => {
        if (dirty && !confirm('저장하지 않은 변경 사항이 있습니다. 저장하지 않고 닫을까요?')) return;
        close(null);
      };
      const saveBtn = noSave ? null : h('button', { class: 'primary', onclick: async () => {
        err.textContent = '';
        saveBtn.disabled = true; saveBtn.textContent = '저장 중…';
        try {
          const r = await onSave(content);
          if (r === false) { saveBtn.disabled = false; saveBtn.textContent = saveLabel || '저장'; return; }
          close(r === undefined ? true : r);
        } catch (e) {
          err.textContent = '저장 실패: ' + e.message;
          saveBtn.disabled = false; saveBtn.textContent = saveLabel || '저장';
        }
      } }, saveLabel || '저장');
      const modal = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal-h' }, h('h3', {}, title), h('button', { class: 'x', title: '닫기 (Esc)', 'aria-label': '닫기', onclick: tryClose }, '×')),
        h('div', { class: 'modal-b' }, content),
        h('div', { class: 'modal-f' }, err, h('button', { onclick: tryClose }, cancelLabel || '취소'), saveBtn));
      const bg = h('div', { class: 'modal-bg', onmousedown: (e) => { if (e.target === bg) tryClose(); } }, modal);
      content.addEventListener && content.addEventListener('input', () => { dirty = true; });
      const onKey = (e) => { if (e.key === 'Escape') tryClose(); };
      document.addEventListener('keydown', onKey);
      document.body.appendChild(bg);
      const first = content.querySelector && content.querySelector('input,select,textarea');
      if (first) setTimeout(() => first.focus(), 30);
    });
  };

  PS.confirm = function (message, { okLabel, danger, detail } = {}) {
    return new Promise((resolve) => {
      const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      const ok = h('button', { class: danger ? 'primary danger' : 'primary', style: danger ? { background: '#c0392b', borderColor: '#c0392b', color: '#fff' } : null, onclick: () => close(true) }, okLabel || '확인');
      const bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal', role: 'alertdialog' },
        h('div', { class: 'modal-h' }, h('h3', {}, '확인')),
        h('div', { class: 'modal-b' }, h('p', {}, message), detail ? h('p', { class: 'note' }, detail) : null),
        h('div', { class: 'modal-f' }, h('button', { onclick: () => close(false) }, '취소'), ok)));
      document.addEventListener('keydown', onKey);
      document.body.appendChild(bg);
      ok.focus();
    });
  };

  // ------------------------------------------------------------ 저장 바 (페이지용)
  // 자동 저장 없음. 명확한 저장 버튼과 상태(변경됨/저장 중/저장됨/실패)를 보여준다.
  PS.saveBar = function ({ onSave, onCancel, extra }) {
    const state = h('span', { class: 'savestate' }, '변경 사항 없음');
    const btn = h('button', { class: 'primary' }, '저장');
    const bar = h('div', { class: 'savebar' }, btn, onCancel ? h('button', { onclick: onCancel }, '닫기') : null, state, h('span', { class: 'grow' }), extra || null);
    const api = {
      el: bar, dirty: false,
      markDirty() { api.dirty = true; PS.setDirty(true); state.className = 'savestate dirty'; state.textContent = '● 저장되지 않은 변경 사항이 있습니다'; },
      markClean(msg) { api.dirty = false; PS.setDirty(false); state.className = 'savestate ok'; state.textContent = msg || '✓ 저장됨 ' + new Date().toLocaleTimeString('ko-KR'); },
      async save() {
        btn.disabled = true; state.className = 'savestate busy'; state.textContent = '저장 중…';
        try {
          const r = await onSave();
          if (r === false) { state.className = 'savestate dirty'; state.textContent = '저장하지 않았습니다 (입력 확인 필요)'; return false; }
          api.markClean();
          return r;
        } catch (e) {
          state.className = 'savestate fail';
          state.textContent = '✕ 저장 실패: ' + e.message + ' — 데이터가 저장되지 않았습니다';
          PS.toast('저장 실패: ' + e.message, 'bad');
          return false;
        } finally { btn.disabled = false; }
      },
    };
    btn.onclick = () => api.save();
    return api;
  };

  // ------------------------------------------------------------ 라우터 · 뒤로/앞으로
  let dirtyFlag = false, lastHash = location.hash, suppress = false, currentCleanup = null;
  PS.setDirty = (v) => { dirtyFlag = !!v; };
  window.addEventListener('beforeunload', (e) => { if (dirtyFlag) { e.preventDefault(); e.returnValue = ''; } });
  PS.route = (pattern, fn) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/?]+)'; }) + '(?:\\?(.*))?$');
    PS.routes.push({ rx, keys, fn });
  };
  PS.go = (hash) => { location.hash = hash; };
  PS.query = () => Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || ''));
  PS.setQuery = (obj) => {
    // 현재 화면 상태를 주소에 반영 (뒤로/앞으로로 복원 가능)
    const base = location.hash.split('?')[0];
    const qs = new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
    const nh = base + (qs ? '?' + qs : '');
    if (nh !== location.hash) { suppress = true; history.replaceState(null, '', nh); lastHash = nh; suppress = false; }
  };

  async function dispatch() {
    if (suppress) return;
    const hash = location.hash || '#/samples';
    if (dirtyFlag && hash !== lastHash) {
      if (!confirm('저장하지 않은 변경 사항이 있습니다. 이 화면을 떠날까요?')) {
        suppress = true; history.pushState(null, '', lastHash); suppress = false; return;
      }
      dirtyFlag = false;
    }
    lastHash = hash;
    const path = hash.slice(1);
    if (currentCleanup) { try { currentCleanup(); } catch (e) { /* ignore */ } currentCleanup = null; }
    const view = document.getElementById('view');
    for (const r of PS.routes) {
      const m = path.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const sec = path.split('/')[1];
      document.querySelectorAll('#mainnav a').forEach((a) => a.classList.toggle('on', a.dataset.sec === sec || (sec === 'sample' && a.dataset.sec === 'samples') || (sec === 'm' && a.dataset.sec === 'samples')));
      view.innerHTML = '';
      view.appendChild(h('div', { class: 'empty' }, '불러오는 중…'));
      try {
        const out = await r.fn(params, view);
        if (typeof out === 'function') currentCleanup = out;
      } catch (e) {
        console.error(e);
        view.innerHTML = '';
        view.appendChild(h('div', { class: 'panel badge-bad' }, '화면을 불러오지 못했습니다: ' + e.message));
      }
      view.focus({ preventScroll: true });
      return;
    }
    location.hash = '#/samples';
  }
  PS.refresh = dispatch;
  PS.crumb = (parts) => {
    const c = document.getElementById('crumb');
    c.innerHTML = '';
    parts.forEach((p, i) => {
      if (i) c.appendChild(document.createTextNode(' › '));
      c.appendChild(p.href ? h('a', { href: p.href, style: { color: '#cfd6e4' } }, p.label) : h('span', {}, p.label));
    });
  };

  PS.start = async function () {
    document.getElementById('nav-back').onclick = () => history.back();
    document.getElementById('nav-fwd').onclick = () => history.forward();
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft') history.back();
      if (e.altKey && e.key === 'ArrowRight') history.forward();
    });
    try { await PS.loadMeta(); } catch (e) {
      document.getElementById('view').appendChild(h('div', { class: 'panel badge-bad' }, e.message));
      return;
    }
    window.addEventListener('hashchange', dispatch);
    if (!location.hash) location.hash = '#/samples'; else dispatch();
  };

  // ------------------------------------------------------------ 공통 조각
  PS.statusChip = function (status, extra) {
    status = status || '미업로드';
    return h('span', Object.assign({ class: 'st st-' + status.replace(/\s/g, '') }, extra || {}), status);
  };
  PS.srcBadge = function (src) {
    const label = { default: '기본값', user: '입력', file: '파일', extracted: '추출', extracted_edited: '추출→수정', computed: '계산', fit: '피팅 추정', snapshot: '측정 당시 고정', live: '세션 따라 갱신' }[src] || src;
    const tip = { default: '앱 기본값입니다. 실제 조건으로 확인되지 않았습니다.', user: '사용자가 직접 입력하거나 확인한 값', file: '파일에 기재된 값을 자동 입력', extracted: '보고서/붙여넣기에서 추출된 값 (수정 안 함)', extracted_edited: '추출 후 사용자가 수정한 값', computed: '앱이 계산한 값', fit: '앱의 Gaussian 피팅이 추정한 값 (실측 아님)', snapshot: '측정을 저장할 때의 조건으로 고정됩니다', live: '전극/세션 정보를 수정하면 함께 바뀝니다' }[src] || '';
    return src ? h('span', { class: 'src src-' + src, title: tip }, label) : null;
  };
  PS.sampleDot = (s) => h('span', { class: 'dot', style: { background: s.color } });
  PS.sampleLink = (s) => h('a', { href: '#/sample/' + s.id }, PS.sampleDot(s), s.name);

  PS.readFileAsText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
  PS.readFileAsB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
  PS.download = (name, text, type) => {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'application/json' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  PS.store = {
    get(k, d) { try { const v = localStorage.getItem('ps.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ps.' + k, JSON.stringify(v)); } catch (e) { /* 저장소 사용 불가 */ } },
  };

  PS.metricDefs = (code) => ((PS.typeMap[code] || {}).config || {}).metrics || [];
  // 측정 기록에서 지표 값 찾기: 기록값(values) 우선, 없으면 계산값(computed.metrics)
  PS.metricOf = function (m, key) {
    const v = m.values && m.values[key];
    if (v && C.isNum(Number(v.value)) && v.value !== '' && v.value !== null) return { value: Number(v.value), unit: v.unit, source: v.source || 'user', kind: 'recorded' };
    const c = m.computed && m.computed.metrics && m.computed.metrics[key];
    if (c && C.isNum(c.value)) return { value: c.value, unit: c.unit, source: 'computed', formula: c.formula, kind: 'computed' };
    return null;
  };

  global.PS = PS;
})(window);
