/* 头像墙（在「名单与设置」页内）：卡片渲染、置灰与描金标记。
   头像分配由 app.js 每轮随机决定并通过 items 传入，本模块不做随机。 */
window.Wall = (function () {
  'use strict';

  var el = null;
  var cards = {}; /* key -> 卡片元素 */

  /* items: [{ key, name, id, avatar }] */
  function build(items) {
    el = document.getElementById('wall');
    el.innerHTML = '';
    cards = {};
    var frag = document.createDocumentFragment();

    items.forEach(function (s, i) {
      var card = document.createElement('div');
      card.className = 'card enter';
      card.style.animationDelay = Math.min(i * 14, 600) + 'ms';
      card.dataset.key = s.key;

      var img = document.createElement('img');
      img.className = 'avatar';
      img.src = s.avatar;
      img.alt = '';
      img.draggable = false;

      var name = document.createElement('span');
      name.className = 'cname';
      name.textContent = s.name;

      card.appendChild(img);
      if (s.id) {
        var id = document.createElement('span');
        id.className = 'cid';
        id.textContent = s.id;
        card.appendChild(id);
      }
      card.appendChild(name);

      frag.appendChild(card);
      cards[s.key] = card;
    });

    el.appendChild(frag);

    /* 入场动画结束后清理 enter 类，避免残留 */
    setTimeout(function () {
      var all = el.querySelectorAll('.card.enter');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('enter');
    }, 1100);
  }

  function spotlight(key) {
    var card = cards[key];
    if (card) card.classList.add('winner');
  }

  /* 更新某个学生的头像图片（指定英雄模式点选/上传后调用） */
  function updateAvatar(key, src) {
    var card = cards[key];
    var img = card && card.querySelector('.avatar');
    if (img) img.src = src;
  }

  function clearMarks() {
    var marked = el.querySelectorAll('.card.winner');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('winner');
  }

  function markCalled(keys) {
    keys.forEach(function (k) {
      var c = cards[k];
      if (c) c.classList.add('called');
    });
  }

  function unmarkAll() {
    var marked = el.querySelectorAll('.card.called');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('called');
  }

  return {
    build: build,
    spotlight: spotlight,
    updateAvatar: updateAvatar,
    clearMarks: clearMarks,
    markCalled: markCalled,
    unmarkAll: unmarkAll
  };
})();
