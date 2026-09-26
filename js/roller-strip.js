/* StripRoller：CS:GO 开箱风格的横向滚动抽取组件（纸带 + 金色准线）。
   用法：
     var roller = new StripRoller(container);   // container 已挂载、有确定尺寸
     roller.roll({
       items: [{ key, name, id, avatar }],      // 候选数组
       winners: ['k9'],                          // 长度恒为 1，必在 items 中
       reduced: false,                           // true：跳过长动画，直接淡入定格
       durationMs: 2100,                         // 可选，覆盖默认时长
       onTick: function () {},                   // 每有一个条目边界越过准线调用一次
       onLand: function (item, index) {}         // 第 index 个中奖者定格瞬间调用
     });                                        // → Promise，定格 + 高亮一拍后 resolve
     roller.resize();                           // 容器尺寸变化后重算
     roller.destroy();                          // 移除 DOM、停掉动画

   实现要点：
   - 滚动本体用 rAF 自绘缓动，只动 transform / opacity / filter（合成器友好）；
   - 对齐：终点 x 精确解出 targetX = cx - winIndex*ITEM_W - ITEM_W/2，
     cx 取根节点宽度一半（与 CSS left:50% 同源），误差为浮点级（<< 2px）；
   - 缓动：easeOutQuint 打底（启动最快、长尾减速），进度 60% 后叠加一个
     两端导数为 0 的回弹项，收尾轻微越过终点 ≤3px 再 settle 回准线。 */
window.StripRoller = (function () {
  'use strict';

  var ITEM_W = 96;        // 单格宽度，必须与 roller-strip.css 里的 .rs-cell 严格一致
  var DEFAULT_MS = 2100;  // 默认时长（2.0–2.2s）
  var HOLD_MS = 260;      // 定格后高亮一拍再 resolve
  var FADE_MS = 200;      // reduced 模式的淡入时长
  var MAX_BLUR = 1.2;     // 峰值运动模糊上限（px）
  var BUMP_T0 = 0.6;      // 回弹项从进度 60% 处开始生效

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* 主缓动：easeOutQuint，启动最快、长尾极慢 */
  function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }

  /* 收尾回弹形状：u∈[0,1]，0→1→0，两端导数为 0，峰值恰好 1 */
  function settleBump(u) {
    var k = u * u * (1 - u) * (1 - u);
    return 16 * k;
  }

  /* ------------------------------------------------------------------
     序列构建：候选循环 + 局部打乱（相邻不重复），中奖者放进指定格位
     ------------------------------------------------------------------ */

  function findItem(items, key) {
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].key) === String(key)) return items[i];
    }
    return null;
  }

  /* 随机取一个与 prevKey 不同的候选（只有一个候选时只能重复） */
  function nextCandidate(items, prevKey) {
    if (items.length === 1) return items[0];
    var guard = 0;
    var c;
    do {
      c = items[Math.floor(Math.random() * items.length)];
    } while (String(c.key) === prevKey && ++guard < 24);
    return c;
  }

  /* 随机取一个既不是 notKey 也不是 alsoNotKey 的候选 */
  function pickOther(items, notKey, alsoNotKey) {
    var guard = 0;
    var c;
    while (guard++ < 24) {
      c = items[Math.floor(Math.random() * items.length)];
      if (String(c.key) !== String(notKey) &&
          (alsoNotKey == null || String(c.key) !== String(alsoNotKey))) {
        return c;
      }
    }
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].key) !== String(notKey)) return items[i];
    }
    return items[0];
  }

  function buildSequence(items, winnerKey, count, winIndex) {
    if (!items.length) items = [{ key: '', name: '', id: '', avatar: '' }];
    var seq = [];
    for (var i = 0; i < count; i++) {
      var prev = seq.length ? String(seq[seq.length - 1].key) : '';
      seq.push(nextCandidate(items, prev));
    }
    var winner = findItem(items, winnerKey) || items[0];
    seq[winIndex] = winner;
    /* 修正与中奖者相邻的撞车（相邻不重复） */
    if (items.length > 1) {
      if (winIndex > 0 && String(seq[winIndex - 1].key) === String(winner.key)) {
        seq[winIndex - 1] = pickOther(items, winner.key,
          winIndex > 1 ? seq[winIndex - 2].key : null);
      }
      if (winIndex < count - 1 && String(seq[winIndex + 1].key) === String(winner.key)) {
        seq[winIndex + 1] = pickOther(items, winner.key,
          String(seq[winIndex].key) === String(winner.key) ? null : seq[winIndex].key);
      }
    }
    return seq;
  }

  /* ------------------------------------------------------------------
     组件本体
     ------------------------------------------------------------------ */

  function StripRoller(container) {
    if (!container || container.nodeType !== 1) {
      throw new Error('StripRoller: 需要一个已挂载的容器元素');
    }
    this.container = container;
    this.root = null;
    this.track = null;
    this.cells = [];
    this.raf = 0;
    this.gen = 0;             // 代际号：新 roll / destroy 会让旧动画帧失效
    this.width = 0;           // 根节点宽度（= 组件实际可用宽度）
    this.cx = 0;              // 准线中心 x（宽度一半，与 CSS left:50% 同源）
    this.winIndex = -1;       // 中奖卡片在纸带中的格位
    this.targetX = 0;         // 定格时纸带的 transform x
    this.landed = false;      // 是否处于定格高亮状态
    this._geo = null;
    this._seq = null;
    this._items = null;
    this._pendingResolve = null;
    this._lastLandedItem = null;
    this._build();
  }

  /* 建静态层：纸带容器 + 光晕 + 左右渐隐 + 准线 */
  StripRoller.prototype._build = function () {
    var root = document.createElement('div');
    root.className = 'rs-root';

    var track = document.createElement('div');
    track.className = 'rs-track';
    root.appendChild(track);

    var halo = document.createElement('div');
    halo.className = 'rs-halo';
    root.appendChild(halo);

    var fadeL = document.createElement('div');
    fadeL.className = 'rs-fade rs-fade-l';
    var fadeR = document.createElement('div');
    fadeR.className = 'rs-fade rs-fade-r';
    root.appendChild(fadeL);
    root.appendChild(fadeR);

    var line = document.createElement('div');
    line.className = 'rs-line';
    root.appendChild(line);

    this.root = root;
    this.track = track;
    this.container.appendChild(root);
    this._measure();
  };

  /* 量尺寸：取根节点宽度的一半作为准线中心（与 CSS left:50% 严格一致） */
  StripRoller.prototype._measure = function () {
    var rect = this.root.getBoundingClientRect();
    this.width = rect.width;
    this.cx = rect.width / 2;
  };

  /* 几何规划：算格子总数、中奖格位、起始余量。
     sideCells 覆盖半屏；leftPad 给随机起始偏移留余量；spin 是滚动途经格数。 */
  StripRoller.prototype._geometry = function () {
    var w = Math.max(this.width, 240);
    var sideCells = Math.ceil((this.cx + ITEM_W / 2) / ITEM_W) + 1;
    var leftPad = sideCells + 2;
    var spin = clamp(Math.ceil(w / ITEM_W) * 4, 20, 44);
    var winIndex = leftPad + spin;
    return {
      n: winIndex + 1 + sideCells,   // 总格数（一般 30–60，随容器宽度变化）
      w: winIndex,                   // 中奖格位
      spin: spin,
      leftPad: leftPad
    };
  };

  /* 重建纸带 DOM：清掉上一轮的格子与状态 */
  StripRoller.prototype._buildTape = function (seq) {
    var track = this.track;
    track.innerHTML = '';
    this.cells = [];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < seq.length; i++) {
      var data = seq[i];
      var cell = document.createElement('div');
      cell.className = 'rs-cell';

      var item = document.createElement('div');
      item.className = 'rs-item';

      var img = document.createElement('img');
      img.className = 'rs-avatar';
      img.src = data.avatar || '';
      img.alt = '';
      img.draggable = false;
      item.appendChild(img);

      var name = document.createElement('span');
      name.className = 'rs-name';
      name.textContent = data.name || '';
      item.appendChild(name);

      if (data.id) {
        var id = document.createElement('span');
        id.className = 'rs-id';
        id.textContent = data.id;
        item.appendChild(id);
      }

      cell.appendChild(item);
      frag.appendChild(cell);
      this.cells.push(cell);
    }
    track.appendChild(frag);
    track.style.opacity = '1';
    track.style.filter = 'none';
    track.style.transform = 'translate3d(0px,0,0)';
  };

  /* 清掉上一轮动画：停 raf、提前 settle 旧 Promise、使旧回调失效 */
  StripRoller.prototype._supersede = function () {
    if (this.raf) {
      window.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.gen++;
    if (this._pendingResolve) {
      var resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve(this._lastLandedItem || null);
    }
  };

  StripRoller.prototype.roll = function (opts) {
    opts = opts || {};
    var self = this;
    var items = opts.items || [];
    var winners = opts.winners || [];
    var onTick = typeof opts.onTick === 'function' ? opts.onTick : function () {};
    var onLand = typeof opts.onLand === 'function' ? opts.onLand : function () {};
    var reduced = opts.reduced === true ||
      (opts.reduced == null && window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    this._supersede();
    var gen = ++this.gen;
    this.landed = false;
    this._lastLandedItem = null;

    this._measure();
    var geo = this._geometry();
    var winnerKey = winners.length ? winners[0] : '';
    this._items = items;
    this._geo = geo;
    this.winIndex = geo.w;
    this._seq = buildSequence(items, winnerKey, geo.n, geo.w);
    this._buildTape(this._seq);
    this.root.classList.remove('rs-dimmed');
    /* 终点精确解：中奖卡片中心 = targetX + w*96 + 48 = cx，浮点级误差 */
    this.targetX = this.cx - geo.w * ITEM_W - ITEM_W / 2;

    return new Promise(function (resolve) {
      self._pendingResolve = resolve;
      if (reduced) {
        self._runReduced(gen, onLand);
      } else {
        self._runSpin(gen, opts, onTick, onLand);
      }
    });
  };

  /* 主动画：rAF 自绘缓动，向左滑行到 targetX */
  StripRoller.prototype._runSpin = function (gen, opts, onTick, onLand) {
    var self = this;
    var track = this.track;
    var geo = this._geo;
    var D = geo.spin * ITEM_W + Math.random() * Math.max(geo.leftPad * ITEM_W + ITEM_W / 2 - this.cx, 0);
    var overshoot = clamp(D * 0.0011, 1.4, 3);  // 收尾回弹幅度，≤3px
    var dur = clamp(Number(opts.durationMs) > 0 ? Number(opts.durationMs) : DEFAULT_MS, 500, 8000);
    var t0 = 0;
    var prevT = 0;
    var prevX = this.targetX + D;
    var lastBlur = -1;
    var lastIdx = Math.floor((this.cx - prevX) / ITEM_W);

    track.style.transform = 'translate3d(' + prevX + 'px,0,0)';

    function frame(now) {
      if (gen !== self.gen) return;   // 已被新 roll / destroy 取代
      if (!t0) { t0 = now; prevT = now; }
      var t = dur > 0 ? Math.min((now - t0) / dur, 1) : 1;
      var x;
      if (t >= 1) {
        x = self.targetX;             // 终点直接取精确解，不靠浮点累加
      } else {
        var u = t <= BUMP_T0 ? 0 : (t - BUMP_T0) / (1 - BUMP_T0);
        x = self.targetX + D * (1 - easeOutQuint(t)) - overshoot * settleBump(u);
      }

      /* 运动模糊：只跟速度走，量化到 0.2px；速度低时彻底移除 filter */
      var dt = Math.max(now - prevT, 1);
      var speed = Math.abs(prevX - x) / dt;
      var blur = clamp((speed - 0.35) * 0.35, 0, MAX_BLUR);
      var bq = Math.round(blur * 5) / 5;
      if (bq !== lastBlur) {
        track.style.filter = bq > 0 ? 'blur(' + bq + 'px)' : 'none';
        lastBlur = bq;
      }

      /* onTick：每有一个条目边界越过准线调用一次（一帧跨多格则补发） */
      var idx = Math.floor((self.cx - x) / ITEM_W);
      if (idx !== lastIdx) {
        var fire = Math.min(Math.abs(idx - lastIdx), 4);
        for (var k = 0; k < fire; k++) onTick();
        lastIdx = idx;
      }

      track.style.transform = 'translate3d(' + x + 'px,0,0)';
      prevX = x;
      prevT = now;

      if (t >= 1) {
        self._land(gen, onLand);
        return;
      }
      self.raf = window.requestAnimationFrame(frame);
    }

    this.raf = window.requestAnimationFrame(frame);
  };

  /* reduced：不做长动画，直接摆到终点再 200ms 淡入 */
  StripRoller.prototype._runReduced = function (gen, onLand) {
    var self = this;
    var track = this.track;
    track.style.transform = 'translate3d(' + this.targetX + 'px,0,0)';
    track.style.opacity = '0';
    var t0 = 0;

    function frame(now) {
      if (gen !== self.gen) return;
      if (!t0) t0 = now;
      var t = Math.min((now - t0) / FADE_MS, 1);
      track.style.opacity = String(t);
      if (t >= 1) {
        track.style.opacity = '1';
        self.raf = 0;
        self._land(gen, onLand);
        return;
      }
      self.raf = window.requestAnimationFrame(frame);
    }

    this.raf = window.requestAnimationFrame(frame);
  };

  /* 定格：描金 + 压暗其余项，onLand 后高亮一拍再 resolve */
  StripRoller.prototype._land = function (gen, onLand) {
    var self = this;
    this.raf = 0;
    if (gen !== this.gen) return;
    this.track.style.filter = 'none';
    var cell = this.cells[this.winIndex];
    var item = this._seq ? this._seq[this.winIndex] : null;
    if (cell) cell.classList.add('rs-win');
    this.root.classList.add('rs-dimmed');
    this.landed = true;
    this._lastLandedItem = item || null;
    if (onLand && item) onLand(item, 0);

    setTimeout(function () {
      if (gen !== self.gen) return;
      var resolve = self._pendingResolve;
      self._pendingResolve = null;
      if (resolve) resolve(item);
    }, HOLD_MS);
  };

  /* 容器尺寸变化后重算：
     - 滚动中：只更新终点（同一格位换算新 cx），轨迹自然接到新准线上；
     - 已定格：几何可能盖不满新宽度，按需重建同序列纸带并直接落位。 */
  StripRoller.prototype.resize = function () {
    if (!this._seq || !this.cells.length) {
      this._measure();
      return;
    }
    var oldWidth = this.width;
    this._measure();
    if (this.raf) {
      this.targetX = this.cx - this.winIndex * ITEM_W - ITEM_W / 2;
      return;
    }
    if (this.width !== oldWidth) {
      var geo = this._geometry();
      if (geo.n !== this._seq.length) {
        /* 先按旧序列取出中奖者 key，再换新几何重建 */
        var winnerKey = this._seq[this.winIndex] ? this._seq[this.winIndex].key : '';
        this._geo = geo;
        this.winIndex = geo.w;
        this._seq = buildSequence(this._items, winnerKey, geo.n, geo.w);
        this._buildTape(this._seq);
      }
    }
    this.targetX = this.cx - this.winIndex * ITEM_W - ITEM_W / 2;
    this.track.style.transform = 'translate3d(' + this.targetX + 'px,0,0)';
    if (this.landed) {
      var cell = this.cells[this.winIndex];
      if (cell) cell.classList.add('rs-win');
      this.root.classList.add('rs-dimmed');
    }
  };

  StripRoller.prototype.destroy = function () {
    if (this.raf) {
      window.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.gen++;
    if (this._pendingResolve) {
      var resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve(this._lastLandedItem || null);
    }
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this.root = null;
    this.track = null;
    this.cells = [];
    this._seq = null;
    this._items = null;
    this._geo = null;
    this.landed = false;
  };

  return StripRoller;
})();
