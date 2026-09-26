/* 入口：全局状态、抽号流程（单人开箱式 / 多人老虎机式）、名单与设置、历史 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /* ---- 全局状态 ---- */
  var state = {
    students: Roster.load() || [],
    called: {},        /* 本轮已点：key -> true */
    rolling: false,
    panelOpen: false,  /* 抽取面板是否展开 */
    lastWinners: []    /* 最近一轮中奖 key，用于设置页头像墙描金 */
  };
  var byKey = {};
  var avatarByKey = {}; /* 本轮头像分配：key -> 图片 URL */

  function rebuildIndex() {
    byKey = {};
    state.students.forEach(function (s) { byKey[s.key] = s; });
  }
  rebuildIndex();

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 从候选中随机抽 n 个（互不相同） */
  function pick(arr, n) {
    var copy = arr.slice();
    shuffle(copy);
    return copy.slice(0, n);
  }

  /* ---- 设置（持久化） ---- */
  var settings = { mode: 'single', count: 3, noRepeat: false, sound: true };
  try {
    var saved = JSON.parse(localStorage.getItem('heroRoll.settings.v1') || '{}');
    if (saved.mode === 'multi' || saved.mode === 'single') settings.mode = saved.mode;
    if (saved.count >= 2 && saved.count <= 5) settings.count = saved.count;
    if (typeof saved.noRepeat === 'boolean') settings.noRepeat = saved.noRepeat;
    if (typeof saved.sound === 'boolean') settings.sound = saved.sound;
  } catch (e) { /* 忽略 */ }
  function saveSettings() {
    try { localStorage.setItem('heroRoll.settings.v1', JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  }

  /* ---- 本轮已点名单（持久化，名单变更后自动失效） ---- */
  function fingerprint() {
    return state.students.map(function (s) { return s.key; }).join(',');
  }
  function saveCalled() {
    try {
      localStorage.setItem('heroRoll.called.v1',
        JSON.stringify({ fp: fingerprint(), keys: Object.keys(state.called) }));
    } catch (e) { /* 忽略 */ }
  }
  function loadCalled() {
    try {
      var d = JSON.parse(localStorage.getItem('heroRoll.called.v1') || 'null');
      if (d && d.fp === fingerprint() && Array.isArray(d.keys)) {
        d.keys.forEach(function (k) { if (byKey[k]) state.called[k] = true; });
      }
    } catch (e) { /* 忽略 */ }
  }

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- 头像分配：每次点名随机换一批 ---- */
  function repickAvatars() {
    var pool = (window.AVATARS && window.AVATARS.length) ? window.AVATARS.slice() : [''];
    shuffle(pool);
    state.students.forEach(function (s, i) {
      avatarByKey[s.key] = pool[i % pool.length];
    });
  }

  function itemsOf(list) {
    return list.map(function (s) {
      return { key: s.key, name: s.name, id: s.id, avatar: avatarByKey[s.key] };
    });
  }

  /* ---- 小提示 / 对话框 ---- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  function confirmModal(title, body, okText) {
    return new Promise(function (resolve) {
      $('modal-title').textContent = title;
      $('modal-body').textContent = body;
      $('modal-ok').textContent = okText || '确定';
      $('modal').hidden = false;
      $('modal-ok').focus();
      function done(v) {
        $('modal').hidden = true;
        $('modal-ok').onclick = null;
        $('modal-cancel').onclick = null;
        $('modal').onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') done(false);
        if (e.key === 'Enter') done(true);
      }
      $('modal-ok').onclick = function () { done(true); };
      $('modal-cancel').onclick = function () { done(false); };
      $('modal').onclick = function (e) { if (e.target === $('modal')) done(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  /* ---- 页面切换：抽号主界面 / 名单与设置 ---- */
  function setupOpen() { return !$('page-setup').hidden; }

  function openSetup() {
    if (!$('roster-text').value.trim() && state.students.length) {
      $('roster-text').value = Roster.toCsvText(state.students);
    }
    renderPreview();
    $('page-setup').hidden = false;
    document.body.classList.add('setup-open');
    rebuildWall();
  }

  function closeSetup() {
    $('page-setup').hidden = true;
    document.body.classList.remove('setup-open');
  }

  function rebuildWall() {
    var empty = !state.students.length;
    $('wall-empty').hidden = !empty;
    $('wall-summary').textContent = empty
      ? '每次点名会随机换一批头像'
      : state.students.length + ' 名同学 · 每次点名随机换头像';
    if (empty) { $('wall').innerHTML = ''; return; }
    Wall.build(itemsOf(state.students));
    applyCalledVisual();
    state.lastWinners.forEach(function (k) { Wall.spotlight(k); });
  }

  function calledCount() { return Object.keys(state.called).length; }

  function updateSummary() {
    $('roster-summary').textContent =
      '共 ' + state.students.length + ' 人，本轮已点 ' + calledCount() + ' 人';
  }

  function applyCalledVisual() {
    if (settings.noRepeat) {
      Wall.markCalled(Object.keys(state.called));
    } else {
      Wall.unmarkAll();
    }
  }

  function updateEmpty() {
    var empty = !state.students.length;
    $('roller-empty').hidden = !empty;
    $('btn-roll').disabled = empty;
  }

  function setRollingUi(rolling) {
    var btn = $('btn-roll');
    btn.disabled = rolling || !state.students.length;
    btn.textContent = rolling
      ? '抽取中…'
      : (calledCount() ? '再点一次' : '开始点名');
    if (rolling) $('btn-collapse').hidden = true;
  }

  /* ==========================================================================
     名单与设置：导入 / 预览 / 文件
     ========================================================================== */

  var lastParse = null;
  var previewTimer = null;

  function renderPreview() {
    var text = $('roster-text').value;
    var preview = $('preview');
    if (!text.trim()) {
      preview.hidden = true;
      $('btn-import').disabled = true;
      lastParse = null;
      return;
    }
    lastParse = Roster.parse(text);
    preview.hidden = false;

    var countMsg = '识别出 ' + lastParse.students.length + ' 名同学';
    if (lastParse.headersSkipped) countMsg += '，已跳过表头 ' + lastParse.headersSkipped + ' 行';
    $('preview-count').textContent = countMsg;
    $('preview-errors').textContent = lastParse.errors.length
      ? '，' + lastParse.errors.length + ' 行格式有误'
      : '';

    var ul = $('preview-list');
    ul.innerHTML = '';
    lastParse.students.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'chip';
      if (s.id) {
        var b = document.createElement('b');
        b.textContent = s.id;
        li.appendChild(b);
      }
      li.appendChild(document.createTextNode(s.name));
      ul.appendChild(li);
    });
    lastParse.errors.forEach(function (e) {
      var li = document.createElement('li');
      li.className = 'chip bad';
      li.textContent = '第 ' + e.line + ' 行「' + e.text + '」：' + e.reason;
      ul.appendChild(li);
    });

    $('btn-import').disabled = !lastParse.students.length;
  }

  $('roster-text').addEventListener('input', function () {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  });

  /* 文件读取：优先按 UTF-8 严格解码，失败回退 GBK（Excel 导出的 CSV 常见） */
  function decodeBuffer(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) {
      try { return new TextDecoder('gbk').decode(bytes); }
      catch (e2) { return new TextDecoder().decode(bytes); }
    }
  }

  $('roster-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      $('roster-text').value = decodeBuffer(new Uint8Array(reader.result)).trim();
      renderPreview();
      toast('已读取「' + file.name + '」，请核对解析结果');
    };
    reader.readAsArrayBuffer(file);
    this.value = '';
  });

  /* 示例名单：用 Blob 生成下载，file:// 下同样可用 */
  $('btn-example').addEventListener('click', function () {
    var text = '学号,姓名\r\n2024001,张三\r\n2024002,李四\r\n2024003,王五\r\n2024004,赵六\r\n2024005,陈七\r\n';
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'students.example.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  });

  $('btn-import').addEventListener('click', function () {
    if (!lastParse || !lastParse.students.length) return;
    state.students = lastParse.students;
    rebuildIndex();
    Roster.save(state.students);
    state.called = {};
    state.lastWinners = [];
    saveCalled();
    repickAvatars();
    rebuildWall();
    updateSummary();
    updateEmpty();
    setRollingUi(false);
    closeSetup();
    toast('名单已保存，共 ' + state.students.length + ' 名同学');
  });

  $('btn-setup').addEventListener('click', openSetup);
  $('btn-setup-close').addEventListener('click', closeSetup);
  $('btn-empty-import').addEventListener('click', openSetup);

  /* ==========================================================================
     抽号：单人开箱式 / 多人老虎机式
     ========================================================================== */

  var stripRoller = null;
  var slotRoller = null;

  function getRoller() {
    if (settings.mode === 'multi') {
      if (!slotRoller) slotRoller = new SlotRoller($('roller'));
      return slotRoller;
    }
    if (!stripRoller) stripRoller = new StripRoller($('roller'));
    return stripRoller;
  }

  window.addEventListener('resize', function () {
    var r = settings.mode === 'multi' ? slotRoller : stripRoller;
    if (r && r.resize) r.resize();
  });

  /* 滚动声节流：高速时太密集会变成噪声；同时把两次嗒声的间隔
     映射成速度感（间隔越短滚得越快）传给音效 */
  var lastTickAt = 0;
  function throttledTick() {
    var now = performance.now();
    var gap = now - lastTickAt;
    if (gap >= 40) {
      lastTickAt = now;
      Sfx.tick(Math.max(0, Math.min(1, 1 - gap / 500)));
    }
  }

  function clearTray() {
    $('tray').innerHTML = '';
  }

  function addTrayChip(item) {
    var tray = $('tray');
    var chip = document.createElement('span');
    chip.className = 'tray-chip';
    var img = document.createElement('img');
    img.src = item.avatar;
    img.alt = '';
    var name = document.createElement('b');
    name.textContent = item.name;
    chip.appendChild(img);
    chip.appendChild(name);
    tray.appendChild(chip);
    if (!reducedMotion) {
      chip.animate(
        [{ opacity: 0, transform: 'scale(0.7)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 220, easing: 'cubic-bezier(0.2, 1.1, 0.3, 1)' }
      );
    }
  }

  function panelHeight() {
    return window.matchMedia('(max-width: 680px)').matches ? 200 : 236;
  }

  /* ---- 全屏金色准线（单人抽取）：从屏幕中心向上下生长，标记中奖列 ---- */
  var screenLineTimer = null;

  function showScreenLine() {
    if (settings.mode !== 'single') return;
    if (screenLineTimer) { clearTimeout(screenLineTimer); screenLineTimer = null; }
    var line = $('screen-line');
    document.body.classList.add('screen-line-on');
    line.hidden = false;
    void line.offsetWidth; /* 强制回流，让 scaleY 过渡生效 */
    line.classList.add('on');
  }

  function hideScreenLine() {
    if (screenLineTimer) { clearTimeout(screenLineTimer); screenLineTimer = null; }
    document.body.classList.remove('screen-line-on');
    var line = $('screen-line');
    line.classList.remove('on');
    screenLineTimer = setTimeout(function () {
      screenLineTimer = null;
      if (!line.classList.contains('on')) line.hidden = true;
    }, 560);
  }

  /* 抽完 5.6 秒后，全屏准线平滑收回至中间（面板内的短准线接管标记中奖位） */
  function scheduleScreenLineRetract() {
    if (settings.mode !== 'single') return;
    if (screenLineTimer) clearTimeout(screenLineTimer);
    screenLineTimer = setTimeout(function () {
      screenLineTimer = null;
      hideScreenLine();
    }, 5600);
  }

  /* 定格微震：窗口轻微下沉回弹，一层打击感。
     注意必须用相对定位的 top 而不是 transform——transform 会让小窗
     变成独立图层，全屏准线（z45）会在微震的 180ms 里盖住中奖头像 */
  function thump() {
    if (reducedMotion) return;
    document.querySelector('.app-window').animate(
      [{ top: '0px' }, { top: '3px' }, { top: '-1px' }, { top: '0px' }],
      { duration: 180, easing: 'ease-out' }
    );
  }

  function startRoll() {
    if (state.rolling) return;
    if (!state.students.length) { openSetup(); return; }
    Sfx.unlock();

    var pool = settings.noRepeat
      ? state.students.filter(function (s) { return !state.called[s.key]; })
      : state.students.slice();

    if (!pool.length) {
      confirmModal('全班都点过了', '不重复模式下这一轮的所有同学都被点到了。要重置本轮，重新开始吗？', '重置本轮')
        .then(function (ok) {
          if (ok) {
            resetRound(false);
            startRoll();
          }
        });
      return;
    }

    var count = settings.mode === 'multi'
      ? Math.max(2, Math.min(settings.count, pool.length))
      : 1;
    var winnerKeys = pick(pool.map(function (s) { return s.key; }), count);

    state.rolling = true;
    setRollingUi(true);
    clearTray();
    repickAvatars(); /* 每轮随机换一批头像 */
    if (settings.mode === 'single') showScreenLine();

    /* 面板收起时先丝滑展开（配一声 whoosh），再开抽 */
    var opening;
    if (state.panelOpen) {
      opening = Promise.resolve();
    } else {
      Sfx.start();
      document.body.classList.add('panel-open');
      opening = Mood.openPanel($('roller'), panelHeight()).then(function () {
        state.panelOpen = true;
      });
    }

    opening.then(function () {
      Mood.vignetteOn(document.body); /* 暗角罩住整个屏幕，从四角/上下边缘压进来 */
      return getRoller().roll({
        items: itemsOf(pool),
        winners: winnerKeys,
        reduced: reducedMotion,
        onTick: throttledTick,
      onLand: function (item) {
        Sfx.land();
        addTrayChip(item);
        thump();
      }
      });
    }).then(function () {
      winnerKeys.forEach(function (k) { state.called[k] = true; });
      state.lastWinners = winnerKeys.slice();
      saveCalled();
      updateSummary();

      Sfx.reveal();
      confettiBurst();
      Mood.vignetteOff(document.body);
      scheduleScreenLineRetract(); /* 5.6 秒后全屏准线平滑收回 */
      HistoryStore.add(winnerKeys.map(function (k) {
        return { id: byKey[k].id, name: byKey[k].name };
      }));

      state.rolling = false;
      setRollingUi(false);
      $('btn-collapse').hidden = false;
      maybePromptReset();
    });
  }

  function maybePromptReset() {
    if (!settings.noRepeat) return;
    var left = state.students.filter(function (s) { return !state.called[s.key]; }).length;
    if (left) return;
    setTimeout(function () {
      confirmModal('全班都点过了', '这一轮所有同学都被点到了，要重置本轮开始新的一轮吗？', '重置本轮')
        .then(function (ok) { if (ok) resetRound(true); });
    }, 1400);
  }

  function resetRound(announce) {
    state.called = {};
    state.lastWinners = [];
    saveCalled();
    applyCalledVisual();
    updateSummary();
    setRollingUi(false);
    clearTray();
    if (announce) toast('本轮已重置，全班重新开始');
  }

  $('btn-roll').addEventListener('click', startRoll);

  /* 收起抽取面板，回到只有「开始点名」按钮的安静状态 */
  $('btn-collapse').addEventListener('click', function () {
    if (state.rolling) return;
    $('btn-collapse').hidden = true;
    clearTray();
    hideScreenLine();
    Mood.closePanel($('roller')).then(function () {
      document.body.classList.remove('panel-open');
      state.panelOpen = false;
      /* 面板里的旧画面不再需要：销毁滚动器，下次展开时重建 */
      if (stripRoller) { stripRoller.destroy(); stripRoller = null; }
      if (slotRoller) { slotRoller.destroy(); slotRoller = null; }
    });
  });

  /* 空格 / 回车也可开始抽取（输入控件聚焦时除外） */
  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea, select, button') || state.rolling) return;
    if (setupOpen()) return;
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      startRoll();
    }
  });

  /* ---- 控制行：模式 / 人数 / 不重复 / 音效 / 重置 ---- */
  function syncModeUi() {
    var buttons = $('mode-seg').querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('on', buttons[i].dataset.mode === settings.mode);
    }
    $('count-label').hidden = settings.mode !== 'multi';
  }

  $('mode-seg').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-mode]');
    if (!btn || btn.dataset.mode === settings.mode) return;
    settings.mode = btn.dataset.mode;
    saveSettings();
    syncModeUi();
    /* 切换模式时销毁另一套滚动器，清掉它在容器里的残留画面 */
    if (settings.mode === 'multi') {
      if (stripRoller) { stripRoller.destroy(); stripRoller = null; }
      hideScreenLine();
    } else if (slotRoller) {
      slotRoller.destroy();
      slotRoller = null;
    }
    var r = settings.mode === 'multi' ? slotRoller : stripRoller;
    if (r && r.resize) r.resize();
  });

  $('opt-count').addEventListener('change', function () {
    settings.count = parseInt(this.value, 10) || 3;
    saveSettings();
  });

  $('opt-norepeat').addEventListener('change', function () {
    settings.noRepeat = this.checked;
    saveSettings();
    applyCalledVisual();
    toast(this.checked ? '不重复模式：点过的同学不再被抽中' : '完全随机模式：所有人都可能被点到');
  });

  $('opt-sound').addEventListener('change', function () {
    settings.sound = this.checked;
    saveSettings();
    Sfx.setEnabled(settings.sound);
    if (settings.sound) Sfx.tick();
  });

  $('btn-reset').addEventListener('click', function () {
    if (state.rolling) return;
    var n = calledCount();
    if (!n) { toast('本轮还没有点过人'); return; }
    confirmModal('重置本轮', '已点过的 ' + n + ' 位同学将恢复可选，确定重置吗？', '重置')
      .then(function (ok) { if (ok) resetRound(true); });
  });

  /* ---- 历史记录抽屉 ---- */
  function fmtTime(t) {
    var d = new Date(t);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderHistory() {
    var list = HistoryStore.all();
    $('history-empty').hidden = list.length > 0;
    $('btn-history-clear').hidden = !list.length;
    var ul = $('history-list');
    ul.innerHTML = '';
    list.forEach(function (entry) {
      var li = document.createElement('li');
      var time = document.createElement('time');
      time.textContent = fmtTime(entry.t);
      var names = document.createElement('span');
      names.textContent = entry.names.map(function (n) { return n.name; }).join('、');
      li.appendChild(time);
      li.appendChild(names);
      ul.appendChild(li);
    });
  }

  function openHistory() {
    renderHistory();
    $('history-panel').hidden = false;
    $('drawer-mask').hidden = false;
  }
  function closeHistory() {
    $('history-panel').hidden = true;
    $('drawer-mask').hidden = true;
  }

  $('btn-history').addEventListener('click', openHistory);
  $('btn-history-close').addEventListener('click', closeHistory);
  $('drawer-mask').addEventListener('click', closeHistory);
  $('btn-history-clear').addEventListener('click', function () {
    confirmModal('清空历史', '所有点名记录将被删除，确定清空吗？', '清空')
      .then(function (ok) {
        if (ok) {
          HistoryStore.clear();
          renderHistory();
          toast('历史记录已清空');
        }
      });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('history-panel').hidden) { closeHistory(); return; }
    if (setupOpen()) closeSetup();
  });

  /* ---- 彩带（浅色调、克制的庆祝） ---- */
  function confettiBurst() {
    if (reducedMotion) return;
    var cv = $('confetti');
    cv.hidden = false;
    cv.width = window.innerWidth;
    cv.height = window.innerHeight;
    var ctx2 = cv.getContext('2d');
    var colors = ['#f2d998', '#d5a844', '#b8860b', '#f5e6c2', '#8fc7d4'];
    var parts = [];
    for (var i = 0; i < 90; i++) {
      parts.push({
        x: Math.random() * cv.width,
        y: -20 - Math.random() * cv.height * 0.35,
        w: 5 + Math.random() * 7,
        h: 9 + Math.random() * 9,
        vy: 2.4 + Math.random() * 3,
        vx: -1.3 + Math.random() * 2.6,
        rot: Math.random() * Math.PI,
        vr: -0.12 + Math.random() * 0.24,
        color: colors[i % colors.length]
      });
    }
    var start = performance.now();
    function frame(now) {
      ctx2.clearRect(0, 0, cv.width, cv.height);
      var alive = false;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.rot += p.vr;
        if (p.y < cv.height + 30) alive = true;
        ctx2.save();
        ctx2.translate(p.x, p.y);
        ctx2.rotate(p.rot);
        ctx2.fillStyle = p.color;
        ctx2.globalAlpha = 0.9;
        ctx2.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx2.restore();
      }
      if (alive && now - start < 3800) {
        requestAnimationFrame(frame);
      } else {
        ctx2.clearRect(0, 0, cv.width, cv.height);
        cv.hidden = true;
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---- 初始化 ---- */
  $('opt-norepeat').checked = settings.noRepeat;
  $('opt-count').value = String(settings.count);
  $('opt-sound').checked = settings.sound;
  Sfx.setEnabled(settings.sound);
  syncModeUi();
  loadCalled();
  repickAvatars();
  updateSummary();
  updateEmpty();

  if (!state.students.length) {
    openSetup(); /* 首次使用：直接进入名单导入 */
  }
})();
