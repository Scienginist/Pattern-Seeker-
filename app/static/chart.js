/* 가벼운 SVG 그래프 (오프라인, 외부 라이브러리 없음)
 * PSChart.render(container, spec) -> { redraw(spec), destroy() }
 * spec: { series:[{name,color,x,y,dash,width,opacity,mode:'line'|'points'|'both',axis:'y'|'y2',hidden}],
 *         xLabel, yLabel, y2Label, note, markers:[{x,y,color,label,shape}], vlines:[{x,color,label}],
 *         bands:[{from,to,color,label}], onClick(x,y,evt), clickMode:bool, height, xDomain, yDomain, bars }
 */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const fin = Number.isFinite;

  function niceTicks(lo, hi, count) {
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    const span = hi - lo, step0 = span / Math.max(2, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const r = step0 / mag;
    const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return { ticks: out, step };
  }
  function tickFmt(v, step) {
    if (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0)) return v.toExponential(1);
    const d = Math.max(0, -Math.floor(Math.log10(step)));
    return v.toFixed(Math.min(d, 6));
  }

  function extent(series, key, filter) {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) {
      if (s.hidden || (filter && !filter(s))) continue;
      const arr = s[key] || [];
      for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (fin(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    }
    return [lo, hi];
  }

  // 픽셀 열 단위 min/max 축약으로 큰 데이터도 빠르게
  function decimate(xs, ys, sx, sy, pxw) {
    const n = Math.min(xs.length, ys.length);
    if (n <= pxw * 4) {
      const pts = [];
      for (let i = 0; i < n; i++) pts.push(fin(xs[i]) && fin(ys[i]) ? [sx(xs[i]), sy(ys[i])] : null);
      return pts;
    }
    const pts = [];
    let col = null, mn = null, mx = null, first = null, last = null;
    const flush = () => { if (col === null) return; pts.push(first); if (mn !== first && mn !== last) pts.push(mn); if (mx !== first && mx !== last && mx !== mn) pts.push(mx); if (last !== first) pts.push(last); };
    for (let i = 0; i < n; i++) {
      if (!fin(xs[i]) || !fin(ys[i])) { flush(); col = null; pts.push(null); continue; }
      const px = sx(xs[i]), py = sy(ys[i]), c = Math.round(px);
      const p = [px, py];
      if (c !== col) { flush(); col = c; first = mn = mx = last = p; } else { last = p; if (py < mn[1]) mn = p; if (py > mx[1]) mx = p; }
    }
    flush();
    return pts;
  }
  function pathOf(pts) {
    let d = '', pen = false;
    for (const p of pts) {
      if (!p) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
      pen = true;
    }
    return d;
  }

  function render(container, spec) {
    container.classList.add('ps-chart');
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'ps-chart-plot';
    const legend = document.createElement('div');
    legend.className = 'ps-chart-legend';
    const info = document.createElement('div');
    info.className = 'ps-chart-info';
    container.append(wrap, info, legend);
    let zoom = null; // {x:[a,b], y:[a,b]}
    let cur = spec;

    function draw() {
      const s = cur;
      const W = Math.max(280, wrap.clientWidth || container.clientWidth || 600);
      const H = s.height || Math.round(Math.min(440, Math.max(240, W * 0.55)));
      wrap.innerHTML = '';
      const hasY2 = s.series.some((x) => x.axis === 'y2' && !x.hidden);
      const m = { l: 62, r: hasY2 ? 62 : 16, t: 12, b: 44 };
      const pw = W - m.l - m.r, ph = H - m.t - m.b;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'ps-svg', role: 'img' }, wrap);
      let [x0, x1] = s.xDomain || extent(s.series, 'x');
      let [y0, y1] = s.yDomain || extent(s.series, 'y', (q) => q.axis !== 'y2');
      for (const mk of s.markers || []) { if (fin(mk.y) && mk.axis !== 'y2') { y0 = Math.min(y0, mk.y); y1 = Math.max(y1, mk.y); } }
      let [z0, z1] = extent(s.series, 'y', (q) => q.axis === 'y2');
      if (!fin(x0)) { x0 = 0; x1 = 1; }
      if (!fin(y0)) { y0 = 0; y1 = 1; }
      if (zoom) { [x0, x1] = zoom.x; [y0, y1] = zoom.y; }
      else {
        const py = (y1 - y0) * 0.05 || 1; y0 -= py; y1 += py;
        if (fin(z0)) { const pz = (z1 - z0) * 0.05 || 1; z0 -= pz; z1 += pz; }
        if (x0 === x1) { x0 -= 1; x1 += 1; }
      }
      const sx = (v) => m.l + ((v - x0) / (x1 - x0)) * pw;
      const sy = (v) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
      const sz = (v) => m.t + ph - ((v - z0) / (z1 - z0)) * ph;
      const ix = (px) => x0 + ((px - m.l) / pw) * (x1 - x0);
      const iy = (py) => y0 + ((m.t + ph - py) / ph) * (y1 - y0);

      const clipId = 'c' + Math.random().toString(36).slice(2);
      const defs = el('defs', {}, svg);
      el('rect', { x: m.l, y: m.t, width: pw, height: ph }, el('clipPath', { id: clipId }, defs));
      el('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'ps-plotbg' }, svg);

      const xt = niceTicks(x0, x1, Math.max(3, Math.floor(pw / 80)));
      const yt = niceTicks(y0, y1, Math.max(3, Math.floor(ph / 45)));
      const g = el('g', { class: 'ps-axis' }, svg);
      for (const t of xt.ticks) {
        el('line', { x1: sx(t), x2: sx(t), y1: m.t, y2: m.t + ph, class: 'ps-grid' }, g);
        el('text', { x: sx(t), y: m.t + ph + 16, 'text-anchor': 'middle' }, g).textContent = tickFmt(t, xt.step);
      }
      for (const t of yt.ticks) {
        el('line', { x1: m.l, x2: m.l + pw, y1: sy(t), y2: sy(t), class: 'ps-grid' }, g);
        el('text', { x: m.l - 6, y: sy(t) + 4, 'text-anchor': 'end' }, g).textContent = tickFmt(t, yt.step);
      }
      if (hasY2 && fin(z0)) {
        const zt = niceTicks(z0, z1, Math.max(3, Math.floor(ph / 45)));
        for (const t of zt.ticks) el('text', { x: m.l + pw + 6, y: sz(t) + 4, 'text-anchor': 'start' }, g).textContent = tickFmt(t, zt.step);
        el('text', { x: W - 8, y: m.t + ph / 2, transform: `rotate(90 ${W - 8} ${m.t + ph / 2})`, 'text-anchor': 'middle', class: 'ps-label' }, g).textContent = s.y2Label || '';
      }
      el('text', { x: m.l + pw / 2, y: H - 6, 'text-anchor': 'middle', class: 'ps-label' }, g).textContent = s.xLabel || '';
      el('text', { x: 12, y: m.t + ph / 2, transform: `rotate(-90 12 ${m.t + ph / 2})`, 'text-anchor': 'middle', class: 'ps-label' }, g).textContent = s.yLabel || '';

      const plot = el('g', { 'clip-path': `url(#${clipId})` }, svg);
      for (const b of s.bands || []) {
        el('rect', { x: Math.min(sx(b.from), sx(b.to)), y: m.t, width: Math.abs(sx(b.to) - sx(b.from)), height: ph, fill: b.color || '#f5c542', opacity: 0.18 }, plot);
      }
      for (const v of s.vlines || []) {
        el('line', { x1: sx(v.x), x2: sx(v.x), y1: m.t, y2: m.t + ph, stroke: v.color || '#555', 'stroke-dasharray': '4 3' }, plot);
        if (v.label) el('text', { x: sx(v.x) + 4, y: m.t + 12, class: 'ps-vlabel' }, plot).textContent = v.label;
      }
      if (s.bars) {
        // 막대 그래프: s.bars = {categories:[..], groups:[{name,color,values:[..]}]}
        const cats = s.bars.categories, groups = s.bars.groups;
        const bw = pw / Math.max(1, cats.length);
        const gw = (bw * 0.8) / Math.max(1, groups.length);
        cats.forEach((c, ci) => {
          groups.forEach((gr, gi) => {
            const v = gr.values[ci];
            const bx = m.l + ci * bw + bw * 0.1 + gi * gw;
            if (!fin(v)) {
              el('text', { x: bx + gw / 2, y: sy(Math.max(y0, 0)) - 4, 'text-anchor': 'middle', class: 'ps-na' }, plot).textContent = '값 없음';
              return;
            }
            const top = sy(Math.max(v, 0)), bot = sy(Math.min(v, 0));
            const r = el('rect', { x: bx, y: top, width: Math.max(1, gw - 2), height: Math.max(1, bot - top), fill: gr.colors ? gr.colors[ci] : gr.color }, plot);
            el('title', {}, r).textContent = `${c} · ${gr.name}: ${v}`;
          });
        });
        // 카테고리 라벨 대신 x축 눈금 숨김
        g.querySelectorAll('text').forEach((t) => { if (+t.getAttribute('y') === m.t + ph + 16) t.remove(); });
        cats.forEach((c, ci) => { el('text', { x: m.l + ci * bw + bw / 2, y: m.t + ph + 16, 'text-anchor': 'middle', class: 'ps-cat' }, g).textContent = c.length > 14 ? c.slice(0, 13) + '…' : c; });
      }
      for (const se of s.series) {
        if (se.hidden) continue;
        const yy = se.axis === 'y2' ? sz : sy;
        const mode = se.mode || 'line';
        if (mode !== 'points') {
          const d = pathOf(decimate(se.x, se.y, sx, yy, pw));
          el('path', { d, fill: 'none', stroke: se.color, 'stroke-width': se.width || 1.6, 'stroke-dasharray': se.dash || null, opacity: se.opacity || 1, 'stroke-linejoin': 'round' }, plot);
        }
        if (mode === 'points' || mode === 'both') {
          for (let i = 0; i < se.x.length; i++) {
            if (!fin(se.x[i]) || !fin(se.y[i])) continue;
            const c = el('circle', { cx: sx(se.x[i]), cy: yy(se.y[i]), r: se.r || 3.5, fill: se.color, opacity: se.opacity || 1 }, plot);
            if (se.labels) el('title', {}, c).textContent = se.labels[i];
          }
        }
      }
      for (const mk of s.markers || []) {
        if (!fin(mk.x) || !fin(mk.y)) continue;
        const yy = mk.axis === 'y2' ? sz : sy;
        const c = el(mk.shape === 'square' ? 'rect' : 'circle', mk.shape === 'square'
          ? { x: sx(mk.x) - 4, y: yy(mk.y) - 4, width: 8, height: 8, fill: mk.color || '#000', stroke: '#fff' }
          : { cx: sx(mk.x), cy: yy(mk.y), r: mk.r || 5, fill: mk.color || '#000', stroke: '#fff', 'stroke-width': 1.5 }, svg);
        if (mk.label) {
          el('title', {}, c).textContent = mk.label;
          if (mk.showLabel) el('text', { x: sx(mk.x) + 7, y: yy(mk.y) - 6, class: 'ps-mlabel' }, svg).textContent = mk.label;
        }
      }
      if (s.note) el('text', { x: m.l + pw - 6, y: m.t + 14, 'text-anchor': 'end', class: 'ps-note' }, svg).textContent = s.note;

      // 상호작용: 좌표 표시, 드래그 확대, 더블클릭 원복, 클릭 모드
      const ov = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', class: s.clickMode ? 'ps-click' : 'ps-zoomable' }, svg);
      let drag = null, box = null;
      const pos = (e) => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
      ov.addEventListener('mousemove', (e) => {
        const [px, py] = pos(e);
        info.textContent = `x = ${tickFmt(ix(px), xt.step / 100)}, y = ${tickFmt(iy(py), yt.step / 100)}` + (s.clickMode ? '  · 클릭: 점 추가' : '  · 드래그: 확대 · 더블클릭: 원래대로');
        if (drag) {
          const xa = Math.min(drag[0], px), xb = Math.max(drag[0], px), ya = Math.min(drag[1], py), yb = Math.max(drag[1], py);
          if (!box) box = el('rect', { class: 'ps-zoombox' }, svg);
          box.setAttribute('x', xa); box.setAttribute('y', ya); box.setAttribute('width', xb - xa); box.setAttribute('height', yb - ya);
        }
      });
      ov.addEventListener('mouseleave', () => { info.textContent = ''; });
      ov.addEventListener('mousedown', (e) => { if (!s.clickMode) drag = pos(e); });
      ov.addEventListener('mouseup', (e) => {
        const [px, py] = pos(e);
        if (s.clickMode) { if (s.onClick) s.onClick(ix(px), iy(py), e); return; }
        if (drag && Math.abs(px - drag[0]) > 6 && Math.abs(py - drag[1]) > 6) {
          zoom = { x: [ix(Math.min(px, drag[0])), ix(Math.max(px, drag[0]))], y: [iy(Math.max(py, drag[1])), iy(Math.min(py, drag[1]))] };
          drag = null; draw(); return;
        }
        drag = null; if (box) { box.remove(); box = null; }
        if (s.onClick) s.onClick(ix(px), iy(py), e);
      });
      ov.addEventListener('dblclick', () => { zoom = null; draw(); });

      // 범례 (그래프 밖, 줄바꿈 배치)
      legend.innerHTML = '';
      for (const se of s.series) {
        if (se.noLegend) continue;
        const item = document.createElement('span');
        item.className = 'ps-leg' + (se.hidden ? ' off' : '');
        item.innerHTML = `<i style="background:${se.color};${se.dash ? 'height:0;border-top:2px dashed ' + se.color + ';background:none' : ''}"></i>`;
        item.appendChild(document.createTextNode(se.name || ''));
        item.title = '클릭하면 숨기기/보이기';
        item.onclick = () => { se.hidden = !se.hidden; draw(); };
        legend.appendChild(item);
      }
      for (const gr of (s.bars && s.bars.groups) || []) {
        if (gr.colors) continue; // 막대마다 샘플 색을 쓰는 경우 범례 대신 x축 이름으로 구분
        const item = document.createElement('span');
        item.className = 'ps-leg';
        item.innerHTML = `<i style="background:${gr.color}"></i>`;
        item.appendChild(document.createTextNode(gr.name));
        legend.appendChild(item);
      }
    }

    let raf = null;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); });
    ro.observe(container);
    draw();
    return {
      redraw(ns, keepZoom) { if (ns) cur = ns; if (!keepZoom) zoom = null; draw(); },
      resetZoom() { zoom = null; draw(); },
      destroy() { ro.disconnect(); container.innerHTML = ''; },
    };
  }

  global.PSChart = { render };
})(window);
