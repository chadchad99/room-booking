/* 상담실 예약 — 화면
   월(첫 화면): 달력 칸마다 방별 가로줄(예약된 시간을 방 색으로) + 오른쪽 그날 시간표
   주: 한 주 세로 시간표 + 왼쪽 작은 달력·지금 방 상황·내 예약 */
'use strict';
(() => {
  const $ = (s, r) => (r || document).querySelector(s);
  const DOW = '일월화수목금토';
  const KEY = { me: 'rb.me', session: 'rb.session', view: 'rb.view' };
  const KEEP_DAYS = 90, POLL_MS = 60000, SETTINGS_MS = 300000;

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
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = !!v;
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

  const S = { lock: null, payload: null, me: '', view: 'week', cursor: '', now: Core.nowKST(), months: new Map(),
              busy: 0, timer: 0, lastLoad: 0, lastSettings: 0, sig: '', drag: false, skipClick: false };
  const st = () => Data.settings;

  /* ---------- 작은 도우미 ---------- */
  const md = d => (+d.slice(5, 7)) + '월 ' + (+d.slice(8)) + '일';
  const dow = d => DOW[Core.weekday(d)];
  const roomName = id => { const r = Core.roomById(st(), id); return r ? r.name : '(없어진 방)'; };
  const kc = id => { const r = Core.roomById(st(), id); return 'k' + (r ? r.color : Core.COLORS - 1); };   // 방 색
  const isAdmin = () => { const me = st().staff.find(s => s.name === S.me); return !!(me && me.admin) || !st().staff.some(s => s.admin); };
  const loaded = d => S.months.has(Core.ymOf(d));
  const itemsOn = d => (S.months.get(Core.ymOf(d)) || []).filter(b => b.date === d && Core.roomById(st(), b.room));
  const canEdit = g => (g.owner === S.me || isAdmin()) && !Core.ended(g.date, g.end, S.now);
  const openHours = d => Core.dayHours(st(), d).filter(hr => !Core.ended(d, hr + 1, S.now));
  const span = g => (g.end - g.start > 1 ? g.start + '~' + g.end + '시' : g.start + '시');
  const whenText = g => (g.date === S.now.date ? '오늘' : (+g.date.slice(5, 7)) + '/' + (+g.date.slice(8)) + '(' + dow(g.date) + ')') + ' ' + g.start + '시';
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
  /* 지금 방마다 비어 있는지. 오늘 자료를 아직 못 읽었으면 null */
  function roomsNow() {
    const d = S.now.date;
    if (!loaded(d)) return null;
    const hours = Core.dayHours(st(), d), list = itemsOn(d);
    const open = hours.length ? hours[0] : 0, close = hours.length ? hours[hours.length - 1] + 1 : 0, at = Math.max(S.now.hour, open);
    return st().rooms.map(r => {
      if (!hours.length) return { r, state: 'closed', text: '쉬는 날' };
      if (at >= close) return { r, state: 'closed', text: '오늘은 끝' };
      const mine = list.filter(b => b.room === r.id), b = mine.find(x => x.start <= at && at < x.end);
      if (b) {
        let end = b.end, nx;
        while ((nx = mine.find(x => x.start === end && x.owner === b.owner))) end = nx.end;
        return { r, state: 'busy', text: b.owner + ' 예약 · ' + end + '시까지' };
      }
      const next = mine.filter(x => x.start > at).sort((a, c) => a.start - c.start)[0];
      return { r, state: 'free', at, text: (S.now.hour < open ? open + '시부터 ' : '') + '비어 있음 · ' + (next ? next.start : close) + '시까지' };
    });
  }
  /* 앞으로 남은 내 예약 (읽어 둔 달에서) */
  function myUpcoming() {
    const all = [];
    S.months.forEach(items => items.forEach(b => { if (b.owner === S.me && Core.roomById(st(), b.room)) all.push(b); }));
    return Core.groups(all).filter(g => !Core.ended(g.date, g.end, S.now));
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
    S.payload = payload;
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
    const start = async () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) return;
      try { busy(1); await Data.saveSettings(Object.assign({}, st(), { staff: [{ name, admin: true }] }), name); choose(name); }
      catch (e) { oops(e); } finally { busy(-1); }
    };
    names.className = '';
    names.replaceChildren(h('form', { class: 'addname', onsubmit: e => { e.preventDefault(); start(); } }, input, btn('시작하기', start, 'primary')));
    $('#pickFine').textContent = '직원 명단이 아직 비어 있습니다. 이름을 적으면 관리자로 등록되고, 설정에서 다른 직원을 추가할 수 있습니다.';
  }

  /* ---------- 예약 화면: 읽기·이동 ---------- */
  function startApp() {
    $('#app').hidden = false;
    $('#who').textContent = S.me;
    render(true); load();
    if (!S.timer) S.timer = setInterval(() => { if (!document.hidden && !$('#app').hidden) load(true); }, POLL_MS);
  }

  /* 화면에 필요한 달: 보고 있는 주·달, 오늘이 든 달(지금 빈 방), 다음 달(내 예약) */
  function wanted() {
    const today = Core.ymOf(S.now.date);
    const yms = (S.view === 'week' ? Core.weekDates(st(), S.cursor).map(Core.ymOf) : []).concat([Core.ymOf(S.cursor), today, Core.addMonths(today, 1)]);
    return yms.filter((x, i) => yms.indexOf(x) === i);
  }
  /* quiet = 자동 새로 고침(표시 없이, 실패해도 조용히). sure = 없는 달도 다시 확인 */
  async function load(quiet, sure) {
    if (!quiet) busy(1);
    try {
      if (Date.now() - S.lastSettings > SETTINGS_MS) { S.lastSettings = Date.now(); await Data.loadSettings(); }
      const yms = wanted();
      const res = await Promise.all(yms.map(ym => Data.month(ym, sure)));
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
    S.cursor = date; render(true);
    if (wanted().some(ym => !S.months.has(ym)) || Date.now() - S.lastLoad > 15000) load();
  }
  function stepMonth(dir) {
    let d = Core.monthsLater(S.cursor, dir);
    if (Core.ymOf(d) === Core.ymOf(S.now.date)) d = S.now.date;
    go(d);
  }
  function step(dir) { if (S.view === 'week') go(Core.addDays(S.cursor, 7 * dir)); else stepMonth(dir); }
  function setView(v) { S.view = v; if (SS) keep.set(KEY.view, v, SS); go(S.cursor); }   // 같은 창에서 새로 고칠 때만 기억한다
  function addNew() { bookForm({ date: S.cursor < S.now.date ? S.now.date : S.cursor }); }

  function signature() {
    return [S.view, S.cursor, S.me, S.now.date, S.now.hour, Math.floor(S.now.minute / 5), Data.sha('settings.json')]
      .concat(wanted().map(ym => ym + (S.months.has(ym) ? Data.sha(Data.path(ym)) : '?'))).join('|');
  }
  function render(force) {
    if ($('#app').hidden || (S.drag && !force)) return;
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

    const main = $('#main');
    main.dataset.view = S.view;
    main.replaceChildren(...(S.view === 'week' ? [sidebar(), weekView()] : [monthView(), dayPanel()]));
  }

  /* ----- 지금 빈 방·내 다음 예약 한 줄 (월 화면, 좁은 화면의 주 화면) ----- */
  function strip() {
    const rn = roomsNow(), next = myUpcoming()[0], free = rn ? rn.filter(x => x.state === 'free') : [];
    return h('div', { class: 'strip' },
      h('span', { class: 'k' }, '지금 빈 방'),
      !rn ? h('span', { class: 'hint' }, '불러오는 중…')
        : rn.length && rn[0].state === 'closed' ? h('span', { class: 'hint' }, rn[0].text === '쉬는 날' ? '오늘은 쉬는 날입니다' : '오늘 운영 시간이 끝났습니다')
        : free.length ? free.map(x => h('button', { class: 'chip ' + kc(x.r.id), type: 'button', title: x.text + ' · 누르면 지금 시간으로 예약',
            onclick: () => bookForm({ date: S.now.date, room: x.r.id, start: x.at }) }, h('i', { class: 'dot' }), x.r.name))
        : h('span', { class: 'hint' }, '지금은 빈 방이 없습니다'),
      h('span', { class: 'sep' }),
      h('span', { class: 'k' }, '내 다음 예약'),
      next ? h('button', { class: 'chip ' + kc(next.room), type: 'button', onclick: () => go(next.date) }, h('i', { class: 'dot' }), whenText(next) + ' ' + roomName(next.room))
        : h('span', { class: 'hint' }, '없음'));
  }

  /* ----- 왼쪽 칸: 작은 달력·지금·내 예약 (넓은 화면의 주 화면) ----- */
  function sidebar() {
    const ym = Core.ymOf(S.cursor), week = Core.weekDates(st(), S.cursor), rn = roomsNow(), mine = myUpcoming();
    const mini = h('div', { class: 'mini' }, [...DOW].map((x, i) => h('span', { class: 'hd' + (i === 0 ? ' s' : '') }, x)),
      Core.monthGrid(ym).map(row => row.map(d => {
        const out = Core.ymOf(d) !== ym, list = out ? [] : itemsOn(d);
        const cls = [out ? 'o' : '', Core.weekday(d) === 0 ? 's' : '', week.indexOf(d) >= 0 ? 'inwk' : '', d === S.now.date ? 'td' : '', d === S.cursor ? 'cur' : '',
          list.length ? 'has' : '', list.some(b => b.owner === S.me) ? 'mine' : ''].filter(Boolean).join(' ');
        return h('button', { type: 'button', class: cls, 'aria-label': md(d) + (list.length ? ', 예약 ' + list.length + '건' : ''), onclick: () => go(d) }, +d.slice(8));
      })));
    return h('aside', { class: 'left' },
      h('div', { class: 'mtitle' }, h('b', null, (+ym.slice(5)) + '월', h('em', null, ym.slice(0, 4))),
        h('span', null, h('button', { type: 'button', class: 'arrow', 'aria-label': '이전 달', onclick: () => stepMonth(-1) }, '‹'),
          h('button', { type: 'button', class: 'arrow', 'aria-label': '다음 달', onclick: () => stepMonth(1) }, '›'))),
      mini,
      h('h4', null, '지금 방 상황', h('small', null, '오늘 ' + S.now.hour + ':' + Core.pad(S.now.minute) + ' 기준')),
      h('div', { class: 'nowl' }, !rn ? h('p', { class: 'hint' }, '불러오는 중…') : rn.map(x => x.state === 'free'
        ? h('button', { type: 'button', class: kc(x.r.id), title: '누르면 지금 시간으로 예약', onclick: () => bookForm({ date: S.now.date, room: x.r.id, start: x.at }) },
            h('i', { class: 'dot' }), h('b', null, x.r.name), h('small', null, x.text))
        : h('div', { class: kc(x.r.id) + ' busy' }, h('i', { class: 'dot' }), h('b', null, x.r.name), h('small', null, x.text)))),
      h('h4', null, '내 예약', mine.length ? h('button', { type: 'button', class: 'more', onclick: showMine }, '모두 보기') : null),
      h('div', { class: 'myl' }, mine.length ? mine.slice(0, 5).map(g => h('button', { type: 'button', class: kc(g.room), title: '누르면 그 날짜로 가서 예약을 엽니다', onclick: () => { go(g.date); showBooking(g); } },
          h('i', { class: 'dot' }), h('b', null, (g.date === S.now.date ? '오늘' : (+g.date.slice(5, 7)) + '/' + (+g.date.slice(8)) + '(' + dow(g.date) + ')') + ' ' + g.start + '~' + g.end + '시'), h('span', null, roomName(g.room))))
        : h('p', { class: 'hint' }, '앞으로 잡힌 예약이 없습니다.')));
  }

  /* ----- 하루 시간표: 방(가로) × 시간(세로). 주 화면의 하루 칸과 월 화면의 오른쪽 창이 같이 쓴다 ----- */
  function dayGrid(d, withHead) {
    const rooms = st().rooms, hours = Core.gridHours(st()), list = itemsOn(d), ready = loaded(d);
    const c0 = withHead ? 2 : 1, r0 = withHead ? 2 : 1, last = hours[hours.length - 1] + 1;
    const g = h('div', { class: 'tt', 'data-date': d, style: {
      gridTemplateColumns: (withHead ? 'var(--tw) ' : '') + 'repeat(' + rooms.length + ',minmax(0,1fr))',
      gridTemplateRows: (withHead ? 'auto ' : '') + 'repeat(' + hours.length + ',var(--rh))' } });
    if (withHead) {
      g.append(h('div', { class: 'h corner' }));
      rooms.forEach(r => g.append(h('div', { class: 'h ' + kc(r.id), title: r.name }, r.name)));
    }
    hours.forEach((hr, i) => {
      if (withHead) g.append(h('div', { class: 'tm', style: { gridRow: i + r0, gridColumn: 1 } }, hr + '시'));
      rooms.forEach((r, j) => {
        const state = Core.slotStatus(st(), d, hr, r.id, S.now);
        const free = state === 'ok' && ready && !list.some(x => x.room === r.id && x.start <= hr && hr < x.end);
        g.append(h(free ? 'button' : 'div', {
          class: 'c ' + state + (j === 0 ? ' first' : '') + (free ? ' free' : ''), type: free ? 'button' : null,
          style: { gridRow: i + r0, gridColumn: j + c0 }, 'data-room': r.id, 'data-hour': hr,
          'aria-label': free ? md(d) + ' ' + hr + '시 ' + r.name + ' 예약하기' : null,
          title: state === 'far' ? r.name + Core.josa(r.name, '은 ', '는 ') + Core.limitText(st()) : null }));
      });
    });
    Core.groups(list).forEach(b => {
      const j = rooms.findIndex(r => r.id === b.room), from = Math.max(b.start, hours[0]), i = hours.indexOf(from);
      if (j < 0 || i < 0 || b.end <= hours[0]) return;
      g.append(h('button', { class: 'ev ' + kc(b.room) + (b.owner === S.me ? ' m' : '') + (Core.ended(b.date, b.end, S.now) ? ' old' : ''), type: 'button',
          style: { gridRow: (i + r0) + ' / span ' + Math.max(1, Math.min(b.end, last) - from), gridColumn: j + c0 },
          title: span(b) + ' ' + roomName(b.room) + ' · ' + b.owner + ' · ' + b.purpose,
          onclick: () => showBooking(b) },
        h('b', null, b.owner),
        b.end - b.start > 1 ? [h('small', null, span(b)), h('small', null, withHead ? b.purpose : b.purpose.replace(/상담$/, ''))]
          : h('small', null, withHead ? b.purpose : b.purpose.replace(/상담$/, ''))));
    });
    if (d === S.now.date && hours.indexOf(S.now.hour) >= 0)      // 지금 시각 선
      g.append(h('div', { class: 'nowline', style: { gridRow: hours.indexOf(S.now.hour) + r0, gridColumn: c0 + ' / -1', top: 'calc(var(--rh) * ' + (S.now.minute / 60).toFixed(3) + ')' } },
        h('span', null, '지금 ' + S.now.hour + ':' + Core.pad(S.now.minute))));
    // 빈칸 누르기(한 시간)·끌기(여러 시간)
    g.addEventListener('pointerdown', e => { const c = e.target.closest('.c.free'); if (c && e.button === 0 && e.pointerType === 'mouse') { e.preventDefault(); startDrag(g, c); } });
    g.addEventListener('click', e => { const c = e.target.closest('.c.free'); if (c && !S.skipClick) bookForm({ date: d, room: c.dataset.room, start: +c.dataset.hour }); });
    return g;
  }
  /* 빈칸에서 마우스를 누른 채 위아래로 끌면 그만큼 시간을 고른다. 놓으면 예약 창이 열린다. */
  function startDrag(grid, cell) {
    const room = cell.dataset.room, from = +cell.dataset.hour, date = grid.dataset.date, cells = new Map();
    grid.querySelectorAll('.c.free').forEach(c => { if (c.dataset.room === room) cells.set(+c.dataset.hour, c); });
    let to = from;
    const paint = on => { const a = Math.min(from, to), b = Math.max(from, to); cells.forEach((c, hr) => c.classList.toggle('pick', !!on && hr >= a && hr <= b)); };
    const move = e => {
      const r = cell.getBoundingClientRect(), want = from + Math.floor((e.clientY - r.top) / r.height), dir = want >= from ? 1 : -1;
      let t = from;
      while (t !== want && cells.has(t + dir)) t += dir;          // 빈칸이 이어지는 데까지만
      if (t !== to) { to = t; paint(true); }
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      S.drag = false; paint(false);
      S.skipClick = true; setTimeout(() => { S.skipClick = false; }, 0);
      bookForm({ date, room, start: Math.min(from, to), end: Math.max(from, to) + 1 });
    };
    S.drag = true; paint(true);
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  /* ----- 주 화면 ----- */
  function weekView() {
    const days = Core.weekDates(st(), S.cursor), rooms = st().rooms, hours = Core.gridHours(st());
    const sel = days.indexOf(S.cursor) >= 0 ? S.cursor : days[0];      // 좁은 화면에서 보여 줄 하루
    const mark = d => (d === S.now.date ? ' today' : '') + (d === sel ? ' cur' : '') + (d < S.now.date ? ' past' : '');
    const wk = h('div', { class: 'wk', style: { '--n': hours.length, '--days': days.length } });
    wk.append(h('div', { class: 'corner' }));
    days.forEach(d => wk.append(h('button', { type: 'button', class: 'dh' + mark(d), onclick: () => go(d) }, h('b', null, +d.slice(8)), h('span', null, dow(d) + '요일'))));
    wk.append(h('div', { class: 'corner c2' }));
    days.forEach(d => wk.append(h('div', { class: 'lanes' + mark(d), style: { gridTemplateColumns: 'repeat(' + rooms.length + ',minmax(0,1fr))' } },
      rooms.map(r => h('span', { class: kc(r.id), title: r.name }, h('b', null, r.short), h('em', null, r.name))))));
    wk.append(h('div', { class: 'times', style: { gridTemplateRows: 'repeat(' + hours.length + ',var(--rh))' } }, hours.map(hr => h('span', null, hr + '시')),
      h('span', { class: 'end' }, (hours[hours.length - 1] + 1) + '시')));
    days.forEach(d => wk.append(h('div', { class: 'col' + mark(d) }, dayGrid(d, false))));
    return h('section', { class: 'weekview' },
      strip(),
      h('div', { class: 'daytabs' }, days.map(d => h('button', { type: 'button', class: mark(d).trim(), onclick: () => go(d) }, h('span', null, dow(d)), h('b', null, +d.slice(8)),
        h('i', { class: itemsOn(d).some(b => b.owner === S.me) ? 'mine' : itemsOn(d).length ? 'has' : null })))),
      wk,
      h('div', { class: 'legend' }, rooms.map(r => h('span', { class: kc(r.id) }, h('i', { class: 'dot' }), h('b', null, r.short), r.short === r.name ? null : r.name)),
        h('span', { class: 'minekey' }, h('i', { class: 'dot' }), '짙은 남색은 내 예약'),
        h('span', { class: 'note' }, '빈칸을 누르면 예약 창이 열립니다(아래로 끌면 여러 시간)'),
        days.some(d => !loaded(d)) ? h('span', { class: 'note' }, '불러오는 중…') : null));
  }

  /* ----- 월 화면 ----- */
  /* 달력 칸마다 방 하나에 가로줄 하나씩(왼쪽 여는 시각 → 오른쪽 닫는 시각)을 그린다.
     예약된 시간은 방 색, 빈 시간은 연한 색, 내 예약은 짙은 남색. 달력 위에 색 설명과 시각 눈금을 한 번만 둔다.
     내 예약은 날짜 옆에 글로도 적는다. 빈 시간을 누르면 바로 예약 창, 날짜를 누르면 오른쪽에 그날 시간표. */
  function monthView() {
    const ym = Core.ymOf(S.cursor), rooms = st().rooms, hours = Core.gridHours(st()), grid = Core.monthGrid(ym);
    const open = hours[0], close = hours[hours.length - 1] + 1, marks = [];
    for (let hr = open; hr <= close; hr += 3) marks.push(hr);
    const sun = st().hours.sunday > 0, cols = (sun ? 'minmax(0,1fr)' : 'minmax(0,var(--sunw))') + ' repeat(6,minmax(0,1fr))';
    return h('section', { class: 'cal', style: { '--n': hours.length, '--rooms': rooms.length, '--rows': grid.length } }, strip(),
      h('div', { class: 'key' },
        h('span', { class: 'kt' }, '예약된 시간'), rooms.map(r => h('span', { class: kc(r.id) }, h('i', { class: 'kb' }), r.name)),
        h('span', null, h('i', { class: 'km' }), '내 예약'), h('span', null, h('i', { class: 'kf' }), '빈 시간'),
        h('span', { class: 'note' }, '줄의 빈 곳을 누르면 그 시간으로 예약')),
      h('div', { class: 'dow', style: { gridTemplateColumns: cols } }, [...DOW].map((x, i) => h('span', { class: i === 0 ? 'sun' : null }, x,
        i > 0 || sun ? h('span', { class: 'ax' }, marks.map(hr => h('i', null, hr))) : null))),
      h('div', { class: 'weeks' }, grid.map(row => h('div', { class: 'week', style: { gridTemplateColumns: cols } }, row.map(d => dayCell(d, ym, rooms, hours))))));
  }
  function dayCell(d, ym, rooms, hours) {
    const out = Core.ymOf(d) !== ym, openDay = Core.dayHours(st(), d), list = out ? [] : itemsOn(d), mine = Core.groups(list.filter(b => b.owner === S.me));
    const cls = ['day', out ? 'out' : '', Core.weekday(d) === 0 ? 'sun' : '', d === S.now.date ? 'today' : '', d < S.now.date ? 'past' : '', d === S.cursor ? 'sel' : ''].filter(Boolean).join(' ');
    const short = id => Core.roomById(st(), id).short;
    const chip = !mine.length ? null : h('span', { class: 'mychip', title: '내 예약: ' + mine.map(g => span(g) + ' ' + roomName(g.room)).join(', ') },
      (mine[0].end - mine[0].start > 1 ? mine[0].start + '~' + mine[0].end + '시' : mine[0].start + '시') + ' ' + short(mine[0].room) + (mine.length > 1 ? ' 외 ' + (mine.length - 1) : ''));
    const pick = e => {                       // 줄의 빈 곳을 눌렀으면 그 방·시간으로 예약 창, 아니면 그날을 고른다
      const t = window.innerWidth >= 900 && e.target.closest ? e.target.closest('.track') : null;   // 휴대전화에서는 줄이 작아 날짜만 고른다
      if (t && !e.target.closest('i.b, i.m, i.x') && loaded(d)) {
        const box = t.getBoundingClientRect(), hr = hours[Math.max(0, Math.min(hours.length - 1, Math.floor((e.clientX - box.left) / box.width * hours.length)))];
        const room = t.dataset.room, taken = list.some(x => x.room === room && x.start <= hr && hr < x.end);
        if (!taken && Core.slotStatus(st(), d, hr, room, S.now) === 'ok') { S.cursor = d; render(true); return bookForm({ date: d, room, start: hr }); }
      }
      go(d);
    };
    return h('button', { class: cls, type: 'button', onclick: pick,
        'aria-label': md(d) + ' ' + dow(d) + '요일' + (!out && !openDay.length ? ', 쉬는 날' : '') + (list.length ? ', 예약 ' + Core.groups(list).length + '건' : '') + (mine.length ? ', 내 예약 ' + mine.length + '건' : ''),
        title: !out && !openDay.length ? '쉬는 날' : null, 'aria-pressed': d === S.cursor ? 'true' : 'false' },
      h('span', { class: 'dhead' }, h('span', { class: 'num' }, +d.slice(8)), chip),
      out || !openDay.length ? null : dayStrips(d, list, rooms, hours, openDay));
  }
  /* 방마다 이어진 한 줄을 깔고, 예약된 구간만 그 위에 색으로 얹는다 (칸을 잘게 쪼개지 않아 줄이 고르게 보인다) */
  function dayStrips(d, list, rooms, hours, openDay) {
    const open = hours[0], n = hours.length, close = open + n, from = openDay[0], to = openDay[openDay.length - 1] + 1;
    const pos = (a, b) => ({ left: ((a - open) / n * 100).toFixed(3) + '%', width: ((b - a) / n * 100).toFixed(3) + '%' });
    const ticks = []; for (let hr = open + 3; hr < close; hr += 3) ticks.push(hr);
    return h('span', { class: 'strips' }, rooms.map(r => h('span', { class: 'track ' + kc(r.id), 'data-room': r.id, title: r.name + ' · 빈 곳을 누르면 그 시간으로 예약' },
      from > open ? h('i', { class: 'x', style: pos(open, from), title: '운영 시간 아님' }) : null,
      to < close ? h('i', { class: 'x', style: pos(to, close), title: '운영 시간 아님' }) : null,
      Core.groups(list.filter(b => b.room === r.id)).map(g => h('i', { class: g.owner === S.me ? 'm' : 'b',
        title: r.name + ' ' + span(g) + ' · ' + (g.owner === S.me ? '내 예약' : g.owner + ' 예약'), style: pos(Math.max(g.start, open), Math.min(g.end, close)) })),
      ticks.map(hr => h('i', { class: 't', style: { left: ((hr - open) / n * 100).toFixed(3) + '%' } })))));
  }
  function dayPanel() {
    const d = S.cursor, list = itemsOn(d), gs = Core.groups(list), open = Core.dayHours(st(), d), mine = gs.filter(g => g.owner === S.me).length;
    const limited = st().rooms.filter(r => r.limited).map(r => r.name);
    const sum = !open.length ? '쉬는 날입니다.' : !loaded(d) ? '불러오는 중…'
      : !gs.length ? '아직 예약이 없습니다.' : ['예약 ' + gs.length + '건', mine ? [' · ', h('b', null, '내 예약 ' + mine + '건')] : null];
    return h('aside', { class: 'side', style: { '--n': Core.gridHours(st()).length } },
      h('h2', null, md(d), h('span', null, dow(d) + '요일')),
      h('p', { class: 'sum' }, sum),
      open.length ? dayGrid(d, true) : null,
      h('p', { class: 'note' }, open.length ? '빈칸을 누르거나 아래로 끌어서 예약합니다. ' : null,
        limited.length ? joinNames(limited) + Core.josa(limited[limited.length - 1], '은 ', '는 ') + Core.limitText(st()) : null,
        h('br'), '내담자 이름·학교·연락처 같은 정보는 적지 않습니다.'));
  }

  /* ---------- 예약하기·바꾸기 창 ---------- */
  function bookForm(init) {
    const edit = init.edit || null, skip = new Set(edit ? edit.items.map(b => b.id) : []);
    const f = edit ? { date: edit.date, room: edit.room, start: edit.start, end: edit.end, purpose: edit.purpose, repeat: 1 }
      : { date: init.date || S.cursor, room: init.room || st().rooms[0].id, start: init.start == null ? null : init.start,
          end: init.end || (init.start == null ? null : init.start + 1), purpose: null, repeat: 1 };
    let sending = false, purposeTouched = !!edit, failed = '';
    const body = h('form', { class: 'form', novalidate: true, onsubmit: e => { e.preventDefault(); submit(); } });

    // 바꾸는 중인 예약은 빼고 본다
    const monthItems = d => { const m = S.months.get(Core.ymOf(d)); return m ? m.filter(x => !skip.has(x.id)) : null; };
    const cand = (date, series) => {
      const b = { id: Core.newId(), date, start: f.start, end: f.end, room: f.room, purpose: f.purpose, owner: edit ? edit.owner : S.me, at: edit ? edit.items[0].at : Core.nowKST().stamp };
      const s0 = edit && edit.items[0].series;
      if (s0 && edit.items.every(x => x.series === s0)) b.series = s0;
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
          const free = hours.find(hr => !items.some(x => x.date === f.date && x.room === f.room && x.start <= hr && hr < x.end));
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
      const others = (items || []).filter(x => x.date === f.date && x.room === f.room);
      const why = !open.length ? (Core.dayHours(st(), f.date).length ? '오늘은 예약할 수 있는 시간이 끝났습니다.' : '쉬는 날에는 예약할 수 없습니다.')
        : !items ? '' : Core.check(st(), items, cand(f.date), S.now);
      const max = maxRepeat();
      const seg = (list, cur, label, pick) => h('div', { class: 'seg' }, list.map(x => h('button', { type: 'button', class: x === cur ? 'on' : null, 'aria-pressed': x === cur ? 'true' : 'false', onclick: () => { pick(x); draw(); } }, label(x))));

      body.replaceChildren(
        // 지금 고른 내용을 한 줄로 (저장하기 전에 다시 볼 수 있게)
        h('p', { class: 'pickline ' + kc(f.room) }, h('i', { class: 'dot' }),
          md(f.date) + ' ' + dow(f.date) + '요일 · ' + roomName(f.room) + (f.start == null ? '' : ' · ' + f.start + '~' + f.end + '시 (' + (f.end - f.start) + '시간)')),
        h('div', { class: 'field' }, h('label', { class: 'lab', for: 'fDate' }, '날짜'),
          h('div', { class: 'row' },
            h('input', { id: 'fDate', type: 'date', value: f.date, min: S.now.date, onchange: e => { if (Core.parseDate(e.target.value)) { f.date = e.target.value; ensureMonth(f.date, draw); draw(); } } }),
            h('span', { class: 'hint' }, dow(f.date) + '요일'))),
        h('div', { class: 'field' }, h('span', { class: 'lab' }, '방'),
          seg(st().rooms.map(r => r.id), f.room, x => [h('i', { class: 'dot ' + kc(x) }), roomName(x)], x => { f.room = x; })),
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
          h('button', { class: 'btn primary', type: 'submit', disabled: !!why || !items || sending }, sending ? '저장하는 중…' : edit ? '이대로 변경' : f.repeat > 1 ? f.repeat + '건 예약하기' : '예약하기')));
      failed = '';
    }
    const done = tail => (+f.date.slice(5, 7)) + '/' + (+f.date.slice(8)) + '(' + dow(f.date) + ') ' + f.start + '~' + f.end + '시 ' + roomName(f.room) + tail;
    async function submit() {
      if (sending) return;
      sending = true; draw(); busy(1);
      try {
        if (edit) {
          await Data.replace(edit.items, [cand(f.date)], S.me, '변경');
          closeDialog(); S.cursor = f.date; sync([edit.date, f.date]); toast(done('으로 바꿨습니다.'));
        } else {
          const series = f.repeat > 1 ? Core.newId() : null, list = [];
          for (let i = 0; i < f.repeat; i++) list.push(cand(Core.addDays(f.date, 7 * i), series));
          const r = await Data.add(list, S.me);
          sync(list.map(b => b.date));
          if (!r.added.length) throw new StoreError('rule', r.skipped[0].why);
          S.cursor = f.date; render(true);
          if (r.skipped.length) {
            dialog('예약 결과', h('div', null,
              h('p', null, list.length + '건 가운데 ' + r.added.length + '건을 예약했습니다. 아래 날짜는 빠졌습니다.'),
              h('div', { class: 'list' }, r.skipped.map(x => h('button', { type: 'button', disabled: true }, h('b', null, md(x.b.date) + ' (' + dow(x.b.date) + ')'), h('span', null, x.b.start + '~' + x.b.end + '시'), h('span', null, x.why)))),
              h('div', { class: 'actions' }, btn('확인', closeDialog, 'primary'))));
          } else { closeDialog(); toast(r.added.length > 1 ? '매주 ' + dow(f.date) + '요일 ' + f.start + '~' + f.end + '시 ' + roomName(f.room) + ', ' + r.added.length + '건을 예약했습니다.' : done(' 예약했습니다.')); }
        }
      } catch (e) {
        if (e.code === 'gone') { closeDialog(); load(true, true); toast(e.message, true); }
        else if (e.code === 'rule') { failed = e.message; sync([f.date]); }
        else oops(e);
      } finally { busy(-1); sending = false; if (!$('#dlg').hidden && body.isConnected) draw(); }
    }

    dialog(edit ? '예약 변경' : '예약하기', body);
    ensureMonth(f.date, draw);
    draw();
  }

  /* ---------- 예약 자세히 보기 (이어진 예약 한 덩어리) ---------- */
  function showBooking(g) {
    S.now = Core.nowKST();
    const mineB = g.owner === S.me, editable = canEdit(g), over = Core.ended(g.date, g.end, S.now), started = Core.ended(g.date, g.start + 1, S.now);
    const series = g.items.find(b => b.series), live = [];
    for (let hr = g.start; hr < g.end; hr++) if (!Core.ended(g.date, hr + 1, S.now)) live.push(hr);    // 아직 취소할 수 있는 시간
    const pick = new Set(), actions = h('div', { class: 'actions' }), askBox = h('div', { class: 'ask', hidden: true });
    const range = live.length ? live[0] + '~' + (live[live.length - 1] + 1) + '시' : '';
    const normal = () => {
      askBox.hidden = true; askBox.replaceChildren(); pick.clear();
      actions.replaceChildren(
        editable ? btn('예약 취소', () => ask(false), 'danger left') : null,
        editable && series ? btn('이후 반복 모두 취소', () => ask(true), 'danger') : null,
        editable && !started ? btn('예약 변경', () => bookForm({ edit: g })) : null,
        btn('닫기', closeDialog, editable ? null : 'primary'));
    };
    /* 여러 시간짜리 예약: '전체 취소'와 '고른 시간만 취소'를 따로 둔다. 시간 칸은 취소할 것을 눌러 고른다. */
    function ask(all) {
      const many = !all && live.length > 1, who = mineB ? '' : g.owner + ' 님의 예약입니다. ';
      const some = many && pick.size > 0 && pick.size < live.length, kept = live.filter(hr => !pick.has(hr));
      const text = list => Core.runs(list).map(r => r[0] + '~' + r[1] + '시').join(', ');
      askBox.hidden = false;
      askBox.replaceChildren(
        h('p', { class: 'hint' }, who + (all ? md(g.date) + '부터 남은 반복 예약을 모두 취소할까요?'
          : many ? '전체를 취소하거나, 일부만 취소하려면 취소할 시간을 눌러 고르세요.'
          : started && live.length ? '남은 ' + range + '를 취소할까요?' : '이 예약을 취소할까요?')),
        many ? h('div', { class: 'seg' }, live.map(hr => h('button', { type: 'button', class: pick.has(hr) ? 'on del' : null, 'aria-pressed': pick.has(hr) ? 'true' : 'false',
          onclick: () => { if (pick.has(hr)) pick.delete(hr); else pick.add(hr); ask(false); } }, hr + '~' + (hr + 1) + '시'))) : null,
        some ? h('p', { class: 'hint' }, '취소: ' + text(Array.from(pick)) + ' · 남김: ' + text(kept)) : null);
      actions.replaceChildren(btn('돌아가기', normal),
        many ? btn(some ? '고른 ' + pick.size + '시간만 취소' : '고른 시간만 취소', () => cancel(false), 'danger', { disabled: !some }) : null,
        btn(all ? '모두 취소합니다' : many ? '전체 취소 (' + range + ')' : '취소합니다', () => { if (!all) live.forEach(hr => pick.add(hr)); cancel(all); }, 'danger'));
    }
    async function cancel(all) {
      busy(1); actions.replaceChildren(h('span', { class: 'hint' }, '취소하는 중…'));
      try {
        let msg;
        if (all) {
          const k = await Data.cancelSeries(series, S.me);
          msg = k > 1 ? k + '건을 취소했습니다.' : k === 1 ? '예약을 취소했습니다.' : '이미 취소된 예약입니다.';
        } else {
          // 고른 시간에 걸친 예약을 지우고, 그 가운데 남길 시간은 다시 넣는다
          const hit = g.items.filter(b => { for (let hr = b.start; hr < b.end; hr++) if (pick.has(hr)) return true; return false; });
          const left = []; hit.forEach(b => { for (let hr = b.start; hr < b.end; hr++) if (!pick.has(hr)) left.push(hr); });
          const stamp = Core.nowKST().stamp;
          const news = Core.runs(left).map(r => Object.assign({}, hit[0], { id: Core.newId(), start: r[0], end: r[1], upd: stamp }, mineB ? null : { updBy: S.me }));
          await Data.replace(hit, news, S.me, '취소', true);
          msg = pick.size > 1 ? pick.size + '시간 예약을 취소했습니다.' : '예약을 취소했습니다.';
        }
        closeDialog(); sync([g.date]); load(true); toast(msg);
      } catch (e) {
        if (e.code === 'gone') { closeDialog(); load(true, true); toast(e.message, true); }
        else { normal(); oops(e); }
      } finally { busy(-1); }
    }
    normal();
    dialog([md(g.date), h('span', null, dow(g.date) + '요일')], h('div', null,
      h('dl', { class: 'facts' },
        h('dt', null, '시간'), h('dd', null, g.start + '시 ~ ' + g.end + '시', g.end - g.start > 1 ? h('small', null, ' (' + (g.end - g.start) + '시간)') : null),
        h('dt', null, '방'), h('dd', { class: kc(g.room) }, h('i', { class: 'dot' }), ' ' + roomName(g.room)),
        h('dt', null, '용도'), h('dd', null, g.purpose),
        h('dt', null, '예약자'), h('dd', null, g.owner + (mineB ? ' (나)' : '')),
        series ? [h('dt', null, '반복'), h('dd', null, '매주 반복 예약')] : null),
      over ? h('p', { class: 'hint' }, '지난 예약은 바꿀 수 없습니다.') : null,
      !editable && !over ? h('p', { class: 'hint' }, '다른 사람의 예약은 본인이나 관리자만 바꿀 수 있습니다.') : null,
      editable && started ? h('p', { class: 'hint' }, '이미 시작한 예약은 남은 시간만 취소할 수 있습니다.') : null,
      askBox, actions));
  }

  /* ---------- 내 예약 ---------- */
  async function showMine() {
    const holder = h('div', null, h('p', { class: 'empty' }, '불러오는 중…'));
    dialog('내 예약', holder);
    try {
      const first = Core.ymOf(S.now.date), yms = [0, 1, 2, 3].map(i => Core.addMonths(first, i));
      const res = await Promise.all(yms.map(ym => Data.month(ym, true)));
      yms.forEach((ym, i) => S.months.set(ym, res[i]));
      S.now = Core.nowKST();
      const list = myUpcoming();
      holder.replaceChildren(list.length
        ? h('div', { class: 'list' }, list.map(g => h('button', { type: 'button', class: kc(g.room), onclick: () => { closeDialog(); go(g.date); } },
            h('b', null, md(g.date) + ' (' + dow(g.date) + ')'), h('span', null, g.start + '~' + g.end + '시'), h('span', null, h('i', { class: 'dot' }), ' ' + roomName(g.room) + ' · ' + g.purpose), h('small', null, '보기'))))
        : h('p', { class: 'empty' }, '앞으로 잡힌 내 예약이 없습니다.'),
        h('div', { class: 'actions' }, btn('닫기', closeDialog)));
      render();
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
    const freeColor = () => { const used = d.rooms.map(x => x.color); let c = 0; while (c < Core.COLORS - 1 && used.indexOf(c) >= 0) c++; return c; };
    let purposes = d.purposes.join(', ');
    function draw() {
      body.replaceChildren(
        h('div', { class: 'sec' }, h('h4', null, '직원 명단'),
          d.staff.map((s, i) => h('div', { class: 'rowline' }, text(s, 'name', { maxlength: 12, 'aria-label': '이름' }), tick(s, 'admin', '관리자'), del(d.staff, i))),
          h('div', { class: 'rowline' }, btn('이름 추가', () => { d.staff.push({ name: '', admin: false }); draw(); const ins = body.querySelectorAll('.sec')[0].querySelectorAll('input[type=text]'); ins[ins.length - 1].focus(); })),
          h('p', { class: 'hint' }, '이름을 고치면 그 사람이 전에 한 예약은 예전 이름으로 남습니다. 관리자는 설정을 바꾸고 다른 사람의 예약도 바꿀 수 있습니다.')),
        h('div', { class: 'sec' }, h('h4', null, '방'),
          d.rooms.map((r, i) => h('div', { class: 'rowline' },
            h('button', { type: 'button', class: 'swatch k' + r.color, title: '누르면 색이 바뀝니다', 'aria-label': r.name + ' 색 바꾸기', onclick: () => { r.color = (r.color + 1) % Core.COLORS; draw(); } }),
            text(r, 'name', { maxlength: 20, 'aria-label': '방 이름' }), text(r, 'short', { maxlength: 2, class: 'short', 'aria-label': '줄임 글자', title: '시간표 위 색 칸에 쓰는 한두 글자' }),
            tick(r, 'limited', '예약 기간 제한'), del(d.rooms, i))),
          h('div', { class: 'rowline' }, btn('방 추가', () => { d.rooms.push({ id: 'r' + Core.newId().slice(0, 6), name: '', short: '', limited: true, color: freeColor() }); draw(); })),
          h('p', { class: 'hint' }, '색 칸을 누르면 방 색이 바뀝니다. 방을 지우면 그 방의 예약은 화면에 보이지 않게 됩니다.')),
        h('div', { class: 'sec' }, h('h4', null, '운영 시간과 규칙'),
          h('div', { class: 'rowline' }, h('label', null, '여는 시각', num(d.hours, 'open', 0, 23)), h('label', null, '평일 닫는 시각', num(d.hours, 'weekday', 0, 24)),
            h('label', null, '토요일', num(d.hours, 'saturday', 0, 24)), h('label', null, '일요일', num(d.hours, 'sunday', 0, 24))),
          h('p', { class: 'hint' }, '닫는 시각을 0으로 두면 그 요일은 쉬는 날입니다.'),
          h('div', { class: 'rowline' }, h('label', null, '기간 제한이 있는 방은 오늘부터', num(d, 'limitMonths', 1, 12), '달 뒤까지 예약')),
          h('div', { class: 'rowline' }, h('label', null, '용도', h('input', { type: 'text', value: purposes, style: { width: '300px' }, oninput: e => { purposes = e.target.value; } }))),
          h('p', { class: 'hint' }, '용도는 쉼표로 나눠 적습니다.')),
        h('p', { class: 'msg', role: 'alert' }, note),
        h('div', { class: 'actions' }, btn('공용 비밀번호 바꾸기', showPassword, 'left'), btn('닫기', closeDialog), btn(saving ? '저장하는 중…' : '저장', save, 'primary', { disabled: saving })));
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

  /* ---------- 공용 비밀번호 바꾸기 (관리자) ----------
     지금 쓰는 접속 정보를 새 비밀번호로 다시 잠근 lock.json 내용을 만든다. 저장소의 lock.json을 바꾸는 일은 관리자가 깃허브에서 한다. */
  function showPassword() {
    const host = /^([\w-]+)\.github\.io$/.exec(location.hostname), first = location.pathname.split('/').filter(Boolean)[0] || '';
    const siteRepo = host && first && !/\.html$/.test(first) ? host[1] + '/' + first : '';
    const field = more => h('input', Object.assign({ type: 'password', autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false' }, more));
    const p1 = field({ 'aria-label': '새 비밀번호' }), p2 = field({ 'aria-label': '새 비밀번호 한 번 더', placeholder: '한 번 더' });
    const msg = h('p', { class: 'msg', role: 'alert' });
    const out = h('textarea', { class: 'mono', readonly: true, rows: 5, spellcheck: 'false', 'aria-label': '새 잠금 파일 내용' });
    const copy = btn('복사', async () => {
      try { await navigator.clipboard.writeText(out.value); }
      catch (e) { out.focus(); out.select(); try { document.execCommand('copy'); } catch (e2) { /* 직접 복사 */ } }
      copy.textContent = '복사했습니다'; setTimeout(() => { copy.textContent = '복사'; }, 2000);
    }, 'primary');
    const result = h('div', { class: 'sec', hidden: true }, h('h4', null, '새 잠금 파일'),
      h('p', { class: 'hint' }, '아래 글자를 복사한 뒤, 깃허브의 lock.json을 열어 안의 내용을 모두 지우고 붙여 넣고 Commit changes를 누르세요. 1~2분 뒤부터는 새 비밀번호로만 들어올 수 있고, 모든 기기에서 다시 로그인해야 합니다.'),
      out,
      h('div', { class: 'actions' }, copy,
        siteRepo ? h('a', { class: 'btn', target: '_blank', rel: 'noopener', href: 'https://github.com/' + siteRepo + '/edit/main/lock.json' }, '깃허브에서 lock.json 열기') : null));
    const make = btn('새 잠금 파일 만들기', run, 'primary');
    async function run() {
      msg.className = 'msg';
      const weak = Lock.weakness(p1.value);
      if (weak) { msg.textContent = '비밀번호: ' + weak; return; }
      if (Lock.clean(p1.value) !== Lock.clean(p2.value)) { msg.textContent = '비밀번호 두 칸이 서로 다릅니다.'; return; }
      if (!S.payload) { msg.textContent = '다시 로그인한 뒤 해 주세요.'; return; }
      make.disabled = true; msg.className = 'msg info'; msg.textContent = '만드는 중…';
      try {
        const text = JSON.stringify(await Lock.create(p1.value, S.payload));
        await Lock.open(p1.value, JSON.parse(text));          // 다시 열리는지 확인
        out.value = text; result.hidden = false; msg.textContent = '';
      } catch (e) { msg.className = 'msg'; msg.textContent = '만들지 못했습니다. 다시 해 주세요.'; console.error(e); }
      finally { make.disabled = false; }
    }
    dialog('공용 비밀번호 바꾸기', h('form', { class: 'form', novalidate: true, onsubmit: e => { e.preventDefault(); run(); } },
      h('div', { class: 'field' }, h('span', { class: 'lab' }, '새 비밀번호', h('small', null, '10자 이상, 영문과 숫자를 섞어서')),
        h('div', { class: 'row' }, p1,
          h('label', { class: 'hint' }, h('input', { type: 'checkbox', onchange: e => { p1.type = p2.type = e.target.checked ? 'text' : 'password'; } }), ' 글자 보기')),
        p2),
      msg,
      h('div', { class: 'actions' }, btn('닫기', closeDialog), make),
      result,
      h('p', { class: 'hint' }, '예전 비밀번호를 아는 사람을 완전히 막으려면 접속 열쇠도 새로 만들어야 합니다. ', h('a', { href: 'setup.html' }, '설정 페이지'), '에서 할 수 있습니다.')));
  }

  /* ---------- 이름 메뉴 ---------- */
  function toggleMenu() {
    const m = $('#menu');
    if (!m.hidden) return closeMenu();
    const item = (label, fn) => h('button', { type: 'button', onclick: () => { closeMenu(); fn(); } }, label);
    m.replaceChildren(
      item('내 예약', showMine),
      item('이름 바꾸기', showPick),
      isAdmin() ? item('설정', showSettings) : null,
      item('새로 고침', () => load(false, true)),
      item('잠그기', () => { forget(); location.reload(); }));
    m.hidden = false;
  }

  /* ---------- 시작 ---------- */
  async function boot() {
    S.now = Core.nowKST(); S.cursor = S.now.date;
    S.view = SS && keep.get(KEY.view, SS) === 'week' ? 'week' : 'month';      // 처음 열면 늘 월 화면
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
  $('#add').addEventListener('click', addNew);
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
