/* 상담실 예약 — 화면 */
'use strict';
(() => {
  const $ = (s, r) => (r || document).querySelector(s);
  const DOW = '일월화수목금토';
  const KEY = { me: 'rb.me', session: 'rb.session', view: 'rb.view' };
  const KEEP_DAYS = 90, POLL_MS = 45000, SETTINGS_MS = 300000;

  /* DOM 만들기: h('div', { class: 'x', onclick: fn }, 자식…). 글자는 늘 글자로만 들어가므로 안전하다. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    attrs = attrs || {};
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false || k === 'value') continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') { for (const p in v) { if (p.startsWith('--')) el.style.setProperty(p, v[p]); else el.style[p] = v[p]; } }
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== '') el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    if (attrs.value != null) el.value = attrs.value;
    return el;
  }
  const btn = (label, fn, kind, extra) => h('button', Object.assign({ class: 'btn' + (kind ? ' ' + kind : ''), type: 'button', onclick: fn }, extra), label);

  const box = name => { try { return window[name]; } catch (e) { return null; } };
  const LS = box('localStorage'), SS = box('sessionStorage');
  const keep = {
    get(k, s) { try { return (s || LS).getItem(k); } catch (e) { return null; } },
    set(k, v, s) { try { (s || LS).setItem(k, v); } catch (e) { /* 저장 못 해도 계속 */ } },
    del(k, s) { try { (s || LS).removeItem(k); } catch (e) { /* 없음 */ } }
  };

  const S = { lock: null, me: '', view: 'month', cursor: '', now: Core.nowKST(), months: new Map(), busy: 0, timer: 0, lastLoad: 0, lastSettings: 0, sig: '' };
  const st = () => Data.settings;

  /* ---------- 작은 도우미 ---------- */
  const md = d => (+d.slice(5, 7)) + '월 ' + (+d.slice(8)) + '일';
  const dow = d => DOW[Core.weekday(d)];
  const roomName = id => { const r = Core.roomById(st(), id); return r ? r.name : '(없어진 방)'; };
  const isAdmin = () => { const me = st().staff.find(s => s.name === S.me); return !!(me && me.admin) || !st().staff.some(s => s.admin); };
  const loaded = d => S.months.has(Core.ymOf(d));
  const itemsOn = d => (S.months.get(Core.ymOf(d)) || []).filter(b => b.date === d && Core.roomById(st(), b.room));
  const canEdit = b => (b.owner === S.me || isAdmin()) && !Core.ended(b.date, b.end, S.now);
  const openHours = d => Core.dayHours(st(), d).filter(hr => !Core.ended(d, hr + 1, S.now));
  /* '상담실 1', '상담실 2', '상담실 3' → '상담실 1·2·3' */
  function joinNames(names) {
    let p = names[0] || '';
    names.forEach(n => { while (p && !n.startsWith(p)) p = p.slice(0, -1); });
    return names.length > 1 && p.trim().length >= 2 && names.every(n => n.length > p.length) ? p + names.map(n => n.slice(p.length)).join('·') : names.join(', ');
  }
  function defaultPurpose(roomId) {
    const p = st().purposes, r = Core.roomById(st(), roomId);
    return (r && /집단/.test(r.name) && p.find(x => /집단/.test(x))) || p[0];
  }

  let toastTimer = 0;
  function toast(text, bad) {
    const t = $('#toast');
    t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5500 : 3000);
  }
  function busy(n) { S.busy += n; $('#bar').hidden = S.busy <= 0; }
  function oops(e) {
    if (e && e.code === 'auth') { forget(); showLock(e.message); return; }
    toast((e && e.message) || '알 수 없는 오류가 생겼습니다.', true);
    if (!(e instanceof StoreError)) console.error(e);
  }

  /* ---------- 창 ---------- */
  function dialog(title, body, wide) {
    const back = $('#dlg'), el = $('.dlg', back);
    el.className = 'dlg' + (wide ? ' wide' : '');
    el.replaceChildren(h('div', { class: 'dlg-head' }, h('h3', null, title),
      h('button', { class: 'x', type: 'button', 'aria-label': '닫기', onclick: closeDialog }, '×')), body);
    back.hidden = false; document.body.classList.add('modal'); el.scrollTop = 0;
    closeMenu();
  }
  function closeDialog() { $('#dlg').hidden = true; document.body.classList.remove('modal'); $('#dlg .dlg').replaceChildren(); }
  function closeMenu() { $('#menu').hidden = true; }

  /* ---------- 잠금 화면 ---------- */
  function showLock(msg, mode) {
    $('#app').hidden = true; $('#pick').hidden = true; $('#lock').hidden = false; closeDialog(); closeMenu();
    clearInterval(S.timer); S.timer = 0;
    const m = $('#lockMsg');
    m.textContent = msg || ''; m.className = 'msg';
    $('#lockForm').hidden = mode === 'setup' || mode === 'fatal';
    if (mode === 'setup') {
      $('#lockFine').replaceChildren('아직 준비 중입니다. 관리자가 ', h('a', { href: 'setup.html' }, '설정 페이지'), '에서 잠금 파일을 만들면 쓸 수 있습니다.');
    } else if (mode === 'fatal') {
      $('#lockFine').replaceChildren(msg + ' ', h('a', { href: '.' }, '새로 고침'));
      m.textContent = '';
    } else { try { $('#pw').focus(); } catch (e) { /* 무시 */ } }
  }
  function readSession() {
    for (const src of [SS, LS]) {
      if (!src) continue;
      try {
        const v = JSON.parse(src.getItem(KEY.session));
        if (v && v.salt === S.lock.salt && v.until > Date.now() && v.payload) return v;
      } catch (e) { /* 깨진 값은 무시 */ }
    }
    return null;
  }
  function saveSession(payload, stay) {
    const v = JSON.stringify({ salt: S.lock.salt, until: Date.now() + KEEP_DAYS * 86400000, payload });
    if (SS) keep.set(KEY.session, v, SS);
    if (stay) keep.set(KEY.session, v); else keep.del(KEY.session);
  }
  function forget() { if (SS) keep.del(KEY.session, SS); keep.del(KEY.session); }

  async function unlock(e) {
    e.preventDefault();
    const pw = $('#pw').value, m = $('#lockMsg'), b = $('#enter');
    if (!pw.trim() || b.disabled) return;
    b.disabled = true; m.className = 'msg info'; m.textContent = '확인하는 중…';
    try {
      const payload = await Lock.open(pw, S.lock);
      await enter(payload);
      saveSession(payload, $('#keep').checked);
      $('#pw').value = ''; m.textContent = '';
    } catch (err) {
      m.className = 'msg';
      m.textContent = err.code === 'bad-password' ? '비밀번호가 맞지 않습니다.'
        : err.code === 'bad-lock' ? '잠금 파일이 올바르지 않습니다. 관리자에게 알려 주세요.'
        : err.code === 'auth' ? '비밀번호는 맞지만 접속 열쇠가 만료되었습니다. 관리자에게 알려 주세요.'
        : (err.message || '들어갈 수 없습니다. 잠시 후 다시 해 주세요.');
      if (!(err instanceof StoreError) && !err.code) console.error(err);
    } finally { b.disabled = false; }
  }

  /* 접속 정보로 설정을 읽고 예약 화면으로 들어간다 */
  async function enter(payload) {
    Data.store = new GitHubStore(payload);
    await Data.loadSettings();
    if (!Data.hasSettings) {
      const code = await Data.store.ping();
      if (code === 401) throw new StoreError('auth', '접속 열쇠가 만료되었거나 바뀌었습니다. 비밀번호를 다시 넣어 주세요.', 401);
      if (code !== 200) throw new StoreError('notfound', '자료 저장소에 닿지 않습니다. 관리자에게 알려 주세요.', code);
    }
    S.lastSettings = Date.now();
    S.me = keep.get(KEY.me) || '';
    if (!st().staff.some(s => s.name === S.me)) S.me = '';
    $('#lock').hidden = true;
    if (S.me) startApp(); else showPick();
  }

  /* ---------- 이름 고르기 ---------- */
  function showPick() {
    $('#app').hidden = true; $('#lock').hidden = true; $('#pick').hidden = false; closeMenu();
    const names = $('#names'), staff = st().staff;
    const choose = name => { S.me = name; keep.set(KEY.me, name); $('#pick').hidden = true; startApp(); };
    if (staff.length) {
      names.className = 'names';
      names.replaceChildren(...staff.map(s => h('button', { type: 'button', class: s.name === S.me ? 'on' : null, onclick: () => choose(s.name) }, s.name)));
      $('#pickFine').textContent = '고른 이름으로 예약됩니다. 나중에 오른쪽 위 이름을 눌러 바꿀 수 있습니다. 이름이 없으면 관리자에게 말씀해 주세요.';
      return;
    }
    // 명단이 비어 있을 때(처음 설치 직후): 첫 사람이 이름을 적고 관리자가 된다
    const input = h('input', { type: 'text', maxlength: 12, placeholder: '이름', autocomplete: 'off' });
    const go = async () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) return;
      try { busy(1); await Data.saveSettings(Object.assign({}, st(), { staff: [{ name, admin: true }] }), name); choose(name); }
      catch (e) { oops(e); } finally { busy(-1); }
    };
    names.className = '';
    names.replaceChildren(h('form', { class: 'addname', onsubmit: e => { e.preventDefault(); go(); } }, input, btn('시작하기', go, 'primary')));
    $('#pickFine').textContent = '직원 명단이 아직 비어 있습니다. 이름을 적으면 관리자로 등록되고, 설정에서 다른 직원을 추가할 수 있습니다.';
  }

  /* ---------- 예약 화면 ---------- */
  function startApp() {
    $('#app').hidden = false;
    $('#who').textContent = S.me;
    render(true); load();
    if (!S.timer) S.timer = setInterval(() => { if (!document.hidden && !$('#app').hidden) load(true); }, POLL_MS);
  }

  function wanted() {
    const yms = S.view === 'week' ? Core.weekDates(st(), S.cursor).map(Core.ymOf) : [];
    yms.push(Core.ymOf(S.cursor));
    return yms.filter((x, i) => yms.indexOf(x) === i);
  }
  /* 화면에 필요한 달을 읽는다. quiet = 자동 새로 고침(표시 없이, 실패해도 조용히) */
  async function load(quiet) {
    if (!quiet) busy(1);
    try {
      if (Date.now() - S.lastSettings > SETTINGS_MS) { S.lastSettings = Date.now(); await Data.loadSettings(); }
      const yms = wanted();
      const res = await Promise.all(yms.map(ym => Data.month(ym)));
      yms.forEach((ym, i) => S.months.set(ym, res[i]));
      S.lastLoad = Date.now();
      if (S.me && !st().staff.some(s => s.name === S.me) && st().staff.length) { S.me = ''; keep.del(KEY.me); showPick(); return; }
      render();
    } catch (e) { if (!quiet || e.code === 'auth') oops(e); }
    finally { if (!quiet) busy(-1); }
  }
  /* 방금 저장한 내용을 화면에 바로 반영 */
  function sync(dates) {
    dates.map(Core.ymOf).forEach(ym => { const items = Data.cached(ym); if (items) S.months.set(ym, items); });
    render(true);
  }
  async function ensureMonth(d, then) {
    const ym = Core.ymOf(d);
    if (S.months.has(ym)) return;
    try { S.months.set(ym, await Data.month(ym)); if (then) then(); } catch (e) { oops(e); }
  }

  function go(date) {
    S.cursor = date; S.jump = true; render(true);
    if (wanted().some(ym => !S.months.has(ym)) || Date.now() - S.lastLoad > 15000) load();
  }
  function step(dir) {
    if (S.view === 'week') return go(Core.addDays(S.cursor, 7 * dir));
    let d = Core.monthsLater(S.cursor, dir);
    if (Core.ymOf(d) === Core.ymOf(S.now.date)) d = S.now.date;
    go(d);
  }
  function setView(v) { S.view = v; keep.set(KEY.view, v); go(S.cursor); }

  function signature() {
    return [S.view, S.cursor, S.me, S.now.date, S.now.hour, Data.sha('settings.json')].concat(wanted().map(ym => ym + (S.months.has(ym) ? Data.sha(Data.path(ym)) : '?'))).join('|');
  }
  function render(force) {
    if ($('#app').hidden) return;
    S.now = Core.nowKST();
    const sig = signature();
    if (!force && sig === S.sig) return;
    S.sig = sig;

    const per = $('#period');
    let y = S.cursor.slice(0, 4), m = (+S.cursor.slice(5, 7)) + '월';
    if (S.view === 'week') {
      const w = Core.weekDates(st(), S.cursor), a = w[0] || S.cursor, b = w[w.length - 1] || S.cursor;
      y = a.slice(0, 4);
      m = md(a) + ' – ' + (Core.ymOf(a) === Core.ymOf(b) ? (+b.slice(8)) + '일' : md(b));
    }
    $('.y', per).textContent = y + '년'; $('.m', per).textContent = m;
    per.className = 'period' + (S.view === 'week' ? ' long' : '');
    $('#vMonth').className = S.view === 'month' ? 'on' : ''; $('#vWeek').className = S.view === 'week' ? 'on' : '';
    $('#who').textContent = S.me;
    document.title = '상담실 예약 · ' + (S.view === 'week' ? m : y + '년 ' + m);

    const main = $('#main'), before = $('.weekview', main), left = before ? before.scrollLeft : null;
    main.dataset.view = S.view;
    main.replaceChildren(...(S.view === 'week' ? [weekView()] : [monthView(), dayPanel()]));
    // 좁은 화면의 주간 보기: 날짜를 옮겼을 때는 그 날이 보이게, 그 밖에는 보던 자리를 그대로
    const wv = $('.weekview', main);
    if (wv && wv.scrollWidth > wv.clientWidth) {
      const col = wv.querySelector('.col[data-date="' + S.cursor + '"]');
      if ((S.jump || left == null) && col) wv.scrollLeft = col.getBoundingClientRect().left - wv.getBoundingClientRect().left + wv.scrollLeft - $('.times', wv).offsetWidth - 6;
      else if (left != null) wv.scrollLeft = left;
    }
    S.jump = false;
  }

  /* ----- 월 달력 ----- */
  function monthView() {
    const ym = Core.ymOf(S.cursor), rooms = st().rooms, hours = Core.gridHours(st());
    return h('section', { class: 'cal' },
      h('div', { class: 'dow' }, [...DOW].map((x, i) => h('span', { class: i === 0 ? 'sun' : null }, x))),
      h('div', { class: 'weeks' }, Core.monthGrid(ym).map(row => h('div', { class: 'week' }, row.map(d => dayCell(d, ym, rooms, hours))))),
      h('div', { class: 'legend' },
        h('span', null, h('i', { class: 'mi' }), '내 예약'), h('span', null, h('i', { class: 'ot' }), '다른 사람'), h('span', null, h('i', { class: 'fr' }), '빈 시간'),
        h('span', { class: 'long' }, '띠 한 줄이 방 하나 (' + rooms.map(r => r.short).join(' · ') + '), 왼쪽 ' + hours[0] + '시 → 오른쪽 ' + (hours[hours.length - 1] + 1) + '시')));
  }
  function dayCell(d, ym, rooms, hours) {
    const out = Core.ymOf(d) !== ym, open = Core.dayHours(st(), d), list = out ? [] : itemsOn(d);
    const cls = ['day'];
    if (out) cls.push('out');
    if (Core.weekday(d) === 0) cls.push('sun');
    if (d === S.now.date) cls.push('today');
    if (d < S.now.date) cls.push('past');
    if (d === S.cursor) cls.push('sel');
    const mine = list.filter(b => b.owner === S.me).length;
    return h('button', { class: cls.join(' '), type: 'button', onclick: () => go(d),
        'aria-label': md(d) + ' ' + dow(d) + '요일' + (list.length ? ', 예약 ' + list.length + '건' : ''), 'aria-pressed': d === S.cursor ? 'true' : 'false' },
      h('span', { class: 'num' }, +d.slice(8)),
      mine ? h('span', { class: 'mine-count' }, '내 예약 ' + mine) : null,
      out ? null : !open.length ? h('span', { class: 'rest' }, '쉬는 날') : strips(list, rooms, hours, open));
  }
  function strips(list, rooms, hours, open) {
    const from = open[0], to = open[open.length - 1] + 1;
    return h('span', { class: 'strips' }, rooms.map(r => {
      const mineOf = list.filter(b => b.room === r.id);
      const track = h('span', { class: 'track', style: { gridTemplateColumns: 'repeat(' + hours.length + ',minmax(0,1fr))' } }, hours.map(hr => {
        const b = mineOf.find(x => x.start <= hr && hr < x.end);
        return h('u', { class: hr < from || hr >= to ? 'x' : b ? (b.owner === S.me ? 'm' : 'o') : null, title: b ? r.name + ' ' + hr + '시 ' + b.owner : null });
      }));
      return h('span', { class: 'strip' }, h('em', null, r.short), track);
    }));
  }

  /* ----- 하루 시간표: 방(가로) × 시간(세로) ----- */
  function dayGrid(d, withHead) {
    const rooms = st().rooms, hours = Core.gridHours(st()), list = itemsOn(d), ready = loaded(d);
    const c0 = withHead ? 2 : 1, r0 = withHead ? 2 : 1;
    const g = h('div', { class: 'tt', style: {
      gridTemplateColumns: (withHead ? 'var(--tw) ' : '') + 'repeat(' + rooms.length + ',minmax(0,1fr))',
      gridTemplateRows: (withHead ? 'auto ' : '') + 'repeat(' + hours.length + ',var(--rh))' } });
    if (withHead) {
      g.append(h('div', { class: 'h corner' }));
      rooms.forEach(r => g.append(h('div', { class: 'h', title: r.name }, r.name)));
    }
    hours.forEach((hr, i) => {
      if (withHead) g.append(h('div', { class: 'tm', style: { gridRow: i + r0, gridColumn: 1 } }, hr + '시'));
      rooms.forEach((r, j) => {
        const state = Core.slotStatus(st(), d, hr, r.id, S.now);
        const taken = list.some(x => x.room === r.id && x.start <= hr && hr < x.end);
        const free = state === 'ok' && !taken && ready;
        g.append(h(free ? 'button' : 'div', {
          class: 'c ' + state + (j === 0 ? ' first' : ''), type: free ? 'button' : null,
          style: { gridRow: i + r0, gridColumn: j + c0 },
          'aria-label': free ? md(d) + ' ' + hr + '시 ' + r.name + ' 예약하기' : null,
          title: state === 'far' ? r.name + Core.josa(r.name, '은 ', '는 ') + Core.limitText(st()) : null,
          onclick: free ? () => bookForm({ date: d, room: r.id, start: hr }) : null }));
      });
    });
    const last = hours[hours.length - 1] + 1;
    list.forEach(b => {
      const j = rooms.findIndex(r => r.id === b.room), i = hours.indexOf(Math.max(b.start, hours[0]));
      if (j < 0 || i < 0 || b.end <= hours[0]) return;
      g.append(h('button', { class: 'bk' + (b.owner === S.me ? ' m' : '') + (Core.ended(b.date, b.end, S.now) ? ' past' : ''), type: 'button',
          style: { gridRow: (i + r0) + ' / span ' + Math.max(1, Math.min(b.end, last) - Math.max(b.start, hours[0])), gridColumn: j + c0 },
          title: b.start + '~' + b.end + '시 ' + roomName(b.room) + ' · ' + b.owner + ' · ' + b.purpose,
          onclick: () => showBooking(b) },
        h('b', null, b.owner), h('small', null, withHead ? b.purpose : b.purpose.replace(/상담$/, ''))));
    });
    return g;
  }
  function dayPanel() {
    const d = S.cursor, list = itemsOn(d), open = Core.dayHours(st(), d), mine = list.filter(b => b.owner === S.me).length;
    const limited = st().rooms.filter(r => r.limited).map(r => r.name);
    const sum = !open.length ? '쉬는 날입니다.' : !loaded(d) ? '불러오는 중…'
      : !list.length ? '아직 예약이 없습니다.' : ['예약 ' + list.length + '건', mine ? [' · ', h('b', null, '내 예약 ' + mine + '건')] : null];
    return h('aside', { class: 'side' },
      h('h2', null, md(d), h('span', null, dow(d) + '요일')),
      h('p', { class: 'sum' }, sum),
      open.length ? dayGrid(d, true) : null,
      h('p', { class: 'note' }, open.length ? '빈칸을 누르면 예약할 수 있습니다. ' : null,
        limited.length ? joinNames(limited) + Core.josa(limited[limited.length - 1], '은 ', '는 ') + Core.limitText(st()) : null,
        h('br'), '내담자 이름·학교·연락처 같은 정보는 적지 않습니다.'));
  }

  /* ----- 주간 보기 ----- */
  function weekView() {
    const days = Core.weekDates(st(), S.cursor), rooms = st().rooms, hours = Core.gridHours(st());
    const short = n => { n = n.replace(/\s/g, ''); if (n.length > 4) n = n.replace('상담', ''); return n.slice(0, 4); };
    const wk = h('div', { class: 'wk', style: { gridTemplateColumns: 'var(--tw) repeat(' + days.length + ',minmax(var(--dw),1fr))' } });
    wk.append(h('div', { class: 'dh corner' }));
    days.forEach(d => wk.append(h('div', { class: 'dh' + (d === S.now.date ? ' today' : '') }, h('b', null, +d.slice(8)), h('span', null, dow(d) + '요일'))));
    wk.append(h('div', { class: 'corner' }));
    days.forEach(() => wk.append(h('div', { class: 'lanes', style: { gridTemplateColumns: 'repeat(' + rooms.length + ',minmax(0,1fr))' } },
      rooms.map(r => h('span', { title: r.name }, short(r.name))))));
    wk.append(h('div', { class: 'times', style: { gridTemplateRows: 'repeat(' + hours.length + ',var(--rh))' } }, hours.map(hr => h('span', null, hr + '시'))));
    days.forEach(d => wk.append(h('div', { class: 'col' + (d === S.now.date ? ' today' : ''), 'data-date': d }, dayGrid(d, false))));
    return h('section', { class: 'weekview' }, wk,
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'mi' }), '내 예약'), h('span', null, h('i', { class: 'ob' }), '다른 사람'),
        h('span', null, '빈칸을 누르면 예약 · 예약을 누르면 자세히'),
        days.some(d => !loaded(d)) ? h('span', null, '불러오는 중…') : null));
  }

  /* ---------- 예약하기·바꾸기 창 ---------- */
  function bookForm(init) {
    const edit = init.edit || null;
    const f = edit ? { date: edit.date, room: edit.room, start: edit.start, end: edit.end, purpose: edit.purpose, repeat: 1 }
      : { date: init.date || S.cursor, room: init.room || st().rooms[0].id, start: init.start, end: init.start == null ? null : init.start + 1, purpose: null, repeat: 1 };
    let sending = false, purposeTouched = !!edit, failed = '';
    const body = h('form', { class: 'form', novalidate: true, onsubmit: e => { e.preventDefault(); submit(); } });

    const monthItems = d => S.months.get(Core.ymOf(d));
    const cand = (date, series) => {
      const b = { id: edit ? edit.id : Core.newId(), date, start: f.start, end: f.end, room: f.room, purpose: f.purpose, owner: edit ? edit.owner : S.me, at: edit ? edit.at : Core.nowKST().stamp };
      if (edit && edit.series) b.series = edit.series;
      if (series) b.series = series;
      if (edit) { b.upd = Core.nowKST().stamp; if (edit.owner !== S.me) b.updBy = S.me; }
      return b;
    };
    function fix() {
      const hours = openHours(f.date), close = Core.closeHour(st(), f.date);
      if (!hours.length) { f.start = f.end = null; }
      else {
        if (f.start == null || hours.indexOf(f.start) < 0) {
          const items = monthItems(f.date) || [];
          const free = hours.find(hr => !items.some(x => x.id !== (edit && edit.id) && x.date === f.date && x.room === f.room && x.start <= hr && hr < x.end));
          f.start = free == null ? hours[0] : free; f.end = f.start + 1;
        }
        if (f.end == null || f.end <= f.start) f.end = f.start + 1;
        if (f.end > close) f.end = close;
      }
      if (!purposeTouched || st().purposes.indexOf(f.purpose) < 0) f.purpose = defaultPurpose(f.room);
      const max = maxRepeat(); if (f.repeat > max) f.repeat = max;
    }
    function maxRepeat() {
      const room = Core.roomById(st(), f.room);
      if (!room || !room.limited) return 12;
      let n = 1; const last = Core.lastDate(st(), S.now);
      while (n < 12 && Core.addDays(f.date, 7 * n) <= last) n++;
      return n;
    }
    function draw() {
      S.now = Core.nowKST(); fix();
      const items = monthItems(f.date), hoursAll = Core.gridHours(st()), open = openHours(f.date), close = Core.closeHour(st(), f.date);
      const others = (items || []).filter(x => x.date === f.date && x.room === f.room && x.id !== (edit && edit.id));
      const why = !open.length ? (Core.dayHours(st(), f.date).length ? '오늘은 예약할 수 있는 시간이 끝났습니다.' : '쉬는 날에는 예약할 수 없습니다.')
        : !items ? '' : Core.check(st(), items, cand(f.date), S.now, edit && edit.id);
      const max = maxRepeat();
      const seg = (list, cur, label, pick) => h('div', { class: 'seg' }, list.map(x => h('button', { type: 'button', class: x === cur ? 'on' : null, 'aria-pressed': x === cur ? 'true' : 'false', onclick: () => { pick(x); draw(); } }, label(x))));

      body.replaceChildren(
        h('div', { class: 'field' }, h('label', { class: 'lab', for: 'fDate' }, '날짜'),
          h('div', { class: 'row' },
            h('input', { id: 'fDate', type: 'date', value: f.date, min: S.now.date, onchange: e => { if (Core.parseDate(e.target.value)) { f.date = e.target.value; ensureMonth(f.date, draw); draw(); } } }),
            h('span', { class: 'hint' }, dow(f.date) + '요일'))),
        h('div', { class: 'field' }, h('span', { class: 'lab' }, '방'),
          seg(st().rooms.map(r => r.id), f.room, roomName, x => { f.room = x; })),
        open.length ? h('div', { class: 'field' }, h('span', { class: 'lab' }, '시간', h('small', null, '회색은 이미 예약된 시간')),
          h('div', { class: 'hourbar', style: { gridTemplateColumns: 'repeat(' + hoursAll.length + ',minmax(0,1fr))' } }, hoursAll.map(hr => {
            const o = others.find(x => x.start <= hr && hr < x.end), off = open.indexOf(hr) < 0, on = hr >= f.start && hr < f.end;
            return h('button', { type: 'button', class: off ? 'x' : o ? 't' : on ? 's' : null, disabled: off || !!o, title: o ? o.owner + ' ' + o.start + '~' + o.end + '시' : null,
              'aria-label': hr + '시' + (o ? ' 예약됨' : ''), onclick: () => { f.start = hr; f.end = hr + 1; draw(); } }, hr);
          })),
          h('div', { class: 'row' },
            h('select', { 'aria-label': '시작 시각', value: f.start, onchange: e => { const len = f.end - f.start; f.start = +e.target.value; f.end = Math.min(f.start + len, close); draw(); } },
              open.map(hr => h('option', { value: hr }, hr + '시'))),
            h('span', { class: 'hint' }, '부터'),
            h('select', { 'aria-label': '끝 시각', value: f.end, onchange: e => { f.end = +e.target.value; draw(); } },
              (() => { const a = []; for (let e2 = f.start + 1; e2 <= close; e2++) a.push(h('option', { value: e2 }, e2 + '시')); return a; })()),
            h('span', { class: 'hint' }, '까지 (' + (f.end - f.start) + '시간)'))) : null,
        h('div', { class: 'field' }, h('span', { class: 'lab' }, '용도'),
          seg(st().purposes, f.purpose, x => x, x => { f.purpose = x; purposeTouched = true; })),
        !edit && max > 1 && open.length ? h('div', { class: 'field' }, h('label', { class: 'lab', for: 'fRep' }, '반복'),
          h('select', { id: 'fRep', value: f.repeat, onchange: e => { f.repeat = +e.target.value; draw(); } },
            (() => { const a = [h('option', { value: 1 }, '반복 없음')]; for (let n = 2; n <= max; n++) a.push(h('option', { value: n }, '매주 ' + dow(f.date) + '요일 · ' + n + '번 (' + md(Core.addDays(f.date, 7 * (n - 1))) + '까지)')); return a; })())) : null,
        h('p', { class: 'msg' + (why || failed ? '' : ' info'), role: 'alert' }, failed || why || (!items ? '불러오는 중…' : edit && edit.owner !== S.me ? edit.owner + ' 님의 예약을 관리자 권한으로 바꿉니다.' : '')),
        h('div', { class: 'actions' }, btn('닫기', closeDialog),
          h('button', { class: 'btn primary', type: 'submit', disabled: !!why || !items || sending }, sending ? '저장하는 중…' : edit ? '바꾸기' : f.repeat > 1 ? f.repeat + '건 예약하기' : '예약하기')));
      failed = '';
    }
    async function submit() {
      if (sending) return;
      sending = true; draw(); busy(1);
      try {
        if (edit) {
          const next = cand(f.date);
          await Data.change(edit, next, S.me);
          closeDialog(); S.cursor = f.date; sync([edit.date, f.date]); toast('예약을 바꿨습니다.');
        } else {
          const series = f.repeat > 1 ? Core.newId() : null, list = [];
          for (let i = 0; i < f.repeat; i++) list.push(cand(Core.addDays(f.date, 7 * i), series));
          list.forEach(b => { b.id = Core.newId(); });
          const r = await Data.add(list, S.me);
          sync(list.map(b => b.date));
          if (!r.added.length) throw new StoreError('rule', r.skipped[0].why);
          S.cursor = f.date; render(true);
          if (r.skipped.length) {
            dialog('예약 결과', h('div', null,
              h('p', null, list.length + '건 가운데 ' + r.added.length + '건을 예약했습니다. 아래 날짜는 빠졌습니다.'),
              h('div', { class: 'list' }, r.skipped.map(x => h('button', { type: 'button', disabled: true }, h('b', null, md(x.b.date) + ' (' + dow(x.b.date) + ')'), h('span', null, x.b.start + '~' + x.b.end + '시'), h('span', null, x.why)))),
              h('div', { class: 'actions' }, btn('확인', closeDialog, 'primary'))));
          } else { closeDialog(); toast(r.added.length > 1 ? r.added.length + '건을 예약했습니다.' : '예약했습니다.'); }
        }
      } catch (e) {
        if (e.code === 'rule' || e.code === 'gone') { failed = e.message; sync([f.date]); }
        else oops(e);
      } finally { busy(-1); sending = false; if (!$('#dlg').hidden && body.isConnected) draw(); }
    }

    dialog(edit ? '예약 바꾸기' : '예약하기', body);
    ensureMonth(f.date, draw);
    draw();
  }

  /* ---------- 예약 자세히 보기 ---------- */
  function showBooking(b) {
    const mineB = b.owner === S.me, editable = canEdit(b), actions = h('div', { class: 'actions' });
    const normal = () => actions.replaceChildren(
      editable ? btn('예약 취소', () => ask(false), 'danger left') : null,
      editable && b.series ? btn('이후 반복 모두 취소', () => ask(true), 'danger') : null,
      editable ? btn('바꾸기', () => bookForm({ edit: b })) : null,
      btn('닫기', closeDialog, editable ? null : 'primary'));
    const ask = all => actions.replaceChildren(
      h('span', { class: 'hint left' }, (mineB ? '' : b.owner + ' 님의 예약입니다. ') + (all ? md(b.date) + '부터 남은 반복 예약을 모두 취소할까요?' : '이 예약을 취소할까요?')),
      btn('아니요', normal), btn('취소합니다', () => cancel(all), 'danger'));
    async function cancel(all) {
      busy(1); actions.replaceChildren(h('span', { class: 'hint' }, '취소하는 중…'));
      try {
        const n = all ? await Data.cancelSeries(b, S.me) : await Data.cancel([b], S.me);
        closeDialog(); await load(true); render(true);
        toast(n > 1 ? n + '건을 취소했습니다.' : n === 1 ? '예약을 취소했습니다.' : '이미 취소된 예약입니다.');
      } catch (e) { normal(); oops(e); } finally { busy(-1); }
    }
    normal();
    dialog([md(b.date), h('span', null, dow(b.date) + '요일')], h('div', null,
      h('dl', { class: 'facts' },
        h('dt', null, '시간'), h('dd', null, b.start + '시 ~ ' + b.end + '시'),
        h('dt', null, '방'), h('dd', null, roomName(b.room)),
        h('dt', null, '용도'), h('dd', null, b.purpose),
        h('dt', null, '예약자'), h('dd', null, b.owner + (mineB ? ' (나)' : '')),
        b.series ? [h('dt', null, '반복'), h('dd', null, '매주 반복 예약')] : null),
      !editable && Core.ended(b.date, b.end, S.now) ? h('p', { class: 'hint' }, '지난 예약은 바꿀 수 없습니다.') : null,
      !editable && !Core.ended(b.date, b.end, S.now) ? h('p', { class: 'hint' }, '다른 사람의 예약은 본인이나 관리자만 바꿀 수 있습니다.') : null,
      actions));
  }

  /* ---------- 내 예약 ---------- */
  async function showMine() {
    const holder = h('div', null, h('p', { class: 'empty' }, '불러오는 중…'));
    dialog('내 예약', holder);
    try {
      const first = Core.ymOf(S.now.date), yms = [0, 1, 2, 3].map(i => Core.addMonths(first, i));
      const res = await Promise.all(yms.map(ym => Data.month(ym)));
      yms.forEach((ym, i) => S.months.set(ym, res[i]));
      S.now = Core.nowKST();
      const list = [].concat(...res).filter(b => b.owner === S.me && !Core.ended(b.date, b.end, S.now)).sort(Core.byTime);
      holder.replaceChildren(list.length
        ? h('div', { class: 'list' }, list.map(b => h('button', { type: 'button', onclick: () => { closeDialog(); go(b.date); } },
            h('b', null, md(b.date) + ' (' + dow(b.date) + ')'), h('span', null, b.start + '~' + b.end + '시'), h('span', null, roomName(b.room) + ' · ' + b.purpose), h('small', null, '보기'))))
        : h('p', { class: 'empty' }, '앞으로 잡힌 내 예약이 없습니다.'),
        h('div', { class: 'actions' }, btn('닫기', closeDialog)));
    } catch (e) { closeDialog(); oops(e); }
  }

  /* ---------- 설정 (관리자) ---------- */
  function showSettings() {
    const d = JSON.parse(JSON.stringify(st()));
    let saving = false, note = '';
    const body = h('div', { class: 'form' });
    const text = (obj, key, attrs) => h('input', Object.assign({ type: 'text', value: obj[key], oninput: e => { obj[key] = e.target.value; } }, attrs));
    const num = (obj, key, min, max) => h('input', { type: 'number', min, max, value: obj[key], oninput: e => { obj[key] = e.target.value; } });
    const tick = (obj, key, label) => h('label', null, h('input', { type: 'checkbox', checked: obj[key], onchange: e => { obj[key] = e.target.checked; } }), label);
    const del = (arr, i) => h('button', { type: 'button', class: 'del', onclick: () => { arr.splice(i, 1); draw(); } }, '지우기');
    let purposes = d.purposes.join(', ');
    function draw() {
      body.replaceChildren(
        h('div', { class: 'sec' }, h('h4', null, '직원 명단'),
          d.staff.map((s, i) => h('div', { class: 'rowline' }, text(s, 'name', { maxlength: 12, 'aria-label': '이름' }), tick(s, 'admin', '관리자'), del(d.staff, i))),
          h('div', { class: 'rowline' }, btn('이름 추가', () => { d.staff.push({ name: '', admin: false }); draw(); const ins = body.querySelectorAll('.sec')[0].querySelectorAll('input[type=text]'); ins[ins.length - 1].focus(); })),
          h('p', { class: 'hint' }, '이름을 고치면 그 사람이 전에 한 예약은 예전 이름으로 남습니다. 관리자는 설정을 바꾸고 다른 사람의 예약도 바꿀 수 있습니다.')),
        h('div', { class: 'sec' }, h('h4', null, '방'),
          d.rooms.map((r, i) => h('div', { class: 'rowline' }, text(r, 'name', { maxlength: 20, 'aria-label': '방 이름' }), text(r, 'short', { maxlength: 2, class: 'short', 'aria-label': '줄임 글자', title: '달력 띠 옆에 쓰는 한두 글자' }),
            tick(r, 'limited', '예약 기간 제한'), del(d.rooms, i))),
          h('div', { class: 'rowline' }, btn('방 추가', () => { d.rooms.push({ id: 'r' + Core.newId().slice(0, 6), name: '', short: '', limited: true }); draw(); })),
          h('p', { class: 'hint' }, '방을 지우면 그 방의 예약은 화면에 보이지 않게 됩니다.')),
        h('div', { class: 'sec' }, h('h4', null, '운영 시간과 규칙'),
          h('div', { class: 'rowline' }, h('label', null, '여는 시각', num(d.hours, 'open', 0, 23)), h('label', null, '평일 닫는 시각', num(d.hours, 'weekday', 0, 24)),
            h('label', null, '토요일', num(d.hours, 'saturday', 0, 24)), h('label', null, '일요일', num(d.hours, 'sunday', 0, 24))),
          h('p', { class: 'hint' }, '닫는 시각을 0으로 두면 그 요일은 쉬는 날입니다.'),
          h('div', { class: 'rowline' }, h('label', null, '기간 제한이 있는 방은 오늘부터', num(d, 'limitMonths', 1, 12), '달 뒤까지 예약')),
          h('div', { class: 'rowline' }, h('label', null, '용도', h('input', { type: 'text', value: purposes, style: { width: '300px' }, oninput: e => { purposes = e.target.value; } }))),
          h('p', { class: 'hint' }, '용도는 쉼표로 나눠 적습니다.')),
        h('p', { class: 'msg', role: 'alert' }, note),
        h('div', { class: 'actions' }, h('a', { class: 'link left', href: 'setup.html' }, '비밀번호·접속 열쇠 바꾸기'), btn('닫기', closeDialog), btn(saving ? '저장하는 중…' : '저장', save, 'primary', { disabled: saving })));
      note = '';
    }
    async function save() {
      if (saving) return;
      d.purposes = purposes.split(',');
      const next = Core.normalize(d);
      const blank = d.staff.some(s => !String(s.name).trim()) || d.rooms.some(r => !String(r.name).trim());
      note = blank ? '이름이 빈 줄이 있습니다. 채우거나 지워 주세요.'
        : next.staff.length !== d.staff.length ? '같은 이름이 두 번 들어 있습니다.'
        : next.staff.length && !next.staff.some(s => s.admin) ? '관리자를 한 명 이상 정해 주세요.'
        : !(next.hours.weekday || next.hours.saturday || next.hours.sunday) ? '닫는 시각이 여는 시각보다 늦어야 합니다.' : '';
      if (note) return draw();
      saving = true; draw(); busy(1);
      try {
        await Data.saveSettings(next, S.me);
        S.lastSettings = Date.now();
        closeDialog(); toast('설정을 저장했습니다.');
        if (!st().staff.some(s => s.name === S.me)) { S.me = ''; keep.del(KEY.me); showPick(); } else render(true);
      } catch (e) { saving = false; draw(); oops(e); } finally { busy(-1); }
    }
    dialog('설정', body, true);
    draw();
  }

  /* ---------- 이름 메뉴 ---------- */
  function toggleMenu() {
    const m = $('#menu');
    if (!m.hidden) return closeMenu();
    const item = (label, fn) => h('button', { type: 'button', onclick: () => { closeMenu(); fn(); } }, label);
    m.replaceChildren(
      item('이름 바꾸기', showPick),
      isAdmin() ? item('설정', showSettings) : null,
      item('새로 고침', () => load()),
      item('잠그기', () => { forget(); location.reload(); }));
    m.hidden = false;
  }

  /* ---------- 시작 ---------- */
  async function boot() {
    S.now = Core.nowKST(); S.cursor = S.now.date;
    S.view = keep.get(KEY.view) === 'week' ? 'week' : 'month';
    if (!(window.crypto && crypto.subtle)) return showLock('이 브라우저에서는 열 수 없습니다. 크롬·엣지·사파리 최신판으로 열어 주세요.', 'fatal');
    try {
      const r = await fetch('lock.json', { cache: 'no-store' });
      if (r.ok) S.lock = await r.json();
      else if (r.status !== 404) throw new Error('lock ' + r.status);
    } catch (e) { return showLock('인터넷 연결을 확인해 주세요.', 'fatal'); }
    if (!S.lock || !S.lock.ct) return showLock('', 'setup');
    const sess = readSession();
    if (sess) {
      try { await enter(sess.payload); return; }
      catch (e) {
        if (e.code === 'auth') forget();
        return showLock(e.code === 'auth' ? '다시 로그인해 주세요.' : (e.message || ''));
      }
    }
    showLock('');
  }

  $('#lockForm').addEventListener('submit', unlock);
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $('#today').addEventListener('click', () => go(Core.nowKST().date));
  $('#vMonth').addEventListener('click', () => setView('month'));
  $('#vWeek').addEventListener('click', () => setView('week'));
  $('#mine').addEventListener('click', showMine);
  $('#who').addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  $('#dlg').addEventListener('mousedown', e => { if (e.target === e.currentTarget) closeDialog(); });
  document.addEventListener('click', e => { if (!$('#menu').hidden && !$('#menu').contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!$('#menu').hidden) closeMenu(); else if (!$('#dlg').hidden) closeDialog(); return; }
    if ($('#app').hidden || !$('#dlg').hidden || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ''))) return;
    if (e.key === 'ArrowLeft' && e.altKey) step(-1);
    if (e.key === 'ArrowRight' && e.altKey) step(1);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden && Date.now() - S.lastLoad > 10000) load(true); });

  boot();
})();
