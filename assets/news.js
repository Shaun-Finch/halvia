// Halvia news: loads the weekly story list (data/news.json, written by tools/news.py on GitHub Actions).
// The live copy on GitHub is tried first, so new stories show even before the site redeploys; the copy
// served with the site is the fallback. Story text comes from publishers' feeds, so it is only ever put
// on the page as text, and only http(s) links are used.
(function () {
  'use strict';
  var RAW = 'https://raw.githubusercontent.com/Shaun-Finch/halvia/main/data/news.json';
  function get(url, ms) {
    return new Promise(function (res, rej) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; rej(new Error('timeout')); } }, ms);
      fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { if (!done) { done = true; clearTimeout(t); res(d); } }, function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }
  function ok(d) { return d && Array.isArray(d.items) && d.items.length; }
  function load(localUrl) {
    return get(RAW + '?w=' + Math.floor(Date.now() / 36e5), 4000).then(function (d) { return ok(d) ? d : Promise.reject(); })
      .catch(function () { return get(localUrl, 6000); })
      .then(function (d) {
        var items = (d && Array.isArray(d.items) ? d.items : []).filter(function (i) { return i && i.title && /^https?:\/\//i.test(i.url || ''); });
        var byId = {}; items.forEach(function (i) { byId[i.id] = i; });
        var top = (d && Array.isArray(d.top) ? d.top : []).map(function (id) { return byId[id]; }).filter(Boolean);
        if (top.length < 5) items.forEach(function (i) { if (top.length < 5 && top.indexOf(i) < 0) top.push(i); });
        return { updated: d && d.updated, items: items, top: top };
      })
      .catch(function () { return { updated: null, items: [], top: [] }; });
  }
  function date(iso, withYear) {
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleDateString('en-GB', withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  window.HalviaNews = { load: load, date: date, el: el };
})();
