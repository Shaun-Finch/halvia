// "Welcome to Halvia" intro. Plays every time the home page loads.
// Types the title on with a glitch, plays a robotic female voice, then fades away to reveal the page.
// The voice starts straight away. Some browsers hold back sound until the visitor first interacts with the page;
// if so it plays on their first touch, click or key, with no prompt shown.
(function () {
  'use strict';
  var root = document.documentElement, box = document.getElementById('hvIntro');
  if (!box || !root.classList.contains('hv-intro')) { if (box) box.remove(); return; }
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lbl = box.querySelector('.lbl'), h1 = box.querySelector('h1'), audio = box.querySelector('audio');
  var LABEL = 'HALVIA  /  AI FOR CARE', WORDS = ['Welcome', ' ', 'to', ' '], LAST = 'Halvia';
  var GLYPHS = '#%&@$*+=<>/\\|[]{}01';
  var timers = [], finished = false, voiced = false;
  var later = function (fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; };

  // ---------- voice ----------
  function speakFallback() {
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance('Welcome to Halvia.'), vs = speechSynthesis.getVoices();
    var v = vs.filter(function (x) { return /female|samantha|libby|sonia|aria|jenny|zira|karen|moira|tessa|serena|google uk english female/i.test(x.name) && /^en/i.test(x.lang); })[0] || vs.filter(function (x) { return /^en/i.test(x.lang); })[0];
    if (v) u.voice = v; u.rate = .92; u.pitch = .82;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  function voice() {
    if (voiced || finished) return;
    if (audio && audio.readyState >= 0) {
      var p = audio.play();
      if (p && p.then) p.then(function () { voiced = true; }).catch(function () { });
      else voiced = true;
    } else { speakFallback(); voiced = true; }
  }
  if (audio) audio.addEventListener('error', function () { audio = null; });
  function gesture() { if (!voiced && !finished) { if (audio) audio.currentTime = 0; voice(); } }
  ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach(function (ev) { addEventListener(ev, gesture, { capture: true, passive: true }); });
  addEventListener('keydown', function onKey(e) { if (finished) return removeEventListener('keydown', onKey); if (e.key === 'Escape') return end(true); gesture(); });

  // ---------- pixel clusters ----------
  var spots = [[8, 16], [50, 13], [88, 15], [15, 76], [84, 75], [94, 48], [5, 47]];
  spots.forEach(function (s, i) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 4 4'); svg.setAttribute('class', 'px'); svg.setAttribute('aria-hidden', 'true');
    svg.style.left = s[0] + '%'; svg.style.top = s[1] + '%'; svg.style.transform = 'translate(-50%,-50%)';
    for (var y = 0; y < 4; y++) for (var x = 0; x < 4; x++) {
      if (Math.random() < .45) continue;
      var r = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
      r.setAttribute('fill', Math.random() < .55 ? '#1A3CFF' : '#8EA2FF'); r.style.opacity = reduce ? 1 : 0; svg.appendChild(r);
    }
    box.appendChild(svg);
  });
  var rects = box.querySelectorAll('.px rect');
  function flicker(on) { rects.forEach(function (r) { r.style.opacity = on ? (Math.random() < .82 ? 1 : 0) : 0; }); }

  // ---------- typing ----------
  function rnd() { return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]; }
  function typeLabel(i) { lbl.textContent = LABEL.slice(0, i); if (i < LABEL.length) later(function () { typeLabel(i + 1); }, 26); }
  var chars = [];
  var full = WORDS.join('') + LAST;
  function typeChar(i, done) {
    if (i >= full.length) return done();
    var span = document.createElement('span'); span.className = 'ch scr'; h1.insertBefore(span, cur);
    var steps = full[i] === ' ' ? 0 : 2, k = 0;
    (function scramble() {
      if (k < steps) { span.textContent = rnd(); k++; later(scramble, 28); return; }
      span.textContent = full[i]; span.className = 'ch'; chars.push(span);
      later(function () { typeChar(i + 1, done); }, full[i] === ' ' ? 40 : 58);
    })();
  }
  function glitch(done) {
    // wrap the last word, flash blue slices and inverted blocks, then settle with a blue block on "via"
    var last = chars.slice(-LAST.length), wrap = document.createElement('span'); wrap.className = 'gw';
    h1.insertBefore(wrap, last[0]); last.forEach(function (c) { wrap.appendChild(c); });
    var frames = [['g1', [3, 4, 5]], ['g2', [0, 1]], ['', [2, 3]], ['g3', [3, 4, 5]], ['g1', [1, 2, 3, 4]], ['', [3, 4, 5]]], f = 0;
    (function step() {
      wrap.className = 'gw ' + (frames[f] ? frames[f][0] : '');
      last.forEach(function (c, j) { c.classList.toggle('blk', !!frames[f] && frames[f][1].indexOf(j) >= 0); });
      flicker(true); f++;
      if (f < frames.length) later(step, 70); else { wrap.className = 'gw'; last.forEach(function (c, j) { c.classList.toggle('blk', j >= 3); }); done(); }
    })();
  }
  var cur = document.createElement('span'); cur.className = 'cur'; cur.setAttribute('aria-hidden', 'true'); h1.appendChild(cur);

  function end(now) {
    if (finished) return; finished = true;
    timers.forEach(clearTimeout); box.classList.add('done', 'out');
    var finish = function () { root.classList.remove('hv-intro'); box.remove(); };
    if (now) finish(); else setTimeout(finish, 950);
  }
  box.querySelector('.skip-intro').addEventListener('click', function (e) { e.stopPropagation(); end(true); });

  if (reduce) {
    lbl.textContent = LABEL; h1.textContent = 'Welcome to Halvia'; voice();
    later(function () { end(false); }, 1800);
    return;
  }
  later(function () { flicker(true); typeLabel(1); }, 150);
  var fl = setInterval(function () { if (finished) return clearInterval(fl); flicker(true); }, 180);
  later(function () {
    voice();
    typeChar(0, function () {
      glitch(function () {
        box.classList.add('done');
        later(function () { end(false); }, 1300);
      });
    });
  }, 650);
  later(function () { end(false); }, 9000); // safety: never block the page for long
})();
