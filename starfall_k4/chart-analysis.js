/* chart-analysis.js ― スタンプパッション用の曲解析
   できること
   1) 16分音符のスロットごとに「低音（バスドラ寄り）の強さ」「高音（スネア・ハット寄り）の強さ」を 0〜9 で出す
   2) （任意）BPMと最初の拍の位置を推定する。持ち込み曲向け
   すべてブラウザの中だけで動く。曲はサーバーに送らない。

   使い方（ゲーム側）
     ChartAnalysis.getProfile(song)      // song = {id, file, bpm, first} → Promise<profile|null>
     ChartAnalysis.analyzeFile(file)     // 持ち込みmp3用。bpm未指定ならBPMも推定 → Promise<{profile, tempo}>
   profile = {bpm, first, n, low:Uint8Array, high:Uint8Array}   ※ スロット s = 拍×4 + 16分の位置（first から数える）
*/
(function (root) {
  'use strict';

  const VER = 'v1';
  const RATE = 500;                 // 解析の時間分解能（Hz）。2ms刻み
  const FLOOR_LOW = 0.02;           // これ未満の揺れは「無音」とみなす（フルスケール1.0に対して）
  const FLOOR_HIGH = 0.008;
  const CACHE_PREFIX = 'otoge_prof_' + VER + '|';

  /* ---------- 小さなフィルタ（2次バターワース） ---------- */
  function biquad(type, fc, sr) {
    const w = 2 * Math.PI * fc / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * 0.70710678);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
    const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return function (v) {
      const y = nb0 * v + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      return y;
    };
  }

  /* ---------- 帯域ごとの「音の大きさの輪郭」 ----------
     low : 〜150Hz（バスドラ・ベース）  high : 2kHz〜（スネア・ハット）
     急に立ち上がって、25msくらいで落ちるピークホールドにしてある */
  function envelopes(x, sr) {
    const hop = Math.max(1, Math.round(sr / RATE)), rate = sr / hop, n = Math.floor(x.length / hop);
    const low = new Float32Array(n), high = new Float32Array(n);
    const l1 = biquad('lp', 150, sr), l2 = biquad('lp', 150, sr);
    const h1 = biquad('hp', 2000, sr), h2 = biquad('hp', 2000, sr);
    const dec = Math.exp(-1 / (0.025 * rate));
    let el = 0, eh = 0, p = 0;
    for (let i = 0; i < n; i++) {
      let ml = 0, mh = 0;
      for (let j = 0; j < hop; j++) {
        const v = x[p++];
        let a = l2(l1(v)); if (a < 0) a = -a; if (a > ml) ml = a;
        let b = h2(h1(v)); if (b < 0) b = -b; if (b > mh) mh = b;
      }
      const dl = el * dec, dh = eh * dec;
      el = ml > dl ? ml : dl; eh = mh > dh ? mh : dh;
      low[i] = el; high[i] = eh;
    }
    return { low, high, rate, dur: x.length / sr };
  }

  /* ---------- スロットごとの強さ ---------- */
  /* 窓の中のピーク − 窓の直前20msの底 ＝ その窓で「新しく鳴った音」の強さ。
     前の拍の余韻がまだ残っているだけなら、ピークと底が同じになって0になる */
  function onsetOf(e, i0, i1, jlen) {
    let pk = 0;
    for (let i = i0; i <= i1; i++) if (e[i] > pk) pk = e[i];
    let base = 0;
    if (i0 - jlen >= 0) { base = Infinity; for (let j = i0 - jlen; j <= i0; j++) if (e[j] < base) base = e[j]; }
    return Math.max(0, pk - base);
  }
  function toLevels(arr, floor) {
    const sorted = Float32Array.from(arr).sort();
    const p95 = sorted.length ? sorted[Math.floor(0.95 * (sorted.length - 1))] : 0;
    const ref = Math.max(p95, floor);
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = Math.round(Math.min(1, arr[i] / ref) * 9);
    return out;
  }
  function buildProfile(env, bpm, first) {
    const { low, high, rate, dur } = env, n = low.length, sd = 60 / bpm / 4;
    const N = Math.max(0, Math.floor((dur - first) / sd));
    const lo = new Float32Array(N), hi = new Float32Array(N);
    const aw = Math.min(0.4 * sd, 0.05), bw = Math.min(0.45 * sd, 0.06);   // 拍位置が少しズレていても拾えるように、前後に幅をもたせる
    const jlen = Math.ceil(0.02 * rate);
    for (let s = 0; s < N; s++) {
      const t = first + s * sd;
      const i0 = Math.max(0, Math.floor((t - aw) * rate)), i1 = Math.min(n - 1, Math.ceil((t + bw) * rate));
      lo[s] = onsetOf(low, i0, i1, jlen);
      hi[s] = onsetOf(high, i0, i1, jlen);
    }
    return { bpm, first, n: N, low: toLevels(lo, FLOOR_LOW), high: toLevels(hi, FLOOR_HIGH) };
  }

  /* ---------- BPM・最初の拍の推定（持ち込み曲向け） ---------- */
  function novelty(env) {
    const low = env.low, high = env.high, n = low.length;
    const o = new Float32Array(n), ph = new Float32Array(n);
    let sl = 0, sh = 0;
    for (let i = 1; i < n; i++) { const a = low[i] - low[i - 1], b = high[i] - high[i - 1]; if (a > 0) sl += a * a; if (b > 0) sh += b * b; }
    const rl = Math.max(Math.sqrt(sl / n), 1e-4), rh = Math.max(Math.sqrt(sh / n), 1e-4);
    for (let i = 1; i < n; i++) {
      const a = low[i] - low[i - 1], b = high[i] - high[i - 1];
      const dl = a > 0 ? a / rl : 0, dh = b > 0 ? b / rh : 0;
      o[i] = dl + 0.7 * dh;        // テンポ用（低音+高音）
      ph[i] = dl + 0.35 * dh;      // 拍の位置用（低音寄り）
    }
    return { o, ph };
  }
  function fold(list, T) {
    const nb = Math.max(8, Math.round(T)), h = new Float64Array(nb);
    let tot = 0;
    for (let k = 0; k < list.i.length; k++) {
      const i = list.i[k], w = list.w[k];
      let b = Math.floor((i - Math.floor(i / T) * T) / T * nb); if (b >= nb) b = 0;
      h[b] += w; tot += w;
    }
    let best = -1, bi = 0;
    for (let b = 0; b < nb; b++) {
      const s = 0.5 * h[(b + nb - 2) % nb] + h[(b + nb - 1) % nb] + h[b] + h[(b + 1) % nb] + 0.5 * h[(b + 2) % nb];
      if (s > best) { best = s; bi = b; }
    }
    return { score: tot > 0 ? best / tot : 0, bin: bi, nb, T };
  }
  function strongList(ph) {
    let sum = 0, c = 0;
    for (let i = 0; i < ph.length; i++) if (ph[i] > 0) { sum += ph[i]; c++; }
    const thr = c ? sum / c : 0, ii = [], ww = [];
    for (let i = 0; i < ph.length; i++) if (ph[i] > 0 && ph[i] >= thr) { ii.push(i); ww.push(ph[i]); }
    return { i: ii, w: ww };
  }
  /* novelty と strongList は重いので、env にキャッシュする（BPMをいじるたびに再計算しない） */
  function getNov(env) {
    if (!env._nov) { env._nov = novelty(env); env._list = strongList(env._nov.ph); }
    return env._nov;
  }
  /* おおよそのBPMから、拍の位置に音が集まるBPMを細かく探す（±4%） */
  function refine(list, rate, bpm) {
    let bestC = bpm, bestS = -1;
    for (let c = bpm * 0.96; c <= bpm * 1.04; c += 0.1) { const f = fold(list, rate * 60 / c); if (f.score > bestS) { bestS = f.score; bestC = c; } }
    const c0 = bestC; bestS = -1;
    for (let c = c0 - 0.15; c <= c0 + 0.15; c += 0.01) { const f = fold(list, rate * 60 / c); if (f.score > bestS) { bestS = f.score; bestC = c; } }
    return bestC;
  }
  /* タップなどで決めた「だいたいのBPM」を、曲に合わせて微調整する → {bpm, first} */
  function refineTempo(env, approx) {
    getNov(env);
    const b = Math.round(refine(env._list, env.rate, approx) * 100) / 100;
    const t = detectTempo(env, { bpm: b });
    return t ? { bpm: b, first: t.first } : null;
  }
  /* 曲を4つに分けて、拍の位置が前後でズレていないか見る（テンポがゆれる曲の目印）。spread＝いちばん早い所と遅い所の差(ms) */
  function checkDrift(env, bpm, first) {
    getNov(env);
    const list = env._list, rate = env.rate, T = rate * 60 / bpm, Ts = 60 / bpm, n = env._nov.o.length, K = 4, errs = [];
    for (let k = 0; k < K; k++) {
      const a = n * k / K, b = n * (k + 1) / K, ii = [], ww = [];
      for (let q = 0; q < list.i.length; q++) { const i = list.i[q]; if (i >= a && i < b) { ii.push(i); ww.push(list.w[q]); } }
      if (ii.length < 30) { errs.push(null); continue; }
      const f = fold({ i: ii, w: ww }, T);
      let d = f.bin / f.nb * T / rate - first; d -= Math.round(d / Ts) * Ts;
      errs.push(Math.round(d * 1000));
    }
    const v = errs.filter(x => x !== null);
    return { errs, spread: v.length ? Math.max.apply(null, v) - Math.min.apply(null, v) : 0 };
  }
  /* opt.bpm を渡すと、BPMは固定で「最初の拍の位置」だけ推定する */
  function detectTempo(env, opt) {
    opt = opt || {};
    const rate = env.rate, nov = getNov(env), n = nov.o.length;
    if (n < rate * 8) return null;                         // 8秒未満は無理
    const list = env._list;
    let bpm = opt.bpm, alts = [];
    if (!(bpm > 0)) {
      // 1) 自己相関でおおまかなBPM（250Hzに間引いて軽くする）
      const m = Math.floor(n / 2), od = new Float32Array(m);
      for (let i = 0; i < m; i++) od[i] = nov.o[2 * i] + nov.o[2 * i + 1];
      const r2 = rate / 2, Llo = Math.ceil(r2 * 60 / 190), Lhi = Math.floor(r2 * 60 / 70);
      const r = new Float64Array(2 * Lhi + 2);
      for (let L = Math.floor(Llo / 2); L <= 2 * Lhi; L++) {
        let s = 0; for (let i = 0; i + L < m; i++) s += od[i] * od[i + L];
        r[L] = s / (m - L);
      }
      const sc = new Float64Array(Lhi + 2); let bL = Llo;
      for (let L = Llo; L <= Lhi; L++) {
        const b = r2 * 60 / L, prior = Math.exp(-0.5 * Math.pow(Math.log2(b / 118) / 0.9, 2));
        sc[L] = (r[L] + 0.5 * r[2 * L] + 0.5 * r[Math.round(L / 2)]) * prior;
        if (sc[L] > sc[bL]) bL = L;
      }
      let d = 0;
      if (bL > Llo && bL < Lhi) { const a = sc[bL - 1], b = sc[bL], c = sc[bL + 1], den = a - 2 * b + c; if (den < 0) d = 0.5 * (a - c) / den; }
      bpm = r2 * 60 / (bL + d);
      // 2) 拍の位置に音が集まるBPMを、±4%の範囲で細かく探す
      bpm = refine(list, rate, bpm);
      [bpm / 2, bpm * 2].forEach(a => { if (a >= 60 && a <= 200) alts.push(Math.round(a * 100) / 100); });
    }
    const f = fold(list, rate * 60 / bpm);
    const first = f.bin / f.nb * f.T / rate;
    return { bpm: Math.round(bpm * 100) / 100, first: Math.round(first * 1000) / 1000, conf: Math.round(f.score * f.nb * 100) / 100, alts };
  }

  /* ---------- まとめ ---------- */
  function analyzeSamples(x, sr, opt) {
    opt = opt || {};
    const env = envelopes(x, sr);
    let bpm = opt.bpm, first = opt.first, tempo = null;
    if (!(bpm > 0) || first == null) {
      tempo = detectTempo(env, { bpm: bpm > 0 ? bpm : 0 });
      if (!tempo) return { profile: null, tempo: null };
      if (!(bpm > 0)) bpm = tempo.bpm;
      if (first == null) first = tempo.first;
    }
    return { profile: buildProfile(env, bpm, first), tempo };
  }

  /* ---------- 保存・復元（localStorage 用／曲データに直書きもできる） ---------- */
  function digits(a) { let s = ''; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
  function serialize(p) { return [VER, p.bpm, p.first, p.n, digits(p.low), digits(p.high)].join('|'); }
  function parse(str) {
    const a = String(str).split('|');
    if (a.length !== 6 || a[0] !== VER) throw new Error('bad profile');
    const n = +a[3];
    if (a[4].length !== n || a[5].length !== n) throw new Error('bad profile length');
    return { bpm: +a[1], first: +a[2], n, low: Uint8Array.from(a[4], c => +c), high: Uint8Array.from(a[5], c => +c) };
  }
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { } }

  /* ---------- ブラウザ：mp3 → モノラルの波形 ---------- */
  const tick = () => new Promise(r => setTimeout(r, 30));      // 画面を描き直す時間をあげる
  function decodeWith(makeCtx, buf, ms) {
    return new Promise((res, rej) => {
      let done = false, ctx;
      const t = setTimeout(() => { if (!done) { done = true; rej(new Error('decode timeout')); } }, ms);
      const ok = v => { if (!done) { done = true; clearTimeout(t); res(v); } }, ng = e => { if (!done) { done = true; clearTimeout(t); rej(e || new Error('decode failed')); } };
      try { ctx = makeCtx(); const p = ctx.decodeAudioData(buf, ok, ng); if (p && p.then) p.then(ok, ng); } catch (e) { ng(e); }
    });
  }
  function decodeToMono(buf) {
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext, AC = root.AudioContext || root.webkitAudioContext;
    // ① 22.05kHzのオフライン（軽い）→ ダメなら ② 普通のAudioContext（iPhoneで固まる時の保険）
    const first = () => decodeWith(() => new OAC(1, 1, 22050), buf.slice(0), 20000);
    const second = () => decodeWith(() => { root.__caCtx = root.__caCtx || new AC(); return root.__caCtx; }, buf.slice(0), 40000);
    return first().catch(() => second()).then(ab => {
      const ch = ab.numberOfChannels, sr = ab.sampleRate, f = Math.max(1, Math.round(sr / 22050));
      const len = Math.floor(ab.length / f), out = new Float32Array(len), k = 1 / (ch * f);
      for (let c = 0; c < ch; c++) {
        const d = ab.getChannelData(c);
        for (let i = 0; i < len; i++) { let s = 0; for (let j = 0; j < f; j++) s += d[i * f + j]; out[i] += s * k; }
      }
      return { x: out, sr: sr / f };
    });
  }

  /* ゲームの曲データ用。キャッシュ → 失敗なら null（ゲーム側は従来の譜面にもどる） */
  const memo = new Map(), inflight = new Map(), failed = new Set();   // failed：この読み込み中は、失敗した曲を何度も試さない
  function getProfile(song) {
    const first = song.first || 0, key = song.id + '|' + song.bpm + '|' + first;
    if (song.profile) return Promise.resolve(song.profile);      // マイサウンド：解析済みのデータをそのまま使う
    if (song.prof) {                                       // 曲データに直書きした解析結果（端末ごとの差が出ない）
      try { const p = parse(song.prof); if (p.bpm === song.bpm && Math.abs(p.first - first) < 1e-6) return Promise.resolve(p); } catch (e) { }
    }
    if (memo.has(key)) return Promise.resolve(memo.get(key));
    if (failed.has(key)) return Promise.reject(new Error('analysis failed'));
    const c = lsGet(CACHE_PREFIX + key);
    if (c) { try { const p = parse(c); memo.set(key, p); return Promise.resolve(p); } catch (e) { } }
    if (inflight.has(key)) return inflight.get(key);
    const pr = fetch(song.file)
      .then(r => { if (!r.ok) throw new Error('fetch ' + r.status); return r.arrayBuffer(); })
      .then(decodeToMono)
      .then(a => {
        const res = analyzeSamples(a.x, a.sr, { bpm: song.bpm, first });
        if (!res.profile) throw new Error('too short');
        memo.set(key, res.profile); lsSet(CACHE_PREFIX + key, serialize(res.profile));
        return res.profile;
      })
      .then(p => { inflight.delete(key); return p; }, e => { inflight.delete(key); failed.add(key); throw e; });
    inflight.set(key, pr);
    return pr;
  }

  /* 持ち込みmp3用。opt.bpm / opt.first を省くと推定する */
  function analyzeFile(file, opt) {
    return file.arrayBuffer().then(decodeToMono).then(a => analyzeSamples(a.x, a.sr, opt));
  }
  /* マイサウンド用：解析の途中結果(env)を持ち帰る。BPMや拍の位置を変えても、buildProfile(env, bpm, first) だけで再計算できる */
  function analyzeFileFull(file, onStage) {
    const st = m => { try { onStage && onStage(m); } catch (e) { } };
    st('曲を読み込み中…');
    return tick().then(() => file.arrayBuffer()).then(buf => { st('音を展開中…（' + (buf.byteLength / 1048576).toFixed(1) + 'MB）'); return tick().then(() => decodeToMono(buf)); })
      .then(a => { st('リズムを解析中…'); return tick().then(() => a); })
      .then(a => {
        const env = envelopes(a.x, a.sr); st('テンポを調べ中…');
        return tick().then(() => ({ env, duration: env.dur, tempo: detectTempo(env) }));
      });
  }

  const api = { VER, analyzeSamples, detectTempo, refineTempo, checkDrift, envelopes, buildProfile, serialize, parse, getProfile, analyzeFile, analyzeFileFull };
  root.ChartAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
