/* 老虎机滚轮抽取组件：N 个竖直滚轮同时疾驰、错峰减速，依次定格到各自的中奖者。
   金色赔付线恒在滚轮垂直中央；定格时中奖项金环放大，全部停完后其余压暗。
   滚动由 rAF 自绘缓动驱动（只改 transform / filter），不依赖 CSS 动画；
   落格瞬间按实测位置做一次亚像素校正，保证赔付线正对中奖项（误差 < 2px）。

   用法：
     var roller = new SlotRoller(container);   // container 已挂载、有确定尺寸
     roller.roll({
       items: [{ key, name, id, avatar }],     // 候选数组（不足时循环复用）
       winners: ['k3', 'k7'],                  // 长度 N = 滚轮数，互不相同
       reduced: false,                         // true：不做长动画，淡入定格
       durationMs: 2500,                       // 首位滚轮的定格时间
       onTick: function (reelIndex) {},        // 高频：任一滚轮有条目越过赔付线
       onLand: function (item, index) {}       // 第 index 个滚轮定格瞬间
     }).then(function () {});                  // 全部定格 + 高亮一拍后 resolve
     roller.resize();
     roller.destroy();

   每次 roll() 按 winners.length 重建滚轮（N 可变）；重复 roll() 前自动清理
   上一轮的 DOM / rAF / 定时器。组件不写死任何数据，头像 URL 由调用方传入。 */
window.SlotRoller = (function () {
  'use strict';

  /* 组件常量（条目高、间距等与 css/roller-slots.css 保持一致） */
  var CFG = {
    staggerMs: 350,      // 相邻滚轮的定格间隔
    maxTotalMs: 3200,    // 最后一轮定格的总时长上限
    minBaseMs: 700,      // 首轮定格时间下限，保证减速段可读
    defaultBaseMs: 1800, // durationMs 缺省值
    landBeatMs: 250,     // 全部定格后的高亮一拍，之后 resolve
    topSpeed: 2600,      // 起始滚速 px/s（对应缓动起始斜率 START_SLOPE）
    blurScale: 2600,     // 速度→模糊换算：blur = 速度 / blurScale，封顶 blurMax
    blurMax: 1.2,
    bouncePx: 2.4,       // 收尾回弹幅度（≤3px）
    bounceMs: 150,       // 回弹时长（含在每轮定格时间之内）
    reducedFadeMs: 260,  // reduced 模式整块淡入时长
    reducedGapMs: 70     // reduced 模式下逐轮 onLand 的小间隔
  };

  /* ---------------- 纯函数：缓动 / 几何 / 洗牌袋 ---------------- */

  function easeOutQuint(p) { return 1 - Math.pow(1 - p, 5); }

  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }

  /* 复合缓动：前 60% 时间近似匀速疾驰（启动即最高速），后 40% 时间 easeOutQuint
     长尾滑入；两段斜率连续（f = 5a/(1+4a) 由斜率相等推得），收尾速度趋近于零 */
  var EASE_A = 0.6;
  var START_SLOPE = 5 / (1 + 4 * EASE_A); /* 起始斜率 ≈1.47，用于速度→行程换算 */

  function spinEase(p) {
    var f = 5 * EASE_A / (1 + 4 * EASE_A);
    if (p < EASE_A) return f * (p / EASE_A);
    return f + (1 - f) * easeOutQuint((p - EASE_A) / (1 - EASE_A));
  }

  /* strip 的终点位移：让下标 winnerIndex 的条目中心正对滚轮垂直中央
     （条目 i 在 strip 内的中心 ≈ i * pitch + cellH / 2） */
  function targetY(reelH, cellH, pitch, winnerIndex) {
    return reelH / 2 - cellH / 2 - winnerIndex * pitch;
  }

  /* 滚轮在时刻 t（ms，自本轮开始）的位移：主体缓动 + 收尾 ≤3px 回弹 */
  function yAt(r, t) {
    if (t <= 0) return r.yStart;
    if (t < r.durMain) return r.yStart + r.travel * spinEase(t / r.durMain);
    var q = Math.min((t - r.durMain) / CFG.bounceMs, 1);
    return r.yOver - CFG.bouncePx * easeOutCubic(q);
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 从候选中随机取一个并避开 avoid——用于修补相邻重复（候选仅 1 个时跳过） */
  function pickOther(items, avoid) {
    if (items.length === 1) return items[0];
    var k;
    do {
      k = items[Math.floor(Math.random() * items.length)];
    } while (k === avoid);
    return k;
  }

  /* 洗牌袋：循环复用候选生成 len 个条目，相邻不重复（候选仅 1 个时除外） */
  function bagSequence(items, len) {
    var out = [];
    var last = null;
    while (out.length < len) {
      var batch = shuffle(items.slice());
      if (last && batch[0] === last && items.length > 1) {
        var t = batch[0]; batch[0] = batch[1]; batch[1] = t; /* 与上批结尾重复，批内互换化解 */
      }
      for (var i = 0; i < batch.length && out.length < len; i++) {
        out.push(batch[i]);
        last = batch[i];
      }
    }
    return out;
  }

  /* 单点修补：seq[pos] 若与左右相邻重复则换成不同候选 */
  function deDuplicate(seq, pos, items) {
    var left = pos > 0 ? seq[pos - 1] : null;
    var right = pos < seq.length - 1 ? seq[pos + 1] : null;
    if (seq[pos] !== left && seq[pos] !== right) return;
    var guard = 0;
    while (guard++ < 30 && (seq[pos] === left || seq[pos] === right)) {
      seq[pos] = pickOther(items, left === right ? left : null);
    }
  }

  /* ---------------- DOM 小工具 ---------------- */

  function buildCell(item) {
    var cell = document.createElement('div');
    cell.className = 'sr-cell';

    var img = document.createElement('img');
    img.className = 'sr-avatar';
    img.src = item.avatar || '';
    img.alt = '';
    img.draggable = false;
    cell.appendChild(img);

    var name = document.createElement('span');
    name.className = 'sr-name';
    name.textContent = item.name || '';
    cell.appendChild(name);

    if (item.id) {
      var sid = document.createElement('span');
      sid.className = 'sr-sid';
      sid.textContent = item.id;
      cell.appendChild(sid);
    }
    return cell;
  }

  function setTransform(el, y) {
    el.style.transform = 'translate3d(0,' + y + 'px,0)';
  }

  /* ---------------- 组件本体 ---------------- */

  /* 构造：container 需已挂载且有确定尺寸；组件以绝对定位铺满它 */
  function SlotRoller(container) {
    if (!(this instanceof SlotRoller)) return new SlotRoller(container);
    if (!container || container.nodeType !== 1) {
      throw new Error('SlotRoller: 需要一个容器元素');
    }
    this._box = container;
    /* 容器若是 static，借位成 relative 以便铺满；destroy 时还原 */
    this._ownsPosition = !container.style.position || container.style.position === 'static';
    if (this._ownsPosition) container.style.position = 'relative';

    this._root = document.createElement('div');
    this._root.className = 'sr-root';

    var stage = document.createElement('div');
    stage.className = 'sr-stage';

    this._reelsEl = document.createElement('div');
    this._reelsEl.className = 'sr-reels';
    stage.appendChild(this._reelsEl);

    var payline = document.createElement('div');
    payline.className = 'sr-payline';
    stage.appendChild(payline);

    this._root.appendChild(stage);
    container.appendChild(this._root);

    this._geom = null;   /* { reelH, cellH, pitch }，每次 roll 实测 */
    this._reels = [];
    this._raf = 0;
    this._timers = [];
    this._token = 0;     /* 轮次令牌：旧一轮的帧循环 / 定时器据此作废 */
    this._rolling = false;
    this._resolve = null;
    this._destroyed = false;
  }

  /* 按本轮 winners 重建滚轮并实测几何；无可用的中奖者时返回 false */
  SlotRoller.prototype._buildReels = function (items, winners, base, reduced) {
    var reelsEl = this._reelsEl;
    reelsEl.innerHTML = '';
    this._reels = [];

    var reelByKey = {};
    for (var i = 0; i < items.length; i++) reelByKey[items[i].key] = items[i];
    var landing = [];
    for (var w = 0; w < winners.length; w++) {
      if (reelByKey[winners[w]]) landing.push(reelByKey[winners[w]]);
    }
    if (!landing.length) return false;

    var rootH = this._rootH();
    var estCell = 94;  /* 与 CSS 的约定值，仅用于估算建条数，之后以实测为准 */
    var estPitch = estCell + 10;

    var reels = [];
    for (var k = 0; k < landing.length; k++) {
      var dur = base + k * CFG.staggerMs;
      var durMain = dur - CFG.bounceMs;
      /* 总行程由起始速度反推：v0 = travel * START_SLOPE / durMain */
      var travel = reduced ? 0
        : CFG.topSpeed * (durMain / 1000) / START_SLOPE + CFG.bouncePx;

      var reelEl = document.createElement('div');
      reelEl.className = 'sr-reel';
      var strip = document.createElement('div');
      strip.className = 'sr-strip';
      reelEl.appendChild(strip);
      var fadeTop = document.createElement('div');
      fadeTop.className = 'sr-fade sr-fade-top';
      var fadeBottom = document.createElement('div');
      fadeBottom.className = 'sr-fade sr-fade-bottom';
      reelEl.appendChild(fadeTop);
      reelEl.appendChild(fadeBottom);

      /* 上方至少留一屏余量；下方除一屏外还要覆盖整个滚动距离
         （strip 向下流：起点时看到的是 winner 下方的远处条目） */
      var pad = Math.ceil(rootH / estPitch) + 3;
      var before = pad + (reduced ? 0 : Math.ceil(travel / estPitch));
      var after = pad + 1 + (reduced ? 0 : Math.ceil(travel / estPitch));

      var seq = bagSequence(items, before + 1 + after);
      seq[before] = landing[k];          /* 终点格固定为本轮 winner */
      /* 相邻格若与中奖格相同则替换相邻格；绝不能动中奖格本身，
         否则画面定格的会和 onLand 报告的中奖者不一致 */
      deDuplicate(seq, before - 1, items);
      deDuplicate(seq, before + 1, items);

      var cells = [];
      for (var c = 0; c < seq.length; c++) {
        var cell = buildCell(seq[c]);
        strip.appendChild(cell);
        cells.push(cell);
      }
      reelsEl.appendChild(reelEl);

      reels.push({
        el: reelEl, strip: strip, cells: cells, seq: seq,
        item: landing[k], wIndex: before,
        dur: dur, durMain: durMain, travel: travel,
        yFinal: 0, yStart: 0, yOver: 0,
        prevY: 0, lastPass: null, landed: false
      });
    }

    /* 实测节距与条目高（CSS 若调整，这里自动跟随） */
    var probe = reels[0].strip.children;
    var cellH = probe.length ? probe[0].offsetHeight : estCell;
    var pitch = probe.length > 1 ? (probe[1].offsetTop - probe[0].offsetTop) : estPitch;
    if (pitch <= 0) pitch = estPitch;

    /* 实测后不足的补条：上方补要同步后移终点下标，下方补直接追加 */
    for (var r = 0; r < reels.length; r++) {
      var rl = reels[r];
      var needBefore = Math.ceil((rootH / 2 + cellH / 2) / pitch) + 2;
      var needAfter = needBefore + (reduced ? 0 : Math.ceil(rl.travel / pitch));
      while (rl.wIndex < needBefore) {
        var it = pickOther(items, rl.seq[0]);
        rl.seq.unshift(it);
        var nc = buildCell(it);
        rl.strip.insertBefore(nc, rl.strip.firstChild);
        rl.cells.unshift(nc);
        rl.wIndex++;
      }
      while (rl.seq.length - 1 - rl.wIndex < needAfter) {
        var it2 = pickOther(items, rl.seq[rl.seq.length - 1]);
        rl.seq.push(it2);
        var nc2 = buildCell(it2);
        rl.strip.appendChild(nc2);
        rl.cells.push(nc2);
      }
      /* 终点位移（以实测几何计算） */
      rl.yFinal = targetY(rootH, cellH, pitch, rl.wIndex);
      rl.yOver = rl.yFinal + CFG.bouncePx;
      rl.yStart = rl.yOver - rl.travel;
      rl.prevY = rl.yStart;
    }

    this._geom = { reelH: rootH, cellH: cellH, pitch: pitch };
    this._reels = reels;
    return true;
  };

  /* opts: { items, winners, reduced, durationMs, onTick(reelIndex), onLand(item, index) } */
  SlotRoller.prototype.roll = function (opts) {
    var self = this;
    if (this._destroyed) return Promise.resolve();
    opts = opts || {};

    /* 上一轮尚未结束：作废其帧循环与定时器，并放行旧 Promise */
    this._abort();

    var items = Array.isArray(opts.items) ? opts.items : [];
    var winners = Array.isArray(opts.winners) ? opts.winners.slice() : [];
    var reduced = !!opts.reduced;
    var onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
    var onLand = typeof opts.onLand === 'function' ? opts.onLand : null;
    if (!items.length || !winners.length) return Promise.resolve();

    var n = Math.min(winners.length, 8);
    var base = opts.durationMs > 0 ? opts.durationMs : CFG.defaultBaseMs;
    /* 首轮定格时间夹在 [minBase, 总时长上限 − 错峰累计]，保证 5 轮 ≤3.2s */
    base = Math.max(CFG.minBaseMs,
      Math.min(base, CFG.maxTotalMs - (n - 1) * CFG.staggerMs));

    var ok = this._buildReels(items, winners.slice(0, n), base, reduced);
    if (!ok) return Promise.resolve();

    var promise = new Promise(function (resolve) { self._resolve = resolve; });
    var token = this._token;
    this._rolling = true;

    if (reduced) {
      this._runReduced(token, onLand);
    } else {
      this._startSpin(token, onTick, onLand);
    }
    return promise;
  };

  /* 启动帧循环：全部滚轮同刻起跑，各自按 base + k*350ms 的时刻表定格 */
  SlotRoller.prototype._startSpin = function (token, onTick, onLand) {
    var self = this;
    var reels = this._reels;
    var geom = this._geom;
    var t0 = performance.now();
    var prevT = t0;

    function frame(now) {
      if (token !== self._token || self._destroyed) return;
      var dt = Math.max(now - prevT, 1);
      prevT = now;
      var t = now - t0;
      var spinning = false;

      for (var k = 0; k < reels.length; k++) {
        var r = reels[k];
        if (r.landed) continue;
        if (t >= r.dur) {
          self._landReel(r, k, onLand);
          continue;
        }
        spinning = true;
        var y = yAt(r, t);
        setTransform(r.strip, y);

        /* 速度→运动模糊：只模糊滚轮内容层，随减速衰减到 0 */
        var v = Math.abs(y - r.prevY) / dt * 1000; /* px/s */
        r.prevY = y;
        var blur = Math.min(CFG.blurMax, v / CFG.blurScale);
        r.strip.style.filter = blur > 0.05 ? 'blur(' + blur.toFixed(2) + 'px)' : '';

        /* 条目越过赔付线：压线条目序号变化即回调一次（高频） */
        if (onTick) {
          var pass = Math.round((geom.reelH / 2 - geom.cellH / 2 - y) / geom.pitch);
          if (r.lastPass === null) {
            r.lastPass = pass;
          } else if (pass !== r.lastPass) {
            r.lastPass = pass;
            onTick(k);
          }
        }
      }

      if (!spinning) {
        self._finish(token);
        return;
      }
      self._raf = requestAnimationFrame(frame);
    }

    this._raf = requestAnimationFrame(frame);
  };

  /* 单轮定格：精确落格 + 亚像素校正 + 金环高亮 + onLand */
  SlotRoller.prototype._landReel = function (r, k, onLand) {
    r.landed = true;
    this._snapReel(r);
    r.cells[r.wIndex].classList.add('sr-win');
    if (onLand) onLand(r.item, k);
  };

  /* 落格：先按几何计算值落位，再读实测中心差做一次校正（一般 < 1px） */
  SlotRoller.prototype._snapReel = function (r) {
    setTransform(r.strip, r.yFinal);
    var err = this._centerOffset(r);
    if (err) setTransform(r.strip, r.yFinal - err);
    r.strip.style.filter = '';
  };

  /* 中奖项中心相对滚轮垂直中心的像素差（含当前 transform 的影响） */
  SlotRoller.prototype._centerOffset = function (r) {
    if (!this._root) return 0;
    var rootRect = this._root.getBoundingClientRect();
    var cellRect = r.cells[r.wIndex].getBoundingClientRect();
    if (!rootRect.height || !cellRect.height) return 0;
    return (cellRect.top + cellRect.height / 2) - (rootRect.top + rootRect.height / 2);
  };

  /* 全部定格：压暗非中奖项，高亮一拍后 resolve */
  SlotRoller.prototype._finish = function (token) {
    var self = this;
    this._raf = 0;
    for (var k = 0; k < this._reels.length; k++) {
      this._reels[k].strip.classList.add('sr-dim');
    }
    this._timers.push(setTimeout(function () {
      if (token !== self._token) return;
      self._rolling = false;
      var resolve = self._resolve;
      self._resolve = null;
      if (resolve) resolve();
    }, CFG.landBeatMs));
  };

  /* reduced：不做长动画，直接淡入定格结果（仍逐轮给 onLand 节奏） */
  SlotRoller.prototype._runReduced = function (token, onLand) {
    var self = this;
    var reels = this._reels;

    for (var k = 0; k < reels.length; k++) this._snapReel(reels[k]);

    /* 整块淡入：先置 sr-enter 再移除，让 CSS 过渡生效 */
    var root = this._root;
    root.classList.add('sr-enter');
    void root.offsetWidth; /* 强制回流 */
    root.classList.remove('sr-enter');

    for (var j = 0; j < reels.length; j++) {
      (function (idx) {
        self._timers.push(setTimeout(function () {
          if (token !== self._token) return;
          reels[idx].cells[reels[idx].wIndex].classList.add('sr-win');
          if (onLand) onLand(reels[idx].item, idx);
        }, CFG.reducedGapMs * idx));
      })(j);
    }

    this._timers.push(setTimeout(function () {
      if (token !== self._token) return;
      for (var m = 0; m < reels.length; m++) reels[m].strip.classList.add('sr-dim');
    }, CFG.reducedFadeMs));

    this._timers.push(setTimeout(function () {
      if (token !== self._token) return;
      self._rolling = false;
      var resolve = self._resolve;
      self._resolve = null;
      if (resolve) resolve();
    }, CFG.reducedFadeMs + CFG.landBeatMs));
  };

  /* 容器尺寸变化：重算几何并重新落位；滚动中则让后续帧按新几何计算 */
  SlotRoller.prototype.resize = function () {
    if (this._destroyed || !this._reels.length || !this._geom) return;
    var rootH = this._rootH();
    var probe = this._reels[0].strip.children;
    var cellH = probe.length ? probe[0].offsetHeight : this._geom.cellH;
    var pitch = probe.length > 1 ? (probe[1].offsetTop - probe[0].offsetTop) : this._geom.pitch;
    if (pitch <= 0) pitch = this._geom.pitch;
    this._geom = { reelH: rootH, cellH: cellH, pitch: pitch };

    for (var k = 0; k < this._reels.length; k++) {
      var r = this._reels[k];
      r.yFinal = targetY(rootH, cellH, pitch, r.wIndex);
      r.yOver = r.yFinal + CFG.bouncePx;
      r.yStart = r.yOver - r.travel;
      r.prevY = r.yStart;
      if (r.landed) this._snapReel(r);
    }
  };

  /* 清理当前轮：令牌递增使旧帧循环 / 定时器全部作废，旧 Promise 放行防悬挂 */
  SlotRoller.prototype._abort = function () {
    this._token++;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    for (var i = 0; i < this._timers.length; i++) clearTimeout(this._timers[i]);
    this._timers.length = 0;
    this._rolling = false;
    var resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve();
  };

  SlotRoller.prototype.destroy = function () {
    if (this._destroyed) return;
    this._abort();
    this._destroyed = true;
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    if (this._ownsPosition && this._box) this._box.style.position = '';
    this._root = null;
    this._reelsEl = null;
    this._reels = [];
    this._box = null;
  };

  /* 容器尚未撑开时的兜底高度（与典型调用方 660×230 一致） */
  SlotRoller.prototype._rootH = function () {
    var h = this._root ? this._root.getBoundingClientRect().height : 0;
    return h > 40 ? h : 230;
  };

  /* 供自测脚本验证的纯函数集（非公开 API） */
  SlotRoller._math = {
    easeOutQuint: easeOutQuint,
    easeOutCubic: easeOutCubic,
    spinEase: spinEase,
    startSlope: START_SLOPE,
    targetY: targetY,
    bagSequence: bagSequence
  };

  return SlotRoller;
})();
