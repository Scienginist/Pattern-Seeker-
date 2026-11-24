/* Pattern Seeker 계산·파싱 모듈 (순수 함수).
 * 모든 계산 결과에는 사용한 식(formula)과 입력값을 함께 남긴다.
 * 값이 없으면 null 을 돌려준다. 0 으로 채우지 않는다.
 */
(function (global) {
  'use strict';
  const C = {};

  // ------------------------------------------------------------ 숫자·표
  C.num = function (s) {
    if (s === null || s === undefined) return NaN;
    if (typeof s === 'number') return s;
    let t = String(s).trim().replace(/−/g, '-').replace(/[\s%]+$/, '');
    if (t === '' || t === '-' || /^n\.?d\.?$/i.test(t) || /^nd$/i.test(t)) return NaN;
    if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.'); // 1,23 -> 1.23 (소수점 콤마)
    t = t.replace(/^</, '');
    const v = Number(t);
    return Number.isFinite(v) ? v : NaN;
  };
  C.isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  C.parseTable = function (text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
    if (!lines.length) return { headers: [], rows: [], delimiter: null };
    const sample = lines.slice(0, 20).join('\n');
    let delim;
    if (sample.includes('\t')) delim = '\t';
    else if ((sample.match(/;/g) || []).length >= lines.slice(0, 20).length) delim = ';';
    else if ((sample.match(/,/g) || []).length >= lines.slice(0, 20).length && !/\d,\d+\s/.test(sample)) delim = ',';
    else delim = /\s+/;
    const split = (l) => (typeof delim === 'string' ? l.split(delim) : l.trim().split(delim)).map((c) => c.trim());
    const all = lines.map(split);
    // 숫자 행이 시작되기 전 마지막 텍스트 행을 헤더로 본다.
    let firstNum = all.findIndex((r) => r.filter((c) => C.isNum(C.num(c))).length >= Math.max(1, Math.ceil(r.length / 2)));
    if (firstNum < 0) firstNum = all.length;
    const headers = firstNum > 0 ? all[firstNum - 1] : [];
    const rows = all.slice(firstNum);
    const ncol = Math.max(headers.length, ...rows.map((r) => r.length), 0);
    while (headers.length < ncol) headers.push(`열 ${headers.length + 1}`);
    return { headers, rows, delimiter: typeof delim === 'string' ? delim : 'space', preamble: all.slice(0, Math.max(0, firstNum - 1)).map((r) => r.join(' ')) };
  };

  C.column = function (table, idx) {
    return table.rows.map((r) => C.num(r[idx]));
  };

  C.guessCol = function (headers, patterns, exclude) {
    exclude = exclude || [];
    for (const p of patterns) {
      const i = headers.findIndex((h, k) => !exclude.includes(k) && p.test(String(h).toLowerCase()));
      if (i >= 0) return i;
    }
    return -1;
  };

  // 숫자만 있는 열 두 개 이상을 XY 로 읽는다
  C.parseXY = function (text, xi, yi) {
    const t = C.parseTable(text);
    const nc = t.headers.length;
    xi = xi === undefined ? 0 : xi;
    yi = yi === undefined ? Math.min(1, nc - 1) : yi;
    const x = [], y = [];
    for (const r of t.rows) {
      const a = C.num(r[xi]), b = C.num(r[yi]);
      if (C.isNum(a) && C.isNum(b)) { x.push(a); y.push(b); }
    }
    return { x, y, headers: t.headers, table: t };
  };

  // ------------------------------------------------------------ 통계
  C.linreg = function (xs, ys) {
    const pts = [];
    for (let i = 0; i < xs.length; i++) if (C.isNum(xs[i]) && C.isNum(ys[i])) pts.push([xs[i], ys[i]]);
    const n = pts.length;
    if (n < 2) return null;
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
    if (sxx === 0) return null;
    const slope = sxy / sxx, intercept = my - slope * mx;
    const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
    let sse = 0;
    for (const [x, y] of pts) sse += (y - (slope * x + intercept)) ** 2;
    const seSlope = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : null;
    return { slope, intercept, r2, n, seSlope, r: sxy / Math.sqrt(sxx * syy || 1) };
  };

  C.pearson = function (xs, ys) {
    const lr = C.linreg(xs, ys);
    if (!lr) return null;
    return { r: lr.r, n: lr.n, slope: lr.slope, intercept: lr.intercept };
  };

  C.spearman = function (xs, ys) {
    const pts = [];
    for (let i = 0; i < xs.length; i++) if (C.isNum(xs[i]) && C.isNum(ys[i])) pts.push([xs[i], ys[i]]);
    if (pts.length < 3) return null;
    const rank = (arr) => {
      const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      const r = new Array(arr.length);
      for (let i = 0; i < idx.length;) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
        i = j + 1;
      }
      return r;
    };
    const lr = C.linreg(rank(pts.map((p) => p[0])), rank(pts.map((p) => p[1])));
    return lr ? lr.r : null;
  };

  C.interp = function (xs, ys, x0) {
    // 첫 번째로 x0 를 지나는 구간에서 선형 보간
    for (let i = 1; i < xs.length; i++) {
      const a = xs[i - 1], b = xs[i];
      if ((a - x0) * (b - x0) <= 0 && a !== b) {
        return ys[i - 1] + (ys[i] - ys[i - 1]) * (x0 - a) / (b - a);
      }
    }
    return null;
  };

  // ------------------------------------------------------------ 스플라인 (자연 3차)
  C.naturalSpline = function (pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0]).filter((v, i, arr) => i === 0 || v[0] !== arr[i - 1][0]);
    const n = p.length;
    if (n === 0) return () => 0;
    if (n === 1) return () => p[0][1];
    const x = p.map((v) => v[0]), y = p.map((v) => v[1]);
    if (n === 2) {
      const s = (y[1] - y[0]) / (x[1] - x[0]);
      return (t) => y[0] + s * (t - x[0]);
    }
    const h = [], al = [], l = [1], mu = [0], z = [0];
    for (let i = 0; i < n - 1; i++) h.push(x[i + 1] - x[i]);
    for (let i = 1; i < n - 1; i++) al[i] = (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1]);
    for (let i = 1; i < n - 1; i++) {
      l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
      mu[i] = h[i] / l[i];
      z[i] = (al[i] - h[i - 1] * z[i - 1]) / l[i];
    }
    const c = new Array(n).fill(0), b = [], d = [];
    for (let j = n - 2; j >= 0; j--) {
      c[j] = (j === 0 ? 0 : z[j] - mu[j] * c[j + 1]);
      b[j] = (y[j + 1] - y[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
      d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }
    // 자연 경계: c[0]=c[n-1]=0
    return function (t) {
      if (t <= x[0]) return y[0] + b[0] * (t - x[0]);
      if (t >= x[n - 1]) {
        const j = n - 2, dx = x[n - 1] - x[j];
        const slope = b[j] + 2 * c[j] * dx + 3 * d[j] * dx * dx;
        return y[n - 1] + slope * (t - x[n - 1]);
      }
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] > t) hi = m; else lo = m; }
      const dx = t - x[lo];
      return y[lo] + b[lo] * dx + c[lo] * dx * dx + d[lo] * dx * dx * dx;
    };
  };

  C.maxOf = (arr) => arr.reduce((m, v) => (C.isNum(v) && v > m ? v : m), -Infinity);
  C.minOf = (arr) => arr.reduce((m, v) => (C.isNum(v) && v < m ? v : m), Infinity);

  // ------------------------------------------------------------ XRD
  C.XRD_GS_FORMULA = 'GS(nm) = K × λ / (radians(FWHM) × cos(radians(2θ/2)))';
  C.XRD_SI_FORMULA = 'SI = 피크 적분 면적 / FWHM';
  C.rad = (deg) => (deg * Math.PI) / 180;
  C.scherrer = function (fwhmDeg, twoThetaDeg, K, lambdaNm) {
    if (!C.isNum(fwhmDeg) || !C.isNum(twoThetaDeg) || fwhmDeg <= 0) return null;
    return (K * lambdaNm) / (C.rad(fwhmDeg) * Math.cos(C.rad(twoThetaDeg / 2)));
  };
  C.sharpness = (area, fwhm) => (C.isNum(area) && C.isNum(fwhm) && fwhm > 0 ? area / fwhm : null);

  C.XRD_DEFAULT_LABELS = ['(110)', '(101)', '', ''];

  C.guessXrdColumns = function (headers) {
    const h = headers.map((x) => String(x).toLowerCase());
    const used = [];
    const pick = (pats) => { const i = C.guessCol(h, pats, used); if (i >= 0) used.push(i); return i; };
    const label = pick([/hkl/, /^label/, /miller/]);
    const area = pick([/area\s*intg(?!p)/, /^area$/, /area(?!.*%)/, /^a$/]);
    const fwhm = pick([/fwhm/]);
    const center = pick([/center|centre/, /^xc$/, /2\s*(θ|theta)/, /pos/]);
    const gs = pick([/^gs|grain|crystal|size/]);
    const w = fwhm < 0 ? C.guessCol(h, [/^w$/], used) : -1;
    return { label, area, fwhm, center, gs, w };
  };

  C.computeXrd = function (peaks, K, lambda) {
    const out = peaks.map((p) => {
      const si = C.sharpness(p.area, p.fwhm);
      const gs = C.scherrer(p.fwhm, p.center, K, lambda);
      return { label: p.label, si, gs_nm: gs };
    });
    const metrics = {};
    const set = (key, value, unit, formula, inputs) => { if (C.isNum(value)) metrics[key] = { value, unit, formula, inputs }; };
    peaks.forEach((p, i) => {
      const lab = (p.label || '').replace(/[()\s]/g, '');
      if (!['110', '101'].includes(lab)) return;
      const origin = p.source === 'fit' ? { peak_source: 'Gaussian 피팅 추정' } : {};
      set('gs_' + lab, out[i].gs_nm, 'nm', C.XRD_GS_FORMULA, Object.assign({ FWHM: p.fwhm, '2θ': p.center, K, 'λ(nm)': lambda }, origin));
      set('si_' + lab, out[i].si, '', C.XRD_SI_FORMULA, Object.assign({ area: p.area, FWHM: p.fwhm }, origin));
      set('fwhm_' + lab, p.fwhm, '°', '입력값', {});
      set('center_' + lab, p.center, '°', '입력값', {});
    });
    return { peaks: out, metrics, constants: { K, lambda_nm: lambda }, formulas: { gs: C.XRD_GS_FORMULA, si: C.XRD_SI_FORMULA } };
  };

  // ------------------------------------------------------------ BET
  const BET_PATTERNS = [
    ['bet_ssa', /BET\s+Surface\s+Area[^0-9\n]*?([\d.,]+)\s*(m.?\s*\/\s*g|m2\/g|m²\/g)?/i],
    ['tplot_micro_area', /t-?\s*Plot\s+Micropore\s+Area[^0-9\n]*?([\d.,]+)/i],
    ['tplot_ext_area', /t-?\s*Plot\s+External\s+Surface\s+Area[^0-9\n]*?([\d.,]+)/i],
    ['pore_volume', /total\s+pore\s+volume[\s\S]{0,250}?([\d.]+)\s*cm(?:³|3|\^3)\s*\/\s*g/i],
    ['pore_size', /(?:Adsorption|Desorption)?\s*average\s+pore\s+(?:diameter|width)[^\n]*?:\s*([\d.,]+)\s*(Å|nm|A\b)?/i],
  ];
  C.parseBetReport = function (text) {
    const out = {};
    for (const [key, rx] of BET_PATTERNS) {
      const m = String(text || '').match(rx);
      if (!m) continue;
      let v = C.num(m[1].replace(/,(?=\d{3}\b)/g, ''));
      if (!C.isNum(v)) continue;
      const entry = { value: v, unit: '', source: 'extracted', evidence: m[0].trim().slice(0, 160) };
      if (key === 'pore_size') {
        const u = (m[2] || '').trim();
        if (u === 'Å' || u === 'A' || /Å/.test(m[0])) { entry.value = v / 10; entry.original = { value: v, unit: 'Å' }; entry.conversion = 'nm = Å / 10'; }
        entry.unit = 'nm';
      } else if (key === 'pore_volume') entry.unit = 'cm³/g';
      else entry.unit = 'm²/g';
      out[key] = entry;
    }
    return out;
  };

  // 등온선 데이터: p/p0, 흡착량(cm³/g STP)
  C.BET_SSA_FACTOR = 6.02214076e23 * 0.162e-18 / 22414; // m²/cm³(STP)  ≈ 4.3525
  C.BET_FORMULA = '1/[Q(p0/p − 1)] = (C−1)/(Qm·C)·(p/p0) + 1/(Qm·C);  Qm = 1/(기울기+절편), C = 1 + 기울기/절편, S = Qm × N_A × σ(N₂, 0.162 nm²) / 22414';
  C.betRanges = function (pp, q, opt) {
    opt = Object.assign({ pmin: 0.01, pmax: 0.35, minPts: 4, r2min: 0.995 }, opt || {});
    const pts = [];
    for (let i = 0; i < pp.length; i++) {
      if (C.isNum(pp[i]) && C.isNum(q[i]) && pp[i] > 0 && pp[i] < 1 && q[i] > 0) pts.push({ i, p: pp[i], q: q[i] });
    }
    // 흡착 분지만: p/p0 가 증가하는 첫 구간
    const ads = [];
    for (const pt of pts) { if (ads.length && pt.p < ads[ads.length - 1].p) break; ads.push(pt); }
    const inr = ads.filter((pt) => pt.p >= opt.pmin && pt.p <= opt.pmax);
    // Rouquerol 기준 1: Q(1−p/p0) 가 증가하는 마지막 점까지만 사용 가능
    const rq = ads.map((pt) => pt.q * (1 - pt.p));
    let rqMaxP = Infinity;
    for (let k = 1; k < ads.length; k++) if (rq[k] < rq[k - 1]) { rqMaxP = ads[k - 1].p; break; }
    const cands = [];
    for (let a = 0; a < inr.length; a++) {
      for (let b = a + opt.minPts - 1; b < inr.length; b++) {
        const w = inr.slice(a, b + 1);
        const xs = w.map((v) => v.p), ys = w.map((v) => 1 / (v.q * (1 / v.p - 1)));
        const lr = C.linreg(xs, ys);
        if (!lr) continue;
        const s = lr.slope, ic = lr.intercept;
        const cval = ic !== 0 ? 1 + s / ic : null;
        const qm = s + ic !== 0 ? 1 / (s + ic) : null;
        const ssa = qm !== null ? qm * C.BET_SSA_FACTOR : null;
        const xm = cval > 0 ? 1 / (Math.sqrt(cval) + 1) : null;
        const reasons = [];
        if (lr.r2 < opt.r2min) reasons.push(`R² ${lr.r2.toFixed(4)} < ${opt.r2min}`);
        if (!(ic > 0)) reasons.push('절편 ≤ 0 (C 음수/무한대)');
        if (!(cval > 0)) reasons.push('C ≤ 0');
        if (w[w.length - 1].p > rqMaxP + 1e-9) reasons.push('Rouquerol 1: Q(1−p/p0) 감소 구간 포함');
        if (xm !== null && (xm < w[0].p || xm > w[w.length - 1].p)) reasons.push('Rouquerol 3: 단분자층 p/p0 가 구간 밖');
        cands.push({ from: w[0].p, to: w[w.length - 1].p, idx: w.map((v) => v.i), n: w.length, r2: lr.r2, slope: s, intercept: ic,
          C: cval, qm, ssa, xm, eligible: reasons.length === 0, reasons });
      }
    }
    const eligible = cands.filter((c) => c.eligible);
    // 기본 선택: 기준을 모두 만족하는 후보 중 R² 최고. 점 개수는 선택 기준으로 쓰지 않는다.
    let best = null;
    for (const c of eligible) if (!best || c.r2 > best.r2) best = c;
    return { candidates: cands, eligible, selected: best, options: opt, adsorptionPoints: ads.length, rouquerolMaxP: rqMaxP };
  };

  // ------------------------------------------------------------ XRF
  // 원자량 (IUPAC 표준값, 셋째 자리)
  C.ATOMIC = { H: 1.008, He: 4.003, Li: 6.94, Be: 9.012, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Ne: 20.180, Na: 22.990, Mg: 24.305,
    Al: 26.982, Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, Ar: 39.948, K: 39.098, Ca: 40.078, Sc: 44.956, Ti: 47.867, V: 50.942, Cr: 51.996,
    Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38, Ga: 69.723, Ge: 72.630, As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798,
    Rb: 85.468, Sr: 87.62, Y: 88.906, Zr: 91.224, Nb: 92.906, Mo: 95.95, Ru: 101.07, Rh: 102.91, Pd: 106.42, Ag: 107.87, Cd: 112.41, In: 114.82,
    Sn: 118.71, Sb: 121.76, Te: 127.60, I: 126.90, Xe: 131.29, Cs: 132.91, Ba: 137.33, La: 138.91, Ce: 140.12, Pr: 140.91, Nd: 144.24, Sm: 150.36,
    Eu: 151.96, Gd: 157.25, Tb: 158.93, Dy: 162.50, Ho: 164.93, Er: 167.26, Tm: 168.93, Yb: 173.05, Lu: 174.97, Hf: 178.49, Ta: 180.95, W: 183.84,
    Re: 186.21, Os: 190.23, Ir: 192.22, Pt: 195.08, Au: 196.97, Hg: 200.59, Tl: 204.38, Pb: 207.2, Bi: 208.98, Th: 232.04, U: 238.03 };

  C.parseFormula = function (f) {
    const m = String(f).match(/^([A-Z][a-z]?\d*)+$/);
    if (!m) return null;
    const out = {};
    for (const [, el, n] of String(f).matchAll(/([A-Z][a-z]?)(\d*)/g)) {
      if (!C.ATOMIC[el]) return null;
      out[el] = (out[el] || 0) + (n ? Number(n) : 1);
    }
    return out;
  };
  C.massFraction = function (formula, el) {
    const comp = C.parseFormula(formula);
    if (!comp || !comp[el]) return null;
    let tot = 0;
    for (const [e, n] of Object.entries(comp)) tot += C.ATOMIC[e] * n;
    return (C.ATOMIC[el] * comp[el]) / tot;
  };

  // XRF 값 상태: quantified(정량) / trace(검출됐으나 정량 불가) / nd(불검출) / below(검출한계 미만 "<x")
  // 정량값이 아닌 상태는 value=null 로 두며 0 으로 바꾸지 않는다.
  C.XRF_STATUS = { quantified: '정량', trace: 'Trace', nd: '불검출', below: '검출한계 미만' };
  C.xrfValueToken = function (tok) {
    const t = String(tok ?? '').trim();
    if (/^(trace|tr\.?)$/i.test(t)) return { status: 'trace', value: null };
    if (/^(n\.?d\.?|nd|not\s*detected|-{1,3})$/i.test(t)) return { status: 'nd', value: null };
    const lt = t.match(/^<\s*([\d.]+)/);
    if (lt) return { status: 'below', value: null, limit: Number(lt[1]) };
    const v = C.num(t.replace(/(mass|wt)?%$/i, ''));
    return C.isNum(v) ? { status: 'quantified', value: v } : null;
  };
  const XRF_UNIT = /^((mass|wt)\s*%|%|ppm|mg\/kg)$/i;
  const normUnit = (u) => (/ppm|mg\/kg/i.test(u || '') ? 'ppm' : '%');

  // Rigaku ZSX “SQX Calculation Result” 양식
  C.parseSqx = function (text) {
    const T = String(text || '');
    if (!/Component\s+Result\s+Unit/i.test(T)) return null;
    const nf = (x) => String(x || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const field = (label, stop) => {
      const m = T.match(new RegExp('(?:^|\\s)' + label + '\\s*:[ \\t]*(.*?)[ \\t]*(?:' + (stop || '$') + ')', 'm'));
      return m ? nf(m[1]) : '';
    };
    const dt = (raw) => {
      const m = String(raw).match(/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
      if (!m) return null;
      const d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      return { date: d, time: m[4] ? `${String(m[4]).padStart(2, '0')}:${m[5]}` : null };
    };
    const analyzedRaw = field('Date analyzed');
    const firstLine = T.split(/\r?\n/).find((l) => l.trim()) || '';
    const meta = {
      format: 'Rigaku SQX Calculation Result',
      sample_name: field('Sample', 'Date analyzed|$'),
      date_analyzed: dt(analyzedRaw), date_analyzed_raw: analyzedRaw, printed: dt(firstLine),
      application: field('Application', 'Sample type|$'), sample_type: field('Sample type'),
      balance: field('Balance'), matching_library: field('Matching library'),
      film_correction: field('Sample film corr\\.', 'Impurity corr|$'), impurity_correction: field('Impurity corr\\.'), file: field('File'),
    };
    const rows = [];
    const full = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+((?:mass|wt)\s*%|%|ppm)\s+([-\d.Ee+]+)\s+([A-Z][a-z]?\s*-\s*[A-Za-z]+\w*)\s+([-\d.Ee+]+)\s+([-\d.Ee+]+)\s*$/;
    const loose = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+((?:mass|wt)\s*%|%|ppm)\b\s*(.*)$/;
    for (const line of T.split(/\r?\n/)) {
      let m = line.match(full), r = null;
      if (m) r = { no: +m[1], component: m[2], tok: m[3], unit_raw: m[4], det_limit: C.num(m[5]), line: m[6].replace(/\s+/g, ''), intensity: C.num(m[7]), wo_normal: C.num(m[8]) };
      else if ((m = line.match(loose)) && C.parseFormula(m[2])) r = { no: +m[1], component: m[2], tok: m[3], unit_raw: m[4], rest: m[5] };
      if (!r || !C.parseFormula(r.component)) continue;
      const v = C.xrfValueToken(r.tok);
      if (!v) continue;
      rows.push(Object.assign({ component: r.component, value: v.value, status: v.status, unit: normUnit(r.unit_raw), source: 'extracted', line_text: line.trim().slice(0, 160) },
        r.det_limit !== undefined ? { det_limit: r.det_limit, el_line: r.line, intensity: r.intensity, wo_normal: r.wo_normal } : {}, { row_no: r.no }));
    }
    const q = rows.filter((x) => x.status === 'quantified');
    meta.result_sum = q.reduce((a, x) => a + (x.unit === 'ppm' ? x.value / 1e4 : x.value), 0);
    const wo = rows.filter((x) => C.isNum(x.wo_normal));
    if (wo.length) meta.wo_normal_sum = wo.reduce((a, x) => a + x.wo_normal, 0);
    return { format: meta.format, meta, rows };
  };

  // 일반 텍스트(붙여넣기 등): 성분 다음의 첫 값 토큰을 읽는다. 단위 토큰은 건너뛰고, 그 밖의 토큰을 만나면 멈춘다.
  C.parseXrfGeneric = function (text) {
    const rows = [], seen = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
      const toks = line.trim().split(/[\s\t,;|]+/).filter(Boolean);
      for (let i = 0; i < toks.length - 1; i++) {
        const comp = toks[i].replace(/:$/, '');
        if (!C.parseFormula(comp)) continue;
        let v = null, unit = '%';
        for (let j = i + 1; j < Math.min(toks.length, i + 4); j++) {
          if (XRF_UNIT.test(toks[j])) { unit = normUnit(toks[j]); continue; }
          v = C.xrfValueToken(toks[j]);
          if (v && XRF_UNIT.test(toks[j + 1] || '')) unit = normUnit(toks[j + 1]);
          if (v && /ppm/i.test(toks[j])) unit = 'ppm';
          break;
        }
        if (v && !seen.has(comp)) {
          seen.add(comp);
          rows.push({ component: comp, value: v.value, status: v.status, unit, line_text: line.trim().slice(0, 160), source: 'extracted' });
        }
        break;
      }
    }
    return rows;
  };

  C.parseXrfReport = function (text) {
    const sqx = C.parseSqx(text);
    if (sqx && sqx.rows.length) return sqx;
    return { format: '일반 텍스트', meta: {}, rows: C.parseXrfGeneric(text) };
  };
  C.parseXrf = (text) => C.parseXrfReport(text).rows; // 이전 호출부 호환

  // 주성분: 설정된 목록(예: IrO2) 중 정량된 성분. 없으면 50 % 이상인 최대 성분을 자동 제안한다(확인 필요 표시).
  C.xrfDefaultMains = function (components, configured) {
    const q = components.filter((c) => c.status !== 'trace' && c.status !== 'nd' && c.status !== 'below' && C.isNum(c.value));
    const hit = q.filter((c) => (configured || []).includes(c.component)).map((c) => c.component);
    if (hit.length) return { list: hit, auto: false };
    const top = q.slice().sort((a, b) => b.value - a.value)[0];
    if (top && top.unit !== 'ppm' && top.value >= 50) return { list: [top.component], auto: true, reason: `설정된 주성분(${(configured || []).join(', ') || '없음'})이 성적서에 없어 최대 성분 ${top.component} 을(를) 자동 선택` };
    return { list: [], auto: false };
  };

  C.XRF_PURITY_FORMULA = '순도(%) = Σ(주성분 함량) / Σ(정량된 모든 성분 함량) × 100   (Trace·불검출 성분은 합계에서 제외)';
  C.computeXrf = function (components, mainList, interest) {
    const isQ = (c) => (c.status === undefined || c.status === 'quantified') && C.isNum(c.value);
    const pct = components.filter(isQ).map((c) => ({ ...c, pct: c.unit === 'ppm' ? c.value / 1e4 : c.value }));
    const total = pct.reduce((s, c) => s + c.pct, 0);
    const mains = pct.filter((c) => mainList.includes(c.component));
    const metrics = {};
    if (mains.length && total > 0) {
      const mainSum = mains.reduce((s, c) => s + c.pct, 0);
      metrics.purity = { value: (mainSum / total) * 100, unit: '%', formula: C.XRF_PURITY_FORMULA,
        inputs: { main: mains.map((c) => `${c.component}=${c.pct}`), total_quantified: total } };
    }
    const impurities = {};
    const nonQ = components.filter((c) => !isQ(c));
    for (const el of interest) {
      const direct = pct.find((c) => c.component === el);
      const directNQ = nonQ.find((c) => c.component === el);
      if (direct) impurities[el] = { value: direct.pct, unit: 'wt%', basis: `${el} 직접 보고값` };
      else if (directNQ) impurities[el] = { value: null, status: directNQ.status, unit: 'wt%', basis: `${C.XRF_STATUS[directNQ.status] || directNQ.status} — 정량값 없음 (0 아님)` };
      else {
        const compd = pct.find((c) => C.parseFormula(c.component) && C.parseFormula(c.component)[el] && c.component !== el);
        if (compd) {
          const f = C.massFraction(compd.component, el);
          impurities[el] = { value: compd.pct * f, unit: 'wt%', basis: `${compd.component} ${compd.pct} × ${f.toFixed(4)} (${el} 질량분율 환산)`, from: compd.component };
        }
      }
      if (impurities[el] && C.isNum(impurities[el].value)) metrics['imp_' + el] = { value: impurities[el].value, unit: 'wt%', formula: impurities[el].basis, inputs: {} };
    }
    return { metrics, total_reported: total, impurities, main_components: mainList, interest_elements: interest,
      not_reported: interest.filter((el) => !impurities[el]), non_quantified: nonQ.map((c) => ({ component: c.component, status: c.status })) };
  };

  // 성적서 샘플명과 앱 샘플명 비교용 키 (전각 → 반각, 기호·공백 무시)
  C.nameKey = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

  // ------------------------------------------------------------ PSA
  C.SPAN_FORMULA = 'Span = (D90 − D10) / D50';
  C.span = (d10, d50, d90) => (C.isNum(d10) && C.isNum(d50) && C.isNum(d90) && d50 > 0 ? (d90 - d10) / d50 : null);

  // ------------------------------------------------------------ 스무딩
  C.savgol = function (y, window) {
    // Savitzky–Golay 2차(=3차) 스무딩 계수: c_i = 3(3m²+3m−1−5i²) / ((4m²−1)(2m+3))
    window = Math.max(3, window | 0);
    if (window % 2 === 0) window += 1;
    const m = (window - 1) / 2;
    const coef = [];
    const den = (4 * m * m - 1) * (2 * m + 3);
    for (let i = -m; i <= m; i++) coef.push((3 * (3 * m * m + 3 * m - 1 - 5 * i * i)) / den);
    const n = y.length, out = new Array(n);
    for (let k = 0; k < n; k++) {
      if (k < m || k >= n - m) { out[k] = y[k]; continue; }
      let s = 0, ok = true;
      for (let i = -m; i <= m; i++) { const v = y[k + i]; if (!C.isNum(v)) { ok = false; break; } s += coef[i + m] * v; }
      out[k] = ok ? s : y[k];
    }
    return out;
  };
  C.movingAverage = function (y, window) {
    const h = Math.max(1, Math.floor(window / 2)), out = [];
    for (let k = 0; k < y.length; k++) {
      let s = 0, n = 0;
      for (let i = Math.max(0, k - h); i <= Math.min(y.length - 1, k + h); i++) if (C.isNum(y[i])) { s += y[i]; n++; }
      out.push(n ? s / n : NaN);
    }
    return out;
  };

  // ------------------------------------------------------------ TGA
  C.computeTga = function (T, mass, opt) {
    opt = Object.assign({ massUnit: '%', window: 21, method: 'savgol' }, opt || {});
    const m0 = mass.find((v) => C.isNum(v));
    const pct = opt.massUnit === '%' ? mass.slice() : mass.map((v) => (v / m0) * 100);
    const dtg = new Array(T.length).fill(NaN);
    for (let i = 1; i < T.length - 1; i++) {
      const dT = T[i + 1] - T[i - 1];
      if (Math.abs(dT) > 1e-9) dtg[i] = -(pct[i + 1] - pct[i - 1]) / dT;
    }
    // 등온 구간(dT≈0)의 NaN 은 이웃값 보간 없이 그대로 둔다
    const sm = opt.method === 'none' ? dtg.slice() : opt.method === 'ma' ? C.movingAverage(dtg, opt.window) : C.savgol(dtg, opt.window);
    return { massPct: pct, m0, dtgRaw: dtg, dtgSmooth: sm, smoothing: { method: opt.method, window: opt.window } };
  };
  C.TGA_WATER_FORMULA = '수분 함량(%) = [m(T1) − m(T2)] / m₀ × 100   (m₀: 첫 데이터점 질량)';
  C.tgaLoss = function (T, massPct, t1, t2) {
    const a = C.interp(T, massPct, t1), b = C.interp(T, massPct, t2);
    const m0 = massPct.find((v) => C.isNum(v));
    if (!C.isNum(a) || !C.isNum(b)) return null;
    return { value: ((a - b) / m0) * 100, m_t1: a, m_t2: b, m0 };
  };

  // ------------------------------------------------------------ 전기화학
  C.splitCycles = function (E, cycleCol) {
    const n = E.length;
    if (cycleCol && cycleCol.some((v) => C.isNum(v))) {
      const groups = [];
      let cur = null, curId = null;
      for (let i = 0; i < n; i++) {
        if (cycleCol[i] !== curId) { curId = cycleCol[i]; cur = { id: curId, start: i, end: i }; groups.push(cur); }
        cur.end = i;
      }
      return { method: '데이터의 cycle 열', cycles: groups.map((g, k) => ({ no: k + 1, label: String(g.id), start: g.start, end: g.end })) };
    }
    const lo = C.minOf(E), hi = C.maxOf(E), range = hi - lo;
    if (!(range > 0)) return { method: '분리 불가(전위 변화 없음)', cycles: [{ no: 1, start: 0, end: n - 1 }] };
    const tol = range * 0.02;
    // 방향 전환점(꼭짓점) 찾기 (히스테리시스 적용)
    const vertices = [];
    let dir = 0, ext = E[0], extI = 0;
    for (let i = 1; i < n; i++) {
      const v = E[i];
      if (dir >= 0 && v > ext) { ext = v; extI = i; if (dir === 0 && v - E[0] > tol) dir = 1; }
      else if (dir <= 0 && v < ext) { ext = v; extI = i; if (dir === 0 && E[0] - v > tol) dir = -1; }
      if (dir === 1 && ext - v > tol) { vertices.push({ i: extI, type: 'max' }); dir = -1; ext = v; extI = i; }
      else if (dir === -1 && v - ext > tol) { vertices.push({ i: extI, type: 'min' }); dir = 1; ext = v; extI = i; }
    }
    if (vertices.length < 2) return { method: '분리 불가(꼭짓점 부족) — 단일 곡선', cycles: [{ no: 1, start: 0, end: n - 1 }] };
    const E0 = E[0];
    const startAtVertex = Math.abs(E0 - lo) < tol * 2 || Math.abs(E0 - hi) < tol * 2;
    const bounds = [0];
    if (startAtVertex) {
      const t = Math.abs(E0 - lo) < Math.abs(E0 - hi) ? 'min' : 'max';
      for (const v of vertices) if (v.type === t) bounds.push(v.i);
    } else {
      const d0 = E[Math.min(n - 1, 5)] >= E0 ? 1 : -1;
      let vSince = 0, vk = 0;
      for (let i = 1; i < n; i++) {
        while (vk < vertices.length && vertices[vk].i <= i) { vSince++; vk++; }
        const crossed = d0 > 0 ? E[i - 1] < E0 && E[i] >= E0 : E[i - 1] > E0 && E[i] <= E0;
        if (crossed && vSince >= 2) { bounds.push(i); vSince = 0; }
      }
    }
    const cycles = [];
    for (let k = 0; k < bounds.length; k++) {
      const s = bounds[k], e = k + 1 < bounds.length ? bounds[k + 1] - 1 : n - 1;
      if (e - s >= 3) cycles.push({ no: cycles.length + 1, start: s, end: e });
    }
    const last = cycles[cycles.length - 1];
    if (last) {
      const seg = E.slice(last.start, last.end + 1);
      last.partial = C.maxOf(seg) - C.minOf(seg) < range * 0.9;
    }
    return { method: startAtVertex ? '전위 꼭짓점 기준 자동 분리' : '시작 전위 재통과 기준 자동 분리', cycles, vertices: vertices.length };
  };

  // 한 사이클에서 선택 전위의 산화(정방향)·환원(역방향) 전류
  C.currentsAt = function (E, I, start, end, E0) {
    let ia = null, ic = null;
    for (let i = start + 1; i <= end; i++) {
      const a = E[i - 1], b = E[i];
      if ((a - E0) * (b - E0) > 0 || a === b) continue;
      const v = I[i - 1] + (I[i] - I[i - 1]) * (E0 - a) / (b - a);
      if (b > a && ia === null) ia = v;
      if (b < a && ic === null) ic = v;
    }
    return { ia, ic };
  };

  C.ECSA_FORMULA = 'Cdl(mF) = d[(i_a − i_c)/2] / d(scan rate) (mA ÷ V/s);  ECSA(cm²) = Cdl / Cs;  ECSA/질량 = ECSA / 로딩(mg)';
  C.computeEcsa = function (points, cs, loadingMg) {
    // points: [{rate (V/s), ia (mA), ic (mA)}]
    const ok = points.filter((p) => C.isNum(p.rate) && C.isNum(p.ia) && C.isNum(p.ic));
    const half = ok.map((p) => (p.ia - p.ic) / 2);
    const lr = C.linreg(ok.map((p) => p.rate), half);
    const lrA = C.linreg(ok.map((p) => p.rate), ok.map((p) => p.ia));
    const lrC = C.linreg(ok.map((p) => p.rate), ok.map((p) => -p.ic));
    if (!lr) return { error: 'scan rate 가 다른 측정이 2개 이상 필요합니다', n: ok.length };
    const cdl = lr.slope;
    const res = { cdl_mF: cdl, r2: lr.r2, n: ok.length, anodic_slope: lrA && lrA.slope, cathodic_slope: lrC && lrC.slope,
      intercept: lr.intercept, points: ok.map((p, k) => ({ ...p, half: half[k] })) };
    if (C.isNum(cs) && cs > 0) res.ecsa_cm2 = cdl / cs;
    if (C.isNum(res.ecsa_cm2) && C.isNum(loadingMg) && loadingMg > 0) res.ecsa_per_mg = res.ecsa_cm2 / loadingMg;
    return res;
  };

  // ------------------------------------------------------------ XRD Gaussian 피팅 (Levenberg–Marquardt)
  // 피크: {center, fwhm, height, lock:{center,fwhm,height}}  · 모델 f(x) = Σ H·exp(−4ln2·(x−c)²/w²)
  const L4 = 4 * Math.LN2;
  C.GAUSS_AREA_FACTOR = Math.sqrt(Math.PI / L4); // 면적 = H × FWHM × 1.0645
  C.FIT_FORMULA = 'f(2θ) = Σ Hᵢ·exp(−4ln2·(2θ−cᵢ)²/wᵢ²),  면적ᵢ = Hᵢ × wᵢ × √(π/(4ln2)),  Levenberg–Marquardt 최소제곱';
  C.gaussSum = function (x, peaks) {
    let s = 0;
    for (const p of peaks) { const d = x - p.center; s += p.height * Math.exp((-L4 * d * d) / (p.fwhm * p.fwhm)); }
    return s;
  };

  C.findPeaks = function (x, y, n, opt) {
    opt = Object.assign({ minSep: 0.4, window: 11 }, opt || {});
    const ys = C.savgol(y, opt.window);
    const cand = [];
    for (let i = 2; i < ys.length - 2; i++) if (ys[i] > ys[i - 1] && ys[i] >= ys[i + 1] && ys[i] > ys[i - 2] && ys[i] >= ys[i + 2]) cand.push(i);
    cand.sort((a, b) => ys[b] - ys[a]);
    const picked = [];
    for (const i of cand) {
      if (picked.length >= n) break;
      if (picked.some((j) => Math.abs(x[j] - x[i]) < opt.minSep)) continue;
      if (ys[i] <= 0) continue;
      picked.push(i);
    }
    return picked.sort((a, b) => x[a] - x[b]).map((i) => {
      const half = ys[i] / 2;
      let l = i, r = i;
      while (l > 0 && ys[l] > half) l--;
      while (r < ys.length - 1 && ys[r] > half) r++;
      const w = Math.min(3, Math.max(0.05, x[r] - x[l]));
      return { center: x[i], fwhm: w, height: ys[i], lock: {} };
    });
  };

  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-300) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }

  C.fitGaussians = function (xAll, yAll, peaks0, opt) {
    opt = Object.assign({ xmin: -Infinity, xmax: Infinity, maxIter: 200, maxPts: 3000 }, opt || {});
    let X = [], Y = [];
    for (let i = 0; i < xAll.length; i++) if (xAll[i] >= opt.xmin && xAll[i] <= opt.xmax && C.isNum(yAll[i])) { X.push(xAll[i]); Y.push(yAll[i]); }
    if (X.length > opt.maxPts) { const st = Math.ceil(X.length / opt.maxPts); X = X.filter((_, i) => i % st === 0); Y = Y.filter((_, i) => i % st === 0); }
    const peaks = peaks0.map((p) => ({ center: p.center, fwhm: p.fwhm, height: p.height, lock: Object.assign({}, p.lock || {}), label: p.label }));
    const keys = ['height', 'center', 'fwhm'];
    const free = [];
    peaks.forEach((p, k) => keys.forEach((key) => { if (!p.lock[key]) free.push([k, key]); }));
    const xlo = Math.min(...X), xhi = Math.max(...X), span = xhi - xlo;
    const clamp = () => peaks.forEach((p) => {
      p.height = Math.max(0, p.height);
      p.fwhm = Math.min(Math.max(p.fwhm, 1e-3), span);
      p.center = Math.min(Math.max(p.center, xlo), xhi);
    });
    const sse = () => { let s = 0; for (let i = 0; i < X.length; i++) { const r = Y[i] - C.gaussSum(X[i], peaks); s += r * r; } return s; };
    if (!X.length || !free.length) return { peaks, iterations: 0, converged: false, error: X.length ? '고정되지 않은 변수가 없습니다' : '피팅 범위에 데이터가 없습니다' };
    let lambda = 1e-3, cur = sse(), it = 0, converged = false;
    for (; it < opt.maxIter; it++) {
      const m = free.length;
      const JTJ = Array.from({ length: m }, () => new Array(m).fill(0)), JTr = new Array(m).fill(0);
      const row = new Array(m);
      for (let i = 0; i < X.length; i++) {
        const r = Y[i] - C.gaussSum(X[i], peaks);
        for (let j = 0; j < m; j++) {
          const [k, key] = free[j], p = peaks[k], d = X[i] - p.center, w2 = p.fwhm * p.fwhm;
          const g = Math.exp((-L4 * d * d) / w2);
          row[j] = key === 'height' ? g : key === 'center' ? p.height * g * (2 * L4 * d) / w2 : p.height * g * (2 * L4 * d * d) / (w2 * p.fwhm);
        }
        for (let a = 0; a < m; a++) { if (!row[a]) continue; JTr[a] += row[a] * r; for (let b = a; b < m; b++) JTJ[a][b] += row[a] * row[b]; }
      }
      for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) JTJ[a][b] = JTJ[b][a];
      let improved = false;
      for (let tries = 0; tries < 12; tries++) {
        const A = JTJ.map((r, a) => r.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
        const delta = solve(A, JTr);
        if (!delta) { lambda *= 10; continue; }
        const backup = peaks.map((p) => ({ ...p }));
        free.forEach(([k, key], j) => { peaks[k][key] += delta[j]; });
        clamp();
        const nw = sse();
        if (nw < cur) { const rel = (cur - nw) / (cur || 1); cur = nw; lambda = Math.max(lambda / 10, 1e-12); improved = true; if (rel < 1e-9) converged = true; break; }
        peaks.forEach((p, k) => Object.assign(p, backup[k]));
        lambda *= 10;
      }
      if (!improved || converged) { converged = true; break; }
    }
    let my = 0; for (const v of Y) my += v; my /= Y.length;
    let sst = 0; for (const v of Y) sst += (v - my) ** 2;
    peaks.forEach((p) => { p.area = p.height * p.fwhm * C.GAUSS_AREA_FACTOR; });
    return { peaks, iterations: it, converged, sse: cur, r2: sst ? 1 - cur / sst : null, n: X.length, range: [xlo, xhi] };
  };

  // ------------------------------------------------------------ 보정 회귀 (BET 예측 검증용)
  const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  C.t95 = (df) => (df < 1 ? Infinity : df <= 30 ? T95[df - 1] : df <= 60 ? 2.0 : 1.96);
  C.calibrate = function (xs, ys) {
    const n = xs.length;
    const lr = C.linreg(xs, ys);
    if (!lr) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const sxx = xs.reduce((a, b) => a + (b - mx) ** 2, 0);
    let sse = 0;
    xs.forEach((x, i) => { sse += (ys[i] - (lr.slope * x + lr.intercept)) ** 2; });
    const s = n > 2 ? Math.sqrt(sse / (n - 2)) : null;
    // leave-one-out: 각 샘플을 빼고 맞춘 직선으로 그 샘플을 예측
    const loo = [];
    for (let k = 0; k < n; k++) {
      const fx = xs.filter((_, i) => i !== k), fy = ys.filter((_, i) => i !== k);
      const l = C.linreg(fx, fy);
      loo.push(l ? { pred: l.slope * xs[k] + l.intercept, actual: ys[k] } : null);
    }
    const ok = loo.filter(Boolean);
    const rmse = ok.length ? Math.sqrt(ok.reduce((a, o) => a + (o.pred - o.actual) ** 2, 0) / ok.length) : null;
    const mape = ok.length ? (ok.reduce((a, o) => a + Math.abs((o.pred - o.actual) / o.actual), 0) / ok.length) * 100 : null;
    return {
      slope: lr.slope, intercept: lr.intercept, r2: lr.r2, n, s, mx, sxx, xmin: C.minOf(xs), xmax: C.maxOf(xs), loo, loo_rmse: rmse, loo_mape: mape,
      predict(x) {
        const y = lr.slope * x + lr.intercept;
        const half = s !== null && sxx > 0 ? C.t95(n - 2) * s * Math.sqrt(1 + 1 / n + ((x - mx) ** 2) / sxx) : null;
        return { y, lo: half !== null ? y - half : null, hi: half !== null ? y + half : null, inRange: x >= C.minOf(xs) && x <= C.maxOf(xs) };
      },
    };
  };

  // ------------------------------------------------------------ 표시
  C.fmt = function (v, d) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return '—';
    if (typeof v !== 'number') { const n = Number(v); if (!Number.isFinite(n)) return String(v); v = n; }
    d = d === undefined ? 2 : d;
    if (v !== 0 && Math.abs(v) < Math.pow(10, -d) * 5) return v.toExponential(2);
    return v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  C.dateCandidates = function (text) {
    const out = [];
    const rx = [/(20\d{2})[-./년 ]\s?(\d{1,2})[-./월 ]\s?(\d{1,2})/g];
    for (const r of rx) for (const m of String(text || '').matchAll(r)) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (!out.includes(iso)) out.push(iso);
      }
    }
    return out;
  };

  global.PSCalc = C;
  if (typeof module !== 'undefined') module.exports = C;
})(typeof window !== 'undefined' ? window : globalThis);
