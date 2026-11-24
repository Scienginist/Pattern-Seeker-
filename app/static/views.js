/* 화면: 샘플 목록·상세, 비교, 패턴 탐색, 시리즈, 설정 */
(function (PS) {
  'use strict';
  const { h, help, fmt } = PS;
  const C = window.PSCalc;

  async function loadSamples() { return (await PS.api.get('/samples')).samples; }
  async function loadSeries() { return (await PS.api.get('/series')).series; }
  const stOf = (s, code) => ((s.statuses || {})[code] || {}).status || PS.meta.default_status;

  // ------------------------------------------------------------ 상태 변경 메뉴
  function statusMenu(anchor, sample, code, onDone) {
    document.querySelectorAll('.st-menu').forEach((m) => m.remove());
    const r = anchor.getBoundingClientRect();
    const menu = h('div', { class: 'st-menu panel', style: { position: 'fixed', left: Math.min(r.left, innerWidth - 230) + 'px', top: r.bottom + 4 + 'px', zIndex: 60, padding: '8px', width: '220px' } },
      h('div', { class: 'small muted', style: { marginBottom: '4px' } }, `${sample.name} · ${PS.typeMap[code].name}`),
      PS.meta.statuses.map((st) => h('div', { style: { padding: '3px 0' } }, PS.statusChip(st, { onclick: async () => {
        menu.remove();
        const cnt = (sample.counts || {})[code] || 0;
        if (cnt && st !== '자료 있음' && !(await PS.confirm(`저장된 결과가 ${cnt}개 있는데 상태를 “${st}”(으)로 바꿀까요?`, { detail: '결과 기록은 지워지지 않습니다. 상태 표시만 바뀝니다.' }))) return;
        try { await PS.api.put(`/samples/${sample.id}/status/${code}`, { status: st }); PS.toast('상태 변경: ' + st, 'ok'); onDone && onDone(); }
        catch (e) { PS.toast('상태 변경 실패: ' + e.message, 'bad'); }
      } }))),
      h('div', { class: 'note' }, '“계획 없음”은 하지 않기로 한 분석, “미업로드”는 아직 등록 안 된 상태(기본값)입니다.'));
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); } }), 0);
  }

  // ------------------------------------------------------------ 샘플 등록/수정
  async function sampleForm(sample, allSamples, series) {
    const isNew = !sample;
    sample = sample || {};
    const name = h('input', { type: 'text', value: sample.name || '', placeholder: '최종 분말 이름 (예: IrO2-A1)' });
    const date = h('input', { type: 'date', value: sample.synthesized_on || '' });
    const color = h('input', { type: 'color', value: sample.color || '#1f77b4' });
    const desc = h('input', { type: 'text', value: sample.description || '', style: { width: '100%' } });
    const notes = h('textarea', { class: 'prose', rows: 3 }, sample.notes || '');
    const body = h('div', {}, h('div', { class: 'form' },
      h('label', {}, '샘플명 *', help('샘플명은 최종 분말에 붙입니다. 중간 과정은 별도 샘플이 아니라 “합성 이력”의 단계와 메모로 기록하세요.')), name,
      h('label', {}, '합성(완료)일'), date,
      !isNew ? h('label', {}, '그래프 색') : null, !isNew ? color : null,
      h('label', {}, '한 줄 설명'), desc,
      h('label', {}, '메모'), notes));
    let parentRows = [], seriesChks = [], copyFrom = null;
    if (isNew) {
      const pbox = h('div');
      const addParent = () => {
        const s = PS.select([['', '상위 샘플 선택…']].concat(allSamples.map((x) => [x.id, x.name])), '');
        const rel = PS.select(['파생', '분기', '결합', '재처리', '기타'], '파생');
        const bp = h('input', { type: 'text', placeholder: '갈라진 시점 (예: 프리커서, 열처리 후)', style: { width: '200px' } });
        const row = { s, rel, bp };
        parentRows.push(row);
        pbox.appendChild(h('div', { class: 'row', style: { marginBottom: '4px' } }, s, rel, bp));
      };
      addParent();
      seriesChks = series.map((se) => ({ id: se.id, chk: h('input', { type: 'checkbox' }), name: se.name }));
      copyFrom = PS.select([['', '복사 안 함']].concat(allSamples.map((x) => [x.id, x.name])), '');
      body.append(h('h3', {}, '상위 샘플 (파생·분기·결합) ', help('한 샘플에 상위 샘플을 여러 개 연결할 수 있습니다. 예: 한 배치를 추가 열처리했다면 “재처리”, 두 분말을 섞었다면 각 분말을 “결합”으로 연결.')),
        pbox, h('button', { class: 'small', onclick: addParent }, '+ 상위 샘플 추가'),
        series.length ? h('h3', {}, '시리즈 ', help('시리즈는 연구 묶음(분류)입니다. 파생 관계와는 별개로 관리됩니다.')) : null,
        series.length ? h('div', { class: 'row' }, seriesChks.map((x) => h('label', {}, x.chk, ' ', x.name))) : null,
        h('h3', {}, '합성 단계 복사'), h('div', { class: 'row' }, copyFrom, h('span', { class: 'note' }, '다른 샘플의 합성 단계를 복사해 시작합니다 (복사 후 수정 가능).')));
    }
    return PS.modal({ title: isNew ? '새 샘플' : '샘플 정보 수정', body, wide: isNew, onSave: async () => {
      if (!name.value.trim()) throw new Error('샘플명을 입력하세요');
      const b = { name: name.value.trim(), synthesized_on: date.value || null, description: desc.value, notes: notes.value };
      if (!isNew) { b.color = color.value; await PS.api.put('/samples/' + sample.id, b); PS.toast('저장되었습니다', 'ok'); return sample.id; }
      b.parents = parentRows.filter((r) => r.s.value).map((r) => ({ id: +r.s.value, relation: r.rel.value, branch_point: r.bp.value }));
      b.series_ids = seriesChks.filter((x) => x.chk.checked).map((x) => x.id);
      if (copyFrom.value) b.copy_steps_from = +copyFrom.value;
      const r = await PS.api.post('/samples', b);
      PS.toast('샘플을 등록했습니다', 'ok');
      return r.id;
    } });
  }

  // ------------------------------------------------------------ 샘플 목록
  PS.route('/samples', async (p, view) => {
    PS.crumb([{ label: '샘플 목록' }]);
    const [samples, series] = await Promise.all([loadSamples(), loadSeries()]);
    const types = PS.activeTypes();
    const st = PS.store.get('list', { q: '', sort: 'new', series: '' });
    const q = h('input', { type: 'search', placeholder: '검색: 샘플명, 메모, 시리즈, 상위 샘플', value: st.q, style: { width: '320px' } });
    const sort = PS.select([['new', '최신 등록순'], ['old', '오래된 등록순'], ['name', '이름순'], ['date', '합성일 최신순']], st.sort);
    const ser = PS.select([['', '모든 시리즈']].concat(series.map((s) => [s.id, s.name])), st.series);
    const tableBox = h('div');
    function render() {
      PS.store.set('list', { q: q.value, sort: sort.value, series: ser.value });
      const term = q.value.trim().toLowerCase();
      let list = samples.filter((s) => {
        if (ser.value && !s.series.some((x) => String(x.id) === ser.value)) return false;
        if (!term) return true;
        const hay = [s.name, s.notes, s.description, ...s.series.map((x) => x.name), ...s.parents.map((x) => x.name)].join(' ').toLowerCase();
        return hay.includes(term);
      });
      const cmp = { new: (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id, old: (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
        name: (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }), date: (a, b) => String(b.synthesized_on || '').localeCompare(String(a.synthesized_on || '')) }[sort.value];
      list = list.slice().sort(cmp);
      tableBox.innerHTML = '';
      if (!samples.length) { tableBox.appendChild(h('div', { class: 'empty' }, '아직 샘플이 없습니다. “+ 새 샘플”로 시작하세요.')); return; }
      const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '샘플'), h('th', {}, '합성일'), h('th', {}, '상위 → 이 샘플'), h('th', {}, '시리즈'),
        types.map((t) => h('th', { style: { textAlign: 'center' }, title: t.description }, t.name.replace(/\s*\(.*\)/, '')))));
      for (const s of list) {
        tbl.appendChild(h('tr', {}, h('td', {}, PS.sampleLink(s), s.description ? h('div', { class: 'small muted' }, s.description) : null), h('td', {}, s.synthesized_on || ''),
          h('td', { class: 'small' }, s.parents.map((x, i) => [i ? ', ' : '', h('a', { href: '#/sample/' + x.id }, x.name), h('span', { class: 'muted' }, `(${x.relation})`)])),
          h('td', { class: 'small' }, s.series.map((x) => h('span', { class: 'chip' }, x.name))),
          types.map((t) => {
            const stv = stOf(s, t.code), n = (s.counts || {})[t.code];
            return h('td', { style: { textAlign: 'center' } }, PS.statusChip(stv, { title: `${t.name}: ${stv}${n ? ` (기록 ${n}개)` : ''} — 클릭해서 상태 변경`, onclick: (e) => statusMenu(e.currentTarget, s, t.code, () => PS.refresh()) }),
              n > 1 ? h('span', { class: 'small muted' }, ` ×${n}`) : null);
          })));
      }
      tableBox.append(h('div', { class: 'small muted', style: { margin: '4px 0' } }, `${list.length} / ${samples.length}개`), h('div', { class: 'tablewrap' }, tbl));
    }
    q.oninput = render; sort.onchange = render; ser.onchange = render;
    view.innerHTML = '';
    view.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, '샘플'), h('a', { href: '#/import/xrf' }, h('button', {}, 'XRF 성적서 일괄 가져오기')), h('button', { class: 'primary', onclick: async () => {
      const id = await sampleForm(null, samples, series);
      if (id) PS.go('#/sample/' + id);
    } }, '+ 새 샘플')),
    h('div', { class: 'row', style: { marginBottom: '8px' } }, q, sort, ser,
      h('span', { class: 'small muted' }, '상태: '), PS.meta.statuses.map((x) => PS.statusChip(x)), help('상태 칸을 클릭하면 바로 바꿀 수 있습니다. 결과를 저장하면 자동으로 “자료 있음”이 됩니다.')),
    tableBox);
    render();
  });

  // ------------------------------------------------------------ 샘플 상세
  const TABS = [['overview', '개요·관계'], ['synthesis', '합성 이력'], ['lineage', '계보 맵'], ['analysis', '분석'], ['notes', '해석·가설'], ['files', '첨부']];
  PS.route('/sample/:id', (p, v) => sampleView(p.id, 'overview', v));
  PS.route('/sample/:id/:tab', (p, v) => (p.tab === 'new' ? null : sampleView(p.id, p.tab, v)));
  PS.route('/sample/:id/new/:code', (p, v) => PS.measurementEditor(v, { sampleId: +p.id, code: p.code }));
  PS.route('/m/:id', (p, v) => PS.measurementEditor(v, { measId: +p.id }));

  async function sampleView(id, tab, view) {
    const s = await PS.api.get('/samples/' + id);
    PS.crumb([{ label: '샘플', href: '#/samples' }, { label: s.name }]);
    const body = h('div');
    view.innerHTML = '';
    view.append(
      s.deleted_at ? h('div', { class: 'badge-warn' }, '이 샘플은 휴지통에 있습니다. ', h('button', { class: 'small', onclick: async () => { await PS.api.post(`/samples/${s.id}/restore`); PS.refresh(); } }, '복원')) : null,
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, PS.sampleDot(s), s.name, s.synthesized_on ? h('span', { class: 'muted small' }, '  합성일 ' + s.synthesized_on) : null),
        h('button', { onclick: async () => { const r = await sampleForm(s); if (r) PS.refresh(); } }, '정보 수정'),
        h('button', { class: 'danger', onclick: async () => {
          if (!(await PS.confirm(`샘플 “${s.name}”을(를) 휴지통으로 옮길까요?`, { danger: true, okLabel: '휴지통으로', detail: '측정 기록·관계는 그대로 남고, 설정·백업 > 휴지통에서 복원할 수 있습니다.' }))) return;
          try { await PS.api.del('/samples/' + s.id); PS.toast('휴지통으로 옮겼습니다'); PS.go('#/samples'); } catch (e) { PS.toast(e.message, 'bad'); }
        } }, '삭제')),
      s.description ? h('p', { class: 'muted', style: { marginTop: 0 } }, s.description) : null,
      h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { href: `#/sample/${s.id}/${k}`, class: k === tab ? 'on' : '' }, l))),
      body);
    const fn = { overview: tabOverview, synthesis: tabSynthesis, lineage: tabLineage, analysis: tabAnalysis, notes: tabNotes, files: tabFiles }[tab] || tabOverview;
    await fn(s, body);
  }

  async function linkModal(s) {
    const all = (await loadSamples()).filter((x) => x.id !== s.id);
    const dir = PS.select([['up', `상위 샘플 → ${s.name}`], ['down', `${s.name} → 하위 샘플`]], 'up');
    const other = PS.select([['', '샘플 선택…']].concat(all.map((x) => [x.id, x.name])), '');
    const rel = PS.select(['파생', '분기', '결합', '재처리', '기타'], '파생');
    const bp = h('input', { type: 'text', placeholder: '예: 프리커서 단계, 450 °C 열처리 후' });
    const note = h('input', { type: 'text', style: { width: '100%' } });
    const body = h('div', { class: 'form' }, h('label', {}, '방향'), dir, h('label', {}, '연결할 샘플'), other, h('label', {}, '관계', help('파생: 일반적인 후속 샘플\n분기: 같은 중간물에서 조건을 달리해 갈라짐\n결합: 여러 분말을 합침\n재처리: 추가 열처리·재세척')), rel,
      h('label', {}, '갈라진 시점'), bp, h('label', {}, '메모'), note);
    return PS.modal({ title: '샘플 관계 추가', body, onSave: async () => {
      if (!other.value) throw new Error('샘플을 고르세요');
      const b = dir.value === 'up' ? { parent_id: +other.value, child_id: s.id } : { parent_id: s.id, child_id: +other.value };
      await PS.api.post('/links', Object.assign(b, { relation: rel.value, branch_point: bp.value, note: note.value }));
    } });
  }

  async function tabOverview(s, box) {
    const series = await loadSeries();
    const linkRow = (l, other, otherName, color) => h('div', { class: 'row', style: { padding: '4px 0', borderBottom: '1px solid #f0f2f5' } },
      h('a', { href: '#/sample/' + other }, h('span', { class: 'dot', style: { background: color } }), otherName), h('span', { class: 'chip' }, l.relation),
      l.branch_point ? h('span', { class: 'small muted' }, '시점: ' + l.branch_point) : null, l.note ? h('span', { class: 'small muted' }, l.note) : null, h('span', { class: 'grow' }),
      h('button', { class: 'small link', onclick: async () => {
        if (!(await PS.confirm('이 관계 연결을 삭제할까요?', { danger: true, detail: '샘플 자체는 지워지지 않습니다.' }))) return;
        await PS.api.del('/links/' + l.id); PS.refresh();
      } }, '연결 삭제'));
    const mine = series.filter((x) => x.sample_ids.includes(s.id));
    const addSer = PS.select([['', '시리즈에 추가…']].concat(series.filter((x) => !x.sample_ids.includes(s.id)).map((x) => [x.id, x.name])), '');
    addSer.onchange = async () => { if (!addSer.value) return; await PS.api.post(`/series/${addSer.value}/members`, { sample_id: s.id }); PS.refresh(); };
    box.append(h('div', { class: 'grid2' },
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '기본 정보'),
        h('div', { class: 'kv' }, h('span', {}, '샘플명'), h('span', {}, s.name), h('span', {}, '합성일'), h('span', {}, s.synthesized_on || '—'), h('span', {}, '등록'), h('span', {}, s.created_at.replace('T', ' ')),
          h('span', {}, '수정'), h('span', {}, s.updated_at.replace('T', ' '))),
        h('h3', {}, '메모'), h('div', { style: { whiteSpace: 'pre-wrap' } }, s.notes || h('span', { class: 'muted' }, '없음'))),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '샘플 관계 ', help('파생·분기·결합 이력입니다. 시리즈(분류)와는 별개입니다. 전체 구조는 “계보 맵” 탭에서 볼 수 있습니다.')),
        h('h3', {}, '상위 샘플'), s.links_up.length ? s.links_up.map((l) => linkRow(l, l.parent_id, l.parent_name, l.parent_color)) : h('div', { class: 'muted small' }, '없음'),
        h('h3', {}, '하위 샘플'), s.links_down.length ? s.links_down.map((l) => linkRow(l, l.child_id, l.child_name, l.child_color)) : h('div', { class: 'muted small' }, '없음'),
        h('button', { class: 'small', style: { marginTop: '8px' }, onclick: async () => { if (await linkModal(s)) PS.refresh(); } }, '+ 관계 추가'),
        h('h3', {}, '시리즈'), h('div', { class: 'row' }, mine.map((x) => h('span', { class: 'chip' }, x.name, ' ', h('button', { class: 'small link', title: '시리즈에서 빼기', onclick: async () => { await PS.api.del(`/series/${x.id}/members/${s.id}`); PS.refresh(); } }, '×'))), addSer))));
  }

  // ------------------------------------------------------------ 합성 이력
  const STEP_TYPES = ['시약 혼합', '반응', '세척', '건조', '열처리', '분쇄', '분기 후 처리', '기타'];
  function stepForm(s, step) {
    const settings = PS.meta.settings || {};
    const defSup = settings.reagent_default_supplier || 'H사';
    const isNew = !step;
    step = JSON.parse(JSON.stringify(step || { step_type: '시약 혼합', title: '', params: {}, notes: '', reagents: [] }));
    const type = PS.select(STEP_TYPES, step.step_type);
    const seq = h('input', { type: 'number', class: 'sm', value: step.seq ?? (s.steps.length ? Math.max(...s.steps.map((x) => x.seq)) + 1 : 1) });
    const title = h('input', { type: 'text', value: step.title, style: { width: '100%' } });
    const notes = h('textarea', { class: 'prose', rows: 3, placeholder: '공정 메모 (색 변화, 관찰, 문제 등)' }, step.notes);
    const paramBox = h('div'), reagBox = h('div');
    const params = step.params || {};
    const applyHeatDefaults = () => {
      const d = settings.heat_treatment_defaults || {};
      const labels = { temperature: '열처리 온도', ramp_min: '승온 시간', hold_min: '유지 시간' };
      for (const [k, x] of Object.entries(d)) if (!params[k]) params[k] = { label: labels[k] || k, value: x.value, unit: x.unit, source: 'default' };
    };
    if (isNew && step.step_type === '열처리') applyHeatDefaults();
    type.onchange = () => { if (type.value === '열처리') applyHeatDefaults(); renderParams(); };
    function renderParams() {
      paramBox.innerHTML = '';
      const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '조건'), h('th', {}, '값'), h('th', {}, '단위'), h('th', {}, '출처'), h('th', {}, '실제값 확인', help('기본값으로 채워진 조건을 실제로 사용했다면 체크하세요. 체크하지 않은 값은 “기본값”으로 남아 실측·실제 조건과 구분됩니다.')), h('th')));
      for (const [k, x] of Object.entries(params)) {
        const vi = h('input', { type: 'text', value: x.value ?? '', class: 'num' });
        const ui = h('input', { type: 'text', value: x.unit || '', class: 'sm' });
        const badge = h('span', {}, PS.srcBadge(x.source));
        const chk = h('input', { type: 'checkbox', checked: x.source !== 'default' });
        const setSrc = (src) => { x.source = src; badge.innerHTML = ''; badge.appendChild(PS.srcBadge(src)); chk.checked = src !== 'default'; };
        vi.oninput = () => { const n = C.num(vi.value); x.value = C.isNum(n) ? n : vi.value; setSrc('user'); };
        ui.oninput = () => { x.unit = ui.value; };
        chk.onchange = () => setSrc(chk.checked ? 'user' : 'default');
        tbl.appendChild(h('tr', {}, h('td', {}, x.label || k), h('td', {}, vi), h('td', {}, ui), h('td', {}, badge), h('td', {}, chk), h('td', {}, h('button', { class: 'small link', onclick: () => { delete params[k]; renderParams(); } }, '삭제'))));
      }
      const nk = h('input', { type: 'text', placeholder: '조건 (예: 분위기, 교반 속도)' }), nv = h('input', { type: 'text', placeholder: '값', class: 'num' }), nu = h('input', { type: 'text', placeholder: '단위', class: 'sm' });
      paramBox.append(tbl, h('div', { class: 'row', style: { marginTop: '6px' } }, nk, nv, nu, h('button', { class: 'small', onclick: () => {
        if (!nk.value.trim()) return;
        const n = C.num(nv.value);
        params['p_' + Date.now()] = { label: nk.value.trim(), value: C.isNum(n) ? n : nv.value, unit: nu.value, source: 'user' };
        renderParams();
      } }, '조건 추가')));
    }
    function renderReag() {
      reagBox.innerHTML = '';
      const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '시약'), h('th', {}, '양'), h('th', {}, '단위'), h('th', {}, '제조사', help(`별도 언급이 없으면 ${defSup} 제품을 기본값으로 기록합니다.`)), h('th', {}, 'Lot'), h('th', {}, '메모'), h('th')));
      step.reagents.forEach((r, i) => {
        const f = (k, attrs) => { const e = h('input', Object.assign({ type: 'text', value: r[k] ?? '' }, attrs || {})); e.oninput = () => { r[k] = e.value; if (k === 'supplier') r.supplier_source = e.value && e.value !== defSup ? 'user' : (e.value === defSup ? 'user' : 'default'); }; return e; };
        tbl.appendChild(h('tr', {}, h('td', {}, f('name')), h('td', {}, f('amount', { class: 'num' })), h('td', {}, f('unit', { class: 'sm' })),
          h('td', {}, f('supplier', { placeholder: `${defSup} (기본)`, class: 'sm' }), r.supplier_source === 'default' || !r.supplier ? PS.srcBadge('default') : null), h('td', {}, f('lot', { class: 'sm' })), h('td', {}, f('notes')),
          h('td', {}, h('button', { class: 'small link', onclick: () => { step.reagents.splice(i, 1); renderReag(); } }, '삭제'))));
      });
      reagBox.append(tbl, h('button', { class: 'small', style: { marginTop: '6px' }, onclick: () => { step.reagents.push({ name: '', amount: '', unit: 'g', supplier: '', supplier_source: 'default' }); renderReag(); } }, '+ 시약 추가'));
    }
    renderParams(); renderReag();
    const body = h('div', {}, h('div', { class: 'form' }, h('label', {}, '순서'), seq, h('label', {}, '단계 종류'), type, h('label', {}, '제목'), title, h('label', {}, '공정 메모'), notes),
      h('h3', {}, '조건'), paramBox, h('h3', {}, '시약'), reagBox);
    return PS.modal({ title: isNew ? '합성 단계 추가' : '합성 단계 수정', body, wide: true, onSave: async () => {
      const b = { seq: +seq.value || 1, step_type: type.value, title: title.value, notes: notes.value, params,
        reagents: step.reagents.map((r) => Object.assign({}, r, { supplier: r.supplier || '', supplier_source: r.supplier ? 'user' : 'default' })) };
      if (isNew) await PS.api.post(`/samples/${s.id}/steps`, b); else await PS.api.put('/steps/' + step.id, b);
      PS.toast('저장되었습니다', 'ok');
    } });
  }

  function stepCard(s, st, readonly) {
    const params = Object.entries(st.params || {});
    return h('div', { class: 'step' },
      h('div', { class: 'row' }, h('span', { class: 'seq' }, st.seq), h('b', {}, st.step_type), st.title ? h('span', {}, ' · ' + st.title) : null, h('span', { class: 'grow' }),
        readonly ? null : h('button', { class: 'small', onclick: async () => { if (await stepForm(s, st)) PS.refresh(); } }, '수정'),
        readonly ? null : h('button', { class: 'small link', onclick: async () => {
          if (!(await PS.confirm(`${st.seq}번 단계 “${st.step_type}”을(를) 삭제할까요?`, { danger: true, detail: '삭제 전 내용은 변경 이력에 남습니다.' }))) return;
          await PS.api.del('/steps/' + st.id); PS.refresh();
        } }, '삭제')),
      params.length ? h('div', { class: 'kv' }, params.flatMap(([k, x]) => [h('span', {}, x.label || k), h('span', {}, `${x.value ?? ''} ${x.unit || ''}`, PS.srcBadge(x.source === 'default' ? 'default' : null))])) : null,
      st.reagents && st.reagents.length ? h('table', { class: 'tbl small', style: { marginTop: '6px' } }, h('tr', {}, h('th', {}, '시약'), h('th', { class: 'num' }, '양'), h('th', {}, '제조사'), h('th', {}, 'Lot'), h('th', {}, '메모')),
        st.reagents.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: 'num' }, r.amount ?? '—', ' ', r.unit), h('td', {}, r.supplier, r.supplier_source === 'default' ? PS.srcBadge('default') : null), h('td', {}, r.lot), h('td', {}, r.notes)))) : null,
      st.notes ? h('div', { class: 'note', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, st.notes) : null);
  }

  async function tabSynthesis(s, box) {
    const parents = await Promise.all(s.links_up.map((l) => PS.api.get('/samples/' + l.parent_id).then((ps) => ({ l, ps })).catch(() => null)));
    box.append(h('div', { class: 'row' }, h('h2', { class: 'grow', style: { margin: 0 } }, '합성 단계'), h('button', { class: 'primary', onclick: async () => { if (await stepForm(s)) PS.refresh(); } }, '+ 단계 추가')),
      h('p', { class: 'note' }, '중간 과정은 별도 샘플이 아니라 단계와 메모로 기록합니다. “기본값” 표시는 앱 기본값(열처리 450 °C·승온 50분·유지 30분, 시약 H사)이 확인되지 않은 채 남아 있다는 뜻입니다.'),
      s.steps.length ? s.steps.map((st) => stepCard(s, st)) : h('div', { class: 'empty' }, '등록된 합성 단계가 없습니다.'),
      parents.filter(Boolean).length ? h('div', { class: 'panel', style: { marginTop: '14px' } }, h('h2', { style: { marginTop: 0 } }, '상위 샘플의 합성 이력 (참고)'),
        parents.filter(Boolean).map(({ l, ps }) => h('details', {}, h('summary', {}, `${ps.name} (${l.relation}${l.branch_point ? ', 시점: ' + l.branch_point : ''}) — 단계 ${ps.steps.length}개`),
          ps.steps.map((st) => stepCard(ps, st, true))))) : null);
  }

  // ------------------------------------------------------------ 계보 맵 (DAG, 마인드맵형 좌→우 배치)
  async function tabLineage(s, box) {
    const g = await PS.api.get('/lineage/' + s.id);
    if (g.nodes.length <= 1) { box.appendChild(h('div', { class: 'empty' }, '연결된 샘플이 없습니다. “개요·관계” 탭에서 상위/하위 샘플을 연결하세요.')); return; }
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    const parents = {}, children = {};
    for (const e of g.edges) { (parents[e.child_id] = parents[e.child_id] || []).push(e); (children[e.parent_id] = children[e.parent_id] || []).push(e); }
    // 층: 가장 긴 경로 기준
    const level = {};
    const visit = (id, seen = new Set()) => {
      if (level[id] !== undefined) return level[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      const ps = parents[id] || [];
      level[id] = ps.length ? Math.max(...ps.map((e) => visit(e.parent_id, seen) + 1)) : 0;
      return level[id];
    };
    g.nodes.forEach((n) => visit(n.id));
    const layers = [];
    g.nodes.forEach((n) => { (layers[level[n.id]] = layers[level[n.id]] || []).push(n.id); });
    // 순서: 부모 위치 평균(바리센터)으로 두 번 정렬
    const pos = {};
    layers.forEach((L) => L.forEach((id, i) => { pos[id] = i; }));
    for (let it = 0; it < 3; it++) {
      layers.forEach((L, li) => {
        if (!li) return;
        L.sort((a, b) => {
          const av = (parents[a] || []).map((e) => pos[e.parent_id]), bv = (parents[b] || []).map((e) => pos[e.parent_id]);
          const am = av.length ? av.reduce((x, y) => x + y, 0) / av.length : 0, bm = bv.length ? bv.reduce((x, y) => x + y, 0) / bv.length : 0;
          return am - bm;
        });
        L.forEach((id, i) => { pos[id] = i; });
      });
    }
    const NW = 150, NH = 34, GX = 90, GY = 22;
    const maxRows = Math.max(...layers.map((L) => L.length));
    const W = layers.length * (NW + GX) + 40, H = maxRows * (NH + GY) + 40;
    const xy = {};
    layers.forEach((L, li) => { const off = ((maxRows - L.length) * (NH + GY)) / 2; L.forEach((id, i) => { xy[id] = [20 + li * (NW + GX), 20 + off + i * (NH + GY)]; }); });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    const mk = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); (parent || svg).appendChild(e); return e; };
    for (const e of g.edges) {
      const [x1, y1] = xy[e.parent_id], [x2, y2] = xy[e.child_id];
      const sx = x1 + NW, sy = y1 + NH / 2, ex = x2, ey = y2 + NH / 2, mx = (sx + ex) / 2;
      mk('path', { d: `M${sx} ${sy} C${mx} ${sy} ${mx} ${ey} ${ex} ${ey}`, class: 'lin-edge' });
      mk('polygon', { points: `${ex} ${ey} ${ex - 7} ${ey - 4} ${ex - 7} ${ey + 4}`, fill: '#9aa3b5' });
      const t = mk('text', { x: mx, y: (sy + ey) / 2 - 4, 'text-anchor': 'middle', class: 'lin-elabel' });
      t.textContent = e.relation + (e.branch_point ? ` · ${e.branch_point}` : '');
    }
    for (const n of g.nodes) {
      const [x, y] = xy[n.id];
      const gr = mk('g', { class: 'lin-node' + (n.id === s.id ? ' cur' : '') + (n.deleted_at ? ' del' : ''), transform: `translate(${x} ${y})` });
      mk('rect', { width: NW, height: NH, rx: 8 }, gr);
      mk('circle', { cx: 14, cy: NH / 2, r: 5, fill: n.color }, gr);
      const t = mk('text', { x: 26, y: NH / 2 + 4 }, gr);
      t.textContent = n.name.length > 16 ? n.name.slice(0, 15) + '…' : n.name;
      const tt = mk('title', {}, gr); tt.textContent = `${n.name}${n.synthesized_on ? ' (' + n.synthesized_on + ')' : ''}${n.deleted_at ? ' [휴지통]' : ''}`;
      gr.addEventListener('click', () => PS.go(`#/sample/${n.id}/lineage`));
    }
    // 트리 목록 (텍스트)
    const tree = h('div', { class: 'small' });
    const walk = (id, depth, dirMap, key, seen) => {
      (dirMap[id] || []).forEach((e) => {
        const o = e[key];
        tree.appendChild(h('div', { style: { paddingLeft: depth * 18 + 'px' } }, depth ? '└ ' : '', h('a', { href: `#/sample/${o}/lineage` }, byId[o].name), h('span', { class: 'muted' }, ` (${e.relation}${e.branch_point ? ', ' + e.branch_point : ''})`)));
        if (!seen.has(o)) { seen.add(o); walk(o, depth + 1, dirMap, key, seen); }
      });
    };
    tree.appendChild(h('b', {}, '상위 방향')); walk(s.id, 0, parents, 'parent_id', new Set());
    tree.appendChild(h('div', { style: { height: '6px' } })); tree.appendChild(h('b', {}, '하위 방향')); walk(s.id, 0, children, 'child_id', new Set());
    box.append(h('p', { class: 'note' }, `${s.name} 와(과) 연결된 샘플 ${g.nodes.length}개. 왼쪽이 상위(먼저 만든 쪽), 오른쪽이 하위입니다. 노드를 클릭하면 그 샘플로 이동합니다.`),
      h('div', { class: 'lineage' }, svg), h('div', { class: 'panel', style: { marginTop: '10px' } }, tree));
  }

  // ------------------------------------------------------------ 분석 탭
  async function tabAnalysis(s, box) {
    const cards = h('div', { class: 'cards' });
    for (const t of PS.activeTypes()) {
      const recs = s.measurements.filter((m) => m.analysis_code === t.code);
      const stv = stOf(s, t.code);
      const defs = PS.metricDefs(t.code).slice(0, 4);
      cards.appendChild(h('div', { class: 'card' },
        h('h3', {}, t.name, h('span', { class: 'grow' }), PS.statusChip(stv, { title: '클릭해서 상태 변경', onclick: (e) => statusMenu(e.currentTarget, s, t.code, () => PS.refresh()) })),
        recs.length ? recs.map((m) => h('a', { class: 'rec', href: '#/m/' + m.id },
          h('div', { class: 'row' }, h('b', {}, m.title || `기록 #${m.id}`), m.seq !== null && m.seq !== undefined ? h('span', { class: 'chip' }, '순서 ' + m.seq) : null,
            m.conditions && m.conditions.technique ? h('span', { class: 'chip' }, m.conditions.technique.value) : null, h('span', { class: 'grow' }),
            h('span', { class: 'small muted' }, m.measured_on || '측정일 없음', m.measured_on_source === 'file' ? ' (파일)' : '')),
          defs.length ? h('div', { class: 'small' }, defs.map((d) => { const mv = PS.metricOf(m, d.key); return h('span', { style: { marginRight: '10px' } }, `${d.label}: `, mv ? fmt(mv.value, d.decimals) : '—', d.unit && mv ? ' ' + d.unit : ''); })) : null))
          : h('div', { class: 'muted small' }, '저장된 결과 없음'),
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('a', { href: `#/sample/${s.id}/new/${t.code}` }, h('button', { class: 'small' }, '+ 결과 추가')))));
    }
    box.append(h('p', { class: 'note' }, '결과를 저장하면 상태가 자동으로 “자료 있음”이 됩니다. 그 밖의 상태(의뢰 중, 계획 없음 등)는 상태 표시를 클릭해 직접 바꿉니다.'), cards);
  }

  async function tabNotes(s, box) {
    box.append(h('p', { class: 'note' }, '측정값·계산값과 분리해 연구자 해석과 AI 가설을 기록합니다. AI 가설은 “검증 전”으로 표시되고, 내보내기에서도 따로 구분됩니다.'),
      PS.interpretationsBlock({ sample_id: s.id, measurement_id: null, items: s.interpretations.filter((i) => !i.measurement_id), onChange: () => PS.refresh() }));
  }

  async function tabFiles(s, box) {
    let states = {};
    if (s.attachments.length) states = (await PS.api.get('/attachments/check?ids=' + s.attachments.map((a) => a.id).join(','))).states;
    const missing = Object.values(states).filter((x) => x === 'missing').length;
    box.append(missing ? h('div', { class: 'badge-bad' }, `경로가 깨진 첨부가 ${missing}개 있습니다. 파일을 옮겼다면 “경로 다시 지정”을 누르세요.`) : null,
      s.attachments.length ? s.attachments.map((a) => h('div', {}, a.measurement_id ? h('a', { class: 'small', href: '#/m/' + a.measurement_id }, `기록 #${a.measurement_id}`) : h('span', { class: 'small muted' }, '샘플 첨부'), PS.attachmentRow(a, states[a.id], () => PS.refresh())))
        : h('div', { class: 'empty' }, '첨부가 없습니다. 측정 기록 화면에서 원본 파일을 연결하세요.'));
  }

  // ------------------------------------------------------------ 샘플 선택기 (비교·패턴 공용)
  function samplePicker(samples, series, selected, onChange) {
    const q = h('input', { type: 'search', placeholder: '샘플 검색', style: { width: '100%' } });
    const ser = PS.select([['', '모든 시리즈']].concat(series.map((s) => [s.id, s.name])), '');
    const list = h('div', { class: 'picker' });
    const chips = h('div', { class: 'selchips' });
    const render = () => {
      list.innerHTML = '';
      const term = q.value.trim().toLowerCase();
      const sset = ser.value ? new Set(series.find((x) => String(x.id) === ser.value).sample_ids) : null;
      for (const s of samples) {
        if (sset && !sset.has(s.id)) continue;
        if (term && !s.name.toLowerCase().includes(term)) continue;
        const chk = h('input', { type: 'checkbox', checked: selected.has(s.id) });
        chk.onchange = () => { if (chk.checked) selected.add(s.id); else selected.delete(s.id); renderChips(); onChange(); };
        list.appendChild(h('label', {}, chk, PS.sampleDot(s), s.name, h('span', { class: 'small muted' }, s.synthesized_on || '')));
      }
    };
    const renderChips = () => {
      chips.innerHTML = '';
      const byId = Object.fromEntries(samples.map((s) => [s.id, s]));
      [...selected].filter((id) => byId[id]).forEach((id) => chips.appendChild(h('span', { class: 'chip', title: '클릭해서 선택 해제', onclick: () => { selected.delete(id); render(); renderChips(); onChange(); } }, PS.sampleDot(byId[id]), byId[id].name, ' ×')));
      if (!selected.size) chips.appendChild(h('span', { class: 'muted small' }, '선택한 샘플 없음'));
    };
    q.oninput = render; ser.onchange = render;
    render(); renderChips();
    return h('div', {}, h('div', { class: 'row' }, h('span', { class: 'grow' }, q), ser,
      h('button', { class: 'small', onclick: () => { list.querySelectorAll('input').forEach((c) => { if (!c.checked) { c.checked = true; c.onchange(); } }); } }, '보이는 샘플 모두 선택'),
      h('button', { class: 'small', onclick: () => { selected.clear(); render(); renderChips(); onChange(); } }, '선택 해제')),
    h('div', { style: { margin: '6px 0' } }, chips), list);
  }

  // ------------------------------------------------------------ 비교
  PS.route('/compare', async (p, view) => {
    PS.crumb([{ label: '샘플 비교' }]);
    const [samples, series] = await Promise.all([loadSamples(), loadSeries()]);
    const qs = PS.query();
    const selected = new Set((qs.s || '').split(',').filter(Boolean).map(Number));
    let code = qs.a || '';
    const matrixBox = h('div'), typeBox = h('div'), resultBox = h('div');
    const byId = Object.fromEntries(samples.map((s) => [s.id, s]));
    const sync = () => PS.setQuery({ s: [...selected].join(','), a: code });
    function renderMatrix() {
      matrixBox.innerHTML = ''; typeBox.innerHTML = '';
      const sel = [...selected].map((id) => byId[id]).filter(Boolean);
      if (!sel.length) { matrixBox.appendChild(h('div', { class: 'muted' }, '비교할 샘플을 먼저 고르세요.')); return; }
      const types = PS.activeTypes();
      const tbl = h('table', { class: 'tbl matrix' }, h('tr', {}, h('th', {}, '샘플'), types.map((t) => {
        const n = sel.filter((s) => stOf(s, t.code) === '자료 있음').length;
        return h('th', {}, t.name.replace(/\s*\(.*\)/, ''), h('div', { class: 'small', style: { fontWeight: 400 } }, n === sel.length ? h('span', { style: { color: '#1e8e4e' } }, '공통') : n ? `일부 ${n}/${sel.length}` : '없음'));
      })));
      for (const s of sel) tbl.appendChild(h('tr', {}, h('td', {}, PS.sampleLink(s)), types.map((t) => h('td', {}, PS.statusChip(stOf(s, t.code))))));
      matrixBox.append(h('div', { class: 'tablewrap' }, tbl));
      const btn = (t) => {
        const n = sel.filter((s) => stOf(s, t.code) === '자료 있음').length;
        return h('button', { class: code === t.code ? 'primary' : '', disabled: !n, title: n ? '' : '선택 샘플 중 자료가 있는 샘플이 없습니다', onclick: () => { code = t.code; sync(); renderMatrix(); renderResult(); } },
          t.name, ' ', h('span', { class: 'small' }, n === sel.length ? '(공통)' : `(${n}/${sel.length})`));
      };
      const common = types.filter((t) => sel.every((s) => stOf(s, t.code) === '자료 있음'));
      const partial = types.filter((t) => !common.includes(t) && sel.some((s) => stOf(s, t.code) === '자료 있음'));
      typeBox.append(h('div', { class: 'row' }, h('b', {}, '공통 분석: '), common.length ? common.map(btn) : h('span', { class: 'muted small' }, '없음')),
        h('div', { class: 'row', style: { marginTop: '6px' } }, h('b', {}, '일부 샘플만: '), partial.length ? partial.map(btn) : h('span', { class: 'muted small' }, '없음')));
    }
    async function renderResult() {
      resultBox.innerHTML = '';
      const sel = [...selected].filter((id) => byId[id]);
      if (!code || !sel.length) return;
      resultBox.appendChild(h('div', { class: 'muted' }, '불러오는 중…'));
      const data = await PS.api.post('/compare', { sample_ids: sel, analysis_code: code });
      resultBox.innerHTML = '';
      resultBox.appendChild(compareResult(code, data, byId, sel));
    }
    view.innerHTML = '';
    view.append(h('h1', {}, '샘플 비교'),
      h('div', { class: 'grid2' },
        h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '1. 샘플 고르기'), samplePicker(samples, series, selected, () => { sync(); renderMatrix(); resultBox.innerHTML = ''; if (code) renderResult(); })),
        h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '2. 분석 상태 확인 ', help('선택한 샘플별로 어떤 분석이 자료 있음·미업로드·의뢰 중·계획 없음인지 비교 전에 보여줍니다.')), matrixBox, h('h2', {}, '3. 비교할 분석'), typeBox)),
      resultBox);
    renderMatrix();
    if (code) renderResult();
  });

  function condDiff(ms) {
    // 측정 간 다른 조건 찾기
    const keys = new Set();
    ms.forEach((m) => Object.keys(m.conditions || {}).forEach((k) => keys.add(k)));
    const out = [];
    for (const k of keys) {
      const vals = ms.map((m) => {
        const c = (m.conditions || {})[k];
        if (!c) return '(기록 없음)';
        if (c && typeof c === 'object' && 'value' in c) return `${c.value}${c.unit ? ' ' + c.unit : ''}${c.source === 'default' ? ' [기본값]' : ''}`;
        return JSON.stringify(c).slice(0, 60);
      });
      if (new Set(vals).size > 1) out.push({ key: k, label: ((ms.find((m) => m.conditions && m.conditions[k]) || {}).conditions[k] || {}).label || k, vals });
    }
    return out;
  }

  function compareResult(code, data, byId, selIds) {
    const t = PS.typeMap[code];
    const defs = PS.metricDefs(code);
    const ms = data.measurements;
    const wrap = h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, `${t.name} 비교`));
    const missing = selIds.filter((id) => !ms.some((m) => m.sample_id === id));
    if (missing.length) wrap.appendChild(h('div', { class: 'badge-warn small' }, '이 분석 기록이 없는 샘플: ', missing.map((id) => `${byId[id].name}(${stOf(byId[id], code)})`).join(', '), ' — 비교에서 제외되며 0 으로 취급하지 않습니다.'));
    if (!ms.length) return wrap;
    // 조건 차이
    const diffs = condDiff(ms.map((m) => { const c = Object.assign({}, m.conditions); if (c.session_snapshot) { for (const [k, v] of Object.entries(c.session_snapshot)) if (!k.startsWith('_')) c['전극:' + k] = v; delete c.session_snapshot; } return Object.assign({}, m, { conditions: c }); }));
    if (diffs.length) {
      wrap.appendChild(h('details', { open: true }, h('summary', { class: 'flag' }, `측정 조건이 다른 항목 ${diffs.length}개 — 아래 수치는 같은 조건의 결과가 아닙니다`),
        h('div', { class: 'tablewrap' }, h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '조건'), ms.map((m) => h('th', {}, byId[m.sample_id].name, h('div', { class: 'muted' }, m.title || '#' + m.id)))),
          diffs.map((d) => h('tr', { class: 'diff' }, h('td', {}, d.label), d.vals.map((v) => h('td', {}, v))))))));
    } else wrap.appendChild(h('div', { class: 'badge-ok small' }, '기록된 측정 조건이 모두 같습니다 (기록되지 않은 조건은 확인할 수 없습니다).'));
    // 수치 표
    if (defs.length) {
      const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, '샘플'), h('th', {}, '기록'), h('th', {}, '측정일'), defs.map((d) => h('th', { class: 'num', title: d.help || '' }, d.label, d.unit ? ` (${d.unit})` : ''))));
      for (const m of ms) {
        const s = byId[m.sample_id];
        tbl.appendChild(h('tr', {}, h('td', {}, PS.sampleLink(s)), h('td', {}, h('a', { href: '#/m/' + m.id }, m.title || '#' + m.id), m.seq != null ? h('span', { class: 'small muted' }, ` 순서 ${m.seq}`) : null),
          h('td', { class: 'small' }, m.measured_on || '—'),
          defs.map((d) => {
            const mv = PS.metricOf(m, d.key);
            return h('td', { class: 'num', title: mv ? (mv.formula ? `계산: ${mv.formula}` : `출처: ${mv.source}`) : '기록 없음 (0 아님)' }, mv ? fmt(mv.value, d.decimals) : h('span', { class: 'muted' }, '—'),
              mv && mv.source && mv.source !== 'computed' && mv.source !== 'user' ? PS.srcBadge(mv.source) : null);
          })));
      }
      wrap.append(h('h3', {}, '수치 비교 ', help('기본 소수점 둘째 자리, SI 는 정수로 표시합니다. 원본 정밀도는 그대로 저장됩니다. 셀에 마우스를 올리면 계산식/출처가 보입니다.')), h('div', { class: 'tablewrap' }, tbl));
      // 막대 그래프
      const metricSel = PS.select(defs.map((d) => [d.key, d.label]), defs[0].key);
      const barBox = h('div');
      const drawBars = () => {
        const d = defs.find((x) => x.key === metricSel.value);
        const cats = ms.map((m) => byId[m.sample_id].name + (ms.filter((x) => x.sample_id === m.sample_id).length > 1 ? ` #${m.id}` : ''));
        PSChart.render(barBox, { bars: { categories: cats, groups: [{ name: d.label, color: '#888', colors: ms.map((m) => byId[m.sample_id].color), values: ms.map((m) => { const mv = PS.metricOf(m, d.key); return mv ? mv.value : NaN; }) }] },
          series: [], xLabel: '', yLabel: `${d.label}${d.unit ? ' (' + d.unit + ')' : ''}`, yDomain: (() => { const vals = ms.map((m) => PS.metricOf(m, d.key)).filter(Boolean).map((x) => x.value); return vals.length ? [Math.min(0, ...vals), Math.max(...vals) * 1.1 || 1] : [0, 1]; })(), height: 280 });
      };
      metricSel.onchange = drawBars;
      wrap.append(h('div', { class: 'row', style: { marginTop: '10px' } }, h('b', {}, '그래프 지표'), metricSel), barBox);
      setTimeout(drawBars, 0);
      if (code === 'XRF') wrap.append(xrfImpurityChart(ms, byId));
    }
    // 곡선 비교
    const curves = curveList(code, ms, byId, data.ec_sessions || {});
    if (curves.length) wrap.append(curvePicker(code, curves));
    return wrap;
  }

  function xrfImpurityChart(ms, byId) {
    const box = h('div');
    const els = [...new Set(ms.flatMap((m) => (m.values && m.values.interest_elements) || ['Cl', 'Si', 'Na']))];
    const palette = ['#e67e22', '#8e44ad', '#16a085', '#c0392b', '#2c3e50', '#7f8c8d'];
    setTimeout(() => PSChart.render(box, {
      bars: { categories: ms.map((m) => byId[m.sample_id].name + (ms.filter((x) => x.sample_id === m.sample_id).length > 1 ? ` #${m.id}` : '')),
        groups: els.map((el, i) => ({ name: el + ' (wt%)', color: palette[i % palette.length], values: ms.map((m) => { const mv = PS.metricOf(m, 'imp_' + el); return mv ? mv.value : NaN; }) })) },
      series: [], yLabel: '함량 (wt%)', height: 280, yDomain: (() => { const v = ms.flatMap((m) => els.map((el) => (PS.metricOf(m, 'imp_' + el) || {}).value)).filter(Number.isFinite); return [0, (Math.max(0, ...v) * 1.15) || 1]; })(),
    }), 0);
    return h('div', {}, h('h3', {}, '관심 불순물 함량 (Cl · Si · Na) ', help('“없음”은 성적서에 보고되지 않은 값입니다. 0 으로 그리지 않습니다. 산화물로 보고된 값은 원소 질량분율로 환산했습니다.')), box);
  }

  // 곡선 목록: 데이터셋을 비교 가능한 곡선 단위로 펼친다
  function curveList(code, ms, byId) {
    const out = [];
    for (const m of ms) {
      const s = byId[m.sample_id];
      for (const d of m.datasets || []) {
        const base = { id: `${m.id}:${d.id}`, sample: s, meas: m, ds: d, label: `${s.name} · ${m.title || '#' + m.id}` };
        if (code === 'XRD' && d.name === 'XRD XY') out.push(Object.assign(base, { kind: 'xrd', x: d.data[0], y: d.data[1], xLabel: '2θ (°)', yLabel: '강도' }));
        else if (code === 'TGA') {
          const r = C.computeTga(d.data[0], d.data[1], { massUnit: d.meta.mass_unit || '%', window: d.meta.window || 21, method: d.meta.method || 'savgol' });
          out.push(Object.assign({}, base, { id: base.id + ':m', label: base.label + ' 질량', x: d.data[0], y: r.massPct, xLabel: '온도 (°C)', yLabel: '질량 (%)', group: 'mass' }));
          out.push(Object.assign({}, base, { id: base.id + ':d', label: base.label + ' DTG', x: d.data[0], y: r.dtgSmooth, xLabel: '온도 (°C)', yLabel: 'DTG (%/°C)', group: 'dtg', note: `DTG ${d.meta.method || 'savgol'} ${d.meta.window || 21}점 스무딩` }));
        } else if (code === 'BET' && d.name === 'BET 등온선') out.push(Object.assign(base, { x: d.data[0], y: d.data[1], xLabel: 'p/p0', yLabel: 'Q (cm³/g STP)' }));
        else if (code === 'PSA') out.push(Object.assign(base, { x: d.data[0], y: d.data[1], xLabel: d.columns[0] || '입경', yLabel: d.columns[1] || '' }));
        else if (code === 'EC' || code === 'ECSA') {
          const a = PS.ecArrays(d);
          const tech = (m.conditions.technique || {}).value || (code === 'ECSA' ? 'CV' : '');
          if (!a.I) { out.push(Object.assign(base, { x: a.T || a.E.map((_, i) => i), y: a.E, xLabel: '시간 (s)', yLabel: 'E (V)', group: 'ocv', label: base.label + ` (${tech})` })); continue; }
          const sp = tech === 'CV' ? C.splitCycles(a.E, a.cyc) : { cycles: [{ no: 1, start: 0, end: a.E.length - 1 }] };
          for (const c of sp.cycles) {
            out.push(Object.assign({}, base, { id: `${base.id}:${c.no}`, label: `${base.label} · ${d.name}${sp.cycles.length > 1 ? ` · 사이클 ${c.no}` : ''} (${tech})`, x: a.E.slice(c.start, c.end + 1), y: a.I.slice(c.start, c.end + 1), xLabel: 'E (V)', yLabel: 'I (mA)', group: 'iv' }));
          }
        }
      }
    }
    return out;
  }

  // 여러 곡선을 고른 뒤 “적용”을 눌러야 그래프가 바뀐다. 검색·필터를 바꿔도 선택은 유지된다.
  function curvePicker(code, curves) {
    const key = 'curves.' + code;
    const chosen = new Set(PS.store.get(key, []).filter((id) => curves.some((c) => c.id === id)));
    if (!chosen.size) curves.slice(0, Math.min(6, curves.length)).forEach((c) => chosen.add(c.id));
    let applied = new Set(chosen);
    const q = h('input', { type: 'search', placeholder: '곡선 검색 (샘플명, 기록, 사이클…)', style: { width: '100%' } });
    const list = h('div', { class: 'picker', style: { maxHeight: '220px' } });
    const count = h('span', { class: 'small muted' });
    const chartBox = h('div');
    let norm = code === 'XRD' ? PS.store.get('xrdNorm', false) : false;
    let corr = false;
    const normChk = h('input', { type: 'checkbox', checked: norm });
    const corrChk = h('input', { type: 'checkbox' });
    const pending = h('span', { class: 'small flag' });
    const renderList = () => {
      list.innerHTML = '';
      const term = q.value.trim().toLowerCase();
      for (const c of curves) {
        if (term && !c.label.toLowerCase().includes(term)) continue;
        const chk = h('input', { type: 'checkbox', checked: chosen.has(c.id) });
        chk.onchange = () => { if (chk.checked) chosen.add(c.id); else chosen.delete(c.id); updPending(); };
        list.appendChild(h('label', {}, chk, PS.sampleDot(c.sample), c.label));
      }
      updPending();
    };
    const updPending = () => {
      count.textContent = `선택 ${chosen.size} / ${curves.length}개`;
      const same = chosen.size === applied.size && [...chosen].every((x) => applied.has(x));
      pending.textContent = same ? '' : '선택이 바뀌었습니다 — “그래프에 적용”을 누르세요';
    };
    const draw = () => {
      const sel = curves.filter((c) => applied.has(c.id));
      chartBox.innerHTML = '';
      if (!sel.length) { chartBox.appendChild(h('div', { class: 'muted' }, '선택한 곡선이 없습니다.')); return; }
      const groups = [...new Set(sel.map((c) => c.group || 'main'))];
      const perSample = {};
      for (const grp of groups) {
        const ss = sel.filter((c) => (c.group || 'main') === grp);
        const dashes = [null, '6 3', '2 3', '8 3 2 3'];
        let note = '';
        const series = ss.map((c) => {
          const n = perSample[c.sample.id + grp] = (perSample[c.sample.id + grp] || 0) + 1;
          let x = c.x, y = c.y;
          if (c.kind === 'xrd') {
            const bg = (c.ds.meta || {}).background_points || [];
            if (corr && bg.length >= 2) { const f = C.naturalSpline(bg); y = y.map((v, i) => v - f(x[i])); }
            if (norm) { const mx = C.maxOf(y); y = y.map((v) => v / mx); }
          }
          return { name: c.label, color: c.sample.color, dash: dashes[(n - 1) % dashes.length], x, y };
        });
        if (code === 'XRD') {
          const noBg = ss.filter((c) => ((c.ds.meta || {}).background_points || []).length < 2);
          note = (corr ? '배경 보정(저장된 배경점, 자연 3차 스플라인)' : '원본 강도') + (norm ? ' · 곡선별 최고 피크 = 1 정규화' : '');
          if (corr && noBg.length) note += ` · 배경점 없는 곡선 ${noBg.length}개는 보정 안 됨`;
        }
        if (ss[0].note) note = ss[0].note;
        const box = h('div', { style: { marginBottom: '10px' } });
        chartBox.appendChild(box);
        PSChart.render(box, { series, xLabel: ss[0].xLabel, yLabel: code === 'XRD' && norm ? '정규화 강도 (최고 피크 = 1)' : ss[0].yLabel, note });
      }
      chartBox.appendChild(h('div', { class: 'note' }, '같은 샘플의 곡선은 같은 색이며, 같은 샘플의 여러 곡선은 선 모양(실선·점선)으로 구분합니다. 범례를 클릭하면 곡선을 숨길 수 있습니다.'));
    };
    q.oninput = renderList;
    normChk.onchange = () => { norm = normChk.checked; PS.store.set('xrdNorm', norm); draw(); };
    corrChk.onchange = () => { corr = corrChk.checked; draw(); };
    renderList(); setTimeout(draw, 0);
    return h('div', {}, h('h3', {}, '그래프 비교'),
      h('div', { class: 'grid2', style: { gridTemplateColumns: 'minmax(260px, 340px) 1fr' } },
        h('div', {}, q, list, h('div', { class: 'row', style: { marginTop: '6px' } }, count,
          h('button', { class: 'small', onclick: () => { list.querySelectorAll('input').forEach((c) => { if (!c.checked) { c.checked = true; c.onchange(); } }); } }, '보이는 것 모두'),
          h('button', { class: 'small', onclick: () => { chosen.clear(); renderList(); } }, '모두 해제')),
          h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'primary', onclick: () => { applied = new Set(chosen); PS.store.set(key, [...applied]); updPending(); draw(); } }, '그래프에 적용'), pending),
          code === 'XRD' ? h('div', { style: { marginTop: '8px' } }, h('label', {}, normChk, ' 최고 피크로 정규화'), h('br'), h('label', {}, corrChk, ' 저장된 배경점으로 배경 보정')) : null),
        chartBox));
  }

  // ------------------------------------------------------------ 패턴 탐색
  function featuresFrom(samples, ms, details) {
    // 특징: 분석 지표 (샘플별 평균) + 합성 조건 수치
    const feats = {};
    const add = (key, label, sid, value, meta) => {
      if (!C.isNum(value)) return;
      const f = feats[key] = feats[key] || { key, label, values: {}, meta: {} };
      (f.values[sid] = f.values[sid] || []).push(value);
      (f.meta[sid] = f.meta[sid] || []).push(meta);
    };
    for (const m of ms) {
      for (const d of PS.metricDefs(m.analysis_code)) {
        const mv = PS.metricOf(m, d.key);
        if (mv) add(`${m.analysis_code}.${d.key}`, `${PS.typeMap[m.analysis_code].name} · ${d.label}${d.unit ? ' (' + d.unit + ')' : ''}`, m.sample_id, mv.value, { mid: m.id, conditions: m.conditions, source: mv.source });
      }
    }
    for (const s of details) {
      for (const st of s.steps) {
        for (const [k, p] of Object.entries(st.params || {})) {
          const v = C.num(p.value);
          if (C.isNum(v)) add(`syn.${st.step_type}.${p.label || k}`, `합성 · ${st.step_type} · ${p.label || k}${p.unit ? ' (' + p.unit + ')' : ''}`, s.id, v, { source: p.source, step: st.seq });
        }
      }
    }
    for (const f of Object.values(feats)) {
      f.agg = {};
      for (const [sid, arr] of Object.entries(f.values)) f.agg[sid] = arr.reduce((a, b) => a + b, 0) / arr.length;
      f.multi = Object.entries(f.values).filter(([, a]) => a.length > 1).map(([sid]) => +sid);
      f.defaults = Object.entries(f.meta).filter(([, a]) => a.some((x) => x.source === 'default')).map(([sid]) => +sid);
    }
    void samples;
    return feats;
  }

  function judge(n, r) {
    if (n < 3) return { text: '판단 불가 — 두 값이 모두 있는 샘플이 3개 미만입니다.', cls: 'badge-bad' };
    if (r === null) return { text: '판단 불가 — 값의 변화가 없습니다.', cls: 'badge-bad' };
    const a = Math.abs(r);
    const strength = a >= 0.8 ? '강한' : a >= 0.5 ? '중간 정도의' : a >= 0.3 ? '약한' : '뚜렷하지 않은';
    const dir = r > 0 ? '양(+)의' : '음(−)의';
    if (n < 5) return { text: `참고만 — 샘플 ${n}개로는 우연과 구분하기 어렵습니다. 현재 데이터에서는 ${a >= 0.3 ? dir + ' ' : ''}${strength} 경향 (r = ${r.toFixed(2)}).`, cls: 'badge-warn' };
    return { text: `기록된 ${n}개 샘플에서 ${a >= 0.3 ? dir + ' ' : ''}${strength} 상관 (r = ${r.toFixed(2)}). 상관관계이며 인과관계를 뜻하지 않습니다.`, cls: a >= 0.5 ? 'badge-ok' : 'badge-info' };
  }

  PS.route('/patterns', async (p, view) => {
    PS.crumb([{ label: '패턴 탐색' }]);
    const [samples, series] = await Promise.all([loadSamples(), loadSeries()]);
    const byId = Object.fromEntries(samples.map((s) => [s.id, s]));
    const qs = PS.query();
    const selected = new Set((qs.s || PS.store.get('patternSel', []).join(',')).split(',').filter(Boolean).map(Number).filter((id) => byId[id]));
    const out = h('div');
    let feats = null;
    async function load() {
      PS.setQuery({ s: [...selected].join(',') });
      PS.store.set('patternSel', [...selected]);
      out.innerHTML = '';
      if (selected.size < 2) { out.appendChild(h('div', { class: 'muted' }, '샘플을 2개 이상 고르세요.')); return; }
      out.appendChild(h('div', { class: 'muted' }, '불러오는 중…'));
      const ids = [...selected];
      const [mres, details] = await Promise.all([PS.api.post('/metrics', { sample_ids: ids }), Promise.all(ids.map((id) => PS.api.get('/samples/' + id)))]);
      feats = featuresFrom(samples, mres.measurements, details);
      out.innerHTML = '';
      render(ids);
    }
    function render(ids) {
      const fl = Object.values(feats).sort((a, b) => a.label.localeCompare(b.label, 'ko'));
      // 충분성
      const suff = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '특징'), h('th', { class: 'num' }, '값 있는 샘플'), h('th', {}, '값 없는 샘플'), h('th', {}, '주의')));
      for (const f of fl) {
        const have = ids.filter((id) => f.agg[id] !== undefined);
        const miss = ids.filter((id) => f.agg[id] === undefined);
        const constant = have.length > 1 && new Set(have.map((id) => f.agg[id])).size === 1;
        suff.appendChild(h('tr', {}, h('td', {}, f.label, constant ? h('span', { class: 'small muted' }, ' (모든 샘플 같은 값)') : null), h('td', { class: 'num' }, `${have.length} / ${ids.length}`), h('td', { class: 'muted' }, miss.map((id) => byId[id].name).join(', ') || '—'),
          h('td', { class: 'small flag' }, [f.multi.length ? `여러 측정 평균: ${f.multi.map((id) => byId[id].name).join(', ')}` : '', f.defaults.length ? ` 기본값(미확인) 포함: ${f.defaults.map((id) => byId[id].name).join(', ')}` : ''].join(' '))));
      }
      // 쌍 분석
      const opts = fl.map((f) => [f.key, f.label]);
      // 기본 쌍: 값이 변하는 합성 조건(X) × 첫 분석 지표(Y)
      const varies = (f) => new Set(Object.values(f.agg)).size > 1;
      const dX = (fl.find((f) => f.key.startsWith('syn.') && varies(f)) || fl[0] || {}).key;
      const dY = (fl.find((f) => !f.key.startsWith('syn.') && varies(f) && f.key !== dX) || fl[1] || {}).key;
      const savedX = PS.store.get('patX', null), savedY = PS.store.get('patY', null);
      const xs = PS.select(opts, feats[savedX] ? savedX : dX), ys = PS.select(opts, feats[savedY] ? savedY : dY);
      const pairBox = h('div');
      const drawPair = () => {
        PS.store.set('patX', xs.value); PS.store.set('patY', ys.value);
        pairBox.innerHTML = '';
        const fx = feats[xs.value], fy = feats[ys.value];
        if (!fx || !fy) return;
        const both = ids.filter((id) => fx.agg[id] !== undefined && fy.agg[id] !== undefined);
        const X = both.map((id) => fx.agg[id]), Y = both.map((id) => fy.agg[id]);
        const pr = C.pearson(X, Y), sr = C.spearman(X, Y);
        const j = judge(both.length, pr ? pr.r : null);
        const chart = h('div');
        pairBox.append(h('div', { class: j.cls }, j.text), chart,
          h('div', { class: 'small' }, `n = ${both.length}`, pr ? `, Pearson r = ${pr.r.toFixed(3)}` : '', sr !== null && sr !== undefined ? `, Spearman ρ = ${sr.toFixed(3)}` : '', pr ? `, 기울기 = ${fmt(pr.slope, 4)}` : ''),
          h('div', { class: 'note' }, `X 값이 없는 샘플: ${ids.filter((id) => fx.agg[id] === undefined).map((id) => byId[id].name).join(', ') || '없음'} · Y 값이 없는 샘플: ${ids.filter((id) => fy.agg[id] === undefined).map((id) => byId[id].name).join(', ') || '없음'}. 값이 없는 샘플은 0 으로 채우지 않고 제외했습니다.`),
          (fx.multi.length || fy.multi.length) ? h('div', { class: 'badge-warn small' }, '한 샘플에 측정이 여러 개인 경우 평균을 썼습니다. 측정 조건이 다를 수 있으니 비교 화면에서 조건 차이를 확인하세요.') : null,
          (fx.defaults.length || fy.defaults.length) ? h('div', { class: 'badge-warn small' }, '확인되지 않은 앱 기본값(예: 열처리 450 °C)이 포함되어 있습니다. 실제 조건이 아닐 수 있습니다.') : null,
          h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'small', onclick: () => PS.addInterpretation({ preset: {
            kind: 'user_interpretation',
            text: `${fx.label} 와(과) ${fy.label} 관계: ${j.text}`,
            evidence: { basis: `샘플 ${both.map((id) => byId[id].name).join(', ')} (n=${both.length})`, gaps: `값 없음: ${ids.filter((id) => fx.agg[id] === undefined || fy.agg[id] === undefined).map((id) => byId[id].name).join(', ') || '없음'}`,
              uncertainty: both.length < 5 ? '샘플 수가 적어 우연일 가능성이 큼' : `기록된 범위 X ${fmt(C.minOf(X))}–${fmt(C.maxOf(X))} 안에서만 해당`,
              data: { x: fx.key, y: fy.key, n: both.length, pearson: pr && pr.r, spearman: sr } },
          }, onDone: () => {} }) }, '이 관찰을 해석으로 기록')));
        if (both.length) PSChart.render(chart, { series: [
          { name: '샘플', color: '#888', x: X, y: Y, mode: 'points', r: 6, labels: both.map((id) => byId[id].name), noLegend: true },
          ...(pr && both.length >= 3 ? [{ name: '선형 추세 (참고)', color: '#999', dash: '5 4', x: [C.minOf(X), C.maxOf(X)], y: [C.minOf(X), C.maxOf(X)].map((x) => pr.slope * x + pr.intercept) }] : []),
        ], markers: both.map((id, i) => ({ x: X[i], y: Y[i], color: byId[id].color, label: `${byId[id].name}: (${fmt(X[i])}, ${fmt(Y[i])})`, showLabel: both.length <= 12 })), xLabel: fx.label, yLabel: fy.label, height: 320 });
      };
      xs.onchange = drawPair; ys.onchange = drawPair;
      // 전체 쌍 훑어보기
      const scan = [];
      for (let i = 0; i < fl.length; i++) for (let k = i + 1; k < fl.length; k++) {
        const a = fl[i], b = fl[k];
        const pa = a.key.split('.')[0];
        if (pa !== 'syn' && pa === b.key.split('.')[0]) continue; // 같은 분석 내부 지표끼리(예: FWHM 과 GS)는 당연히 연관되므로 제외
        const both = ids.filter((id) => a.agg[id] !== undefined && b.agg[id] !== undefined);
        if (both.length < 3) continue;
        const pr = C.pearson(both.map((id) => a.agg[id]), both.map((id) => b.agg[id]));
        if (pr) scan.push({ a, b, n: both.length, r: pr.r });
      }
      scan.sort((p1, p2) => Math.abs(p2.r) * Math.min(1, p2.n / 5) - Math.abs(p1.r) * Math.min(1, p1.n / 5));
      const scanTbl = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, 'X'), h('th', {}, 'Y'), h('th', { class: 'num' }, 'n'), h('th', { class: 'num' }, 'r'), h('th', {}, '판단'), h('th')),
        scan.slice(0, 25).map((s) => h('tr', {}, h('td', {}, s.a.label), h('td', {}, s.b.label), h('td', { class: 'num' }, s.n), h('td', { class: 'num' }, s.r.toFixed(2)), h('td', {}, s.n < 5 ? '참고만 (n<5)' : Math.abs(s.r) >= 0.5 ? '확인할 만함' : '약함'),
          h('td', {}, h('button', { class: 'small link', onclick: () => { xs.value = s.a.key; ys.value = s.b.key; drawPair(); pairBox.scrollIntoView({ behavior: 'smooth' }); } }, '보기')))));
      // 다음 측정 제안
      const sugg = [];
      for (const f of fl) {
        const miss = ids.filter((id) => f.agg[id] === undefined);
        if (miss.length && miss.length < ids.length) sugg.push(`${f.label}: ${miss.map((id) => { const code = f.key.split('.')[0]; return PS.typeMap[code] ? `${byId[id].name}(${stOf(byId[id], code)})` : byId[id].name; }).join(', ')}`);
      }
      out.append(
        h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '두 특징 비교 ', help('샘플별 값을 짝지어 산점도와 상관계수를 봅니다. 값이 없는 샘플은 제외하며, 판단 가능 여부를 함께 표시합니다.')),
          h('div', { class: 'row' }, h('label', {}, 'X'), xs, h('label', {}, 'Y'), ys), pairBox),
        h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '확인해 볼 만한 쌍 ', help('서로 다른 분석/합성 조건 사이에서 |r| 이 큰 쌍입니다. 샘플 수가 적을수록 뒤로 밀립니다. 발견이 아니라 확인 후보입니다.')),
          scan.length ? scanTbl : h('div', { class: 'muted' }, '두 값이 모두 있는 샘플이 3개 이상인 쌍이 없습니다. 아래 “데이터 충분성”에서 빠진 측정을 확인하세요.')),
        h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '데이터 충분성'), h('div', { class: 'tablewrap' }, suff)),
        h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '다음 측정 제안'), h('p', { class: 'note' }, '아래 측정이 채워지면 위 비교의 n 이 늘어 판단이 쉬워집니다. 괄호는 현재 분석 상태입니다.'),
          sugg.length ? h('ul', { class: 'small' }, sugg.slice(0, 30).map((x) => h('li', {}, x))) : h('div', { class: 'muted' }, '선택 샘플들은 같은 특징을 모두 갖고 있습니다.')),
        h('div', { class: 'note' }, 'Cdl 로 BET 를 추정하려면 ', h('a', { href: '#/bet-predict' }, 'BET 예측(검증형)'), ' 화면을 쓰세요. 실측 BET 로 보정·교차검증한 경우에만 예측값을 보여줍니다.'));
      drawPair();
    }
    view.innerHTML = '';
    view.append(h('h1', {}, '패턴 탐색'),
      h('p', { class: 'note' }, '기록된 데이터로 확인할 수 있는 관계와, 데이터가 부족해 판단할 수 없는 부분을 구분해 보여줍니다. 결과는 상관관계이며 인과관계가 아닙니다.'),
      h('div', { class: 'panel' }, samplePicker(samples, series, selected, () => {}), h('button', { class: 'primary', style: { marginTop: '8px' }, onclick: load }, '선택 샘플로 분석')), out);
    if (selected.size >= 2) load();
  });


  // ------------------------------------------------------------ BET 예측 (실측 BET 로 보정·검증한 경우에만)
  PS.route('/bet-predict', async (p, view) => {
    PS.crumb([{ label: 'BET 예측 (검증형)' }]);
    const samples = await loadSamples();
    const byId = Object.fromEntries(samples.map((s) => [s.id, s]));
    const ms = (await PS.api.post('/metrics', { sample_ids: samples.map((s) => s.id) })).measurements;
    const st = PS.store.get('betPred', { bet: 'report_first', x: 'per_mass', minN: 5 });
    const betSel = PS.select([['report_first', '보고서 값 우선 (없으면 앱 재계산)'], ['report', '보고서 값만'], ['recalc', '앱 재계산 값만']], st.bet);
    const xSel = PS.select([['per_mass', 'Cdl / 로딩 (mF/mg)'], ['cdl', 'Cdl (mF, 로딩 무시)']], st.x);
    const out = h('div');
    function build() {
      PS.store.set('betPred', { bet: betSel.value, x: xSel.value, minN: 5 });
      const bet = {}, xv = {};
      for (const m of ms) {
        if (m.analysis_code === 'BET') {
          const rep = PS.metricOf(m, 'bet_ssa'), rc = PS.metricOf(m, 'bet_ssa_recalc');
          const pick = betSel.value === 'report' ? (rep && { ...rep, which: '보고서' }) : betSel.value === 'recalc' ? (rc && { ...rc, which: '재계산' }) : (rep ? { ...rep, which: '보고서' } : rc && { ...rc, which: '재계산' });
          if (pick) (bet[m.sample_id] = bet[m.sample_id] || []).push({ v: pick.value, which: pick.which, mid: m.id, cond: m.conditions });
        }
        if (m.analysis_code === 'ECSA') {
          const cdl = PS.metricOf(m, 'cdl');
          if (!cdl) continue;
          const load = m.values && m.values.loading ? C.num(m.values.loading.value) : NaN;
          const x = xSel.value === 'per_mass' ? (C.isNum(load) && load > 0 ? cdl.value / load : NaN) : cdl.value;
          if (!C.isNum(x)) continue;
          const snap = (m.conditions && m.conditions.session_snapshot) || {};
          const cond = { 전해질: snap.electrolyte ? snap.electrolyte.value : '(기록 없음)', '선택 전위(V)': m.values && m.values.e_select, 로딩: C.isNum(load) ? load : '(없음)', 로딩출처: m.values && m.values.loading ? m.values.loading.source : '' };
          (xv[m.sample_id] = xv[m.sample_id] || []).push({ v: x, cdl: cdl.value, load, mid: m.id, cond });
        }
      }
      const avg = (a) => a.reduce((s, o) => s + o.v, 0) / a.length;
      const train = Object.keys(xv).filter((id) => bet[id]).map((id) => ({ id: +id, x: avg(xv[id]), y: avg(bet[id]), nx: xv[id].length, ny: bet[id].length, xs: xv[id], ys: bet[id] }));
      const targets = Object.keys(xv).filter((id) => !bet[id]).map((id) => ({ id: +id, x: avg(xv[id]), xs: xv[id] }));
      out.innerHTML = '';
      const xLabel = xSel.value === 'per_mass' ? 'Cdl / 로딩 (mF/mg)' : 'Cdl (mF)';
      const warns = [];
      const distinct = (f) => [...new Set(train.flatMap((t) => t.xs.map(f)).map(String))];
      const el = distinct((o) => o.cond.전해질), es = distinct((o) => o.cond['선택 전위(V)']), ls = distinct((o) => o.cond.로딩출처);
      if (el.length > 1) warns.push(`학습 샘플의 전해질이 섞여 있습니다: ${el.join(', ')}. 전해질이 다르면 Cdl 을 같은 기준으로 비교하기 어렵습니다.`);
      if (es.length > 1) warns.push(`Cdl 계산에 쓴 선택 전위가 서로 다릅니다: ${es.join(', ')} V.`);
      if (ls.includes('default')) warns.push('일부 샘플의 로딩이 확인되지 않은 기본값(0.222 mg)입니다.');
      if (train.some((t) => t.nx > 1 || t.ny > 1)) warns.push('한 샘플에 측정이 여러 개 있으면 평균을 썼습니다.');
      if (new Set(train.flatMap((t) => t.ys.map((o) => o.which))).size > 1) warns.push('학습 데이터에 보고서 BET 와 앱 재계산 BET 가 섞여 있습니다.');
      const n = train.length;
      const cal = n >= 3 ? C.calibrate(train.map((t) => t.x), train.map((t) => t.y)) : null;
      const enough = cal && n >= 5;
      const verdict = !cal ? { cls: 'badge-bad', text: `실측 BET 와 Cdl 이 모두 있는 샘플이 ${n}개입니다. 최소 3개가 있어야 관계를 볼 수 있고, 예측은 5개 이상에서만 제공합니다.` }
        : !enough ? { cls: 'badge-bad', text: `학습 샘플 ${n}개 — 검증이 불충분해 예측값을 표시하지 않습니다 (5개 이상 필요). 아래 관계는 참고용입니다.` }
          : cal.loo_mape > 30 ? { cls: 'badge-warn', text: `교차검증 평균 오차 ${fmt(cal.loo_mape, 1)} % — 예측 신뢰도가 낮습니다. 예측값은 대략적인 범위로만 보세요.` }
            : { cls: 'badge-ok', text: `학습 샘플 ${n}개, 교차검증 평균 오차 ${fmt(cal.loo_mape, 1)} %. 아래 예측은 이 데이터 범위 안에서만 의미가 있습니다.` };
      const chart = h('div');
      out.append(h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '보정·검증'), h('div', { class: verdict.cls }, verdict.text),
        warns.map((w) => h('div', { class: 'badge-warn small', style: { marginTop: '6px' } }, w)),
        cal ? h('div', { class: 'small', style: { marginTop: '8px' } },
          `BET = ${fmt(cal.slope, 3)} × x ${cal.intercept >= 0 ? '+' : '−'} ${fmt(Math.abs(cal.intercept), 2)}  ·  R² = ${cal.r2.toFixed(3)}  ·  n = ${n}  ·  `,
          `LOO RMSE = ${fmt(cal.loo_rmse)} m²/g, LOO 평균 오차 = ${fmt(cal.loo_mape, 1)} %  ·  학습 범위 x = ${fmt(cal.xmin, 3)}–${fmt(cal.xmax, 3)}`,
          help('LOO(leave-one-out): 샘플 하나씩 빼고 나머지로 직선을 맞춘 뒤 뺀 샘플을 예측해 오차를 구합니다. 실제 예측 성능에 가까운 지표입니다.')) : null,
        chart,
        h('h3', {}, '학습 데이터 (실측 BET 와 Cdl 이 모두 있는 샘플)'),
        train.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '샘플'), h('th', { class: 'num' }, '실측 BET (m²/g)'), h('th', {}, 'BET 출처'), h('th', { class: 'num' }, xLabel), h('th', {}, '전해질'), h('th', { class: 'num' }, 'LOO 예측'), h('th', { class: 'num' }, '오차 %')),
          train.map((t, i) => {
            const lo = cal && cal.loo[i];
            return h('tr', {}, h('td', {}, PS.sampleLink(byId[t.id])), h('td', { class: 'num' }, fmt(t.y)), h('td', {}, [...new Set(t.ys.map((o) => o.which))].join('/')), h('td', { class: 'num' }, fmt(t.x, 4)),
              h('td', {}, [...new Set(t.xs.map((o) => o.cond.전해질))].join(', ')), h('td', { class: 'num' }, lo ? fmt(lo.pred) : '—'), h('td', { class: 'num' }, lo ? fmt(((lo.pred - lo.actual) / lo.actual) * 100, 1) : '—'));
          }))) : h('div', { class: 'muted' }, '없음')));
      const preds = cal && enough ? targets.map((t) => ({ ...t, p: cal.predict(t.x) })) : [];
      out.append(h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, 'BET 예측 (추정, 실측 아님)'),
        !targets.length ? h('div', { class: 'muted' }, 'Cdl 은 있지만 실측 BET 가 없는 샘플이 없습니다.')
          : !enough ? h('div', { class: 'muted' }, `예측 대상 ${targets.length}개가 있지만, 검증이 불충분해 값을 표시하지 않습니다.`)
            : h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '샘플'), h('th', { class: 'num' }, xLabel), h('th', { class: 'num' }, '예측 BET (m²/g)'), h('th', { class: 'num' }, '95 % 예측구간'), h('th', {}, '적용 범위')),
              preds.map((t) => h('tr', { style: t.p.inRange ? null : { color: '#9aa1ad' } }, h('td', {}, PS.sampleLink(byId[t.id])), h('td', { class: 'num' }, fmt(t.x, 4)),
                h('td', { class: 'num' }, fmt(t.p.y)), h('td', { class: 'num' }, !t.p.inRange ? '외삽 — 구간 신뢰 불가' : t.p.lo !== null ? `${fmt(t.p.lo)} – ${fmt(t.p.hi)}` : '—'),
                h('td', {}, t.p.inRange ? '학습 범위 안' : h('span', { class: 'flag' }, '학습 범위 밖 — 외삽, 신뢰할 수 없음'))))),
        h('p', { class: 'note' }, '예측값은 저장하지 않습니다. 이 샘플의 BET 를 실제로 측정해 학습 데이터에 더하면 보정이 개선됩니다. Cdl 은 전기화학적 정전용량이며 BET 비표면적의 직접 측정값이 아닙니다. 두 값의 관계는 재료·전해질·전극 조건에 따라 달라질 수 있습니다.')));
      if (train.length) {
        const xr = train.map((t) => t.x).concat(preds.map((t) => t.x));
        const lo = C.minOf(xr), hi = C.maxOf(xr), grid = [];
        for (let k = 0; k <= 40; k++) grid.push(lo + ((hi - lo) * k) / 40);
        const series = [{ name: '학습 샘플 (실측 BET)', color: '#888', x: train.map((t) => t.x), y: train.map((t) => t.y), mode: 'points', r: 0.1, noLegend: true }];
        if (cal) {
          series.push({ name: '보정 직선', color: '#333', x: grid, y: grid.map((x) => cal.slope * x + cal.intercept) });
          if (cal.s !== null) {
            series.push({ name: '95 % 예측구간', color: '#999', dash: '4 4', x: grid, y: grid.map((x) => cal.predict(x).lo) });
            series.push({ name: '', noLegend: true, color: '#999', dash: '4 4', x: grid, y: grid.map((x) => cal.predict(x).hi) });
          }
        }
        const markers = train.map((t) => ({ x: t.x, y: t.y, color: byId[t.id].color, label: `${byId[t.id].name}: 실측 ${fmt(t.y)} m²/g`, showLabel: train.length <= 12 }))
          .concat(preds.map((t) => ({ x: t.x, y: t.p.y, color: byId[t.id].color, shape: 'square', label: `${byId[t.id].name}: 예측 ${fmt(t.p.y)} m²/g${t.p.inRange ? '' : ' (범위 밖)'}`, showLabel: true })));
        PSChart.render(chart, { series, markers, bands: cal ? [{ from: cal.xmin, to: cal.xmax, color: '#2ca02c', label: '학습 범위' }] : [], xLabel, yLabel: 'BET 비표면적 (m²/g)',
          note: '● 실측  ■ 예측(추정)  초록 띠: 학습 범위', height: 340 });
      }
    }
    betSel.onchange = build; xSel.onchange = build;
    view.innerHTML = '';
    view.append(h('h1', {}, 'BET 예측 (검증형)'),
      h('div', { class: 'badge-info small' }, '사용자의 실측 BET 와 전기화학 Cdl 을 짝지어 직선 보정을 만들고, 교차검증으로 오차를 확인한 경우에만 Cdl 만 있는 샘플의 BET 를 추정합니다. 샘플이 적거나 학습 범위를 벗어나면 그 사실을 표시합니다.'),
      h('div', { class: 'row', style: { margin: '10px 0' } }, h('label', {}, '실측 BET'), betSel, h('label', {}, '예측 변수'), xSel,
        help('Cdl 은 전극에 올린 분말 양에 비례하므로 BET(m²/g)와 비교할 때는 로딩으로 나눈 값(mF/mg)을 기본으로 씁니다.')),
      out);
    build();
  });


  // ------------------------------------------------------------ XRF 성적서 일괄 가져오기
  PS.route('/import/xrf', async (p, view) => {
    PS.crumb([{ label: '샘플', href: '#/samples' }, { label: 'XRF 성적서 일괄 가져오기' }]);
    let samples = await loadSamples();
    const cfg = (PS.typeMap.XRF || {}).config || {};
    const items = []; // {name, path?, file?, status, report, error, target, newName, dup, result}
    const dirIn = h('input', { type: 'text', placeholder: '성적서 폴더 경로 (예: D:\\보관소\\XRF\\2026-11)', style: { flex: 1, minWidth: '320px' } });
    const recur = h('input', { type: 'checkbox' });
    const fileIn = h('input', { type: 'file', multiple: true, accept: '.pdf,.txt' });
    const attMode = PS.select([['link', '원본 경로만 연결 (기본)'], ['copy', '앱 폴더에 복사'], ['none', '첨부 안 함']], 'link');
    const listBox = h('div'), actBox = h('div');
    const keyOf = (s) => C.nameKey(s);
    const stem = (n) => String(n || '').replace(/\.[^.]+$/, '').replace(/[_\s-]*METAL$/i, '');
    async function existingXrf() {
      const ids = samples.map((s) => s.id);
      if (!ids.length) return [];
      return (await PS.api.post('/metrics', { sample_ids: ids })).measurements.filter((m) => m.analysis_code === 'XRF');
    }
    async function readAll() {
      const xrfs = await existingXrf();
      for (const it of items) {
        if (it.report || it.error) continue;
        it.status = '읽는 중';
        render();
        try {
          let r;
          if (it.path) r = await PS.api.post('/files/read', { path: it.path });
          else if (/\.pdf$/i.test(it.name)) r = await PS.api.post('/extract', { file_name: it.name, content_b64: await PS.readFileAsB64(it.file) });
          else r = { text: await PS.readFileAsText(it.file), method: 'text' };
          it.method = r.method;
          it.report = C.parseXrfReport(r.text);
          if (!it.report.rows.length) throw new Error('성분 표를 찾지 못했습니다');
          // 샘플 매칭: 성적서 샘플명 → 파일 이름 순으로 정규화 이름 일치 확인
          const keys = [it.report.meta.sample_name, stem(it.name)].filter(Boolean).map(keyOf);
          const hit = samples.find((s) => keys.includes(keyOf(s.name)));
          it.target = hit ? String(hit.id) : '';
          it.newName = (it.report.meta.sample_name || stem(it.name)).normalize('NFKC').trim();
          const da = it.report.meta.date_analyzed;
          it.dup = hit ? xrfs.find((m) => m.sample_id === hit.id && ((m.source && m.source.file_name === it.name) ||
            (m.values && m.values.report && m.values.report.date_analyzed_raw && m.values.report.date_analyzed_raw === it.report.meta.date_analyzed_raw))) : null;
          if (it.dup) it.target = '';
          it.status = '확인 필요';
          void da;
        } catch (e) { it.error = e.message; it.status = '읽기 실패'; }
        render();
      }
    }
    function render() {
      listBox.innerHTML = '';
      if (!items.length) { listBox.appendChild(h('div', { class: 'muted' }, '폴더 경로를 넣거나 파일을 고르세요.')); actBox.innerHTML = ''; return; }
      const tbl = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '파일'), h('th', {}, '성적서 샘플명'), h('th', {}, '분석일'), h('th', {}, '주성분·순도'), h('th', { class: 'num' }, 'Cl'), h('th', { class: 'num' }, 'Si'), h('th', { class: 'num' }, 'Na'),
        h('th', {}, '저장할 샘플', help('샘플명이 정확히 맞는 샘플은 자동으로 고릅니다(전각·기호·공백 무시). 맞는 샘플이 없으면 “건너뛰기”가 기본이며, 새 샘플로 만들지 직접 고르세요.')), h('th', {}, '결과')));
      for (const it of items) {
        let cells = [h('td', {}, '—'), h('td', {}, '—'), h('td', {}, '—'), h('td'), h('td'), h('td')];
        if (it.report) {
          const built = PS.xrfRecord(it.report, cfg);
          const imp = built.computed.details.impurities;
          const cell = (el) => h('td', { class: 'num' }, imp[el] ? (C.isNum(imp[el].value) ? fmt(imp[el].value, 3) : C.XRF_STATUS[imp[el].status]) : h('span', { class: 'muted' }, '보고 없음'));
          const pur = built.computed.metrics.purity;
          cells = [h('td', {}, it.report.meta.sample_name || h('span', { class: 'muted' }, '(없음)')), h('td', {}, it.report.meta.date_analyzed ? it.report.meta.date_analyzed.date : '—'),
            h('td', {}, built.values.main_components.join('+') || '—', pur ? ` ${fmt(pur.value)} %` : '', built.values.main_auto ? h('span', { class: 'flag', title: built.values.main_auto_reason }, ' (자동)') : null),
            cell('Cl'), cell('Si'), cell('Na')];
        }
        const sel = PS.select([['', it.dup ? '건너뛰기 (이미 가져온 성적서로 보임)' : '건너뛰기']].concat([['__new', `새 샘플 만들기: ${it.newName || ''}`]]).concat(samples.map((s) => [String(s.id), s.name])), it.target || '', { disabled: !it.report || !!it.result });
        sel.onchange = () => { it.target = sel.value; render(); };
        const nameIn = it.target === '__new' && !it.result ? h('input', { type: 'text', value: it.newName, class: 'sm', style: { width: '140px' }, oninput: (e) => { it.newName = e.target.value; } }) : null;
        tbl.appendChild(h('tr', {}, h('td', { title: it.path || '' }, it.name), ...cells, h('td', {}, sel, nameIn, it.dup ? h('div', { class: 'flag' }, `같은 샘플에 같은 성적서 기록 있음: `, h('a', { href: '#/m/' + it.dup.id }, '#' + it.dup.id)) : null),
          h('td', {}, it.result ? (it.result.ok ? h('a', { href: '#/m/' + it.result.id, style: { color: '#1e8e4e' } }, '✓ 저장됨 #' + it.result.id) : h('span', { style: { color: '#c0392b' } }, '✕ ' + it.result.error))
            : it.error ? h('span', { style: { color: '#c0392b' } }, it.error) : it.status || '')));
      }
      listBox.appendChild(h('div', { class: 'tablewrap' }, tbl));
      const chosen = items.filter((it) => it.report && it.target && !it.result);
      actBox.innerHTML = '';
      actBox.append(h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', {}, '원본 첨부'), attMode,
        h('button', { class: 'primary', disabled: !chosen.length, onclick: saveAll }, `선택한 ${chosen.length}개 저장`),
        h('span', { class: 'note' }, '저장하면 샘플별 XRF 기록이 만들어지고 상태가 “자료 있음”이 됩니다. 추출값은 “추출” 출처로 표시되며 기록 화면에서 확인·수정할 수 있습니다.')));
    }
    async function saveAll() {
      const chosen = items.filter((it) => it.report && it.target && !it.result);
      if (!(await PS.confirm(`${chosen.length}개 성적서를 저장할까요?`, { detail: `새 샘플 ${chosen.filter((x) => x.target === '__new').length}개가 만들어집니다. 저장 전 자동 백업을 만듭니다.` }))) return;
      try { await PS.api.post('/backups', { reason: 'XRF 일괄 가져오기 직전 자동 백업' }); } catch (e) { if (!(await PS.confirm('백업 생성에 실패했습니다. 그래도 계속할까요?', { detail: e.message }))) return; }
      for (const it of chosen) {
        try {
          let sid = it.target;
          if (sid === '__new') {
            if (!it.newName.trim()) throw new Error('새 샘플 이름이 비어 있습니다');
            const ex = samples.find((s) => keyOf(s.name) === keyOf(it.newName));
            sid = ex ? ex.id : (await PS.api.post('/samples', { name: it.newName.trim(), notes: `XRF 성적서 일괄 가져오기로 생성 (${it.name})` })).id;
          }
          const built = PS.xrfRecord(it.report, cfg);
          const da = it.report.meta.date_analyzed;
          const id = (await PS.api.post('/measurements', {
            sample_id: +sid, analysis_code: 'XRF', title: `XRF ${it.report.meta.sample_name || stem(it.name)}`, measured_on: da ? da.date : null, measured_on_source: da ? 'file' : 'none',
            values: built.values, computed: built.computed, notes: '',
            source: { method: it.method || 'pdf_text', file_name: it.name, edited: false, report_format: it.report.format, report_sample: it.report.meta.sample_name || null, date_from: da ? `${it.name} (Date analyzed)` : null, imported: 'XRF 일괄 가져오기' },
          })).id;
          if (attMode.value !== 'none') {
            try {
              const body = { measurement_id: id, mode: attMode.value, role: '성적서', file_name: it.name };
              if (it.path) body.path = it.path;
              else { body.mode = 'copy'; body.content_b64 = await PS.readFileAsB64(it.file); }
              if (it.path || attMode.value === 'copy') await PS.api.post('/attachments', body);
            } catch (e) { it.attErr = e.message; }
          }
          it.result = { ok: true, id, note: it.attErr ? '첨부 실패: ' + it.attErr : '' };
        } catch (e) { it.result = { ok: false, error: e.message }; }
        render();
      }
      samples = await loadSamples();
      const ok = chosen.filter((x) => x.result && x.result.ok).length;
      PS.toast(`${ok}/${chosen.length}개 저장${ok < chosen.length ? ' — 실패한 행을 확인하세요' : ''}`, ok === chosen.length ? 'ok' : 'bad', 8000);
      render();
    }
    view.innerHTML = '';
    view.append(h('h1', {}, 'XRF 성적서 일괄 가져오기'),
      h('p', { class: 'note' }, 'Rigaku SQX(“SQX Calculation Result”) 성적서 PDF 를 여러 개 읽어 샘플별 XRF 기록으로 저장합니다. 측정일은 성적서의 “Date analyzed”를 쓰고, Trace·불검출 성분은 0 이 아니라 값 없음으로 저장합니다.'),
      h('div', { class: 'panel' },
        h('div', { class: 'row' }, dirIn, h('label', {}, recur, ' 하위 폴더 포함'), h('button', { onclick: async () => {
          if (!dirIn.value.trim()) return;
          try {
            const r = await PS.api.post('/files/list', { dir: dirIn.value, recursive: recur.checked, exts: ['.pdf'] });
            for (const f of r.files) if (!items.some((x) => x.path === f.path)) items.push({ name: f.name, path: f.path });
            if (!r.files.length) PS.toast('PDF 가 없습니다', 'bad');
            render(); await readAll();
          } catch (e) { PS.toast(e.message, 'bad'); }
        } }, '폴더에서 PDF 찾기')),
        h('div', { class: 'row', style: { marginTop: '8px' } }, fileIn, h('button', { onclick: async () => {
          for (const f of fileIn.files) items.push({ name: f.name, file: f });
          fileIn.value = '';
          render(); await readAll();
        } }, '선택한 파일 추가'), h('span', { class: 'small muted' }, '브라우저에서 고른 파일은 원래 경로를 알 수 없어 “앱 폴더에 복사” 또는 첨부 없음만 가능합니다.'),
          h('button', { class: 'small', onclick: () => { items.length = 0; render(); } }, '목록 비우기'))),
      listBox, actBox);
    render();
  });

  // ------------------------------------------------------------ 시리즈
  PS.route('/series', async (p, view) => {
    PS.crumb([{ label: '시리즈' }]);
    const [series, samples] = await Promise.all([loadSeries(), loadSamples()]);
    const byId = Object.fromEntries(samples.map((s) => [s.id, s]));
    const editSeries = (se) => {
      const name = h('input', { type: 'text', value: se ? se.name : '' });
      const desc = h('textarea', { class: 'prose', rows: 2 }, se ? se.description : '');
      return PS.modal({ title: se ? '시리즈 수정' : '새 시리즈', body: h('div', { class: 'form' }, h('label', {}, '이름'), name, h('label', {}, '설명'), desc), onSave: async () => {
        if (!name.value.trim()) throw new Error('이름을 입력하세요');
        if (se) await PS.api.put('/series/' + se.id, { name: name.value.trim(), description: desc.value });
        else await PS.api.post('/series', { name: name.value.trim(), description: desc.value });
      } });
    };
    view.innerHTML = '';
    view.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, '시리즈 (연구 그룹)'), h('button', { class: 'primary', onclick: async () => { if (await editSeries()) PS.refresh(); } }, '+ 새 시리즈')),
      h('p', { class: 'note' }, '시리즈는 샘플을 묶는 분류입니다. 파생·분기·결합 관계와는 따로 관리되며, 한 샘플이 여러 시리즈에 속할 수 있습니다.'),
      series.length ? h('div', { class: 'cards' }, series.map((se) => {
        const add = PS.select([['', '샘플 추가…']].concat(samples.filter((s) => !se.sample_ids.includes(s.id)).map((s) => [s.id, s.name])), '');
        add.onchange = async () => { if (add.value) { await PS.api.post(`/series/${se.id}/members`, { sample_id: +add.value }); PS.refresh(); } };
        return h('div', { class: 'card' }, h('h3', {}, se.name, h('span', { class: 'grow' }), h('button', { class: 'small', onclick: async () => { if (await editSeries(se)) PS.refresh(); } }, '수정'),
          h('button', { class: 'small link', onclick: async () => {
            if (!(await PS.confirm(`시리즈 “${se.name}”을(를) 삭제할까요?`, { danger: true, detail: '샘플은 지워지지 않고 묶음만 해제됩니다.' }))) return;
            await PS.api.del('/series/' + se.id); PS.refresh();
          } }, '삭제')),
          se.description ? h('p', { class: 'note' }, se.description) : null,
          h('div', { class: 'row' }, se.sample_ids.map((id) => byId[id] ? h('span', { class: 'chip' }, PS.sampleLink(byId[id]), ' ', h('button', { class: 'small link', onclick: async () => { await PS.api.del(`/series/${se.id}/members/${id}`); PS.refresh(); } }, '×')) : null)),
          h('div', { class: 'row', style: { marginTop: '8px' } }, add, h('a', { href: `#/compare?s=${se.sample_ids.join(',')}` }, '이 시리즈 비교')));
      })) : h('div', { class: 'empty' }, '시리즈가 없습니다.'));
  });

  // ------------------------------------------------------------ 설정 · 백업
  PS.route('/settings', async (p, view) => {
    PS.crumb([{ label: '설정·백업' }]);
    const [bk, trash, audit] = await Promise.all([PS.api.get('/backups'), PS.api.get('/trash'), PS.api.get('/audit?limit=60')]);
    await PS.loadMeta();
    const meta = PS.meta;
    // 백업
    const bkTbl = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '백업'), h('th', {}, '만든 시각'), h('th', {}, '사유'), h('th', {}, '검증'), h('th', {}, '샘플/측정 수'), h('th')),
      bk.backups.map((b) => h('tr', {}, h('td', { class: 'mono' }, b.name), h('td', {}, (b.created_at || '').replace('T', ' ')), h('td', {}, b.reason || ''),
        h('td', {}, b.verified ? h('span', { style: { color: '#1e8e4e' } }, '✓ 무결성·행 수 일치') : h('span', { class: 'flag' }, '검증 실패/정보 없음')),
        h('td', {}, b.counts ? `${b.counts.samples ?? '?'} / ${b.counts.measurements ?? '?'}` : ''),
        h('td', {}, h('button', { class: 'small', onclick: async () => {
          try { const r = await PS.api.post('/backups/verify', { name: b.name }); PS.toast(r.ok ? `검증 통과: integrity ${r.integrity}, 샘플 ${r.counts.samples}, 측정 ${r.counts.measurements}` : '검증 실패: ' + (r.integrity || r.error), r.ok ? 'ok' : 'bad', 6000); }
          catch (e) { PS.toast(e.message, 'bad'); }
        } }, '검증'), ' ', h('button', { class: 'small danger', onclick: async () => {
          if (!(await PS.confirm(`현재 데이터를 백업 “${b.name}” 시점으로 되돌릴까요?`, { danger: true, okLabel: '복구', detail: '복구 전에 현재 데이터를 자동으로 백업합니다(되돌리기 가능). 백업은 무결성 검사 후 적용되고, 적용 후 행 수를 다시 비교합니다.' }))) return;
          try {
            const r = await PS.api.post('/backups/restore', { name: b.name });
            PS.toast(r.verified ? `복구 완료·검증 통과. 복구 전 상태는 ${r.safety_backup} 에 보관` : '복구했지만 검증 불일치: ' + JSON.stringify(r.count_diff), r.verified ? 'ok' : 'bad', 9000);
            PS.refresh();
          } catch (e) { PS.toast('복구 실패: ' + e.message, 'bad', 9000); }
        } }, '이 시점으로 복구')))));
    // 기본값
    const s = meta.settings;
    const sup = h('input', { type: 'text', value: s.reagent_default_supplier || 'H사' });
    const heat = s.heat_treatment_defaults || {};
    const ht = { temperature: h('input', { type: 'text', class: 'sm', value: (heat.temperature || {}).value }), ramp_min: h('input', { type: 'text', class: 'sm', value: (heat.ramp_min || {}).value }), hold_min: h('input', { type: 'text', class: 'sm', value: (heat.hold_min || {}).value }) };
    const ecd = s.ec_defaults || {};
    const ec = Object.fromEntries(PS.EC_FIELDS.map((f) => [f.key, h('input', { type: 'text', value: (ecd[f.key] || {}).value ?? '' })]));
    const defBar = PS.saveBar({ onSave: async () => {
      await PS.api.put('/settings/reagent_default_supplier', { value: sup.value.trim() || 'H사' });
      await PS.api.put('/settings/heat_treatment_defaults', { value: { temperature: { value: C.num(ht.temperature.value), unit: '°C' }, ramp_min: { value: C.num(ht.ramp_min.value), unit: 'min' }, hold_min: { value: C.num(ht.hold_min.value), unit: 'min' } } });
      const ev = {};
      for (const f of PS.EC_FIELDS) if (ec[f.key].value.trim() !== '') ev[f.key] = { value: f.num && C.isNum(C.num(ec[f.key].value)) ? C.num(ec[f.key].value) : ec[f.key].value.trim(), unit: f.unit || '' };
      await PS.api.put('/settings/ec_defaults', { value: ev });
      await PS.loadMeta();
    } });
    const defPanel = h('div', {}, h('div', { class: 'form' },
      h('label', {}, '시약 기본 제조사'), sup,
      h('label', {}, '열처리 기본값'), h('div', { class: 'row' }, ht.temperature, '°C · 승온', ht.ramp_min, '분 · 유지', ht.hold_min, '분'),
      ...PS.EC_FIELDS.flatMap((f) => [h('label', {}, '전기화학 기본 ' + f.label), ec[f.key]])),
    h('p', { class: 'note' }, '기본값은 새로 만드는 단계·세션에만 “기본값” 표시와 함께 채워집니다. 이미 저장된 기록은 바뀌지 않습니다.'));
    defPanel.addEventListener('input', () => defBar.markDirty());
    // 분석 종류
    const typeTbl = h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '코드'), h('th', {}, '이름'), h('th', {}, '그룹'), h('th', {}, '지표'), h('th', {}, '사용')),
      PS.types.map((t) => {
        const chk = h('input', { type: 'checkbox', checked: !!t.active });
        chk.onchange = async () => { try { await PS.api.put('/analysis_types/' + t.code, { active: chk.checked ? 1 : 0 }); await PS.loadMeta(); PS.toast('저장됨', 'ok'); } catch (e) { PS.toast(e.message, 'bad'); chk.checked = !chk.checked; } };
        return h('tr', {}, h('td', { class: 'mono' }, t.code), h('td', {}, t.name), h('td', {}, t.group_name), h('td', {}, (t.config.metrics || []).map((m) => m.label).join(', ')), h('td', {}, chk));
      }));
    const addType = async () => {
      const code = h('input', { type: 'text', placeholder: '예: RAMAN' }), name = h('input', { type: 'text', placeholder: '예: 라만' }), group = h('input', { type: 'text', value: '사용자 정의' });
      const fields = h('textarea', { rows: 4, placeholder: '항목을 한 줄에 하나씩: 키, 이름, 단위\n예)\nid_ig, ID/IG 비, \npeak_pos, 주 피크 위치, cm⁻¹' });
      return PS.modal({ title: '분석 종류 추가', body: h('div', {}, h('div', { class: 'form' }, h('label', {}, '코드(영문)'), code, h('label', {}, '이름'), name, h('label', {}, '그룹'), group, h('label', {}, '입력 항목'), fields),
        h('p', { class: 'note' }, '추가한 분석은 일반 입력 화면(값·단위·조건·첨부)으로 기록하고, 비교·패턴 탐색에 자동으로 포함됩니다.')), onSave: async () => {
        const fl = fields.value.split(/\n/).map((l) => l.split(',').map((x) => x.trim())).filter((a) => a[0]).map(([key, label, unit]) => ({ key: key.replace(/\W/g, '_'), label: label || key, unit: unit || '', help: '', decimals: 2 }));
        await PS.api.post('/analysis_types', { code: code.value, name: name.value, group_name: group.value, config: { tool: 'generic', fields: fl, metrics: fl } });
        await PS.loadMeta();
      } });
    };
    view.innerHTML = '';
    view.append(h('h1', {}, '설정 · 백업'),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '백업 · 복구 ', help('백업은 SQLite 백업 기능으로 만들고, 만든 직후 무결성 검사와 테이블별 행 수 비교로 검증합니다. 마이그레이션 전과 복구 전에도 자동 백업됩니다.')),
        h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
          try { const r = await PS.api.post('/backups', { reason: '수동 백업' }); PS.toast(r.verified ? `백업 완료·검증 통과: ${r.name}` : '백업은 만들었지만 검증 실패', r.verified ? 'ok' : 'bad', 6000); PS.refresh(); }
          catch (e) { PS.toast('백업 실패: ' + e.message, 'bad'); }
        } }, '지금 백업'), h('span', { class: 'small muted mono' }, '백업 폴더: ' + bk.backup_dir)),
        h('p', { class: 'note' }, `데이터 폴더: ${meta.data_dir}. DB 백업에는 “앱에 복사”한 첨부 파일 자체는 들어가지 않습니다(data/files 폴더를 함께 보관하세요). 앱은 복사본 파일을 지우지 않습니다. 경로 연결 첨부의 원본은 사용자의 보관소에 있습니다.`),
        h('div', { class: 'tablewrap', style: { maxHeight: '300px' } }, bkTbl)),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '휴지통'),
        trash.samples.length || trash.measurements.length ? h('div', {},
          trash.samples.map((x) => h('div', { class: 'row small' }, h('span', { class: 'chip' }, '샘플'), x.name, h('span', { class: 'muted' }, x.deleted_at.replace('T', ' ')), h('button', { class: 'small', onclick: async () => { await PS.api.post(`/samples/${x.id}/restore`); PS.toast('복원했습니다', 'ok'); PS.refresh(); } }, '복원'))),
          trash.measurements.map((x) => h('div', { class: 'row small' }, h('span', { class: 'chip' }, '측정'), `${x.sample_name} · ${x.analysis_code} ${x.title || '#' + x.id}`, h('span', { class: 'muted' }, x.deleted_at.replace('T', ' ')),
            h('button', { class: 'small', onclick: async () => { try { await PS.api.post(`/measurements/${x.id}/restore`); PS.toast('복원했습니다', 'ok'); PS.refresh(); } catch (e) { PS.toast(e.message, 'bad'); } } }, '복원'))))
          : h('div', { class: 'muted' }, '휴지통이 비어 있습니다.')),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, 'AI 연구 맥락 내보내기 ', help('샘플·관계·합성 단계·분석 상태·측정 조건·기록값·계산값(식 포함)·출처·연구자 해석·AI 가설을 분리된 JSON 으로 내보냅니다. 값이 없는 항목은 비워 두며 0 으로 채우지 않습니다.')),
        h('button', { onclick: async () => { const d = await PS.api.get('/export/context'); PS.download(`pattern-seeker-context-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(d, null, 1)); } }, '전체 샘플 JSON 내려받기')),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '기본값'), defPanel, defBar.el),
      h('div', { class: 'panel' }, h('div', { class: 'row' }, h('h2', { class: 'grow', style: { marginTop: 0 } }, '분석 종류'), h('button', { onclick: async () => { if (await addType()) PS.refresh(); } }, '+ 분석 종류 추가')), typeTbl),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '기능 상태'),
        h('div', {}, 'PDF 텍스트 추출: 내장 추출기 사용 가능 (장비 “인쇄→PDF” 양식)', meta.capabilities.pypdf ? ' + pypdf (보조)' : h('span', { class: 'muted' }, ' · pypdf 없음 — 내장 추출기로 못 읽는 PDF 는 pip install pypdf 또는 텍스트 붙여넣기')),
        h('div', {}, '이미지 OCR: ', meta.capabilities.ocr ? '사용 가능 (Tesseract)' : h('span', { class: 'flag' }, '사용 불가 — Tesseract + pytesseract 설치 시 활성화. 없으면 값을 직접 입력하세요')),
        h('div', { class: 'small muted' }, `스키마 버전 v${meta.schema_version}`)),
      h('div', { class: 'panel' }, h('h2', { style: { marginTop: 0 } }, '최근 변경 이력'), h('div', { class: 'tablewrap', style: { maxHeight: '260px' } },
        h('table', { class: 'tbl small' }, h('tr', {}, h('th', {}, '시각'), h('th', {}, '대상'), h('th', {}, '작업')), audit.entries.map((e) => h('tr', {}, h('td', {}, e.ts.replace('T', ' ')), h('td', {}, `${e.entity} ${e.entity_id ?? ''}`), h('td', {}, e.action)))))));
  });

  PS.start();
})(window.PS);
