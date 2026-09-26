/* 名单解析（纯函数）+ localStorage 读写 */
window.Roster = (function () {
  'use strict';

  var SEP_PRIORITY = [',', '，', '\t', ';', '；', ' '];
  var NAME_HEADERS = { '姓名': 1, '名字': 1, '名称': 1, '学生姓名': 1, '同学姓名': 1, 'name': 1 };
  var ID_HEADERS = { '学号': 1, '序号': 1, '编号': 1, '考号': 1, 'no': 1, 'no.': 1, 'id': 1 };

  function splitLine(line) {
    for (var i = 0; i < SEP_PRIORITY.length; i++) {
      var sep = SEP_PRIORITY[i];
      if (line.indexOf(sep) !== -1) {
        return { sep: sep, fields: line.split(sep === ' ' ? /\s+/ : sep) };
      }
    }
    return { sep: '', fields: [line] };
  }

  function clean(v) {
    return String(v == null ? '' : v).trim().replace(/^["']+|["']+$/g, '');
  }

  function isHeader(fields) {
    var hitName = 0, hitId = 0;
    fields.forEach(function (f) {
      var k = clean(f).toLowerCase();
      if (NAME_HEADERS[k]) hitName++;
      if (ID_HEADERS[k]) hitId++;
    });
    return hitName > 0 && (hitId > 0 || fields.length === 1);
  }

  function keyOf(s) { return s.id || s.name; }

  /* 纯函数：把多行文本解析为 { students, errors, headersSkipped }
     students: [{ id, name, key }]，errors: [{ line, text, reason }] */
  function parse(text) {
    var students = [], errors = [], headersSkipped = 0;
    var seen = {};
    String(text || '').split(/\r?\n/).forEach(function (raw, idx) {
      var line = raw.trim();
      if (!line) return;

      var parts = splitLine(line);
      var fields = parts.fields.map(clean);
      if (isHeader(fields)) { headersSkipped++; return; }

      var id = '', name = '';
      if (fields.length >= 2) {
        id = fields[0];
        name = fields[1];
      } else {
        name = fields[0];
      }

      if (!name) {
        errors.push({ line: idx + 1, text: line, reason: '没有解析到姓名' });
        return;
      }
      if (name.length > 12) {
        errors.push({ line: idx + 1, text: line, reason: '姓名超过 12 个字' });
        return;
      }
      var key = keyOf({ id: id, name: name });
      if (seen[key]) {
        errors.push({ line: idx + 1, text: line, reason: '与第 ' + seen[key] + ' 行重复' });
        return;
      }
      seen[key] = idx + 1;
      students.push({ id: id, name: name, key: key });
    });
    return { students: students, errors: errors, headersSkipped: headersSkipped };
  }

  /* ---- localStorage ---- */
  var KEY = 'heroRoll.roster.v1';

  function save(students) {
    try { localStorage.setItem(KEY, JSON.stringify(students)); } catch (e) { /* 隐私模式等 */ }
  }
  function load() {
    try {
      var arr = JSON.parse(localStorage.getItem(KEY) || 'null');
      return Array.isArray(arr) && arr.length ? arr : null;
    } catch (e) { return null; }
  }
  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

  function toCsvText(students) {
    var rows = ['学号,姓名'];
    students.forEach(function (s) { rows.push((s.id || '') + ',' + s.name); });
    return rows.join('\r\n') + '\r\n';
  }

  return { parse: parse, keyOf: keyOf, save: save, load: load, clear: clear, toCsvText: toCsvText };
})();
