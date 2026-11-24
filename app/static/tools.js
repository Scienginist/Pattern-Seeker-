/* 측정 기록 편집기와 분석별 도구.
 * 분석 종류는 analysis_types.config.tool 로 도구를 고른다. 없는 도구는 generic 으로 처리하므로
 * 새 분석 종류를 데이터로 추가해도 화면 코드를 고칠 필요가 없다.
 */
(function (PS) {
  'use strict';
  const { h, help, fmt } = PS;
  const C = window.PSCalc;
  const N = (v) => (v === '' || v === null || v === undefined ? null : (C.isNum(C.num(v)) ? C.num(v) : null));
  const clone = (o) => JSON.parse(JSON.stringify(o ?? null));

  function numInput(val, onchange, attrs) {
    const i = h('input', Object.assign({ type: 'text', inputmode: 'decimal', class: 'num', value: val ?? '' }, attrs || {}));
    i.addEventListener('input', () => onchange(N(i.value), i.value));
    return i;
  }
  PS.numInput = numInput;

  // ------------------------------------------------------------ 가져오기 위젯 (붙여넣기 / 경로 / 파일)
  PS.importWidget = function ({ label, placeholder, onText, allowPdf, ctx, attachRole }) {
    const ta = h('textarea', { placeholder: placeholder || '여기에 표/텍스트를 붙여 넣으세요 (Origin·Excel 에서 복사)', rows: 5 });
    const pathIn = h('input', { type: 'text', placeholder: '예: D:\\연구자료\\XRD\\A1.xy  (탐색기에서 Shift+우클릭 → 경로로 복사)', style: { width: '100%' } });
    const attachChk = h('input', { type: 'checkbox', checked: true });
    const modeSel = PS.select([['link', '경로만 연결 (원본 복사 안 함)'], ['copy', '앱 폴더에 복사']], 'link');
    const fileIn = h('input', { type: 'file', accept: allowPdf ? '.pdf,.png,.jpg,.jpeg,.txt,.csv,.xy,.dat,.asc' : '.txt,.csv,.xy,.dat,.asc,.tsv' });
    const copyChk = h('input', { type: 'checkbox' });
    const status = h('div', { class: 'small muted' });
    const emit = async (text, meta) => {
      try { await onText(text, meta); status.textContent = `불러옴: ${meta.file_name || '붙여넣기'} (${meta.method})`; }
      catch (e) { status.textContent = '처리 실패: ' + e.message; status.style.color = '#c0392b'; }
    };
    return h('div', { class: 'importw' },
      label ? h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, label) : null,
      ta,
      h('div', { class: 'row', style: { marginTop: '4px' } },
        h('button', { onclick: () => {
          if (!ta.value.trim()) return;
          // 붙여 넣은 원문에 적힌 날짜도 측정일 후보로 쓴다 (사용자가 고른 날짜가 우선)
          const dates = C.dateCandidates(ta.value).map((d) => ({ date: d, context: '붙여넣은 텍스트' }));
          emit(ta.value, { method: 'paste', file_name: '붙여넣은 텍스트', date_candidates: dates });
        } }, '붙여넣은 내용 적용'),
        h('span', { class: 'muted small' }, '또는')),
      h('details', { style: { marginTop: '6px' } }, h('summary', {}, '파일 경로로 불러오기 / 파일 선택'),
        h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'grow' }, pathIn),
          h('button', { onclick: async () => {
            if (!pathIn.value.trim()) return;
            status.textContent = '읽는 중…';
            try {
              const r = await PS.api.post('/files/read', { path: pathIn.value });
              await emit(r.text, { method: r.method, file_name: r.file_name, path: r.path, date_candidates: r.date_candidates });
              if (attachChk.checked && ctx) ctx.queueAttachment({ mode: modeSel.value, path: r.path, file_name: r.file_name, role: attachRole || '원본' });
            } catch (e) { status.textContent = e.message; status.style.color = '#c0392b'; }
          } }, '경로에서 읽기')),
        h('div', { class: 'row small' }, h('label', {}, attachChk, ' 이 파일을 기록에 첨부'), modeSel, help('경로만 연결: 개인 보관소의 원본을 그대로 두고 위치만 기록합니다. 파일을 옮기면 "경로 깨짐"으로 표시됩니다.\n앱 폴더에 복사: data/files 에 사본을 보관합니다.')),
        h('div', { class: 'row', style: { marginTop: '6px' } }, fileIn,
          h('label', { class: 'small' }, copyChk, ' 선택한 파일을 앱에 복사해 첨부'), help('브라우저에서 고른 파일은 원래 경로를 알 수 없어 "경로만 연결"을 쓸 수 없습니다. 원본을 연결하려면 위의 경로 입력을 쓰세요.')),
        h('button', { class: 'small', style: { marginTop: '4px' }, onclick: async () => {
          const f = fileIn.files[0];
          if (!f) return;
          status.textContent = '읽는 중…';
          try {
            const isBin = /\.(pdf|png|jpe?g|bmp|tiff?)$/i.test(f.name);
            let text, method, dates = [];
            if (isBin) {
              const r = await PS.api.post('/extract', { file_name: f.name, content_b64: await PS.readFileAsB64(f) });
              text = r.text; method = r.method; dates = r.date_candidates;
            } else {
              text = await PS.readFileAsText(f); method = 'text';
              dates = (await PS.api.post('/dates', { text })).date_candidates;
            }
            await emit(text, { method, file_name: f.name, date_candidates: dates });
            if (copyChk.checked && ctx) ctx.queueAttachment({ mode: 'copy', file: f, file_name: f.name, role: attachRole || '원본' });
          } catch (e) { status.textContent = e.message; status.style.color = '#c0392b'; }
        } }, '선택한 파일 읽기')),
      status);
  };

  // 열 지정 UI
  function colSelect(headers, value, allowNone) {
    const opts = (allowNone ? [[-1, '(없음)']] : []).concat(headers.map((x, i) => [i, `${i + 1}: ${x}`]));
    return PS.select(opts, value);
  }
  PS.colSelect = colSelect;

  // ------------------------------------------------------------ 측정 기록 편집기
  PS.measurementEditor = async function (view, { sampleId, code, measId }) {
    let meas = null;
    if (measId) { meas = await PS.api.get('/measurements/' + measId); sampleId = meas.sample_id; code = meas.analysis_code; }
    const sample = await PS.api.get('/samples/' + sampleId);
    const type = PS.typeMap[code];
    if (!type) throw new Error('알 수 없는 분석 종류: ' + code);
    const cfg = type.config || {};
    const rec = meas ? clone(meas) : {
      sample_id: sampleId, analysis_code: code, title: '', measured_on: '', measured_on_source: 'none', conditions: {}, values: {}, computed: {},
      source: { method: 'manual' }, notes: '', datasets: [], seq: null, ec_session_id: null,
    };
    rec.conditions = rec.conditions || {}; rec.values = rec.values || {}; rec.computed = rec.computed || {}; rec.source = rec.source || {}; rec.datasets = rec.datasets || [];
    if (!meas) {
      for (const [k, d] of Object.entries(cfg.default_conditions || {})) rec.conditions[k] = { value: d.value, unit: d.unit, label: d.label, source: 'default' };
    }
    PS.crumb([{ label: '샘플', href: '#/samples' }, { label: sample.name, href: '#/sample/' + sample.id + '/analysis' }, { label: type.name + (meas ? ` #${meas.id}` : ' 새 기록') }]);

    const pendingAtt = [];
    let bar;
    const ctx = {
      rec, sample, type, cfg, isNew: !meas,
      markDirty: () => bar && bar.markDirty(),
      queueAttachment(a) { pendingAtt.push(a); renderAtt(); ctx.markDirty(); },
      setSource(patch) { Object.assign(rec.source, patch); ctx.markDirty(); },
      applyFileDates(meta) {
        if (!meta || !meta.date_candidates || !meta.date_candidates.length) return;
        dateCands.innerHTML = '';
        dateCands.append('파일 기재 날짜 후보: ', ...meta.date_candidates.map((c) => h('button', { class: 'small link', title: c.context, onclick: () => { dateIn.value = c.date; rec.measured_on = c.date; rec.measured_on_source = 'user'; updDateBadge(); ctx.markDirty(); } }, c.date)));
        if (rec.measured_on_source !== 'user') {
          rec.measured_on = meta.date_candidates[0].date; rec.measured_on_source = 'file'; rec.source.date_from = meta.file_name || '붙여넣기';
          dateIn.value = rec.measured_on; updDateBadge(); ctx.markDirty();
        }
      },
      onConditions: [],
    };

    // ---- 기본 정보
    const titleIn = h('input', { type: 'text', value: rec.title || '', placeholder: '예: 1차 측정, 외부 의뢰(○○대)', style: { width: '100%' } });
    titleIn.oninput = () => { rec.title = titleIn.value; ctx.markDirty(); };
    const dateIn = h('input', { type: 'date', value: rec.measured_on || '' });
    const dateBadge = h('span');
    const dateCands = h('div', { class: 'small muted' });
    const updDateBadge = () => {
      dateBadge.innerHTML = '';
      const s = rec.measured_on_source;
      if (s === 'file') dateBadge.append(PS.srcBadge('file'), h('span', { class: 'small muted' }, ` ${rec.source.date_from || ''} 에서 자동 입력 — 직접 고르면 그 날짜가 우선합니다`));
      else if (s === 'user') dateBadge.append(PS.srcBadge('user'));
    };
    dateIn.oninput = () => { rec.measured_on = dateIn.value; rec.measured_on_source = dateIn.value ? 'user' : 'none'; updDateBadge(); ctx.markDirty(); };
    updDateBadge();
    const notesIn = h('textarea', { class: 'prose', rows: 3, placeholder: '측정 메모 (장비, 의뢰처, 특이사항 등)' }, rec.notes || '');
    notesIn.oninput = () => { rec.notes = notesIn.value; ctx.markDirty(); };

    // ---- 조건
    const condBox = h('div');
    function renderConditions() {
      condBox.innerHTML = '';
      const entries = Object.entries(rec.conditions).filter(([k, v]) => v && typeof v === 'object' && 'value' in v && !k.startsWith('_'));
      if (!entries.length) condBox.appendChild(h('div', { class: 'muted small' }, '등록된 조건이 없습니다.'));
      const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '조건'), h('th', {}, '값'), h('th', {}, '단위'), h('th', {}, '출처'), h('th', {}, '실제 조건 확인'), h('th')));
      for (const [k, c] of entries) {
        const vin = h('input', { type: 'text', value: c.value ?? '', style: { width: '160px' } });
        const chk = h('input', { type: 'checkbox', checked: c.source !== 'default', title: '체크하면 기본 안내가 아니라 실제로 사용한 조건으로 기록합니다' });
        const badge = h('span', {}, PS.srcBadge(c.source));
        const setSrc = (s) => { c.source = s; badge.innerHTML = ''; badge.appendChild(PS.srcBadge(s)); chk.checked = s !== 'default'; };
        vin.oninput = () => { const n = C.num(vin.value); c.value = C.isNum(n) && /^[-\d.,eE+\s]+$/.test(vin.value) ? n : vin.value; setSrc('user'); ctx.markDirty(); ctx.onConditions.forEach((f) => f()); };
        chk.onchange = () => { setSrc(chk.checked ? 'user' : 'default'); ctx.markDirty(); };
        tbl.appendChild(h('tr', {}, h('td', {}, c.label || k), h('td', {}, vin), h('td', {}, c.unit || ''), h('td', {}, badge), h('td', {}, chk),
          h('td', {}, h('button', { class: 'small link', onclick: () => { delete rec.conditions[k]; renderConditions(); ctx.markDirty(); } }, '삭제'))));
      }
      condBox.appendChild(tbl);
      const nk = h('input', { type: 'text', placeholder: '조건 이름 (예: 장비)', style: { width: '160px' } });
      const nv = h('input', { type: 'text', placeholder: '값', style: { width: '120px' } });
      const nu = h('input', { type: 'text', placeholder: '단위', class: 'sm' });
      condBox.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } }, nk, nv, nu, h('button', { class: 'small', onclick: () => {
        if (!nk.value.trim()) return;
        const key = 'c_' + nk.value.trim().replace(/\s+/g, '_');
        const n = C.num(nv.value);
        rec.conditions[key] = { label: nk.value.trim(), value: C.isNum(n) ? n : nv.value, unit: nu.value, source: 'user' };
        renderConditions(); ctx.markDirty();
      } }, '조건 추가')));
      const hasDefault = entries.some(([, c]) => c.source === 'default');
      if (hasDefault) condBox.appendChild(h('div', { class: 'badge-warn small', style: { marginTop: '6px' } }, '“기본값” 조건은 앱의 기본 안내입니다. 실제로 그렇게 측정했다면 “실제 조건 확인”을 체크하세요. 체크하지 않으면 AI 내보내기·비교에서도 기본 안내로 표시됩니다.'));
    }
    renderConditions();
    ctx.renderConditions = renderConditions;

    // ---- 첨부
    const attBox = h('div');
    async function renderAtt() {
      attBox.innerHTML = '';
      const list = (meas && meas.attachments) || [];
      let states = {};
      if (list.length) { try { states = (await PS.api.get('/attachments/check?ids=' + list.map((a) => a.id).join(','))).states; } catch (e) { /* 표시만 생략 */ } }
      for (const a of list) attBox.appendChild(PS.attachmentRow(a, states[a.id], () => reload()));
      for (const a of pendingAtt) {
        attBox.appendChild(h('div', { class: 'row small' }, h('span', { class: 'chip' }, '저장 시 첨부'), a.file_name, h('span', { class: 'muted' }, a.mode === 'link' ? `경로 연결: ${a.path}` : '앱에 복사'), a.role,
          h('button', { class: 'small link', onclick: () => { pendingAtt.splice(pendingAtt.indexOf(a), 1); renderAtt(); } }, '취소')));
      }
      if (!list.length && !pendingAtt.length) attBox.appendChild(h('div', { class: 'muted small' }, '첨부 없음'));
      const p = h('input', { type: 'text', placeholder: '파일 경로 (예: D:\\보관소\\BET\\A1_report.pdf)', style: { flex: 1, minWidth: '260px' } });
      const mode = PS.select([['link', '경로만 연결'], ['copy', '앱 폴더에 복사']], 'link');
      const role = PS.select(['원본', '보고서 그래프', '성적서', '사진', '기타'], '원본');
      attBox.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } }, p, mode, role, h('button', { class: 'small', onclick: () => {
        if (!p.value.trim()) return;
        ctx.queueAttachment({ mode: mode.value, path: p.value.trim(), file_name: p.value.trim().split(/[\\/]/).pop(), role: role.value });
        p.value = '';
      } }, '첨부 추가'), help('원본 파일을 앱에 무조건 복사하지 않습니다. 기본은 "경로만 연결"이며, 파일을 옮기거나 지우면 목록에 "경로 깨짐"이 표시됩니다.')));
      const f = h('input', { type: 'file' });
      attBox.appendChild(h('div', { class: 'row small', style: { marginTop: '4px' } }, f, h('button', { class: 'small', onclick: () => {
        if (!f.files[0]) return;
        ctx.queueAttachment({ mode: 'copy', file: f.files[0], file_name: f.files[0].name, role: role.value });
      } }, '선택 파일을 앱에 복사해 첨부')));
    }

    // ---- 도구
    const toolFn = PS.tools[cfg.tool] || PS.tools.generic;
    const tool = toolFn(ctx);

    // ---- 해석
    const interpBox = h('div');
    if (meas) interpBox.appendChild(PS.interpretationsBlock({ sample_id: sample.id, measurement_id: meas.id, items: meas.interpretations || [], onChange: () => reload() }));
    else interpBox.appendChild(h('div', { class: 'muted small' }, '기록을 저장한 뒤 해석을 추가할 수 있습니다.'));

    async function reload() { PS.setDirty(false); await PS.refresh(); }

    bar = PS.saveBar({
      onCancel: () => history.back(),
      onSave: async () => {
        const out = tool.collect();
        if (out === false) return false;
        const payload = {
          sample_id: sample.id, analysis_code: code, title: rec.title, measured_on: rec.measured_on || null, measured_on_source: rec.measured_on_source,
          conditions: rec.conditions, values: out.values ?? rec.values, computed: out.computed ?? rec.computed, source: rec.source, notes: rec.notes,
          seq: rec.seq, ec_session_id: rec.ec_session_id,
        };
        if (out.datasets) payload.datasets = out.datasets;
        let id = meas && meas.id;
        if (id) await PS.api.put('/measurements/' + id, payload);
        else id = (await PS.api.post('/measurements', payload)).id;
        const failed = [];
        while (pendingAtt.length) {
          const a = pendingAtt[0];
          try {
            const body = { measurement_id: id, sample_id: sample.id, mode: a.mode, role: a.role, file_name: a.file_name };
            if (a.file) body.content_b64 = await PS.readFileAsB64(a.file); else body.path = a.path;
            await PS.api.post('/attachments', body);
          } catch (e) { failed.push(a.file_name + ': ' + e.message); }
          pendingAtt.shift();
        }
        if (failed.length) PS.toast('기록은 저장됐지만 첨부 일부 실패: ' + failed.join(' / '), 'bad', 10000);
        else PS.toast('저장되었습니다', 'ok');
        PS.setDirty(false);
        if (!meas) { history.replaceState(null, '', '#/m/' + id); }
        setTimeout(() => PS.refresh(), 50);
        return true;
      },
      extra: meas ? h('button', { class: 'danger', onclick: async () => {
        if (!(await PS.confirm('이 측정 기록을 휴지통으로 옮길까요?', { danger: true, okLabel: '휴지통으로', detail: '설정·백업 > 휴지통에서 복원할 수 있습니다. 연결된 원본 파일은 지우지 않습니다.' }))) return;
        try { await PS.api.del('/measurements/' + meas.id); PS.setDirty(false); PS.toast('휴지통으로 옮겼습니다'); PS.go('#/sample/' + sample.id + '/analysis'); }
        catch (e) { PS.toast('삭제 실패: ' + e.message, 'bad'); }
      } }, '삭제') : null,
    });

    view.innerHTML = '';
    view.append(
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, PS.sampleDot(sample), sample.name, ' · ', type.name, meas ? h('span', { class: 'muted small' }, `  기록 #${meas.id}`) : h('span', { class: 'chip' }, '새 기록')),
        h('a', { href: '#/sample/' + sample.id + '/analysis' }, '← 샘플로')),
      h('div', { class: 'panel' },
        h('div', { class: 'form' },
          h('label', {}, '기록 제목'), titleIn,
          h('label', {}, '측정일', help('파일에 기재된 날짜를 자동으로 넣습니다. 사용자가 직접 고른 날짜가 항상 우선합니다.')), h('div', {}, h('div', { class: 'row' }, dateIn, dateBadge), dateCands),
          h('label', {}, '메모'), notesIn)),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, type.name, ' 데이터'), type.description ? h('p', { class: 'note' }, type.description) : null, tool.el),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '측정 조건 ', help('측정 조건은 값과 함께 저장됩니다. 비교 화면에서 조건이 다른 측정은 차이가 표시됩니다.')), condBox),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '원본 파일·첨부'), attBox, PS.provenanceLine(rec)),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '해석 ', help('측정 메모와 별도로, 이 결과에 대한 연구자의 해석이나 AI 가설을 구분해 기록합니다.')), interpBox),
      bar.el);
    renderAtt();
    if (tool.afterMount) tool.afterMount();
    PS.setDirty(false);
  };

  PS.provenanceLine = function (rec) {
    const s = rec.source || {};
    const method = { manual: '직접 입력', paste: '붙여넣기', text: '텍스트 파일', pdf_text: 'PDF 텍스트 추출', ocr: 'OCR' }[s.method] || s.method || '직접 입력';
    return h('div', { class: 'note', style: { marginTop: '8px' } }, `값 출처: ${method}`, s.file_name ? ` · 파일: ${s.file_name}` : '', s.edited ? ' · 추출 후 사용자 수정 있음' : '');
  };

  PS.attachmentRow = function (a, state, onChange) {
    const stEl = state === 'missing' ? h('span', { class: 'chip', style: { color: '#c0392b', borderColor: '#e9b9b3' } }, '경로 깨짐')
      : state === 'changed' ? h('span', { class: 'chip', style: { color: '#b7791f' }, title: '연결 후 파일 크기나 수정 시각이 바뀌었습니다' }, '파일 변경됨')
        : state === 'ok' ? h('span', { class: 'chip', style: { color: '#1e8e4e' } }, '확인됨') : h('span', { class: 'chip' }, '확인 전');
    return h('div', { class: 'row small', style: { padding: '4px 0', borderBottom: '1px solid #f0f2f5' } },
      stEl, h('span', { class: 'chip' }, a.mode === 'link' ? '경로 연결' : '앱 복사본'), h('span', { class: 'chip' }, a.role),
      state !== 'missing' ? h('a', { href: '/api/attachments/' + a.id + '/file', target: '_blank' }, a.file_name) : h('span', {}, a.file_name),
      h('span', { class: 'muted mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '420px', whiteSpace: 'nowrap' }, title: a.original_path }, a.mode === 'link' ? a.original_path : ''),
      a.mode === 'link' ? h('button', { class: 'small link', onclick: async () => {
        const np = prompt('새 파일 경로를 입력하세요', a.original_path);
        if (!np) return;
        try { await PS.api.put('/attachments/' + a.id, { path: np }); PS.toast('경로를 다시 지정했습니다', 'ok'); onChange && onChange(); } catch (e) { PS.toast(e.message, 'bad'); }
      } }, '경로 다시 지정') : null,
      h('button', { class: 'small link', onclick: async () => {
        if (!(await PS.confirm(`첨부 "${a.file_name}" 연결을 지울까요?`, { danger: true, okLabel: '연결 삭제', detail: '원본 파일과 앱 복사본 파일은 삭제하지 않습니다. 기록에서 연결만 지웁니다.' }))) return;
        try { await PS.api.del('/attachments/' + a.id); onChange && onChange(); } catch (e) { PS.toast(e.message, 'bad'); }
      } }, '연결 삭제'));
  };

  PS.interpretationsBlock = function ({ sample_id, measurement_id, items, onChange }) {
    const box = h('div');
    for (const it of items) {
      const ev = it.evidence || {};
      box.appendChild(h('div', { class: 'rec' },
        h('div', { class: 'row' }, h('span', { class: 'chip', style: it.kind === 'ai_hypothesis' ? { background: '#f3e8ff', color: '#5b21b6' } : { background: '#e8f6ed', color: '#18603a' } },
          it.kind === 'ai_hypothesis' ? 'AI 가설 (검증 전)' : '연구자 해석'), h('span', { class: 'muted small grow' }, it.created_at.replace('T', ' ')),
        h('button', { class: 'small link', onclick: async () => {
          if (!(await PS.confirm('이 해석을 삭제할까요?', { danger: true }))) return;
          await PS.api.del('/interpretations/' + it.id); onChange();
        } }, '삭제')),
        h('div', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, it.text),
        Object.keys(ev).length ? h('div', { class: 'note' }, Object.entries(ev).map(([k, v]) => h('div', {}, h('b', {}, ({ basis: '근거', conditions: '조건 차이', gaps: '데이터 부족/충돌', uncertainty: '불확실성·적용 범위', next: '확인할 다음 측정' })[k] || k, ': '), typeof v === 'string' ? v : JSON.stringify(v)))) : null));
    }
    box.appendChild(h('button', { class: 'small', style: { marginTop: '8px' }, onclick: () => PS.addInterpretation({ sample_id, measurement_id, onDone: onChange }) }, '+ 해석 추가'));
    return box;
  };

  PS.addInterpretation = function ({ sample_id, measurement_id, preset, onDone }) {
    preset = preset || {};
    const kind = PS.select([['user_interpretation', '연구자 해석'], ['ai_hypothesis', 'AI 가설 (검증 전)']], preset.kind || 'user_interpretation');
    const text = h('textarea', { class: 'prose', rows: 4 }, preset.text || '');
    const f = {};
    const fields = [['basis', '근거 (어떤 샘플·측정값)'], ['conditions', '같은/다른 조건'], ['gaps', '데이터 부족·충돌'], ['uncertainty', '불확실성·적용 범위'], ['next', '확인할 다음 측정·비교']];
    const body = h('div', {}, h('div', { class: 'form' }, h('label', {}, '종류'), kind, h('label', {}, '내용'), text,
      ...fields.flatMap(([k, l]) => { f[k] = h('textarea', { class: 'prose', rows: 2 }, (preset.evidence || {})[k] || ''); return [h('label', {}, l), f[k]]; })),
    h('p', { class: 'note' }, 'AI 가설은 사실이 아니라 검증할 제안으로 저장됩니다. 상관관계를 인과관계로 쓰지 마세요.'));
    return PS.modal({ title: '해석 / 가설 기록', body, wide: true, onSave: async () => {
      if (!text.value.trim()) throw new Error('내용을 입력하세요');
      const evidence = {};
      for (const [k] of fields) if (f[k].value.trim()) evidence[k] = f[k].value.trim();
      if (preset.evidence && preset.evidence.data) evidence.data = preset.evidence.data;
      await PS.api.post('/interpretations', { kind: kind.value, sample_id, measurement_id, text: text.value.trim(), evidence });
      PS.toast('저장되었습니다', 'ok');
      onDone && onDone();
    } });
  };

  // ------------------------------------------------------------ 값 입력 필드 (generic)
  function valueFields(ctx, fields, onAny) {
    const { rec } = ctx;
    const inputs = {};
    const tbl = h('table', { class: 'tbl', style: { maxWidth: '760px' } }, h('tr', {}, h('th', {}, '항목'), h('th', { class: 'num' }, '값'), h('th', {}, '단위'), h('th', {}, '출처'), h('th', {}, '근거')));
    for (const f of fields) {
      const cur = rec.values[f.key] || {};
      const badge = h('span', {}, PS.srcBadge(cur.source));
      const ev = h('span', { class: 'small muted' }, cur.evidence || '');
      const inp = numInput(cur.value, (v) => {
        const prev = rec.values[f.key] || {};
        if (v === null) { delete rec.values[f.key]; badge.innerHTML = ''; }
        else {
          const src = prev.source === 'extracted' || prev.source === 'extracted_edited' ? 'extracted_edited' : 'user';
          rec.values[f.key] = Object.assign({}, prev, { value: v, unit: f.unit, source: src });
          if (src === 'extracted_edited') rec.source.edited = true;
          badge.innerHTML = ''; badge.appendChild(PS.srcBadge(src));
        }
        ctx.markDirty(); onAny && onAny();
      }, { placeholder: '미입력' });
      inputs[f.key] = { inp, badge, ev };
      tbl.appendChild(h('tr', {}, h('td', {}, f.label, f.help ? help(f.help) : null), h('td', { class: 'num' }, inp), h('td', {}, f.unit), h('td', {}, badge), h('td', {}, ev)));
    }
    return {
      el: tbl,
      set(key, entry) {
        rec.values[key] = entry;
        const i = inputs[key]; if (!i) return;
        i.inp.value = entry.value; i.badge.innerHTML = ''; i.badge.appendChild(PS.srcBadge(entry.source)); i.ev.textContent = entry.evidence || '';
      },
    };
  }

  PS.tools.generic = function (ctx) {
    const fields = ctx.cfg.fields || [];
    const vf = valueFields(ctx, fields);
    const el = h('div', {}, fields.length ? vf.el : h('div', { class: 'muted' }, '이 분석 종류에는 정의된 입력 항목이 없습니다. 설정에서 항목을 추가하거나 메모·첨부로 기록하세요.'),
      h('p', { class: 'note' }, '빈칸은 “측정 안 함/미입력”으로 저장되며 0 으로 바뀌지 않습니다.'));
    return { el, collect: () => ({ values: ctx.rec.values }) };
  };

  // ------------------------------------------------------------ PSA
  PS.tools.psa = function (ctx) {
    const { rec, cfg } = ctx;
    const out = h('div', { class: 'badge-info', style: { marginTop: '8px' } });
    const ref = (cfg.reference_ranges || {}).d90;
    const upd = () => {
      const g = (k) => (rec.values[k] ? rec.values[k].value : null);
      const sp = C.span(g('d10'), g('d50'), g('d90'));
      out.innerHTML = '';
      out.append(h('div', {}, h('b', {}, 'Span = '), fmt(sp), '  ', h('span', { class: 'small' }, `(${C.SPAN_FORMULA}; 분포 폭 지표, 작을수록 좁은 분포)`)));
      if (ref && C.isNum(g('d90'))) {
        const inside = g('d90') >= ref.min && g('d90') <= ref.max;
        out.append(h('div', { class: 'small' }, `D90 ${fmt(g('d90'))} µm — ${ref.label} ${ref.min}–${ref.max} µm ${inside ? '안' : '밖'}에 있습니다. 합격/불합격 판정이 아닙니다.`));
      }
    };
    const vf = valueFields(ctx, cfg.fields, upd);
    // 분포 데이터 (선택)
    const chartBox = h('div');
    let dist = rec.datasets.find((d) => d.name === 'PSA 분포');
    const drawDist = () => {
      chartBox.innerHTML = '';
      if (!dist) return;
      PSChart.render(chartBox, { series: [{ name: '분포', color: ctx.sample.color, x: dist.data[0], y: dist.data[1] }], xLabel: dist.columns[0] || '입경 (µm)', yLabel: dist.columns[1] || '부피 %' });
    };
    const imp = PS.importWidget({ ctx, label: '분포 데이터 (선택: 입경, 빈도/누적)', onText: (text, meta) => {
      const xy = C.parseXY(text);
      if (xy.x.length < 3) throw new Error('숫자 2열 데이터를 찾지 못했습니다');
      dist = { name: 'PSA 분포', columns: [xy.headers[0], xy.headers[1]], data: [xy.x, xy.y], meta: { file_name: meta.file_name || null } };
      ctx.applyFileDates(meta); ctx.markDirty(); drawDist();
    } });
    upd();
    return {
      el: h('div', {}, vf.el, out, h('p', { class: 'note' }, '측정 방식: 분말을 용매(물 등)에 분산해 측정. 대표 전처리 조건은 아래 “측정 조건”에 기본 안내로 들어가 있으며, 실제 사용 여부를 체크로 구분합니다.'),
        h('details', {}, h('summary', {}, '분포 곡선 데이터'), imp, chartBox)),
      afterMount: drawDist,
      collect() {
        const g = (k) => (rec.values[k] ? rec.values[k].value : null);
        const sp = C.span(g('d10'), g('d50'), g('d90'));
        const computed = { metrics: {} };
        if (C.isNum(sp)) computed.metrics.span = { value: sp, unit: '', formula: C.SPAN_FORMULA, inputs: { D10: g('d10'), D50: g('d50'), D90: g('d90') } };
        return { values: rec.values, computed, datasets: dist ? [dist] : [] };
      },
    };
  };

  // ------------------------------------------------------------ XRD
  PS.tools.xrd = function (ctx) {
    const { rec } = ctx;
    rec.values.peaks = rec.values.peaks || [];
    const peaks = rec.values.peaks;
    const K = () => C.num((rec.conditions.scherrer_k || {}).value) || 0.94;
    const L = () => C.num((rec.conditions.wavelength_nm || {}).value) || 0.15418;

    // --- 피크 표
    const peakBox = h('div');
    const summary = h('div', { class: 'badge-info', style: { marginTop: '8px' } });
    const mapBox = h('div');
    function renderPeaks() {
      peakBox.innerHTML = '';
      const res = C.computeXrd(peaks, K(), L());
      const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '#'), h('th', {}, '면 (hkl)'), h('th', { class: 'num' }, '중심 2θ (°)'), h('th', { class: 'num' }, '적분 면적'),
        h('th', { class: 'num' }, 'FWHM (°)'), h('th', { class: 'num' }, 'GS 입력값 (nm)', help('붙여 넣은 표에 GS 열이 있으면 원본값으로 보존합니다. 비교에는 앱 계산 GS 를 씁니다.')),
        h('th', { class: 'num' }, 'GS 계산 (nm)'), h('th', { class: 'num' }, 'SI', help(C.XRD_SI_FORMULA + '\n정수로 표시합니다.')), h('th', {}, '요약 포함', help('네 번째 피크는 기본적으로 요약에서 제외됩니다. 기록은 그대로 남습니다.')), h('th')));
      peaks.forEach((p, i) => {
        const set = (k) => (v, raw) => { p[k] = k === 'label' ? raw : v; if (p.source === 'extracted') { p.source = 'extracted_edited'; rec.source.edited = true; } ctx.markDirty(); renderSummary(); upd(i); };
        const lab = h('input', { type: 'text', value: p.label || '', class: 'sm' }); lab.oninput = () => set('label')(null, lab.value);
        const gsCell = h('td', { class: 'num' }), siCell = h('td', { class: 'num' });
        const upd = (k) => { const r = C.computeXrd([peaks[k]], K(), L()).peaks[0]; gsCell.textContent = fmt(r.gs_nm); siCell.textContent = fmt(r.si, 0); };
        const inc = h('input', { type: 'checkbox', checked: p.include !== false }); inc.onchange = () => { p.include = inc.checked; ctx.markDirty(); renderSummary(); };
        tbl.appendChild(h('tr', {}, h('td', {}, i + 1, ' ', PS.srcBadge(p.source)), h('td', {}, lab), h('td', { class: 'num' }, numInput(p.center, set('center'))), h('td', { class: 'num' }, numInput(p.area, set('area'))),
          h('td', { class: 'num' }, numInput(p.fwhm, set('fwhm'))), h('td', { class: 'num' }, numInput(p.gs_input, set('gs_input'))), gsCell, siCell, h('td', {}, inc),
          h('td', {}, h('button', { class: 'small link', onclick: () => { peaks.splice(i, 1); ctx.markDirty(); renderPeaks(); } }, '삭제'))));
        gsCell.textContent = fmt(res.peaks[i].gs_nm); siCell.textContent = fmt(res.peaks[i].si, 0);
      });
      peakBox.append(tbl, h('button', { class: 'small', style: { marginTop: '6px' }, onclick: () => { peaks.push({ label: C.XRD_DEFAULT_LABELS[peaks.length] || '', include: peaks.length !== 3, source: 'user' }); ctx.markDirty(); renderPeaks(); } }, '+ 피크 행 추가'));
      renderSummary();
    }
    function renderSummary() {
      const res = C.computeXrd(peaks, K(), L());
      const m = res.metrics;
      summary.innerHTML = '';
      summary.append(
        h('div', {}, h('b', {}, '(101) GS: '), m.gs_101 ? fmt(m.gs_101.value) + ' nm' : '— (101) 피크 없음', '   ·   ', h('b', {}, '(110) GS: '), m.gs_110 ? fmt(m.gs_110.value) + ' nm' : '—',
          '   ·   ', h('b', {}, '(110) SI: '), m.si_110 ? fmt(m.si_110.value, 0) : '—', '   ·   ', h('b', {}, '(101) SI: '), m.si_101 ? fmt(m.si_101.value, 0) : '—'),
        h('div', { class: 'small' }, `${C.XRD_GS_FORMULA},  K = ${K()}, λ = ${L()} nm (측정 조건에서 변경)  ·  ${C.XRD_SI_FORMULA}`),
        h('div', { class: 'small' }, '요약 지표는 라벨이 (110), (101) 인 피크에서 계산합니다. 라벨을 바꾸면 요약도 바뀝니다.'));
    }
    ctx.onConditions.push(renderPeaks);
    const imp = PS.importWidget({ ctx, label: '피크 표 붙여넣기 (Origin Peak Analyzer / 피팅 결과)', onText: (text, meta) => {
      const t = C.parseTable(text);
      if (!t.rows.length) throw new Error('숫자 행을 찾지 못했습니다');
      const g = C.guessXrdColumns(t.headers);
      mapBox.innerHTML = '';
      const sel = {};
      const roles = [['label', '면 라벨', true], ['center', '중심 2θ', false], ['area', '적분 면적', false], ['fwhm', 'FWHM', false], ['gs', 'GS (있으면)', true]];
      const row = h('div', { class: 'row' });
      for (const [k, l] of roles) { sel[k] = colSelect(t.headers, g[k], true); row.append(h('label', {}, l, ' '), sel[k]); }
      const warn = g.fwhm < 0 && g.w >= 0 ? h('div', { class: 'badge-warn small' }, `FWHM 열이 없고 "w" 열이 있습니다. Gaussian 피팅의 w 는 FWHM 이 아닐 수 있습니다 (FWHM = w × √(ln4) ≈ 1.1774 × w). 직접 확인 후 FWHM 열을 지정하세요.`) : null;
      mapBox.append(h('div', { class: 'badge-info small' }, `${t.rows.length}개 행을 읽었습니다. 열 지정을 확인한 뒤 “표 적용”을 누르세요.`), row, warn,
        h('button', { class: 'primary small', style: { marginTop: '6px' }, onclick: () => {
          const ix = Object.fromEntries(Object.entries(sel).map(([k, s]) => [k, +s.value]));
          if (ix.fwhm < 0 || ix.center < 0) { PS.toast('중심 2θ 와 FWHM 열은 꼭 지정하세요', 'bad'); return; }
          peaks.length = 0;
          t.rows.forEach((r, i) => {
            const n = (k) => (ix[k] >= 0 ? N(r[ix[k]]) : null);
            peaks.push({ label: ix.label >= 0 ? r[ix.label] : (C.XRD_DEFAULT_LABELS[i] || ''), center: n('center'), area: n('area'), fwhm: n('fwhm'), gs_input: n('gs'), include: i !== 3, source: 'extracted' });
          });
          ctx.setSource({ method: meta.method, file_name: meta.file_name || rec.source.file_name || null, edited: false, peak_columns: Object.fromEntries(Object.entries(ix).map(([k, v]) => [k, v >= 0 ? t.headers[v] : null])) });
          ctx.applyFileDates(meta);
          mapBox.innerHTML = '';
          renderPeaks();
        } }, '표 적용 (기존 피크 표를 바꿈)'));
    } });

    // --- XY 그래프 · 배경
    let xy = rec.datasets.find((d) => d.name === 'XRD XY') || null;
    let bgPts = xy && xy.meta && xy.meta.background_points ? xy.meta.background_points.slice() : [];
    const undo = [];
    let clickMode = false, showCorr = false, showNorm = false;
    const chartBox = h('div');
    const ptsList = h('div', { class: 'small' });
    let chart = null;
    const pushUndo = () => { undo.push(JSON.stringify(bgPts)); if (undo.length > 100) undo.shift(); };
    const nearestY = (x) => {
      const X = xy.data[0], Y = xy.data[1];
      let bi = 0, bd = Infinity;
      for (let i = 0; i < X.length; i++) { const d = Math.abs(X[i] - x); if (d < bd) { bd = d; bi = i; } }
      return [X[bi], Y[bi]];
    };
    function spec() {
      const X = xy.data[0], Y = xy.data[1];
      const series = [];
      let note = '원본 강도';
      const spl = bgPts.length >= 2 ? C.naturalSpline(bgPts) : null;
      let y = Y;
      if (showCorr && spl) { y = Y.map((v, i) => v - spl(X[i])); note = '배경 보정(원본 − 스플라인 배경)'; }
      if (showNorm) { const mx = C.maxOf(y); y = y.map((v) => v / mx); note += ' · 최고 피크 = 1 로 정규화'; }
      series.push({ name: ctx.sample.name + (showCorr ? ' (보정)' : ''), color: ctx.sample.color, x: X, y });
      if (spl && !showCorr && !showNorm) series.push({ name: '배경선 (자연 3차 스플라인)', color: '#777', dash: '6 4', x: X, y: X.map((v) => spl(v)) });
      const markers = (!showCorr && !showNorm) ? bgPts.map((p, i) => ({ x: p[0], y: p[1], color: '#e67e22', label: `배경점 ${i + 1}`, shape: 'square' })) : [];
      return { series, markers, xLabel: '2θ (°)', yLabel: showNorm ? '정규화 강도' : '강도 (a.u.)', note, clickMode, onClick: (x) => {
        if (!clickMode) return;
        pushUndo(); bgPts.push(nearestY(x)); bgPts.sort((a, b) => a[0] - b[0]); ctx.markDirty(); redraw(true);
      } };
    }
    function redraw(keepZoom) {
      if (typeof renderFit === 'function' && fitStatus) setTimeout(() => renderFit(), 0);
      ptsList.innerHTML = '';
      if (!xy) { chartBox.innerHTML = ''; chartBox.appendChild(h('div', { class: 'muted small' }, 'XY 데이터가 없습니다.')); return; }
      if (!chart) chart = PSChart.render(chartBox, spec()); else chart.redraw(spec(), keepZoom);
      ptsList.append(h('span', {}, `배경점 ${bgPts.length}개: `), ...bgPts.map((p, i) => h('span', { class: 'chip', style: { marginRight: '4px' } }, `${fmt(p[0])}°`,
        h('button', { class: 'small link', title: '이 배경점 삭제', onclick: () => { pushUndo(); bgPts.splice(i, 1); ctx.markDirty(); redraw(true); } }, '×'))));
    }
    const modeBtn = h('button', { class: 'small', onclick: () => { clickMode = !clickMode; modeBtn.textContent = clickMode ? '배경점 찍기 중 (클릭해서 끄기)' : '배경점 찍기'; modeBtn.classList.toggle('primary', clickMode); redraw(true); } }, '배경점 찍기');
    const corrChk = h('input', { type: 'checkbox' }); corrChk.onchange = () => { showCorr = corrChk.checked; redraw(); };
    const normChk = h('input', { type: 'checkbox' }); normChk.onchange = () => { showNorm = normChk.checked; redraw(); };
    const xyImp = PS.importWidget({ ctx, label: 'XY 텍스트 데이터 (2θ, 강도)', onText: (text, meta) => {
      const p = C.parseXY(text);
      if (p.x.length < 10) throw new Error('2열 숫자 데이터를 찾지 못했습니다');
      xy = { name: 'XRD XY', columns: ['2θ (°)', '강도'], data: [p.x, p.y], meta: { file_name: meta.file_name || null, background_points: [], background_method: '자연 3차 스플라인 (사용자 지정 배경점)' } };
      bgPts = []; undo.length = 0; chart = null; fit = null; fitPeaks = []; ctx.applyFileDates(meta); ctx.markDirty(); redraw(); renderFit();
    } });

    // --- Gaussian 피팅 (원본 XY 는 그대로, 결과는 xy.meta.fit 에 “피팅 추정”으로 저장)
    const FIT_COLORS = ['#e67e22', '#16a085', '#8e44ad', '#c0392b', '#2c3e50', '#d35400', '#27ae60', '#7f8c8d', '#2980b9', '#f39c12'];
    let fit = xy && xy.meta && xy.meta.fit ? JSON.parse(JSON.stringify(xy.meta.fit)) : null;
    let fitPeaks = fit ? fit.peaks.map((p) => Object.assign({ lock: {} }, p)) : [];
    const fitBox = h('div'), fitChart = h('div'), fitResid = h('div'), fitStatus = h('div');
    const nIn = numInput(7, () => {}, { class: 'sm' });
    const fxMin = numInput(fit && fit.range ? fit.range[0] : null, () => {}, { class: 'sm', placeholder: '최소 2θ' });
    const fxMax = numInput(fit && fit.range ? fit.range[1] : null, () => {}, { class: 'sm', placeholder: '최대 2θ' });
    const fitBasis = () => {
      const X = xy.data[0], Y = xy.data[1];
      if (bgPts.length >= 2) { const f = C.naturalSpline(bgPts); return { X, Y: Y.map((v, i) => v - f(X[i])), basis: 'bg_corrected', label: `배경 보정 데이터 (배경점 ${bgPts.length}개, 자연 3차 스플라인)` }; }
      return { X, Y, basis: 'raw', label: '원본 강도 (배경점 없음 — 배경이 피크 높이·면적에 섞입니다)' };
    };
    const fitStale = () => fit && JSON.stringify(fit.background_points || []) !== JSON.stringify(bgPts);
    function fitRange() {
      const X = xy.data[0];
      return [N(fxMin.value) ?? C.minOf(X), N(fxMax.value) ?? C.maxOf(X)];
    }
    function storeFit(extra) {
      const b = fitBasis();
      fit = Object.assign({ model: 'gaussian', formula: C.FIT_FORMULA, status: '피팅 추정 (실측 아님)', basis: b.basis, background_points: JSON.parse(JSON.stringify(bgPts)), range: fitRange(),
        peaks: fitPeaks.map((p) => ({ label: p.label || '', center: p.center, fwhm: p.fwhm, height: p.height, area: p.height * p.fwhm * C.GAUSS_AREA_FACTOR, lock: p.lock || {} })) }, extra || {});
      ctx.markDirty();
    }
    function renderFit() {
      fitBox.innerHTML = ''; fitChart.innerHTML = ''; fitResid.innerHTML = ''; fitStatus.innerHTML = '';
      if (!xy) { fitBox.appendChild(h('div', { class: 'muted small' }, 'XY 데이터를 불러오면 피팅할 수 있습니다.')); return; }
      const b = fitBasis();
      fitStatus.append(h('div', { class: b.basis === 'raw' ? 'badge-warn small' : 'note' }, '피팅 대상: ', b.label));
      if (fit && fit.r2 !== undefined) fitStatus.append(h('div', { class: 'badge-info small' }, `피팅 추정 결과 — R² = ${fit.r2 !== null ? fit.r2.toFixed(5) : '—'}, 반복 ${fit.iterations}회${fit.converged ? ', 수렴' : ', 수렴 안 됨'}, 범위 ${fmt(fit.range[0])}–${fmt(fit.range[1])}°, 데이터 ${fit.n}점`,
        fit.edited ? ' · 피팅 후 값을 직접 수정함' : '', h('div', {}, C.FIT_FORMULA)));
      if (fitStale()) fitStatus.append(h('div', { class: 'badge-warn small' }, '피팅 후 배경점이 바뀌었습니다. 결과를 쓰기 전에 “피팅 실행”을 다시 누르세요.'));
      const tbl = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '#'), h('th', {}, '라벨'), h('th', { class: 'num' }, '중심 2θ (°)'), h('th', {}, '고정'), h('th', { class: 'num' }, 'FWHM (°)'), h('th', {}, '고정'),
        h('th', { class: 'num' }, '높이'), h('th', {}, '고정'), h('th', { class: 'num' }, '면적 (계산)'), h('th')));
      fitPeaks.forEach((p, i) => {
        p.lock = p.lock || {};
        const ed = (k) => (v) => { if (v !== null) { p[k] = v; if (fit) fit.edited = true; storeFit(fit ? { r2: fit.r2, iterations: fit.iterations, converged: fit.converged, n: fit.n, edited: true } : {}); drawFit(); } };
        const lk = (k) => { const c = h('input', { type: 'checkbox', checked: !!p.lock[k], title: '체크하면 피팅 중 이 값을 바꾸지 않습니다' }); c.onchange = () => { p.lock[k] = c.checked; ctx.markDirty(); }; return c; };
        const lab = h('input', { type: 'text', value: p.label || '', class: 'sm' }); lab.oninput = () => { p.label = lab.value; ctx.markDirty(); };
        tbl.appendChild(h('tr', {}, h('td', {}, h('span', { class: 'dot', style: { background: FIT_COLORS[i % FIT_COLORS.length] } }), i + 1), h('td', {}, lab),
          h('td', { class: 'num' }, numInput(+p.center.toFixed(4), ed('center'))), h('td', {}, lk('center')),
          h('td', { class: 'num' }, numInput(+p.fwhm.toFixed(4), ed('fwhm'))), h('td', {}, lk('fwhm')),
          h('td', { class: 'num' }, numInput(+p.height.toFixed(2), ed('height'))), h('td', {}, lk('height')),
          h('td', { class: 'num' }, fmt(p.height * p.fwhm * C.GAUSS_AREA_FACTOR)),
          h('td', {}, h('button', { class: 'small link', onclick: () => { fitPeaks.splice(i, 1); storeFit(); renderFit(); } }, '삭제'))));
      });
      const addC = numInput(null, () => {}, { class: 'sm', placeholder: '2θ' });
      fitBox.append(tbl, h('div', { class: 'row', style: { marginTop: '6px' } }, addC, h('button', { class: 'small', onclick: () => {
        const c = N(addC.value); if (c === null) { PS.toast('추가할 피크의 2θ 를 입력하세요', 'bad'); return; }
        const bb = fitBasis(); const yy = C.interp(bb.X, bb.Y, c);
        fitPeaks.push({ center: c, fwhm: 0.4, height: Math.max(1, yy || 1), lock: {} }); fitPeaks.sort((a, b2) => a.center - b2.center); storeFit(); renderFit();
      } }, '+ 피크 추가')));
      drawFit();
    }
    function drawFit() {
      fitChart.innerHTML = ''; fitResid.innerHTML = '';
      if (!xy || !fitPeaks.length) return;
      const b = fitBasis(), [lo, hi] = fitRange();
      const X = [], Y = [];
      b.X.forEach((x, i) => { if (x >= lo && x <= hi) { X.push(x); Y.push(b.Y[i]); } });
      const series = [{ name: '데이터', color: ctx.sample.color, x: X, y: Y, width: 1.2 },
        { name: 'Gaussian 합 (피팅 추정)', color: '#111', dash: '5 3', x: X, y: X.map((x) => C.gaussSum(x, fitPeaks)) }];
      fitPeaks.forEach((p, i) => series.push({ name: `피크 ${i + 1}${p.label ? ' ' + p.label : ''}`, color: FIT_COLORS[i % FIT_COLORS.length], x: X, y: X.map((x) => C.gaussSum(x, [p])), width: 1 }));
      PSChart.render(fitChart, { series, xLabel: '2θ (°)', yLabel: '강도', note: b.basis === 'raw' ? '원본 강도에 피팅' : '배경 보정 데이터에 피팅' });
      PSChart.render(fitResid, { series: [{ name: '잔차 (데이터 − 피팅)', color: '#777', x: X, y: X.map((x, i) => Y[i] - C.gaussSum(x, fitPeaks)) }], xLabel: '2θ (°)', yLabel: '잔차', height: 160 });
    }
    const fitControls = h('div', { class: 'row', style: { margin: '6px 0' } },
      h('label', {}, '피크 수'), nIn, h('button', { class: 'small', onclick: () => {
        if (!xy) return;
        const n = Math.max(1, Math.round(N(nIn.value) || 7));
        const b = fitBasis(), [lo, hi] = fitRange();
        const X = [], Y = [];
        b.X.forEach((x, i) => { if (x >= lo && x <= hi) { X.push(x); Y.push(b.Y[i]); } });
        fitPeaks = C.findPeaks(X, Y, n);
        fitPeaks.forEach((p, i) => { p.label = C.XRD_DEFAULT_LABELS[i] || ''; });
        fit = null; storeFit(); renderFit();
      } }, '초기값 자동 찾기'),
      h('label', {}, '범위'), fxMin, '–', fxMax, '°',
      h('button', { class: 'primary small', onclick: () => {
        if (!xy || !fitPeaks.length) { PS.toast('먼저 초기 피크를 만드세요', 'bad'); return; }
        const b = fitBasis(), [lo, hi] = fitRange();
        const r = C.fitGaussians(b.X, b.Y, fitPeaks, { xmin: lo, xmax: hi });
        if (r.error) { PS.toast(r.error, 'bad'); return; }
        fitPeaks = r.peaks.map((p, i) => Object.assign(p, { label: fitPeaks[i].label }));
        storeFit({ r2: r.r2, iterations: r.iterations, converged: r.converged, n: r.n, fitted_at: new Date().toISOString(), edited: false });
        renderFit();
      } }, '피팅 실행'),
      h('button', { class: 'small', onclick: async () => {
        if (!fitPeaks.length && !fit) return;
        if (!(await PS.confirm('피팅 결과와 피크 초기값을 지울까요?', { detail: '원본 XY 데이터와 위의 피크 표는 그대로 남습니다. 저장해야 반영됩니다.' }))) return;
        fitPeaks = []; fit = null; ctx.markDirty(); renderFit();
      } }, '피팅 지우기'),
      h('button', { class: 'small', onclick: async () => {
        if (!fit || fit.r2 === undefined) { PS.toast('먼저 피팅을 실행하세요', 'bad'); return; }
        if (fitStale()) { PS.toast('배경점이 바뀌었습니다. 피팅을 다시 실행하세요', 'bad'); return; }
        if (peaks.length && !(await PS.confirm('위 피크 표를 피팅 결과로 바꿀까요?', { detail: '가져온 피크는 “피팅 추정” 출처로 표시되어 실측·Origin 피크 표와 구분됩니다. 라벨이 없으면 2θ 순서대로 (110), (101)을 붙입니다.' }))) return;
        peaks.length = 0;
        fitPeaks.slice().sort((a, b) => a.center - b.center).forEach((p, i) => peaks.push({ label: p.label || C.XRD_DEFAULT_LABELS[i] || '', center: p.center, area: p.height * p.fwhm * C.GAUSS_AREA_FACTOR, fwhm: p.fwhm, gs_input: null, include: i !== 3, source: 'fit' }));
        ctx.setSource({ peak_origin: 'XRD Gaussian 피팅 추정 (앱)', fit_basis: fit.basis, fit_r2: fit.r2 });
        renderPeaks(); PS.toast('피크 표로 가져왔습니다 (피팅 추정)', 'ok');
      } }, '피크 표로 가져오기'));

    const el = h('div', {},
      h('h3', {}, '피크 표 ', help('Origin 등에서 피크 표를 복사해 붙여 넣으면 열을 자동으로 찾습니다. 첫 번째, 두 번째 피크는 (110), (101)로 표시합니다.')),
      imp, mapBox, peakBox, summary,
      h('h3', {}, 'XY 그래프와 배경 보정'),
      xyImp,
      h('div', { class: 'row', style: { margin: '8px 0' } }, modeBtn,
        h('button', { class: 'small', onclick: () => { if (!undo.length) return; bgPts = JSON.parse(undo.pop()); ctx.markDirty(); redraw(true); } }, '실행 취소'),
        h('button', { class: 'small', onclick: () => { if (!bgPts.length) return; pushUndo(); bgPts = []; ctx.markDirty(); redraw(true); } }, '배경점 모두 지우기'),
        h('label', {}, corrChk, ' 배경 보정 결과 보기'), h('label', {}, normChk, ' 최고 피크로 정규화'),
        help('배경점은 클릭한 위치에서 가장 가까운 데이터점에 붙습니다. 배경선은 배경점을 지나는 자연 3차 스플라인입니다.\n원본 데이터는 그대로 저장되고 배경점만 함께 저장됩니다.')),
      chartBox, ptsList,
      h('h3', {}, 'Gaussian 피팅 ', help('기본 7개 Gaussian 으로 XY 데이터를 맞춥니다. 피크를 추가·삭제하거나 위치·폭·높이를 직접 바꾸고, 고정한 값은 피팅 중 바뀌지 않습니다.\n원본 XY 는 바뀌지 않으며 결과는 “피팅 추정”으로 따로 저장됩니다.')),
      h('div', { class: 'badge-warn small' }, '피팅 결과는 모델이 추정한 값입니다. 피크 수·초기값·범위·배경 처리에 따라 달라지므로 실측 사실로 취급하지 마세요.'),
      fitControls, fitStatus, fitBox, fitChart, fitResid);
    return {
      el,
      afterMount() { renderPeaks(); redraw(); renderFit(); },
      collect() {
        const res = C.computeXrd(peaks, K(), L());
        const computed = { metrics: res.metrics, details: { peaks: res.peaks, constants: res.constants, formulas: res.formulas } };
        const datasets = [];
        if (xy) {
          xy.meta = Object.assign({}, xy.meta, { background_points: bgPts, background_method: '자연 3차 스플라인 (사용자 지정 배경점)' });
          if (fit && fitPeaks.length) xy.meta.fit = Object.assign({}, fit, { stale: !!fitStale() }); else delete xy.meta.fit;
          datasets.push(xy);
        }
        if (peaks.some((p) => p.source === 'fit')) computed.details.peak_origin = '일부 또는 전체 피크가 Gaussian 피팅 추정값입니다';
        return { values: rec.values, computed, datasets };
      },
    };
  };

  // ------------------------------------------------------------ BET
  // ---- BET 공용: 보고서 → 기록, 구간 선택
  const near = (a, b) => Math.abs(a - b) < 1e-7;
  // 기본 선택: ① 사용자 선택 → ② 원자료 보고서의 BET 계산 구간(기준 만족 시) → ③ 앱 규칙(기준 만족 후보 중 R² 최고)
  PS.betSelect = function (iso, opt, selKey, reportRange) {
    const result = C.betRanges(iso.data[0], iso.data[1], Object.assign({}, opt, { r2min: 0.995 }));
    const find = (r) => result.candidates.find((c) => near(c.from, r[0]) && near(c.to, r[1])) || null;
    const reportCand = reportRange ? find(reportRange) : null;
    let sel = null, how = '';
    if (selKey) { sel = find([selKey.from, selKey.to]); how = selKey.override ? '기준 미달 구간 사용자 선택' : '사용자 선택'; }
    if (!sel && reportCand && reportCand.eligible) { sel = reportCand; how = '기본 선택: 원자료 보고서의 BET 계산 구간 (기준 만족)'; }
    if (!sel && result.selected) { sel = result.selected; how = '기본 선택: 앱 규칙 (기준 만족 후보 중 R² 최고)'; }
    return { result, sel, how, reportCand, appRule: result.selected };
  };
  PS.betComputed = function (values, pick, iso, opt, selKey) {
    const computed = { metrics: {}, details: {} };
    const sel = pick && pick.sel;
    if (sel) {
      computed.metrics.bet_ssa_recalc = { value: sel.ssa, unit: 'm²/g', formula: C.BET_FORMULA, inputs: { range: [sel.from, sel.to], n: sel.n, r2: sel.r2, C: sel.C, qm: sel.qm } };
      computed.details.bet_range = { from: sel.from, to: sel.to, n: sel.n, r2: sel.r2, C: sel.C, qm: sel.qm, slope: sel.slope, intercept: sel.intercept, selection: pick.how,
        criteria_failed: sel.reasons, options: opt, r2_threshold: 0.995,
        app_rule: pick.appRule ? { from: pick.appRule.from, to: pick.appRule.to, n: pick.appRule.n, ssa: pick.appRule.ssa, r2: pick.appRule.r2 } : null };
    } else if (iso) computed.details.bet_range = { result: '기준 만족 후보 없음 — 계산하지 않음', options: opt };
    const v = (k) => (values[k] && C.isNum(Number(values[k].value)) ? Number(values[k].value) : null);
    if (v('tplot_micro_area') !== null && v('bet_ssa')) computed.metrics.micro_area_ratio = { value: (v('tplot_micro_area') / v('bet_ssa')) * 100, unit: '%', formula: 't-plot 미세기공 면적 / BET 비표면적(보고서) × 100', inputs: { micro: v('tplot_micro_area'), bet: v('bet_ssa') } };
    const rb = values.report && values.report.bet_report;
    if (rb && C.isNum(rb.C)) computed.metrics.bet_c_report = { value: rb.C, unit: '', formula: '보고서 BET 계산의 C', inputs: { range: rb.range, n: rb.n } };
    return computed;
  };
  // MicroActive 보고서 파싱 결과 → values / conditions / dataset / 측정일
  PS.betRecord = function (ma) {
    const values = {};
    for (const [k, e] of Object.entries(ma.values)) values[k] = e;
    values.report = { format: ma.format, meta: ma.meta, bet_report: ma.bet_report, tplot: ma.tplot };
    const m = ma.meta, cond = {};
    const put = (k, label, v) => { if (v) cond[k] = { label, value: v, unit: '', source: 'file' }; };
    put('instrument', '장비', m.instrument); put('adsorptive', '흡착 기체', m.adsorptive); put('bath_temp', '분석 bath 온도', m.bath_temp);
    put('sample_mass', '시료 질량', m.sample_mass); put('equilibration', '평형 간격', m.equilibration); put('auto_degas', '장비 자동 탈기', m.automatic_degas);
    put('thermal_correction', 'Thermal correction', m.thermal_correction);
    const I = ma.isotherm;
    const dataset = I.p.length ? { name: 'BET 등온선', columns: ['p/p0', 'Q (cm³/g STP)', '절대압 (mmHg)', '포화압 (mmHg)'], data: [I.p, I.q, I.pabs, I.po],
      meta: { n_ads: I.n_ads, n_des: I.n_des, source: ma.format, file: m.file } } : null;
    return { values, conditions: cond, dataset, started: m.started, reportRange: ma.bet_report && ma.bet_report.range };
  };

  PS.tools.bet = function (ctx) {
    const { rec, cfg } = ctx;
    const vf = valueFields(ctx, cfg.fields, () => renderDiff());
    const extractInfo = h('div'), reportBox = h('div');
    const diffBox = h('div', { class: 'small', style: { marginTop: '6px' } });
    let iso = rec.datasets.find((d) => d.name === 'BET 등온선') || null;
    const opt = Object.assign({ pmin: 0.01, pmax: 0.35, minPts: 4 }, (iso && iso.meta && iso.meta.options) || {});
    let selKey = iso && iso.meta && iso.meta.selected ? iso.meta.selected : null; // {from,to,override}
    let pick = null;
    const reportRange = () => (rec.values.report && rec.values.report.bet_report && rec.values.report.bet_report.range) || null;
    function setValues(entries) { for (const [k, e] of Object.entries(entries)) if (e) vf.set(k, e); }
    function applyCond(cond) { for (const [k, c] of Object.entries(cond || {})) rec.conditions[k] = c; ctx.renderConditions && ctx.renderConditions(); }
    function renderReport() {
      reportBox.innerHTML = '';
      const r = rec.values.report;
      if (!r) return;
      const m = r.meta || {};
      const rows = r.format && /MicroActive/.test(r.format)
        ? [['양식', r.format], ['보고서 시료명', m.sample_name], ['장비', m.instrument], ['분석 시작', m.started && `${m.started.date} ${m.started.time || ''}`], ['분석 완료', m.completed && `${m.completed.date} ${m.completed.time || ''}`],
          ['시료 질량', m.sample_mass], ['원본 파일(SMP)', m.file],
          ['보고서 BET 계산', r.bet_report && r.bet_report.range ? `p/p0 ${fmt(r.bet_report.range[0], 4)}–${fmt(r.bet_report.range[1], 4)} (${r.bet_report.n}점), C = ${fmt(r.bet_report.C, 1)}, 상관계수 ${r.bet_report.corr}, Qm = ${r.bet_report.qm}` : ''],
          ['t-plot', r.tplot && r.tplot.thickness_range ? `두께 ${r.tplot.thickness_range[0]}–${r.tplot.thickness_range[1]} ${r.tplot.thickness_range[2]}, ${r.tplot.equation || ''}` : '']]
        : [['양식', r.format], ['분석기관', m.lab], ['문서번호', m.doc_no], ['완료일자', m.completed_raw], ['전처리', m.degas], ['BET 구간(공칭)', m.fitting_range], ['결과표 시료명', r.row_sample]];
      reportBox.append(h('div', { class: 'kv', style: { marginBottom: '8px' } }, rows.filter((x) => x[1]).flatMap(([k, v]) => [h('span', {}, k), h('span', {}, v)])));
      const nameIn = m.sample_name || r.row_sample;
      if (nameIn && C.nameKey(nameIn) !== C.nameKey(ctx.sample.name)) reportBox.append(h('div', { class: 'badge-warn small' }, `보고서 시료명 “${nameIn}” 이(가) 앱 샘플명 “${ctx.sample.name}” 과(와) 다릅니다. 맞는 샘플인지 확인하세요.`));
    }
    const imp = PS.importWidget({ ctx, allowPdf: true, attachRole: '성적서', label: 'BET 보고서 (Micromeritics 원자료 보고서 PDF · 분석기관 결과표 PDF · 텍스트)', placeholder: 'MicroActive 보고서 PDF 는 아래 “파일 경로로 불러오기 / 파일 선택”으로 바로 읽습니다. 요약·등온선·BET 계산 구간을 한 번에 가져옵니다.', onText: (text, meta) => {
      extractInfo.innerHTML = '';
      const ma = C.parseMicroActive(text);
      if (ma) {
        const b = PS.betRecord(ma);
        setValues(b.values); rec.values.report = b.values.report; applyCond(b.conditions);
        if (b.dataset) { iso = b.dataset; selKey = null; }
        ctx.setSource({ method: meta.method, file_name: meta.file_name || null, edited: false, report_format: ma.format, report_sample: ma.meta.sample_name });
        ctx.applyFileDates(Object.assign({}, meta, { file_name: `${meta.file_name || '보고서'} (Started)`, date_candidates: (b.started ? [{ date: b.started.date, context: `분석 시작 ${b.started.raw}` }] : []).concat(meta.date_candidates || []) }));
        extractInfo.append(h('div', { class: 'badge-ok small' }, `${ma.format}: 요약 ${Object.keys(ma.values).length}개 항목, 등온선 ${ma.isotherm.n_ads}+${ma.isotherm.n_des}점(흡착+탈착), 보고서 BET 계산 구간 ${ma.bet_report.n || 0}점을 가져왔습니다. 저장 전에 확인하세요.`));
        renderReport(); analyze(); return;
      }
      const sm = C.parseBetSummary(text);
      if (sm && sm.rows.length) {
        const key = C.nameKey(ctx.sample.name);
        let row = sm.rows.find((r) => C.nameKey(r.sample) === key);
        const apply = (r) => {
          setValues(r.values);
          rec.values.report = { format: sm.format, meta: sm.meta, row_sample: r.sample };
          if (sm.meta.degas) applyCond({ degas: { label: '전처리(탈기) 조건', value: sm.meta.degas, unit: '', source: 'file' } });
          if (sm.meta.fitting_range) applyCond({ fitting_range_nominal: { label: '보고서 BET 구간(공칭)', value: sm.meta.fitting_range, unit: 'P/Po', source: 'file' } });
          ctx.setSource({ method: meta.method, file_name: meta.file_name || null, edited: false, report_format: sm.format, report_sample: r.sample });
          renderReport(); renderDiff();
        };
        if (row) { apply(row); extractInfo.append(h('div', { class: 'badge-ok small' }, `결과표에서 “${row.sample}” 행을 가져왔습니다 (등온선 원자료는 결과표에 없습니다).`)); }
        else {
          const sel = PS.select([['', '이 샘플에 해당하는 행 선택…']].concat(sm.rows.map((r, i) => [i, r.sample])), '');
          sel.onchange = () => { if (sel.value !== '') { apply(sm.rows[+sel.value]); sel.disabled = true; } };
          extractInfo.append(h('div', { class: 'badge-warn small' }, `결과표에 ${sm.rows.length}개 시료가 있지만 샘플명 “${ctx.sample.name}” 과 정확히 맞는 행이 없습니다. `, sel));
        }
        return;
      }
      const r = C.parseBetReport(text);
      setValues(r);
      ctx.setSource({ method: meta.method, file_name: meta.file_name || null, edited: false });
      ctx.applyFileDates(meta);
      const missing = cfg.fields.filter((f) => !r[f.key]).map((f) => f.label);
      extractInfo.append(h('div', { class: Object.keys(r).length ? 'badge-ok small' : 'badge-warn small' }, `추출 ${Object.keys(r).length}개 항목. 저장 전에 값과 근거를 확인하세요.`,
        missing.length ? ` 추출하지 못한 항목: ${missing.join(', ')} (0 이 아니라 빈칸으로 남습니다)` : ''));
      renderDiff();
    } });

    // 구간 검토
    const candBox = h('div'), chartIso = h('div'), chartBet = h('div'), selBox = h('div');
    const pminIn = numInput(opt.pmin, (v) => { if (v !== null) { opt.pmin = v; ctx.markDirty(); analyze(); } }, { class: 'sm' });
    const pmaxIn = numInput(opt.pmax, (v) => { if (v !== null) { opt.pmax = v; ctx.markDirty(); analyze(); } }, { class: 'sm' });
    const minIn = numInput(opt.minPts, (v) => { if (v !== null && v >= 3) { opt.minPts = Math.round(v); ctx.markDirty(); analyze(); } }, { class: 'sm' });
    const isoImp = PS.importWidget({ ctx, label: '등온선 데이터만 따로 넣기 (p/p0, 흡착량 cm³/g STP)', onText: (text, meta) => {
      const p = C.parseXY(text);
      if (p.x.length < 4) throw new Error('p/p0 와 흡착량 2열을 찾지 못했습니다');
      iso = { name: 'BET 등온선', columns: ['p/p0', 'Q (cm³/g STP)'], data: [p.x, p.y], meta: { file_name: meta.file_name || null } };
      selKey = null; ctx.markDirty(); analyze();
    } });
    const selected = () => (pick ? pick.sel : null);
    function analyze() {
      candBox.innerHTML = ''; selBox.innerHTML = ''; chartIso.innerHTML = ''; chartBet.innerHTML = '';
      if (!iso) { pick = null; candBox.appendChild(h('div', { class: 'muted small' }, '등온선 데이터가 있으면 후보 구간을 계산합니다. MicroActive 보고서 PDF 를 넣으면 등온선도 함께 들어옵니다.')); renderDiff(); return; }
      pick = PS.betSelect(iso, opt, selKey, reportRange());
      const { result } = pick;
      const sel = pick.sel;
      if (!result.eligible.length) {
        const cnt = {};
        result.candidates.forEach((c) => c.reasons.forEach((r) => { const k = r.replace(/[\d.]+/g, '#'); cnt[k] = (cnt[k] || 0) + 1; }));
        selBox.appendChild(h('div', { class: 'badge-bad' }, h('b', {}, '기준을 만족하는 후보 구간이 없어 비표면적을 계산하지 않았습니다. '),
          `후보 ${result.candidates.length}개 모두 탈락. 주요 이유: `, Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join(', '),
          '. p/p0 범위를 넓히거나 데이터 점을 확인하세요.'));
      }
      if (sel) {
        selBox.appendChild(h('div', { class: sel.eligible ? 'badge-ok' : 'badge-warn' },
          h('b', {}, `선택 구간 p/p0 ${fmt(sel.from, 4)}–${fmt(sel.to, 4)} (${sel.n}점): `),
          `S(BET, 앱 재계산) = ${fmt(sel.ssa)} m²/g, C = ${fmt(sel.C, 1)}, R² = ${sel.r2.toFixed(6)}, Qm = ${fmt(sel.qm, 3)} cm³/g · ${pick.how}`,
          sel.eligible ? '' : ` · ${sel.reasons.join('; ')}`));
      }
      const rr = reportRange();
      if (rr) {
        const rc = pick.reportCand;
        selBox.appendChild(h('div', { class: 'small', style: { marginTop: '6px' } }, h('b', {}, '보고서 구간 검증: '),
          rc ? `p/p0 ${fmt(rr[0], 4)}–${fmt(rr[1], 4)} (${rc.n}점)을 앱이 다시 계산하면 ${fmt(rc.ssa, 4)} m²/g, C = ${fmt(rc.C, 2)} — ${rc.eligible ? '기준 만족' : '기준 미달: ' + rc.reasons.join('; ')}`
            : '보고서 구간과 같은 점 묶음을 등온선에서 찾지 못했습니다 (p/p0 범위 설정을 확인하세요).'));
      }
      if (pick.appRule && sel !== pick.appRule) {
        const a = pick.appRule;
        selBox.appendChild(h('div', { class: 'small muted' }, `참고 — 앱 규칙(기준 만족 후보 중 R² 최고): p/p0 ${fmt(a.from, 4)}–${fmt(a.to, 4)} (${a.n}점), ${fmt(a.ssa)} m²/g, R² ${a.r2.toFixed(7)}. 점이 적은 구간일수록 R² 가 쉽게 높아집니다.`));
      }
      const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th'), h('th', {}, 'p/p0 구간'), h('th', { class: 'num' }, '점 수'), h('th', { class: 'num' }, 'R²'), h('th', { class: 'num' }, 'BET C'),
        h('th', { class: 'num' }, '비표면적 (m²/g)'), h('th', {}, '판정')));
      const list = result.candidates.slice().sort((a, b) => ((b === pick.reportCand) - (a === pick.reportCand)) || (b.eligible - a.eligible) || (b.r2 - a.r2));
      for (const c of list.slice(0, 200)) {
        const isSel = sel === c;
        const rb = h('input', { type: 'radio', name: 'betsel', checked: isSel });
        rb.onchange = async () => {
          if (!c.eligible && !(await PS.confirm('기준을 만족하지 않는 구간입니다. 그래도 선택할까요?', { detail: c.reasons.join(' / ') + ' — 선택하면 기록에 “기준 미달 구간 사용자 선택”으로 남습니다.' }))) { analyze(); return; }
          selKey = { from: c.from, to: c.to, override: !c.eligible }; ctx.markDirty(); analyze();
        };
        tbl.appendChild(h('tr', { style: c.eligible ? (isSel ? { background: '#eef5ff' } : null) : { color: '#9aa1ad' } }, h('td', {}, rb),
          h('td', {}, `${fmt(c.from, 4)} – ${fmt(c.to, 4)}`, c === pick.reportCand ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, '보고서 구간') : null, c === pick.appRule ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, '앱 규칙') : null),
          h('td', { class: 'num' }, c.n), h('td', { class: 'num' }, c.r2.toFixed(6)), h('td', { class: 'num' }, fmt(c.C, 1)), h('td', { class: 'num' }, fmt(c.ssa)),
          h('td', { class: 'small' }, c.eligible ? '기준 만족' : c.reasons.join('; '))));
      }
      candBox.append(h('div', { class: 'small muted' }, `흡착 분지 ${result.adsorptionPoints}점 중 p/p0 ${opt.pmin}–${opt.pmax} 범위에서 후보 ${result.candidates.length}개, 기준 만족 ${result.eligible.length}개. (최대 200개 표시)`),
        h('div', { class: 'tablewrap', style: { maxHeight: '320px' } }, tbl));
      const P = iso.data[0], Q = iso.data[1];
      const na = (iso.meta && iso.meta.n_ads) || P.length;
      const series = [{ name: '흡착', color: ctx.sample.color, x: P.slice(0, na), y: Q.slice(0, na), mode: 'both', r: 2.2 }];
      if (na < P.length) series.push({ name: '탈착', color: ctx.sample.color, dash: '5 3', x: P.slice(na), y: Q.slice(na), mode: 'both', r: 1.8, opacity: 0.7 });
      PSChart.render(chartIso, { series, xLabel: 'p/p0', yLabel: 'Q (cm³/g STP)', bands: sel ? [{ from: sel.from, to: sel.to }] : [], height: 260 });
      if (sel) {
        const xs = sel.idx.map((i) => P[i]), ys = sel.idx.map((i) => 1 / (Q[i] * (1 / P[i] - 1)));
        const fx = [sel.from, sel.to];
        PSChart.render(chartBet, { series: [{ name: 'BET 변환 점', color: ctx.sample.color, x: xs, y: ys, mode: 'points' }, { name: `직선 맞춤 (R² ${sel.r2.toFixed(5)})`, color: '#333', dash: '5 4', x: fx, y: fx.map((x) => sel.slope * x + sel.intercept) }],
          xLabel: 'p/p0', yLabel: '1 / [Q(p0/p − 1)]', height: 260 });
      }
      renderDiff();
    }
    function renderDiff() {
      diffBox.innerHTML = '';
      const rep = rec.values.bet_ssa && rec.values.bet_ssa.value;
      const sel = selected();
      if (C.isNum(rep) && sel) {
        const d = ((sel.ssa - rep) / rep) * 100;
        diffBox.append(`보고서 값 ${fmt(rep, 4)} m²/g  vs  앱 재계산 ${fmt(sel.ssa, 4)} m²/g (차이 ${fmt(d, 2)} %). 두 값은 출처가 다르므로 따로 저장·표시됩니다.`);
      }
      const t = rec.values.tplot_micro_area && rec.values.tplot_micro_area.value, b = rec.values.bet_ssa && rec.values.bet_ssa.value;
      if (C.isNum(t) && C.isNum(b) && t / b > 0.5) diffBox.append(h('div', { class: 'badge-warn small', style: { marginTop: '6px' } }, `미세기공 면적이 BET 비표면적의 ${fmt((t / b) * 100, 1)} % 인 미세기공성 시료입니다. 이런 시료의 BET 값은 계산 구간 선택에 민감하므로 보고서 구간과 앱 재계산을 함께 확인하세요.`));
    }
    const el = h('div', {},
      h('h3', {}, '보고서 값'), imp, extractInfo, reportBox, vf.el, diffBox,
      h('p', { class: 'note' }, 'PDF 전체를 앱에 복사하지 않습니다. 보고서 그래프는 아래 “원본 파일·첨부”에서 역할을 “보고서 그래프”로 지정해 연결하거나 복사하세요.'),
      h('h3', {}, 'BET 구간 검토 ', help('BET 식은 단분자층 형성 구간에서만 성립합니다. 어떤 p/p0 구간을 쓰느냐에 따라 비표면적이 달라지므로, 후보 구간마다 R², C 값, 계산 비표면적을 함께 비교합니다.')),
      h('details', {}, h('summary', {}, '구간 검토가 무엇을 의미하나요?'),
        h('div', { class: 'note' },
          h('p', {}, '• 후보 구간: 흡착 분지에서 연속된 점들의 모든 구간(최소 점 수 이상)을 BET 직선식에 맞춥니다.'),
          h('p', {}, '• 기본 선택에서 제외하는 구간: R² < 0.995, 절편 ≤ 0 또는 C ≤ 0(물리적으로 의미 없음), Q(1−p/p0)가 감소하기 시작한 점을 포함(Rouquerol 기준 1), 단분자층 p/p0 = 1/(√C+1)이 구간 밖(Rouquerol 기준 3).'),
          h('p', {}, '• 기본 선택 순서: 사용자가 고른 구간 → 원자료 보고서의 BET 계산 구간(기준을 만족할 때) → 앱 규칙(기준 만족 후보 중 R² 최고). 점이 적은 구간은 R² 가 쉽게 높아지므로, 보고서 구간이 있으면 그것을 먼저 씁니다.'),
          h('p', {}, '• 기준을 만족하는 구간이 없으면 숫자를 만들지 않고 이유를 보여줍니다.'),
          h('p', {}, '• S = Qm × N_A × 0.162 nm² / 22414 cm³ (N₂ 단면적 0.162 nm² 가정).'))),
      h('details', {}, h('summary', {}, '등온선 데이터만 따로 넣기'), isoImp),
      h('div', { class: 'row', style: { margin: '6px 0' } }, h('label', {}, 'p/p0 최소'), pminIn, h('label', {}, '최대'), pmaxIn, h('label', {}, '최소 점 수'), minIn, h('span', { class: 'muted small' }, 'R² 기준 0.995')),
      selBox, candBox, h('div', { class: 'grid2' }, chartIso, chartBet));
    return {
      el,
      afterMount() { renderReport(); analyze(); },
      collect() {
        const computed = PS.betComputed(rec.values, pick, iso, opt, selKey);
        const datasets = iso ? [Object.assign({}, iso, { meta: Object.assign({}, iso.meta, { options: opt, selected: selKey }) })] : [];
        return { values: rec.values, computed, datasets };
      },
    };
  };

  // ------------------------------------------------------------ XRF
  // 성적서 파싱 결과 → 측정 기록의 values / computed (단일 입력과 일괄 가져오기에서 같이 사용)
  PS.xrfRecord = function (report, cfg, overrides) {
    overrides = overrides || {};
    const comps = report.rows.map((r) => Object.assign({}, r));
    const interest = overrides.interest_elements || (cfg.interest_elements || ['Cl', 'Si', 'Na']).slice();
    const dm = overrides.main_components ? { list: overrides.main_components, auto: !!overrides.main_auto } : C.xrfDefaultMains(comps, cfg.main_components || []);
    const values = { components: comps, main_components: dm.list, main_auto: !!dm.auto, main_auto_reason: dm.reason || null, interest_elements: interest,
      report: Object.assign({}, report.meta, { format: report.format }) };
    const r = C.computeXrf(comps, dm.list, interest, PS.xrfOpts(cfg));
    const computed = { metrics: r.metrics, details: PS.xrfDetails(r, dm.auto ? `자동 선택: ${dm.reason}` : '설정/사용자 선택') };
    return { values, computed, conditions: PS.xrfConditions(report.meta || {}) };
  };
  PS.xrfOpts = (cfg) => ({ basis: cfg.purity_basis || 'metal', exclude: cfg.metal_basis_exclude || C.NONMETALS });
  PS.xrfDetails = (r, mainSel) => ({ total_quantified: r.total_reported, purity_breakdown: r.purity, impurities: r.impurities, not_reported: r.not_reported,
    non_quantified: r.non_quantified, formula: r.metrics.purity ? r.metrics.purity.formula : C.XRF_PURITY_FORMULA, main_selection: mainSel });
  // 필름 보정·Impurity 보정·Application 은 측정 조건으로 저장 → 비교 화면에서 조건 차이로 드러난다
  PS.xrfConditions = function (m) {
    const cond = {};
    if (m.format && /SQX/.test(m.format)) {
      cond.film_correction = { label: 'XRF 필름 보정', value: m.film_label || (m.film_correction ? `있음 (${m.film_correction})` : '없음'), unit: '', source: 'file' };
      cond.impurity_correction = { label: 'Impurity 보정', value: m.impurity_correction || '없음', unit: '', source: 'file' };
      if (m.application) cond.application = { label: 'Application', value: m.application, unit: '', source: 'file' };
      if (m.sample_type) cond.sample_type = { label: 'Sample type', value: m.sample_type, unit: '', source: 'file' };
    }
    return cond;
  };
  PS.filmChip = function (m) {
    if (!m || !m.format || !/SQX/.test(m.format)) return null;
    const on = m.film_corrected !== undefined ? m.film_corrected : !!m.film_correction;
    return h('span', { class: 'chip', style: on ? { background: '#e6eefc', color: '#234f99', borderColor: '#bcd1f2', fontWeight: 600 } : { background: '#f4f5f7', color: '#555' },
      title: '필름 보정 여부에 따라 함량과 검출한계가 조금 달라질 수 있습니다. 보정 여부가 다른 측정은 비교에서 조건 차이로 표시됩니다.' },
    on ? `필름 보정 있음 · ${m.film_correction}` : '필름 보정 없음');
  };

  PS.tools.xrf = function (ctx) {
    const { rec, cfg } = ctx;
    rec.values.components = rec.values.components || [];
    const comps = rec.values.components;
    rec.values.interest_elements = rec.values.interest_elements || (cfg.interest_elements || ['Cl', 'Si', 'Na']).slice();
    if (!rec.values.main_components) { const dm = C.xrfDefaultMains(comps, cfg.main_components || []); rec.values.main_components = dm.list; rec.values.main_auto = dm.auto; rec.values.main_auto_reason = dm.reason || null; }
    const tblBox = h('div'), resBox = h('div', { style: { marginTop: '8px' } }), metaBox = h('div');
    const intIn = h('input', { type: 'text', value: rec.values.interest_elements.join(', '), style: { width: '200px' } });
    intIn.oninput = () => { rec.values.interest_elements = intIn.value.split(/[,\s]+/).filter(Boolean); ctx.markDirty(); renderRes(); };
    const mains = () => rec.values.main_components || [];
    function renderMeta() {
      metaBox.innerHTML = '';
      const m = rec.values.report;
      if (!m || !m.format) return;
      const rows = [['양식', m.format], ['성적서 샘플명', m.sample_name], ['분석 일시 (Date analyzed)', m.date_analyzed ? `${m.date_analyzed.date} ${m.date_analyzed.time || ''}` : m.date_analyzed_raw],
        ['출력 일시', m.printed ? `${m.printed.date} ${m.printed.time || ''}` : ''], ['Application', m.application], ['Sample type', m.sample_type], ['Balance', m.balance || '(없음)'],
        ['Sample film corr.', m.film_correction], ['Impurity corr.', m.impurity_correction || '(없음)'],
        ['Result 합계', C.isNum(m.result_sum) ? fmt(m.result_sum, 3) + ' %' : ''], ['w/o normal 합계', C.isNum(m.wo_normal_sum) ? fmt(m.wo_normal_sum, 3) + ' % (정규화 전)' : '']].filter((r) => r[1]);
      metaBox.append(h('div', { class: 'row', style: { marginBottom: '6px' } }, PS.filmChip(m), help('“Sample film corr.” 칸에 필름 이름이 있으면 필름 보정을 한 측정입니다. 비산되는 시료에 분석자 재량으로 씁니다.')),
        h('div', { class: 'kv', style: { marginBottom: '8px' } }, rows.flatMap(([k, v]) => [h('span', {}, k), h('span', {}, v)])));
      if (m.sample_name && C.nameKey(m.sample_name) !== C.nameKey(ctx.sample.name)) {
        metaBox.append(h('div', { class: 'badge-warn small' }, `성적서의 샘플명 “${m.sample_name}” 이(가) 앱 샘플명 “${ctx.sample.name}” 과(와) 다릅니다. 맞는 샘플의 성적서인지 확인하세요.`));
      }
    }
    function renderTbl() {
      tblBox.innerHTML = '';
      const hasSqx = comps.some((c) => c.det_limit !== undefined);
      const tbl = h('table', { class: 'tbl', style: { maxWidth: '1100px' } }, h('tr', {}, h('th', {}, '성분'), h('th', {}, '상태', help('정량: 함량 값 있음 · Trace: 검출됐으나 정량 불가 · 불검출 · 검출한계 미만\n정량이 아닌 성분은 값이 비어 있고 순도 합계에서 빠집니다. 0 으로 바꾸지 않습니다.')),
        h('th', { class: 'num' }, '함량'), h('th', {}, '단위'), hasSqx ? h('th', { class: 'num' }, '검출한계') : null, hasSqx ? h('th', {}, '분석선') : null,
        h('th', {}, '출처'), h('th', {}, '주성분', help('순도 계산의 분자에 들어갈 성분입니다.')), h('th', {}, '추출 근거 (원문 줄)'), h('th')));
      comps.forEach((c, i) => {
        c.status = c.status || (C.isNum(c.value) ? 'quantified' : 'nd');
        const nm = h('input', { type: 'text', value: c.component, class: 'sm' });
        const edited = () => { if (c.source === 'extracted') { c.source = 'extracted_edited'; rec.source.edited = true; } ctx.markDirty(); renderRes(); };
        nm.oninput = () => { c.component = nm.value.trim(); edited(); };
        const st = PS.select(Object.entries(C.XRF_STATUS), c.status);
        const vin = numInput(c.value, (v) => { c.value = v; if (v !== null) { c.status = 'quantified'; st.value = 'quantified'; } edited(); }, { placeholder: c.status === 'quantified' ? '값' : C.XRF_STATUS[c.status], disabled: c.status !== 'quantified' });
        st.onchange = () => { c.status = st.value; if (c.status !== 'quantified') { c.value = null; vin.value = ''; } vin.disabled = c.status !== 'quantified'; vin.placeholder = c.status === 'quantified' ? '값' : C.XRF_STATUS[c.status]; edited(); };
        const un = PS.select(['%', 'ppm'], c.unit || '%'); un.onchange = () => { c.unit = un.value; edited(); };
        const mc = h('input', { type: 'checkbox', checked: mains().includes(c.component) });
        mc.onchange = () => { const s2 = new Set(mains()); if (mc.checked) s2.add(c.component); else s2.delete(c.component); rec.values.main_components = [...s2]; rec.values.main_auto = false; ctx.markDirty(); renderRes(); };
        tbl.appendChild(h('tr', { style: c.status !== 'quantified' ? { color: '#7a8190' } : null }, h('td', {}, nm), h('td', {}, st), h('td', { class: 'num' }, vin), h('td', {}, un),
          hasSqx ? h('td', { class: 'num small' }, C.isNum(c.det_limit) ? c.det_limit : '') : null, hasSqx ? h('td', { class: 'small' }, c.el_line || '') : null,
          h('td', {}, PS.srcBadge(c.source)), h('td', {}, mc),
          h('td', { class: 'small muted mono' }, c.line_text || c.line || ''), h('td', {}, h('button', { class: 'small link', onclick: () => { comps.splice(i, 1); ctx.markDirty(); renderTbl(); } }, '삭제'))));
      });
      tblBox.append(tbl, h('button', { class: 'small', style: { marginTop: '6px' }, onclick: () => { comps.push({ component: '', value: null, status: 'quantified', unit: '%', source: 'user' }); ctx.markDirty(); renderTbl(); } }, '+ 성분 추가'));
      renderRes();
    }
    function renderRes() {
      const r = C.computeXrf(comps, mains(), rec.values.interest_elements, PS.xrfOpts(cfg));
      resBox.innerHTML = '';
      const p = r.metrics.purity, pb = r.purity || {};
      resBox.append(h('div', { class: 'badge-info' },
        h('div', {}, h('b', {}, '순도 (Metal basis): '), p ? fmt(p.value) + ' %' : '— (주성분을 선택하세요)'),
        p ? h('table', { class: 'tbl small', style: { maxWidth: '760px', margin: '6px 0' } },
          h('tr', {}, h('td', {}, `주성분 (${mains().join('+')})`), h('td', { class: 'num' }, fmt(pb.main_sum, 4)), h('td', { class: 'muted' }, '성적서 값 그대로 (수정하면 “추출→수정”으로 기록)')),
          h('tr', {}, h('td', {}, '금속 불순물 합계'), h('td', { class: 'num' }, fmt(pb.impurity_sum, 4)), h('td', { class: 'muted' }, (pb.metal_impurities || []).map((c) => `${c.component} ${c.pct}`).join(', ') || '없음')),
          h('tr', {}, h('td', {}, '전체 금속량'), h('td', { class: 'num' }, fmt(pb.total_metal, 4)), h('td', { class: 'muted' }, '주성분 + 금속 불순물')),
          h('tr', {}, h('td', {}, '제외 (비금속)'), h('td', { class: 'num' }, fmt((pb.excluded || []).reduce((a, c) => a + c.pct, 0), 4)), h('td', { class: 'muted' }, (pb.excluded || []).map((c) => `${c.component} ${c.pct}`).join(', ') || '없음'))) : null,
        rec.values.main_auto ? h('div', { class: 'small flag' }, `주성분 ${rec.values.main_auto_reason || '자동 선택'} — 맞는지 확인하세요 (주성분 칸을 바꾸면 사용자 선택으로 기록됩니다).`) : null,
        h('div', { class: 'small' }, p ? p.formula : C.XRF_PURITY_FORMULA, help('제외하는 비금속 원소: ' + PS.xrfOpts(cfg).exclude.join(', ') + '\n준금속(B, Si, Ge, As, Sb, Te)은 금속 불순물로 포함합니다.')),
        r.non_quantified.length ? h('div', { class: 'small' }, '정량되지 않은 성분: ', r.non_quantified.map((c) => `${c.component}(${C.XRF_STATUS[c.status] || c.status})`).join(', '), ' — 합계·비교에서 0 으로 쓰지 않습니다.') : null,
        h('table', { class: 'tbl', style: { marginTop: '6px', maxWidth: '700px' } }, h('tr', {}, h('th', {}, '관심 원소'), h('th', { class: 'num' }, '함량 (wt%)'), h('th', {}, '근거')),
          rec.values.interest_elements.map((el) => {
            const im = r.impurities[el];
            return h('tr', {}, h('td', {}, el), h('td', { class: 'num' }, im && C.isNum(im.value) ? fmt(im.value, 3) : h('span', { class: 'flag' }, im ? C.XRF_STATUS[im.status] || '값 없음' : '보고 없음')),
              h('td', { class: 'small' }, im ? im.basis : '성적서에 없음 — 0 으로 간주하지 않습니다 (검출한계 미만일 수도 있음)'));
          }))));
    }
    const imp = PS.importWidget({ ctx, allowPdf: true, attachRole: '성적서', label: 'XRF 성적서 (PDF / 캡처 OCR / 텍스트 붙여넣기)', placeholder: 'Rigaku SQX 성적서 PDF 는 아래 “파일 경로로 불러오기 / 파일 선택”으로 바로 읽을 수 있습니다.\n텍스트 예)\nIr  94.5 mass%\nCl  3.74 mass%\nTl  Trace', onText: (text, meta) => {
      const rep = C.parseXrfReport(text);
      if (!rep.rows.length) throw new Error('원소/화합물과 함량을 찾지 못했습니다. 표를 직접 입력하세요.');
      const built = PS.xrfRecord(rep, cfg, { interest_elements: rec.values.interest_elements });
      comps.length = 0; comps.push(...built.values.components);
      Object.assign(rec.values, { main_components: built.values.main_components, main_auto: built.values.main_auto, main_auto_reason: built.values.main_auto_reason, report: built.values.report });
      Object.assign(rec.conditions, built.conditions); ctx.renderConditions && ctx.renderConditions();
      ctx.setSource({ method: meta.method, file_name: meta.file_name || null, edited: false, report_format: rep.format, report_sample: rep.meta.sample_name || null });
      const dates = (rep.meta.date_analyzed ? [{ date: rep.meta.date_analyzed.date, context: `성적서 Date analyzed ${rep.meta.date_analyzed_raw}` }] : []).concat(meta.date_candidates || []);
      ctx.applyFileDates(Object.assign({}, meta, { date_candidates: dates, file_name: meta.file_name ? `${meta.file_name} (Date analyzed)` : '성적서' }));
      ctx.markDirty(); renderMeta(); renderTbl();
    } });
    return {
      el: h('div', {}, imp, h('div', { class: 'note' }, '추출 결과는 저장 전에 반드시 확인하세요. Trace·불검출 성분은 값이 비어 있고, 추출하지 못한 값은 빈칸으로 남습니다(0 아님).',
        ' 여러 성적서를 한 번에 넣으려면 ', h('a', { href: '#/import/xrf' }, 'XRF 성적서 일괄 가져오기'), '를 쓰세요.'),
      metaBox, h('h3', {}, '원소·성분 함량'), tblBox,
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', {}, '관심 불순물 원소', help('산화물(SiO2, Na2O 등)로 보고된 경우 원소 질량분율로 환산하고 환산식을 함께 기록합니다.')), intIn), resBox),
      afterMount() { renderMeta(); renderTbl(); },
      collect() {
        const r = C.computeXrf(comps, mains(), rec.values.interest_elements, PS.xrfOpts(cfg));
        return { values: rec.values, computed: { metrics: r.metrics, details: PS.xrfDetails(r, rec.values.main_auto ? `자동 선택: ${rec.values.main_auto_reason}` : '설정/사용자 선택') } };
      },
    };
  };

  // ------------------------------------------------------------ TGA
  PS.tools.tga = function (ctx) {
    const { rec } = ctx;
    let ds = rec.datasets.find((d) => d.name === 'TGA raw') || null;
    const m = Object.assign({ method: 'savgol', window: 21, mass_unit: '%' }, (ds && ds.meta) || {});
    const wr = Object.assign({ t1: null, t2: null, rationale: '' }, (rec.values.water_range || {}));
    const chartBox = h('div'), resBox = h('div'), mapBox = h('div');
    const imp = PS.importWidget({ ctx, label: 'TGA raw 텍스트 데이터', onText: (text, meta) => {
      const t = C.parseTable(text);
      if (t.rows.length < 10) throw new Error('데이터 행이 너무 적습니다');
      const hl = t.headers.map((x) => String(x).toLowerCase());
      const gT = Math.max(0, C.guessCol(hl, [/temp|°c|℃|\bt\b/]));
      let gM = C.guessCol(hl, [/weight|mass|tg|%|mg/], [gT]);
      if (gM < 0) gM = gT === 0 ? 1 : 0;
      const sT = colSelect(t.headers, gT), sM = colSelect(t.headers, gM);
      const first = C.num(t.rows[0][gM]);
      const sU = PS.select([['%', '질량 %'], ['mg', '질량 (mg 등 절대값)']], /%/.test(hl[gM]) || (first > 90 && first < 110) ? '%' : 'mg');
      mapBox.innerHTML = '';
      mapBox.append(h('div', { class: 'row' }, h('label', {}, '온도 열'), sT, h('label', {}, '질량 열'), sM, sU,
        h('button', { class: 'primary small', onclick: () => {
          const T = C.column(t, +sT.value), M = C.column(t, +sM.value);
          const keep = T.map((v, i) => C.isNum(v) && C.isNum(M[i]));
          ds = { name: 'TGA raw', columns: [t.headers[+sT.value], t.headers[+sM.value]], data: [T.filter((_, i) => keep[i]), M.filter((_, i) => keep[i])], meta: {} };
          m.mass_unit = sU.value; m.file_name = meta.file_name || null;
          ctx.setSource({ method: meta.method, file_name: meta.file_name || null });
          ctx.applyFileDates(meta); ctx.markDirty(); mapBox.innerHTML = ''; draw();
        } }, '열 적용')));
    } });
    const meth = PS.select([['savgol', 'Savitzky–Golay'], ['ma', '이동 평균'], ['none', '스무딩 없음']], m.method); meth.onchange = () => { m.method = meth.value; ctx.markDirty(); draw(); };
    const win = numInput(m.window, (v) => { if (v >= 3) { m.window = Math.round(v); ctx.markDirty(); draw(); } }, { class: 'sm' });
    const t1 = numInput(wr.t1, (v) => { wr.t1 = v; ctx.markDirty(); draw(); }, { class: 'sm', placeholder: 'T1' });
    const t2 = numInput(wr.t2, (v) => { wr.t2 = v; ctx.markDirty(); draw(); }, { class: 'sm', placeholder: 'T2' });
    const why = h('input', { type: 'text', value: wr.rationale, placeholder: '구간 선택 근거 (예: DTG 첫 피크가 끝나는 온도까지 흡착수)', style: { width: '100%' } });
    why.oninput = () => { wr.rationale = why.value; ctx.markDirty(); };
    function calc() {
      if (!ds) return null;
      const T = ds.data[0], M = ds.data[1];
      const r = C.computeTga(T, M, { massUnit: m.mass_unit, window: m.window, method: m.method });
      const loss = C.isNum(wr.t1) && C.isNum(wr.t2) ? C.tgaLoss(T, r.massPct, wr.t1, wr.t2) : null;
      return { T, r, loss };
    }
    function draw() {
      chartBox.innerHTML = ''; resBox.innerHTML = '';
      if (!ds) { chartBox.appendChild(h('div', { class: 'muted small' }, 'raw 데이터를 불러오면 질량·DTG 곡선을 그립니다.')); return; }
      const { T, r, loss } = calc();
      const sm = m.method === 'none' ? '스무딩 없음' : `${m.method === 'savgol' ? 'Savitzky–Golay(2차)' : '이동 평균'} ${m.window}점`;
      PSChart.render(chartBox, { series: [
        { name: '질량 (%)', color: ctx.sample.color, x: T, y: r.massPct, width: 2 },
        { name: 'DTG 원본', color: '#bbb', x: T, y: r.dtgRaw, axis: 'y2', width: 1, opacity: 0.7 },
        { name: `DTG (${sm})`, color: '#c0392b', x: T, y: r.dtgSmooth, axis: 'y2', width: 1.6 },
      ], xLabel: '온도 (°C)', yLabel: '질량 (%)', y2Label: 'DTG (−d질량%/dT, %/°C)', note: `DTG: ${sm}, 원본 곡선 회색`,
      bands: C.isNum(wr.t1) && C.isNum(wr.t2) ? [{ from: wr.t1, to: wr.t2, color: '#3b82f6' }] : [] });
      if (loss) resBox.appendChild(h('div', { class: 'badge-info' }, h('b', {}, `수분 함량(계산) = ${fmt(loss.value)} %`), `  (T1 ${wr.t1} °C: ${fmt(loss.m_t1)} %, T2 ${wr.t2} °C: ${fmt(loss.m_t2)} %, m₀ ${fmt(loss.m0)} %)`,
        h('div', { class: 'small' }, C.TGA_WATER_FORMULA)));
      else if (C.isNum(wr.t1) || C.isNum(wr.t2)) resBox.appendChild(h('div', { class: 'badge-warn small' }, 'T1, T2 가 데이터 온도 범위 안에 있어야 계산됩니다.'));
    }
    return {
      el: h('div', {}, imp, mapBox,
        h('div', { class: 'row', style: { margin: '8px 0' } }, h('label', {}, 'DTG 스무딩'), meth, h('label', {}, '창 크기(점)'), win, help('DTG 는 질량%를 온도로 미분한 값입니다. 노이즈가 커서 기본으로 스무딩해 보여주며, 원본 DTG 도 함께 표시하고 원본 데이터는 그대로 저장합니다.')),
        chartBox,
        h('h3', {}, '수분 함량 계산 구간 ', help('분석자가 고른 온도 구간의 질량 감소를 수분 함량으로 계산합니다. 구간과 근거가 함께 저장됩니다.')),
        h('div', { class: 'row' }, h('label', {}, 'T1 (°C)'), t1, h('label', {}, 'T2 (°C)'), t2), h('div', { style: { marginTop: '6px' } }, why), resBox),
      afterMount: draw,
      collect() {
        const c = calc();
        const computed = { metrics: {}, details: { smoothing: { method: m.method, window: m.window } } };
        if (c && c.loss) {
          if (!wr.rationale.trim()) { PS.toast('수분 함량 구간을 선택한 근거를 입력하세요', 'bad'); return false; }
          computed.metrics.water_content = { value: c.loss.value, unit: '%', formula: C.TGA_WATER_FORMULA, inputs: { T1: wr.t1, T2: wr.t2, m_T1: c.loss.m_t1, m_T2: c.loss.m_t2, m0: c.loss.m0, rationale: wr.rationale } };
        }
        rec.values.water_range = wr;
        const datasets = ds ? [Object.assign({}, ds, { meta: { mass_unit: m.mass_unit, method: m.method, window: m.window, file_name: m.file_name || (ds.meta || {}).file_name || null } })] : [];
        return { values: rec.values, computed, datasets };
      },
    };
  };

  // ------------------------------------------------------------ 전기화학 공통
  // live: 세션 정보를 고치면 과거 측정에도 반영 / snapshot: 측정 저장 시점 값으로 고정
  PS.EC_FIELDS = [
    { key: 'rde_no', label: 'RDE 번호', live: true, help: '전극 식별 정보. 나중에 확인되면 과거 측정에도 반영됩니다.' },
    { key: 'ink_name', label: '잉크 조성명', live: false },
    { key: 'coating', label: '도포 방식', live: false },
    { key: 'loading_mg', label: '총 분말 로딩', unit: 'mg', live: false, num: true },
    { key: 'electrolyte', label: '전해질', live: false },
    { key: 'reference', label: '기준 전극', live: false },
    { key: 'counter', label: '상대 전극', live: false },
    { key: 'rpm', label: '회전 속도', unit: 'rpm', live: false, num: true },
  ];
  function ecDefaults() {
    const d = (PS.meta.settings || {}).ec_defaults || {};
    const out = {};
    for (const f of PS.EC_FIELDS) if (d[f.key]) out[f.key] = { value: d[f.key].value, unit: d[f.key].unit || f.unit || '', source: 'default' };
    return out;
  }
  PS.editEcSession = function (sampleId, session) {
    const params = clone((session && session.params) || ecDefaults());
    const nameIn = h('input', { type: 'text', value: (session && session.name) || '', placeholder: '예: 전극 1 (11/23)' });
    const notes = h('textarea', { class: 'prose', rows: 2 }, (session && session.notes) || '');
    const rows = PS.EC_FIELDS.map((f) => {
      const cur = params[f.key] || {};
      const badge = h('span', {}, PS.srcBadge(cur.source));
      const i = h('input', { type: 'text', value: cur.value ?? '' });
      i.oninput = () => { params[f.key] = { value: f.num && C.isNum(C.num(i.value)) ? C.num(i.value) : i.value, unit: f.unit || '', source: 'user' }; badge.innerHTML = ''; badge.appendChild(PS.srcBadge('user')); };
      return [h('label', {}, f.label, f.unit ? ` (${f.unit})` : '', f.help ? help(f.help) : null), h('div', { class: 'row' }, i, badge, h('span', { class: 'small muted' }, f.live ? '세션 따라 갱신' : '측정 당시로 고정'))];
    });
    const body = h('div', {}, h('div', { class: 'form' }, h('label', {}, '세션/전극 이름'), nameIn, ...rows.flat(), h('label', {}, '메모'), notes),
      h('p', { class: 'note' }, '“측정 당시로 고정” 항목은 측정을 저장할 때 그 측정에 복사되어, 나중에 여기서 값을 바꿔도 과거 측정 조건은 바뀌지 않습니다. “세션 따라 갱신” 항목(RDE 번호, 이름, 메모)은 과거 측정에도 반영됩니다.'));
    return PS.modal({ title: session ? '전극/세션 수정' : '새 전극/세션', body, onSave: async () => {
      const b = { sample_id: sampleId, name: nameIn.value, params, notes: notes.value };
      if (session) { await PS.api.put('/ec_sessions/' + session.id, b); return session.id; }
      return (await PS.api.post('/ec_sessions', b)).id;
    } });
  };
  function sessionTable(meas, session) {
    const snap = (meas && meas.conditions && meas.conditions.session_snapshot) || null;
    const tbl = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '항목'), h('th', {}, '이 측정에 고정된 값'), h('th', {}, '현재 세션 값'), h('th', {}, '구분')));
    for (const f of PS.EC_FIELDS) {
      const now = session && session.params && session.params[f.key];
      const fixed = snap && snap[f.key];
      const show = (e) => (e ? h('span', {}, `${e.value ?? ''} ${e.unit || ''}`, PS.srcBadge(e.source)) : h('span', { class: 'muted' }, '—'));
      const differ = !f.live && fixed && now && String(fixed.value) !== String(now.value);
      tbl.appendChild(h('tr', { class: differ ? 'diff' : '' }, h('td', {}, f.label), h('td', {}, f.live ? h('span', { class: 'muted' }, '(세션 값 사용)') : show(fixed)), h('td', {}, show(now)),
        h('td', {}, PS.srcBadge(f.live ? 'live' : 'snapshot'), differ ? h('span', { class: 'small flag' }, ' 세션 값이 측정 후 바뀜') : null)));
    }
    return tbl;
  }
  function snapshotOf(session) {
    const out = {};
    for (const f of PS.EC_FIELDS) if (!f.live && session && session.params && session.params[f.key]) out[f.key] = clone(session.params[f.key]);
    out._session_updated_at = session ? session.updated_at : null;
    return out;
  }

  function ecSessionPicker(ctx, onChange) {
    const box = h('div');
    const sessions = ctx.sample.ec_sessions || [];
    async function render() {
      box.innerHTML = '';
      const sel = PS.select([['', '(세션 없음)']].concat(sessions.map((s) => [s.id, s.name || `세션 #${s.id}`])), ctx.rec.ec_session_id || '');
      sel.onchange = () => {
        ctx.rec.ec_session_id = sel.value ? +sel.value : null;
        const s = sessions.find((x) => x.id === ctx.rec.ec_session_id);
        ctx.rec.conditions.session_snapshot = s ? snapshotOf(s) : undefined;
        ctx.markDirty(); render(); onChange && onChange();
      };
      const s = sessions.find((x) => x.id === ctx.rec.ec_session_id);
      box.append(h('div', { class: 'row' }, h('label', {}, '전극/세션'), sel,
        h('button', { class: 'small', onclick: async () => {
          const id = await PS.editEcSession(ctx.sample.id, null);
          if (!id) return;
          const fresh = await PS.api.get('/samples/' + ctx.sample.id);
          sessions.length = 0; sessions.push(...fresh.ec_sessions);
          ctx.rec.ec_session_id = id; ctx.rec.conditions.session_snapshot = snapshotOf(sessions.find((x) => x.id === id)); ctx.markDirty(); render(); onChange && onChange();
        } }, '+ 새 세션'),
        s ? h('button', { class: 'small', onclick: async () => {
          const ok = await PS.editEcSession(ctx.sample.id, s);
          if (!ok) return;
          const fresh = await PS.api.get('/samples/' + ctx.sample.id);
          sessions.length = 0; sessions.push(...fresh.ec_sessions); render();
        } }, '세션 정보 수정') : null,
        s && ctx.rec.conditions.session_snapshot ? h('button', { class: 'small', title: '현재 세션의 고정 항목 값으로 이 측정의 조건을 다시 고정합니다', onclick: () => { ctx.rec.conditions.session_snapshot = snapshotOf(s); ctx.markDirty(); render(); } }, '현재 세션 값으로 다시 고정') : null));
      if (s) box.appendChild(sessionTable(ctx.rec, s));
    }
    render();
    return box;
  }

  function ecOrderList(ctx) {
    const list = (ctx.sample.measurements || []).filter((m) => m.analysis_code === 'EC' || m.analysis_code === 'ECSA')
      .sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9) || String(a.measured_on).localeCompare(String(b.measured_on)) || a.id - b.id);
    if (!list.length) return h('div', { class: 'muted small' }, '이 샘플의 전기화학 측정이 아직 없습니다.');
    return h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '순서'), h('th', {}, '기법'), h('th', {}, '제목'), h('th', {}, '측정일'), h('th', {}, '메모')),
      list.map((m) => h('tr', { style: ctx.rec.id === m.id ? { background: '#eef5ff' } : null }, h('td', {}, m.seq ?? '—'), h('td', {}, (m.conditions && m.conditions.technique && m.conditions.technique.value) || m.analysis_code),
        h('td', {}, h('a', { href: '#/m/' + m.id }, m.title || `#${m.id}`)), h('td', {}, m.measured_on || '—'), h('td', { class: 'muted' }, (m.notes || '').slice(0, 60)))));
  }

  const CUR_FACTOR = { A: 1000, mA: 1, 'µA': 0.001 };
  const POT_FACTOR = { V: 1, mV: 0.001 };
  function ecArrays(ds) {
    const mt = ds.meta || {};
    const E = ds.data[mt.e_col ?? 0].map((v) => v * (POT_FACTOR[mt.potential_unit] || 1));
    const I = mt.i_col !== undefined && mt.i_col >= 0 ? ds.data[mt.i_col].map((v) => v * (CUR_FACTOR[mt.current_unit] || 1)) : null;
    const T = mt.t_col !== undefined && mt.t_col >= 0 ? ds.data[mt.t_col] : null;
    const cyc = mt.cycle_col !== undefined && mt.cycle_col >= 0 ? ds.data[mt.cycle_col] : null;
    return { E, I, T, cyc };
  }
  PS.ecArrays = ecArrays;

  function ecDataImporter(ctx, onDs, label) {
    const mapBox = h('div');
    const imp = PS.importWidget({ ctx, label: label || '원시 데이터 (전위, 전류, [시간], [cycle])', onText: (text, meta) => {
      const t = C.parseTable(text);
      if (t.rows.length < 5) throw new Error('데이터 행이 너무 적습니다');
      const hl = t.headers.map((x) => String(x).toLowerCase());
      const gE = C.guessCol(hl, [/ewe|potential|^e\b|we\(|volt|^e /, /\bv\b/]);
      const gI = C.guessCol(hl, [/<i>|current|^i\b|i\/|\bma\b|\ba\b/], [gE]);
      const gT = C.guessCol(hl, [/time|^t\b|\bs\b/], [gE, gI]);
      const gC = C.guessCol(hl, [/cycle|scan|segment/], [gE, gI, gT]);
      const sE = colSelect(t.headers, gE >= 0 ? gE : 0), sI = colSelect(t.headers, gI >= 0 ? gI : (t.headers.length > 1 ? 1 : -1), true);
      const sT = colSelect(t.headers, gT, true), sC = colSelect(t.headers, gC, true);
      const guessI = /\bma\b|ma\)|\/ma/.test(hl[gI] || '') ? 'mA' : /µa|ua/.test(hl[gI] || '') ? 'µA' : /\ba\b|\(a\)|\/a/.test(hl[gI] || '') ? 'A' : 'mA';
      const uI = PS.select(['A', 'mA', 'µA'], guessI), uE = PS.select(['V', 'mV'], /mv/.test(hl[gE] || '') ? 'mV' : 'V');
      mapBox.innerHTML = '';
      mapBox.append(h('div', { class: 'badge-info small' }, `${t.rows.length}행. 열과 단위를 확인하세요. 원본 값은 그대로 저장되고 단위 환산은 표시·계산에만 적용됩니다.`),
        h('div', { class: 'row' }, h('label', {}, '전위'), sE, uE, h('label', {}, '전류'), sI, uI, h('label', {}, '시간'), sT, h('label', {}, 'cycle'), sC,
          h('button', { class: 'primary small', onclick: () => {
            const cols = t.headers.map((_, i) => C.column(t, i));
            const ds = { name: meta.file_name || '전기화학 데이터', columns: t.headers, data: cols,
              meta: { e_col: +sE.value, i_col: +sI.value, t_col: +sT.value, cycle_col: +sC.value, potential_unit: uE.value, current_unit: uI.value, file_name: meta.file_name || null } };
            ctx.setSource({ method: meta.method, file_name: meta.file_name || null });
            ctx.applyFileDates(meta); mapBox.innerHTML = ''; onDs(ds);
          } }, '열 적용')));
    } });
    return h('div', {}, imp, mapBox);
  }

  const CYCLE_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22'];

  PS.tools.ec = function (ctx) {
    const { rec } = ctx;
    if (!rec.conditions.technique) rec.conditions.technique = { label: '기법', value: 'CV', unit: '', source: 'user' };
    let ds = rec.datasets[0] || null;
    const tech = PS.select(['CV', 'LSV', 'OCV', 'EIS', 'CA/CP', '기타'], rec.conditions.technique.value);
    tech.onchange = () => { rec.conditions.technique.value = tech.value; ctx.markDirty(); draw(); };
    const rate = numInput(rec.conditions.scan_rate ? rec.conditions.scan_rate.value : null, (v) => {
      if (v === null) delete rec.conditions.scan_rate; else rec.conditions.scan_rate = { label: 'scan rate', value: v, unit: 'mV/s', source: 'user' };
      ctx.markDirty();
    }, { class: 'sm', placeholder: 'mV/s' });
    const seq = numInput(rec.seq, (v) => { rec.seq = v === null ? null : Math.round(v); ctx.markDirty(); }, { class: 'sm' });
    const chartBox = h('div'), cycBox = h('div');
    let shown = null;
    function draw() {
      chartBox.innerHTML = ''; cycBox.innerHTML = '';
      if (!ds) { chartBox.appendChild(h('div', { class: 'muted small' }, '원시 데이터를 불러오면 그래프를 그립니다.')); return; }
      const { E, I, T, cyc } = ecArrays(ds);
      const tq = tech.value;
      if (tq === 'OCV' || !I) {
        PSChart.render(chartBox, { series: [{ name: 'E', color: ctx.sample.color, x: T || E.map((_, i) => i), y: E }], xLabel: T ? '시간 (s)' : '점 번호', yLabel: 'E (V)' });
        return;
      }
      if (tq === 'CV') {
        const sp = C.splitCycles(E, cyc);
        ds.meta.cycles = sp.cycles; ds.meta.split_method = sp.method;
        if (!shown) shown = new Set(sp.cycles.map((c) => c.no));
        const tbl = h('table', { class: 'tbl small', style: { maxWidth: '640px' } }, h('tr', {}, h('th', {}, '표시'), h('th', {}, '사이클'), h('th', { class: 'num' }, '점 수'), h('th', {}, '데이터 구간(행)'), h('th', {}, 'E 범위 (V)'), h('th')));
        for (const c of sp.cycles) {
          const chk = h('input', { type: 'checkbox', checked: shown.has(c.no) });
          chk.onchange = () => { if (chk.checked) shown.add(c.no); else shown.delete(c.no); plot(); };
          const seg = E.slice(c.start, c.end + 1);
          tbl.appendChild(h('tr', {}, h('td', {}, chk), h('td', {}, `#${c.no}`, c.label && c.label !== String(c.no) ? ` (원본 ${c.label})` : ''), h('td', { class: 'num' }, c.end - c.start + 1), h('td', {}, `${c.start + 1}–${c.end + 1}`),
            h('td', {}, `${fmt(C.minOf(seg), 3)} ~ ${fmt(C.maxOf(seg), 3)}`), h('td', { class: 'small flag' }, c.partial ? '불완전 사이클' : '')));
        }
        cycBox.append(h('div', { class: 'small muted' }, `사이클 분리: ${sp.method}. 결과가 이상하면 cycle 열을 지정하거나 데이터를 확인하세요.`), tbl);
        const plot = () => {
          const series = sp.cycles.filter((c) => shown.has(c.no)).map((c) => ({ name: `사이클 ${c.no}`, color: CYCLE_COLORS[(c.no - 1) % CYCLE_COLORS.length], x: E.slice(c.start, c.end + 1), y: I.slice(c.start, c.end + 1) }));
          PSChart.render(chartBox, { series, xLabel: 'E (V)', yLabel: 'I (mA)', note: ds.meta.current_unit !== 'mA' ? `전류 ${ds.meta.current_unit} → mA 환산 표시` : '' });
        };
        plot();
        return;
      }
      PSChart.render(chartBox, { series: [{ name: ds.name, color: ctx.sample.color, x: tq === 'CA/CP' && T ? T : E, y: I }], xLabel: tq === 'CA/CP' && T ? '시간 (s)' : 'E (V)', yLabel: 'I (mA)' });
    }
    return {
      el: h('div', {},
        h('h3', {}, '이 샘플의 전기화학 측정 순서'), ecOrderList(ctx),
        h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', {}, '기법'), tech, h('label', {}, 'scan rate'), rate, h('span', { class: 'small' }, 'mV/s'), h('label', {}, '측정 순서', help('같은 전극/세션에서 몇 번째 측정인지. 목록과 비교에서 이 순서로 정렬됩니다.')), seq),
        h('h3', {}, '전극/세션 조건'), ecSessionPicker(ctx),
        h('h3', {}, '원시 데이터'), ecDataImporter(ctx, (d) => { ds = d; shown = null; ctx.markDirty(); draw(); }),
        cycBox, chartBox),
      afterMount: draw,
      collect() {
        if (rec.ec_session_id && !rec.conditions.session_snapshot) {
          const s = (ctx.sample.ec_sessions || []).find((x) => x.id === rec.ec_session_id);
          if (s) rec.conditions.session_snapshot = snapshotOf(s);
        }
        return { values: rec.values, computed: rec.computed, datasets: ds ? [ds] : [] };
      },
    };
  };

  // ------------------------------------------------------------ ECSA / Cdl
  PS.tools.ecsa = function (ctx) {
    const { rec } = ctx;
    const v = rec.values;
    v.entries = v.entries || []; // [{rate_mVs, cycle_no, from_measurement}]
    const dsets = rec.datasets.slice();
    v.e_select = v.e_select ?? null;
    v.cs = v.cs || { value: 0.035, unit: 'mF/cm²', source: 'default', basis: '가정: 산성 전해질 일반값 0.035 mF/cm² (McCrory et al., J. Am. Chem. Soc. 2013)' };
    const listBox = h('div'), chartCv = h('div'), chartFit = h('div'), resBox = h('div');
    const eIn = numInput(v.e_select, (x) => { v.e_select = x; ctx.markDirty(); compute(); }, { class: 'sm', placeholder: 'V' });
    const csIn = numInput(v.cs.value, (x) => { v.cs.value = x; v.cs.source = 'user'; ctx.markDirty(); compute(); }, { class: 'sm' });
    const csBasis = h('input', { type: 'text', value: v.cs.basis, style: { width: '100%' } });
    csBasis.oninput = () => { v.cs.basis = csBasis.value; v.cs.source = 'user'; ctx.markDirty(); };
    const preset = (val, basis) => h('button', { class: 'small', onclick: () => { v.cs = { value: val, unit: 'mF/cm²', source: 'user', basis }; csIn.value = val; csBasis.value = basis; ctx.markDirty(); compute(); } }, `${val} mF/cm²`);
    const loadDefault = () => {
      const snap = rec.conditions.session_snapshot && rec.conditions.session_snapshot.loading_mg;
      if (snap) return { value: C.num(snap.value), source: snap.source, basis: '전극/세션 조건' };
      const d = ((PS.meta.settings || {}).ec_defaults || {}).loading_mg;
      return { value: d ? d.value : 0.222, source: 'default', basis: '앱 기본값' };
    };
    v.loading = v.loading || loadDefault();
    const loadIn = numInput(v.loading.value, (x) => { v.loading = { value: x, source: 'user', basis: '사용자 입력' }; ctx.markDirty(); compute(); }, { class: 'sm' });

    function entryArrays(k) {
      const ds = dsets[k];
      const { E, I, cyc } = ecArrays(ds);
      const sp = C.splitCycles(E, cyc);
      return { E, I, sp };
    }
    function defaultCycle(sp) {
      const full = sp.cycles.filter((c) => !c.partial);
      return (full.length ? full[full.length - 1] : sp.cycles[sp.cycles.length - 1]).no;
    }
    function addDataset(ds, rateMv, fromMeas) {
      dsets.push(ds);
      const { sp } = entryArrays(dsets.length - 1);
      v.entries.push({ rate_mVs: rateMv, cycle_no: defaultCycle(sp), from_measurement: fromMeas || null });
      if (v.e_select === null) { const { E } = entryArrays(0); v.e_select = +(((C.minOf(E) + C.maxOf(E)) / 2).toFixed(3)); eIn.value = v.e_select; }
      ctx.markDirty(); renderList(); compute();
    }
    const pasteRate = numInput(null, () => {}, { class: 'sm', placeholder: 'mV/s' });
    const importer = ecDataImporter(ctx, (ds) => {
      const r = N(pasteRate.value);
      if (r === null) { PS.toast('scan rate (mV/s)를 먼저 입력하세요', 'bad'); return; }
      ds.name = `CV ${r} mV/s`;
      addDataset(ds, r, null);
    }, 'scan rate 별 CV 데이터 붙여넣기');
    const fromSel = PS.select([['', '기존 CV 기록에서 가져오기…']].concat((ctx.sample.measurements || []).filter((m) => m.analysis_code === 'EC' && m.conditions && m.conditions.technique && m.conditions.technique.value === 'CV')
      .map((m) => [m.id, `#${m.id} ${m.title || ''} ${m.conditions.scan_rate ? m.conditions.scan_rate.value + ' mV/s' : '(scan rate 없음)'}`])), '');
    fromSel.onchange = async () => {
      if (!fromSel.value) return;
      const m = await PS.api.get('/measurements/' + fromSel.value);
      fromSel.value = '';
      if (!m.datasets.length) { PS.toast('그 기록에는 데이터가 없습니다', 'bad'); return; }
      let r = m.conditions.scan_rate ? m.conditions.scan_rate.value : N(prompt('scan rate (mV/s)를 입력하세요'));
      if (r === null || r === undefined) return;
      const ds = m.datasets[0];
      addDataset({ name: `CV ${r} mV/s (기록 #${m.id})`, columns: ds.columns, data: ds.data, meta: Object.assign({}, ds.meta, { from_measurement: m.id }) }, r, m.id);
      if (!rec.ec_session_id && m.ec_session_id) { rec.ec_session_id = m.ec_session_id; rec.conditions.session_snapshot = m.conditions.session_snapshot; }
    };

    function renderList() {
      listBox.innerHTML = '';
      if (!v.entries.length) { listBox.appendChild(h('div', { class: 'muted small' }, 'scan rate 가 다른 CV 를 2개 이상 추가하세요.')); return; }
      const tbl = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, 'scan rate (mV/s)'), h('th', {}, '사용 사이클'), h('th', {}, '데이터 구간(행)'), h('th', {}, '출처'), h('th')));
      v.entries.forEach((en, k) => {
        const { sp } = entryArrays(k);
        const cs = PS.select(sp.cycles.map((c) => [c.no, `#${c.no}${c.partial ? ' (불완전)' : ''}`]), en.cycle_no);
        cs.onchange = () => { en.cycle_no = +cs.value; ctx.markDirty(); compute(); };
        const c = sp.cycles.find((x) => x.no === en.cycle_no) || sp.cycles[0];
        tbl.appendChild(h('tr', {}, h('td', {}, numInput(en.rate_mVs, (x) => { en.rate_mVs = x; ctx.markDirty(); compute(); }, { class: 'sm' })), h('td', {}, cs, h('span', { class: 'muted' }, ` / ${sp.cycles.length}개 (${sp.method})`)),
          h('td', {}, c ? `${c.start + 1}–${c.end + 1}` : '—'), h('td', {}, en.from_measurement ? h('a', { href: '#/m/' + en.from_measurement }, `기록 #${en.from_measurement}`) : '붙여넣기'),
          h('td', {}, h('button', { class: 'small link', onclick: () => { v.entries.splice(k, 1); dsets.splice(k, 1); ctx.markDirty(); renderList(); compute(); } }, '삭제'))));
      });
      listBox.appendChild(tbl);
    }
    let last = null;
    function compute() {
      chartCv.innerHTML = ''; chartFit.innerHTML = ''; resBox.innerHTML = '';
      if (!v.entries.length) return;
      const E0 = v.e_select;
      const pts = [], series = [], markers = [];
      v.entries.forEach((en, k) => {
        const { E, I, sp } = entryArrays(k);
        const c = sp.cycles.find((x) => x.no === en.cycle_no) || sp.cycles[0];
        const col = CYCLE_COLORS[k % CYCLE_COLORS.length];
        series.push({ name: `${en.rate_mVs} mV/s (사이클 ${c.no})`, color: col, x: E.slice(c.start, c.end + 1), y: I.slice(c.start, c.end + 1) });
        const r = C.isNum(E0) ? C.currentsAt(E, I, c.start, c.end, E0) : { ia: null, ic: null };
        pts.push({ rate: C.isNum(en.rate_mVs) ? en.rate_mVs / 1000 : NaN, rate_mVs: en.rate_mVs, ia: r.ia, ic: r.ic, cycle_no: c.no, rows: [c.start + 1, c.end + 1] });
        if (C.isNum(r.ia)) markers.push({ x: E0, y: r.ia, color: col, label: `${en.rate_mVs} mV/s 산화 전류 ${fmt(r.ia, 4)} mA` });
        if (C.isNum(r.ic)) markers.push({ x: E0, y: r.ic, color: col, shape: 'square', label: `${en.rate_mVs} mV/s 환원 전류 ${fmt(r.ic, 4)} mA` });
      });
      PSChart.render(chartCv, { series, markers, vlines: C.isNum(E0) ? [{ x: E0, label: `선택 전위 ${E0} V` }] : [], xLabel: 'E (V)', yLabel: 'I (mA)', note: '● 산화(정방향)  ■ 환원(역방향)' });
      const loading = v.loading && C.num(v.loading.value);
      const res = C.computeEcsa(pts, C.num(v.cs.value), loading);
      last = { res, pts };
      const tbl = h('table', { class: 'tbl small', style: { maxWidth: '760px' } }, h('tr', {}, h('th', { class: 'num' }, 'scan rate (mV/s)'), h('th', {}, '사이클'), h('th', { class: 'num' }, 'i_a (mA)'), h('th', { class: 'num' }, 'i_c (mA)'), h('th', { class: 'num' }, '(i_a − i_c)/2 (mA)')),
        pts.map((p) => h('tr', {}, h('td', { class: 'num' }, fmt(p.rate_mVs, 1)), h('td', {}, `#${p.cycle_no} (행 ${p.rows[0]}–${p.rows[1]})`), h('td', { class: 'num' }, fmt(p.ia, 4)), h('td', { class: 'num' }, fmt(p.ic, 4)),
          h('td', { class: 'num' }, C.isNum(p.ia) && C.isNum(p.ic) ? fmt((p.ia - p.ic) / 2, 4) : '선택 전위가 사이클 범위 밖'))));
      resBox.appendChild(tbl);
      if (res.error) { resBox.appendChild(h('div', { class: 'badge-warn small' }, res.error)); return; }
      const xs = res.points.map((p) => p.rate);
      const xr = [0, C.maxOf(xs)];
      PSChart.render(chartFit, { series: [
        { name: '(i_a − i_c)/2', color: '#333', x: xs, y: res.points.map((p) => p.half), mode: 'points' },
        { name: `직선 맞춤: Cdl = ${fmt(res.cdl_mF, 4)} mF (R² ${res.r2.toFixed(4)})`, color: '#333', dash: '5 4', x: xr, y: xr.map((x) => res.cdl_mF * x + res.intercept) },
        { name: 'i_a', color: '#c0392b', x: xs, y: res.points.map((p) => p.ia), mode: 'points', r: 2.5 },
        { name: '|i_c|', color: '#2b6cb0', x: xs, y: res.points.map((p) => -p.ic), mode: 'points', r: 2.5 },
      ], xLabel: 'scan rate (V/s)', yLabel: '전류 (mA)', height: 280 });
      resBox.appendChild(h('div', { class: 'badge-info', style: { marginTop: '8px' } },
        h('div', {}, h('b', {}, `Cdl = ${fmt(res.cdl_mF, 4)} mF`), ` (R² ${res.r2.toFixed(4)}, n=${res.n}; 산화 기울기 ${fmt(res.anodic_slope, 4)}, 환원 기울기 ${fmt(res.cathodic_slope, 4)} mF)`),
        C.isNum(res.ecsa_cm2) ? h('div', {}, h('b', {}, `ECSA(추정) = ${fmt(res.ecsa_cm2)} cm²`), C.isNum(res.ecsa_per_mg) ? `, ECSA/질량(추정) = ${fmt(res.ecsa_per_mg)} cm²/mg (로딩 ${loading} mg)` : '') : null,
        h('div', { class: 'small' }, C.ECSA_FORMULA),
        h('div', { class: 'small' }, `Cs = ${v.cs.value} mF/cm² — ${v.cs.basis}`, PS.srcBadge(v.cs.source))));
      if (res.n < 3) resBox.appendChild(h('div', { class: 'badge-warn small' }, 'scan rate 가 2개뿐이면 직선성(R²)을 검증할 수 없습니다. 3개 이상을 권장합니다.'));
    }
    return {
      el: h('div', {},
        h('div', { class: 'badge-warn small' }, 'Cdl 과 ECSA 는 전기화학적 정전용량에서 얻은 값입니다. ECSA 는 가정한 비정전용량(Cs)에 의존하는 추정값이며, BET 비표면적의 직접 측정값이 아닙니다.'),
        h('h3', {}, '전극/세션'), ecSessionPicker(ctx, () => { v.loading = loadDefault(); loadIn.value = v.loading.value; compute(); }),
        h('h3', {}, 'scan rate 별 CV'), h('div', { class: 'row' }, fromSel), h('div', { class: 'row', style: { marginTop: '6px' } }, h('label', {}, '붙여 넣을 데이터의 scan rate'), pasteRate, h('span', { class: 'small' }, 'mV/s')), importer, listBox,
        h('h3', {}, '계산 조건'),
        h('div', { class: 'form' },
          h('label', {}, '선택 전위', help('패러데이 반응이 없는 이중층 영역의 전위를 고르세요. 각 CV 의 정방향(산화)·역방향(환원) 곡선에서 이 전위의 전류를 읽습니다.')), h('div', { class: 'row' }, eIn, 'V'),
          h('label', {}, 'Cs (비정전용량)', help('ECSA 환산에 쓰는 가정값입니다. 값과 근거(문헌·자체 보정)를 함께 기록하세요.')),
          h('div', {}, h('div', { class: 'row' }, csIn, 'mF/cm²', preset(0.035, '가정: 산성 전해질 일반값 (McCrory et al., J. Am. Chem. Soc. 2013)'), preset(0.040, '가정: 알칼리 전해질 일반값 (McCrory et al., J. Am. Chem. Soc. 2013)')), csBasis),
          h('label', {}, '총 분말 로딩'), h('div', { class: 'row' }, loadIn, 'mg', h('span', { class: 'small muted' }, v.loading.basis || ''))),
        h('div', { class: 'grid2', style: { marginTop: '8px' } }, chartCv, chartFit), resBox),
      afterMount() { renderList(); compute(); },
      collect() {
        const computed = { metrics: {}, details: {} };
        if (last && last.res && !last.res.error) {
          const r = last.res;
          const inputs = { E_select_V: v.e_select, points: last.pts, Cs: v.cs, loading_mg: v.loading };
          computed.metrics.cdl = { value: r.cdl_mF, unit: 'mF', formula: C.ECSA_FORMULA, inputs: { r2: r.r2, n: r.n, E_select_V: v.e_select } };
          if (C.isNum(r.ecsa_cm2)) computed.metrics.ecsa = { value: r.ecsa_cm2, unit: 'cm²', formula: 'ECSA = Cdl / Cs (추정, Cs 가정값)', inputs: { Cs: v.cs } };
          if (C.isNum(r.ecsa_per_mg)) computed.metrics.ecsa_per_mass = { value: r.ecsa_per_mg, unit: 'cm²/mg', formula: 'ECSA / 로딩', inputs: { loading_mg: v.loading } };
          computed.details = { fit: { slope_mF: r.cdl_mF, intercept_mA: r.intercept, r2: r.r2, anodic_slope: r.anodic_slope, cathodic_slope: r.cathodic_slope }, inputs, note: '추정값: BET 비표면적의 직접 측정값이 아님' };
        }
        dsets.forEach((d, k) => { d.meta = Object.assign({}, d.meta, { rate_mVs: v.entries[k] && v.entries[k].rate_mVs, cycle_no: v.entries[k] && v.entries[k].cycle_no }); });
        return { values: v, computed, datasets: dsets };
      },
    };
  };
})(window.PS);
