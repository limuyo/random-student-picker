/* 点名历史：localStorage 存取（渲染在 app.js 中完成） */
window.HistoryStore = (function () {
  'use strict';

  var KEY = 'heroRoll.history.v1';
  var MAX = 500;

  function all() {
    try {
      var arr = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* 忽略 */ }
  }

  /* names: [{ id, name }] */
  function add(names) {
    if (!names || !names.length) return;
    var list = all();
    list.unshift({ t: Date.now(), names: names });
    save(list.slice(0, MAX));
  }

  function clear() { save([]); }

  return { all: all, add: add, clear: clear };
})();
