/* ==========================================================================
   开合动画 + 暗角氛围组件（Mood）
   配合 css/mood.css 使用，类名带 mood- 前缀；纯原生 JS，无依赖，file:// 可用。

   1) openPanel(el, height) / closePanel(el)
      把面板容器在「收起态」与「展开态」之间丝滑过渡，参数路径对称
      （怎么来的怎么回去）：
        收起态： height 0    · opacity 0 · translateY(-10px) · blur(6px)
        展开态： height N px · opacity 1 · translateY(0)     · blur(0)
      展开 ~480ms cubic-bezier(0.2,0.9,0.25,1)（快起步、缓收尾）；
      收起 ~320ms，缓动取展开曲线的时间镜像 cubic-bezier(0.75,0,0.8,0.1)
      （ease-in 类，路径严格对称）。只动 height / transform / opacity / filter，
      由 rAF 逐帧驱动；每次动画结束清理内联 filter（避免残留模糊）；
      收起终态 height:0 且 visibility:hidden + pointer-events:none（不可交互）。

   2) vignetteOn(host) / vignetteOff(host)
      在 host 内淡入 / 淡出暗角覆盖层 .mood-vignette（两层渐变见 css/mood.css，
      z-index 40、pointer-events:none 写死在 CSS）。淡入 350ms、淡出 400ms。
      vignetteOn 幂等（已点亮则直接 resolve）；vignetteOff 在淡出结束后
      移除覆盖层 DOM（保留复用 / 用后移除二选一，此处取「用后移除」，
      下次 vignetteOn 自动重建，host 保持干净）。

   用法：
     Mood.openPanel(panelEl, 320).then(function () {});  // 展开到 320px 高
     Mood.closePanel(panelEl).then(function () {});      // 收起
     Mood.vignetteOn(hostEl).then(function () {});       // host 须为可定位容器
     Mood.vignetteOff(hostEl).then(function () {});

   集成约定：
   - 面板容器建议预置 css/mood.css 的 .mood-panel 类（首帧即为收起态）；
     组件一旦接管，全以内联样式为准。容器自身不要带 padding/border
     （height:0 时内边距仍占位），内边距请放进内层包裹元素。
   - host 若是 position:static，vignetteOn 会临时借位为 relative
     （relative 零偏移不改变布局），vignetteOff 清理后归还原状；
     host 有圆角时建议同时 overflow:hidden（.mood-vignette 已
     border-radius:inherit 自动跟随圆角）。
   - 竞态：同向重复调用复用在途 Promise（不重启动画）；反向调用立即接管，
     被覆盖的旧 Promise 当场 resolve（绝不悬挂），新动画从当前视觉状态
     无缝续接，时长按剩余距离等比缩放。
   - prefers-reduced-motion: reduce：跳过全部动画直接置终态，Promise 立即 resolve。
   ========================================================================== */
window.Mood = (function () {
  'use strict';

  /* ---------------- 常量（与 css/mood.css 的说明保持一致） ---------------- */

  var OPEN_MS = 480;   // 展开总时长
  var CLOSE_MS = 320;  // 收起总时长（稍快）
  /* 展开缓动：快起步、缓收尾；收起缓动为其时间镜像（x/y 各取 1-值） */
  var OPEN_EASE = makeBezier(0.2, 0.9, 0.25, 1);
  var CLOSE_EASE = makeBezier(0.75, 0, 0.8, 0.1);
  var SHIFT_PX = 10;   // 收起态 translateY 偏移
  var BLUR_PX = 6;     // 收起态模糊半径（展开起点 / 收起终点）
  var VG_IN_MS = 350;  // 暗角淡入
  var VG_OUT_MS = 400; // 暗角淡出
  var VG_BUFFER_MS = 24;      // 过渡结束后的小缓冲，视觉落定再 resolve
  var MIN_RETARGET_MS = 120;  // 中途改向时按剩余距离缩放时长的下限

  var panelMap = new WeakMap(); // 面板 el → 动画状态
  var vgMap = new WeakMap();    // 暗角 host → 覆盖层状态
  var media = null;             // matchMedia 句柄缓存

  /* ---------------- 通用工具 ---------------- */

  function isEl(x) { return !!(x && x.nodeType === 1); }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function lerp(a, b, p) { return a + (b - a) * p; }

  function toPx(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) n = 0;
    return n;
  }

  function reducedMotion() {
    if (!window.matchMedia) return false;
    if (!media) media = window.matchMedia('(prefers-reduced-motion: reduce)');
    return !!media.matches;
  }

  /* 三次贝塞尔缓动求解，与 CSS cubic-bezier(x1,y1,x2,y2) 同义：
     牛顿迭代为主、二分兜底，输入时间进度 x∈[0,1]，返回路程进度 y。 */
  function makeBezier(x1, y1, x2, y2) {
    var cx = 3 * x1;
    var bx = 3 * (x2 - x1) - cx;
    var ax = 1 - cx - bx;
    var cy = 3 * y1;
    var by = 3 * (y2 - y1) - cy;
    var ay = 1 - cy - by;

    function sampleX(t) { return ((ax * t + bx) * t + cx) * t; }
    function sampleY(t) { return ((ay * t + by) * t + cy) * t; }
    function sampleDX(t) { return (3 * ax * t + 2 * bx) * t + cx; }

    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x;
      var i;
      for (i = 0; i < 8; i++) {           // 牛顿迭代
        var err = sampleX(t) - x;
        if (Math.abs(err) < 1e-6) return sampleY(t);
        var d = sampleDX(t);
        if (Math.abs(d) < 1e-7) break;
        t -= err / d;
      }
      var lo = 0, hi = 1;                 // 二分兜底
      t = x;
      for (i = 0; i < 24; i++) {
        var vx = sampleX(t);
        if (Math.abs(vx - x) < 1e-6) break;
        if (vx < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return sampleY(t);
    };
  }

  /* ---------------- 面板：状态与样式应用 ---------------- */
  /* st = {
       mode: 'closed' | 'open',   // 已落定的终态
       target: 目标高度 px,
       fullH: 最近一次完全展开高度（收起时长按比例缩放用）,
       raf: 在途 rAF id,
       pending: { dir: 'open'|'close', promise, resolve } | null
     } */

  function ensureState(el) {
    var st = panelMap.get(el);
    if (!st) {
      st = { mode: 'closed', target: 0, fullH: 0, raf: 0, pending: null };
      panelMap.set(el, st);
    }
    if (st.touched !== true) {
      st.touched = true; // 首次接触：按当前布局推断初始状态（未挂 mood-panel 类也能正确收合）
      var h = el.getBoundingClientRect().height;
      if (h > 1) { st.mode = 'open'; st.target = h; st.fullH = h; }
    }
    return st;
  }

  /* 读取当前视觉参数（height/opacity/translateY/blur），用于中途改向时无缝续接 */
  function currentMetrics(el) {
    var cs = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    var ty = 0;
    var tr = cs.transform;
    if (tr && tr !== 'none') {
      var m = tr.match(/matrix\(([^)]*)\)/);
      if (m) ty = parseFloat(m[1].split(',')[5]) || 0;
    }
    var o = parseFloat(cs.opacity);
    var b = 0;
    var fm = cs.filter && cs.filter.match(/blur\(([\d.]+)px\)/);
    if (fm) b = parseFloat(fm[1]) || 0;
    return { h: rect.height, o: isNaN(o) ? 1 : o, y: ty, b: b };
  }

  function applyFrame(el, h, o, y, b) {
    el.style.height = h.toFixed(2) + 'px';
    el.style.opacity = o.toFixed(3);
    el.style.transform = 'translateY(' + y.toFixed(2) + 'px)';
    el.style.filter = b < 0.05 ? 'none' : 'blur(' + b.toFixed(2) + 'px)';
  }

  /* 展开终态：显式覆写全部内联样式；filter 置 none（规格要求清理残留模糊，
     亦压掉可能的收起态默认值），transform/pointer-events 显式落定不回退级联 */
  function applyOpenFinal(el, h) {
    el.style.overflow = 'hidden';
    el.style.height = h + 'px';
    el.style.opacity = '1';
    el.style.transform = 'translateY(0px)';
    el.style.filter = 'none';
    el.style.visibility = 'visible';
    el.style.pointerEvents = 'auto';
    el.style.willChange = '';
  }

  /* 收起终态：height:0 + 不可交互；不写 filter（清理内联，避免残留） */
  function applyClosedFinal(el) {
    el.style.overflow = 'hidden';
    el.style.height = '0px';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-' + SHIFT_PX + 'px)';
    el.style.filter = '';
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
    el.style.willChange = '';
  }

  function cancelAnim(st) {
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    if (st.pending) {           // 被覆盖的在途 Promise 立即 resolve，绝不悬挂
      var p = st.pending;
      st.pending = null;
      p.resolve();
    }
  }

  /* rAF 逐帧驱动：from → to 按缓动插值四参数，结束后落定终态并 resolve */
  function startAnim(el, st, dir, from, to, ms, easeFn) {
    cancelAnim(st);
    var box = {};
    var promise = new Promise(function (resolve) { box.resolve = resolve; });
    st.pending = { dir: dir, promise: promise, resolve: box.resolve };
    st.target = to.h;
    if (dir === 'open' && to.h > st.fullH) st.fullH = to.h;

    el.style.overflow = 'hidden';
    el.style.visibility = 'visible';
    el.style.pointerEvents = dir === 'open' ? 'auto' : 'none'; // 收起一开始就不可点
    el.style.willChange = 'height, transform, opacity, filter';

    var t0 = 0;
    function frame(ts) {
      if (!t0) t0 = ts;
      var t = Math.min(1, (ts - t0) / ms);
      var e = easeFn(t);
      applyFrame(el,
        lerp(from.h, to.h, e),
        lerp(from.o, to.o, e),
        lerp(from.y, to.y, e),
        lerp(from.b, to.b, e));
      if (t < 1) { st.raf = requestAnimationFrame(frame); return; }
      st.raf = 0;
      var done = st.pending;
      st.pending = null;
      if (dir === 'open') { st.mode = 'open'; applyOpenFinal(el, to.h); }
      else { st.mode = 'closed'; applyClosedFinal(el); }
      if (done) done.resolve();
    }
    st.raf = requestAnimationFrame(frame);
    return promise;
  }

  /* ---------------- 面板：对外 API ---------------- */

  function openPanel(el, height) {
    if (!isEl(el)) return Promise.resolve();
    var st = ensureState(el);
    var target = toPx(height);

    if (reducedMotion()) {   // 减少动态：跳过动画直接终态
      cancelAnim(st);
      applyOpenFinal(el, target);
      st.mode = 'open'; st.target = target;
      if (target > st.fullH) st.fullH = target;
      return Promise.resolve();
    }
    if (target < 1) return closePanel(el); // 目标高度为 0 视为收起

    // 幂等 1：已完全展开且目标一致
    if (!st.pending && st.mode === 'open' && st.target === target) return Promise.resolve();
    // 幂等 2：正在向同一目标展开 → 复用在途 Promise，不重启动画
    if (st.pending && st.pending.dir === 'open' && st.target === target) return st.pending.promise;

    var from = currentMetrics(el);
    if (from.o < 0.05 && from.h < 1) {
      // 完全不可见：按规格的收起参数位起步（不可见态快照，无视觉跳变）
      from = { h: 0, o: 0, y: -SHIFT_PX, b: BLUR_PX };
    }
    var to = { h: target, o: 1, y: 0, b: 0 };
    // 中途改向 / 重设高度：按剩余距离等比缩放时长，避免几像素也拖满 480ms
    var ratio = clamp01(Math.abs(to.h - from.h) / Math.max(to.h, 1));
    var ms = Math.max(MIN_RETARGET_MS, Math.round(OPEN_MS * (0.25 + 0.75 * ratio)));
    return startAnim(el, st, 'open', from, to, ms, OPEN_EASE);
  }

  function closePanel(el) {
    if (!isEl(el)) return Promise.resolve();
    var st = ensureState(el);

    if (reducedMotion()) {
      cancelAnim(st);
      applyClosedFinal(el);
      st.mode = 'closed'; st.target = 0;
      return Promise.resolve();
    }

    // 幂等 1：正在收起 → 复用在途 Promise
    if (st.pending && st.pending.dir === 'close') return st.pending.promise;
    // 幂等 2：已收起 → 顺手把终态补齐后直接 resolve
    if (!st.pending && st.mode === 'closed' && st.target === 0) {
      applyClosedFinal(el);
      return Promise.resolve();
    }

    var from = currentMetrics(el);
    var full = Math.max(st.fullH, from.h, 1);
    var to = { h: 0, o: 0, y: -SHIFT_PX, b: BLUR_PX }; // 与展开路径完全对称
    var ratio = clamp01(from.h / full);
    var ms = Math.max(MIN_RETARGET_MS, Math.round(CLOSE_MS * (0.3 + 0.7 * ratio)));
    return startAnim(el, st, 'close', from, to, ms, CLOSE_EASE);
  }

  /* ---------------- 暗角：内部实现 ---------------- */
  /* vs = { layer, timer, pending: {dir, promise, resolve}|null, on: 目标态, borrowed: 是否借位 host } */

  function ensureVgState(host) {
    var vs = vgMap.get(host);
    if (!vs) {
      vs = { layer: null, timer: 0, pending: null, on: false, borrowed: false };
      vgMap.set(host, vs);
    }
    return vs;
  }

  function clearVgTimer(vs) {
    if (vs.timer) { clearTimeout(vs.timer); vs.timer = 0; }
  }

  function resolveVgPending(vs) {
    if (vs.pending) {
      var p = vs.pending;
      vs.pending = null;
      p.resolve();
    }
  }

  function createVignette(host) {
    var layer = document.createElement('div');
    layer.className = 'mood-vignette';
    layer.setAttribute('aria-hidden', 'true');
    var radial = document.createElement('div');   // 第一层：径向暗角
    radial.className = 'mood-vignette-radial';
    var film = document.createElement('div');     // 第二层：上下压暗的电影感
    film.className = 'mood-vignette-film';
    layer.appendChild(radial);
    layer.appendChild(film);
    host.appendChild(layer);
    return layer;
  }

  /* host 为 static 时临时借位 relative（零偏移，不影响布局），记下以便归还原状 */
  function ensureHostPositioned(host, vs) {
    var pos = 'static';
    try { pos = window.getComputedStyle(host).position || 'static'; } catch (e) { /* 保持 static 判断 */ }
    if (pos === 'static') {
      host.style.position = 'relative';
      vs.borrowed = true;
    }
  }

  function restoreHostPosition(host, vs) {
    if (vs.borrowed) {
      vs.borrowed = false;
      host.style.position = '';
    }
  }

  function connectedLayer(host, vs) {
    return (vs.layer && host.contains(vs.layer)) ? vs.layer : null;
  }

  /* ---------------- 暗角：对外 API ---------------- */

  function vignetteOn(host) {
    if (!isEl(host)) return Promise.resolve();
    var vs = ensureVgState(host);

    if (reducedMotion()) {   // 减少动态：直接点亮，不做过渡
      clearVgTimer(vs);
      resolveVgPending(vs);
      ensureHostPositioned(host, vs);
      if (!connectedLayer(host, vs)) vs.layer = createVignette(host);
      vs.layer.style.transition = 'none';
      vs.layer.style.opacity = '1';
      vs.on = true;
      return Promise.resolve();
    }

    // 幂等：已点亮且无在途过渡
    if (vs.on && !vs.pending && connectedLayer(host, vs)) return Promise.resolve();
    // 在途同向：复用同一个 Promise
    if (vs.pending && vs.pending.dir === 'on') return vs.pending.promise;

    clearVgTimer(vs);
    resolveVgPending(vs);    // 反向在途被覆盖：其 Promise 当场 resolve

    ensureHostPositioned(host, vs);
    if (!connectedLayer(host, vs)) vs.layer = createVignette(host);
    var layer = vs.layer;
    layer.style.transition = 'opacity ' + VG_IN_MS + 'ms ease';
    void layer.offsetWidth;  // 强制重排：确保新建层从 opacity:0 起过渡
    layer.style.opacity = '1';
    vs.on = true;

    var box = {};
    var promise = new Promise(function (resolve) { box.resolve = resolve; });
    vs.pending = { dir: 'on', promise: promise, resolve: box.resolve };
    vs.timer = setTimeout(function () {
      vs.timer = 0;
      vs.pending = null;
      box.resolve();
    }, VG_IN_MS + VG_BUFFER_MS);
    return promise;
  }

  function vignetteOff(host) {
    if (!isEl(host)) return Promise.resolve();
    var vs = ensureVgState(host);
    vs.on = false;
    var layer = connectedLayer(host, vs);

    if (reducedMotion()) {   // 减少动态：直接移除
      clearVgTimer(vs);
      resolveVgPending(vs);
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      vs.layer = null;
      restoreHostPosition(host, vs);
      return Promise.resolve();
    }

    // 没有覆盖层（从未点亮 / 已移除）：直接 resolve
    if (!layer) {
      clearVgTimer(vs);
      resolveVgPending(vs);
      restoreHostPosition(host, vs);
      return Promise.resolve();
    }
    // 在途同向：复用同一个 Promise
    if (vs.pending && vs.pending.dir === 'off') return vs.pending.promise;

    clearVgTimer(vs);
    resolveVgPending(vs);    // 反向在途被覆盖：其 Promise 当场 resolve

    layer.style.transition = 'opacity ' + VG_OUT_MS + 'ms ease';
    layer.style.opacity = '0';
    var box = {};
    var promise = new Promise(function (resolve) { box.resolve = resolve; });
    vs.pending = { dir: 'off', promise: promise, resolve: box.resolve };
    vs.timer = setTimeout(function () {
      vs.timer = 0;
      vs.pending = null;
      if (layer.parentNode) layer.parentNode.removeChild(layer); // 用后移除，host 保持干净
      vs.layer = null;
      restoreHostPosition(host, vs);
      box.resolve();
    }, VG_OUT_MS + VG_BUFFER_MS);
    return promise;
  }

  /* ---------------- 对外接口 ---------------- */

  return {
    openPanel: openPanel,
    closePanel: closePanel,
    vignetteOn: vignetteOn,
    vignetteOff: vignetteOff
  };
})();
