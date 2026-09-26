/* 音效引擎：Web Audio 实时合成，无外部音频文件，离线可用
   音色美学：偏暖的三角波/正弦 + 短噪声瞬态，克制、统一、不过载 */
window.Sfx = (function () {
  'use strict';

  var ctx = null;        /* 懒创建的 AudioContext */
  var enabled = true;
  var master = null;     /* 主增益节点：统一响度出口 */
  var noise = null;      /* 共享白噪声缓冲（懒建一次，全部瞬态复用） */
  var tickFlip = 0;      /* tick 交替标志：连续触发也保持微妙差异 */
  var FLOOR = 0.0001;    /* 包络下限（指数斜坡不能到 0） */

  /* ---- 基础设施 ---- */

  function ac() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch (e) { /* 忽略 */ }
    }
    return ctx;
  }

  /* 主总线：所有音色汇入 master，经限幅器兜底后输出，绝不过载。
     各音色峰值按 ~0.25（约 -12dBFS）设计，master 0.9 仅作整体微收 */
  function bus(c) {
    if (!master) {
      master = c.createGain();
      master.gain.value = 0.9;
      var lim = c.createDynamicsCompressor();
      lim.threshold.value = -6;  /* 仅在多层叠加时才介入的安全阈值 */
      lim.knee.value = 6;
      lim.ratio.value = 12;
      lim.attack.value = 0.003;
      lim.release.value = 0.18;
      master.connect(lim);
      lim.connect(c.destination);
    }
    return master;
  }

  /* 共享噪声缓冲：1 秒白噪声 */
  function noiseBuf(c) {
    if (!noise) {
      var len = Math.floor(c.sampleRate);
      noise = c.createBuffer(1, len, c.sampleRate);
      var d = noise.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  /* 打击类包络：快起 → 指数衰减 → 归零，避免爆音 */
  function env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, FLOOR), t + attack);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + attack + decay);
    g.gain.setValueAtTime(0, t + attack + decay + 0.005);
  }

  /* 延音类包络：快起 → 缓降段（先慢后快）→ 归零，长音更饱满 */
  function envPad(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, FLOOR), t + attack);
    g.gain.exponentialRampToValueAtTime(peak * 0.22, t + attack + decay * 0.55);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + attack + decay);
    g.gain.setValueAtTime(0, t + attack + decay + 0.005);
  }

  /* 噪声瞬态：带通滤波的短噪声；随机读取起点让每次音色略有不同 */
  function noiseHit(c, t, freq, q, peak, attack, decay, type) {
    var out = bus(c);
    var src = c.createBufferSource();
    src.buffer = noiseBuf(c);
    src.loop = true;
    var f = c.createBiquadFilter();
    f.type = type || 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    f.Q.value = q;
    var g = c.createGain();
    env(g, t, peak, attack, decay);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  /* 振荡音：波形 + 包络 */
  function tone(c, t, freq, type, peak, attack, decay, pad) {
    var out = bus(c);
    var o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    var g = c.createGain();
    (pad ? envPad : env)(g, t, peak, attack, decay);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  function lerp(a, b, k) { return a + (b - a) * k; }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  /* ---- 音色 ---- */

  /* 抽取开始的气声 whoosh：带通噪声扫频 250→1400Hz，约 400ms，音量克制 */
  function start() {
    if (!enabled) return;
    var c = ac();
    if (!c) return;
    var t = c.currentTime;
    var jit = 1 + (Math.random() * 2 - 1) * 0.05;
    var out = bus(c);

    var src = c.createBufferSource();
    src.buffer = noiseBuf(c);
    src.loop = true;
    var f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.1;
    f.frequency.setValueAtTime(250 * jit, t);
    f.frequency.exponentialRampToValueAtTime(1400 * jit, t + 0.38);
    var g = c.createGain();
    g.gain.setValueAtTime(FLOOR, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.16);
    g.gain.exponentialRampToValueAtTime(FLOOR, t + 0.46);
    g.gain.setValueAtTime(0, t + 0.47);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.52);

    /* 极轻的低频隆起，给气声一点身体 */
    tone(c, t, 110 * jit, 'sine', 0.035, 0.18, 0.26);
  }

  /* 滚动嗒声：vel∈[0,1]（1=刚起步高速，0=减速尾段），无参按中速。
     高速：更亮更高、稍轻的短嗒；低速：更低沉清晰的“咔”，叠木质瞬态。
     微随机（音高/增益/噪声起点 + 左右交替偏移）避免机关枪式机械感 */
  function tick(vel) {
    if (!enabled) return;
    var c = ac();
    if (!c) return;
    var v = (typeof vel === 'number' && isFinite(vel)) ? clamp01(vel) : 0.5;
    tickFlip = 1 - tickFlip;
    var jit = 1 + (Math.random() * 2 - 1) * 0.06 + (tickFlip ? 0.025 : -0.025);
    var gj = 0.88 + Math.random() * 0.24; /* 增益微随机 */
    var t = c.currentTime;

    /* 噪声层：速度越高滤波越亮、衰减越短、力度稍轻 */
    noiseHit(c, t, lerp(1000, 4200, v) * jit, lerp(1.4, 0.9, v),
      lerp(0.13, 0.09, v) * gj, 0.001, lerp(0.085, 0.038, v));

    /* 泛音层：偏暖三角波，随速度升高 */
    tone(c, t, lerp(340, 1250, v) * jit, 'triangle',
      lerp(0.09, 0.065, v) * gj, 0.0015, lerp(0.07, 0.04, v));

    /* 木质瞬态：仅尾段（vel 低）叠加的低频短叩 */
    var wood = Math.max(0, 1 - v * 2);
    if (wood > 0) {
      tone(c, t, 150 * jit, 'sine', 0.07 * wood * gj, 0.001, 0.05);
    }
  }

  /* 定格：咔哒（高频脆响 + 中频叩击两层噪声瞬态）+ 金属 ping
     （基音三角波 + 非谐高泛音 + 低八度垫体），约 0.5s */
  function land() {
    if (!enabled) return;
    var c = ac();
    if (!c) return;
    var t = c.currentTime;
    var jit = 1 + (Math.random() * 2 - 1) * 0.01;

    /* 咔哒 */
    noiseHit(c, t, 2600 * jit, 0.8, 0.15, 0.001, 0.03);
    noiseHit(c, t, 900 * jit, 1.2, 0.10, 0.001, 0.05);

    /* 金属 ping：稍晚于咔哒，形成“咔-叮”的层次 */
    var base = 987.77 * jit;
    tone(c, t + 0.018, base, 'triangle', 0.16, 0.002, 0.42);
    tone(c, t + 0.018, base * 2.756, 'sine', 0.05, 0.002, 0.18);
    tone(c, t + 0.018, base * 0.5, 'sine', 0.06, 0.002, 0.22);
  }

  /* 最终揭晓：C 大九和弦上行琶音 + 低音垫底 + 高频 shimmer，
     总时长约 1.2s，庄重愉悦但克制 */
  function reveal() {
    if (!enabled) return;
    var c = ac();
    if (!c) return;
    var t = c.currentTime;
    var jit = 1 + (Math.random() * 2 - 1) * 0.008;

    /* 低音垫底：C3 + 纯五度 G3，慢起长衰减 */
    tone(c, t, 130.81 * jit, 'sine', 0.10, 0.10, 1.0, true);
    tone(c, t, 196.00 * jit, 'sine', 0.05, 0.12, 0.95, true);

    /* 琶音：C4 E4 G4 B4 D5 G5，三角波，交替轻重 */
    var arp = [261.63, 329.63, 392.00, 493.88, 587.33, 783.99];
    for (var i = 0; i < arp.length; i++) {
      tone(c, t + i * 0.10, arp[i] * jit, 'triangle',
        (i % 2 ? 0.085 : 0.095), 0.008, 0.55, true);
    }

    /* 高频 shimmer：C7 与略失谐副本，慢起极轻，营造光泽 */
    tone(c, t + 0.2, 2093.0 * jit, 'sine', 0.035, 0.25, 0.75, true);
    tone(c, t + 0.2, 2093.0 * jit * 1.006, 'sine', 0.028, 0.30, 0.70, true);
  }

  return {
    setEnabled: function (v) { enabled = !!v; if (enabled) ac(); },
    isEnabled: function () { return enabled; },
    /* 首次用户手势时解锁 AudioContext */
    unlock: function () { if (enabled) ac(); },

    /* 抽取开始的气声 whoosh（随面板展开播放） */
    start: start,
    /* 光标每跳一下的短促声 */
    tick: tick,
    /* 舞台每定格一位中奖者的短音 */
    land: land,
    /* 最终揭晓的和弦 */
    reveal: reveal
  };
})();
