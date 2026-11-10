/* 예약 규칙과 날짜 계산 — 화면·저장과 무관한 순수 계산만 모았다.
   날짜는 'YYYY-MM-DD' 글자, 시각은 정수 시(9 = 9시)로 다루고, 모두 한국 시간 기준이다. */
'use strict';
const Core = (() => {

  /* ---------- 기본 설정 (자료 저장소의 settings.json이 이 값을 덮어쓴다) ---------- */
  const DEFAULTS = {
    v: 1,
    rooms: [
      { id: 'r1', name: '상담실 1', short: '1', limited: true },
      { id: 'r2', name: '상담실 2', short: '2', limited: true },
      { id: 'r3', name: '상담실 3', short: '3', limited: true },
      { id: 'g', name: '집단상담실', short: '집', limited: false }   // limited: 예약 가능 기간 제한
    ],
    purposes: ['개인상담', '부모상담', '집단상담', '회의', '기타'],
    hours: { open: 9, weekday: 21, saturday: 18, sunday: 0 },         // 닫는 시각. 0이면 쉬는 날
    limitMonths: 1,                                                    // limited 방은 오늘부터 몇 달 뒤까지
    staff: []                                                          // { name, admin }
  };

  const COLORS = 8;   // 방에 줄 수 있는 색 수 (style.css의 .k0 ~ .k7)
  const int = (v, lo, hi, d) => { if (v == null || v === '') return d; v = Math.round(Number(v)); return Number.isFinite(v) && v >= lo && v <= hi ? v : d; };
  const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

  /* 저장된 설정을 믿고 쓸 수 있는 모양으로 다듬는다 */
  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const out = { v: 1 };
    const seen = new Set();
    out.rooms = (Array.isArray(raw.rooms) ? raw.rooms : DEFAULTS.rooms).map(r => ({
      id: str(r && r.id, 12), name: str(r && r.name, 20), short: str(r && r.short, 3), limited: !!(r && r.limited), color: int(r && r.color, 0, COLORS - 1, -1)
    })).filter(r => r.id && r.name && !seen.has(r.id) && seen.add(r.id));
    if (!out.rooms.length) out.rooms = DEFAULTS.rooms.map(r => Object.assign({ color: -1 }, r));
    // 줄임 이름: 숫자만 있으면 '1실'처럼, '집'은 '집단'으로 (글자만 봐도 방인 줄 알게)
    out.rooms.forEach(r => {
      if (!r.short) r.short = r.name.replace(/\s/g, '').slice(-1);
      if (/^\d{1,2}$/.test(r.short)) r.short += '실';
      else if (r.short === '집') r.short = '집단';
    });
    // 방 색: 정해 둔 색이 없으면 아직 안 쓴 색을 차례로 준다
    out.rooms.forEach(r => {
      if (r.color >= 0) return;
      const used = out.rooms.map(x => x.color);
      let c = 0; while (c < COLORS - 1 && used.indexOf(c) >= 0) c++;
      r.color = c;
    });
    out.purposes = (Array.isArray(raw.purposes) ? raw.purposes : DEFAULTS.purposes).map(p => str(p, 12)).filter(Boolean);
    out.purposes = out.purposes.filter((p, i) => out.purposes.indexOf(p) === i);
    if (!out.purposes.length) out.purposes = DEFAULTS.purposes.slice();
    const h = raw.hours || {};
    const open = int(h.open, 0, 23, DEFAULTS.hours.open);
    const close = (v, d) => { v = int(v, 0, 24, d); return v > open ? v : 0; };
    out.hours = { open, weekday: close(h.weekday, DEFAULTS.hours.weekday), saturday: close(h.saturday, DEFAULTS.hours.saturday), sunday: close(h.sunday, DEFAULTS.hours.sunday) };
    out.limitMonths = int(raw.limitMonths, 1, 12, DEFAULTS.limitMonths);
    const names = new Set();
    out.staff = (Array.isArray(raw.staff) ? raw.staff : []).map(s => ({ name: str(s && s.name, 12), admin: !!(s && s.admin) }))
      .filter(s => s.name && !names.has(s.name) && names.add(s.name));
    return out;
  }

  /* ---------- 날짜 ---------- */
  const pad = n => (n < 10 ? '0' : '') + n;
  const fmt = t => t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) return null;
    const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3] ? t : null;
  }
  function nowKST(ms) {
    const d = new Date((ms == null ? Date.now() : ms) + 9 * 3600000);
    return { date: fmt(d), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
             stamp: fmt(d) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) };
  }
  const addDays = (s, n) => { const t = parseDate(s); t.setUTCDate(t.getUTCDate() + n); return fmt(t); };
  const weekday = s => parseDate(s).getUTCDay();               // 0 = 일요일
  const ymOf = s => String(s).slice(0, 7);
  function addMonths(ym, n) {
    const p = ym.split('-'); const t = new Date(Date.UTC(+p[0], +p[1] - 1 + n, 1));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1);
  }
  /* n달 뒤 같은 날짜. 그 달에 없는 날이면 말일 (1월 31일 → 2월 28일) */
  function monthsLater(s, n) {
    const t = parseDate(s), y = t.getUTCFullYear(), m = t.getUTCMonth() + n, d = t.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return fmt(new Date(Date.UTC(y, m, Math.min(d, last))));
  }
  /* 달력 한 달: 일요일부터 시작하는 주 단위 날짜 배열 */
  function monthGrid(ym) {
    const first = ym + '-01', start = addDays(first, -weekday(first)), weeks = [];
    for (let w = 0; w < 6; w++) {
      const row = [];
      for (let i = 0; i < 7; i++) row.push(addDays(start, w * 7 + i));
      if (w > 0 && ymOf(row[0]) !== ym) break;
      weeks.push(row);
    }
    return weeks;
  }
  /* 그 날짜가 들어 있는 주(일~토) 가운데 문 여는 날만 */
  function weekDates(st, s) {
    const start = addDays(s, -weekday(s)), out = [];
    for (let i = 0; i < 7; i++) { const d = addDays(start, i); if (closeHour(st, d) > 0) out.push(d); }
    return out;
  }

  /* ---------- 운영 시간·예약 가능 여부 ---------- */
  function closeHour(st, date) { const w = weekday(date), h = st.hours; return w === 0 ? h.sunday : w === 6 ? h.saturday : h.weekday; }
  function dayHours(st, date) { const a = []; for (let h = st.hours.open, c = closeHour(st, date); h < c; h++) a.push(h); return a; }
  function gridHours(st) { const a = [], c = Math.max(st.hours.weekday, st.hours.saturday, st.hours.sunday, st.hours.open + 1); for (let h = st.hours.open; h < c; h++) a.push(h); return a; }
  const roomById = (st, id) => st.rooms.find(r => r.id === id) || null;
  const lastDate = (st, now) => monthsLater(now.date, st.limitMonths);
  /* 끝난 시간인가 (진행 중인 시간은 아직 예약·취소할 수 있다) */
  const ended = (date, endHour, now) => date < now.date || (date === now.date && endHour <= now.hour);

  /* 한 칸(한 시간)의 상태: ok / closed(운영 시간 아님) / past(지난 시간) / far(예약 가능 기간 밖) */
  function slotStatus(st, date, hour, roomId, now) {
    if (!parseDate(date) || dayHours(st, date).indexOf(hour) < 0) return 'closed';
    if (ended(date, hour + 1, now)) return 'past';
    const room = roomById(st, roomId);
    if (room && room.limited && date > lastDate(st, now)) return 'far';
    return 'ok';
  }
  function limitText(st) { return (st.limitMonths === 1 ? '한 달' : st.limitMonths + '달') + ' 뒤 같은 날짜까지만 예약할 수 있습니다.'; }
  /* 조사 고르기: 받침이 있으면 a, 없으면 b (숫자로 끝나면 읽는 소리 기준) */
  function josa(word, a, b) {
    const ch = String(word).slice(-1), code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) return (code - 0xAC00) % 28 ? a : b;
    if (ch >= '0' && ch <= '9') return '013678'.indexOf(ch) >= 0 ? a : b;
    return a;
  }

  const overlap = (a, b) => a.date === b.date && a.room === b.room && a.start < b.end && b.start < a.end;
  function conflict(items, b, ignoreId) { return items.find(x => x.id !== ignoreId && overlap(x, b)) || null; }

  /* 예약 하나가 규칙에 맞는지. 맞으면 '', 아니면 사용자에게 보여 줄 말.
     loose = true면 지난 시간·예약 가능 기간은 보지 않는다(기존 예약을 옮겨 올 때). */
  function check(st, items, b, now, ignoreId, loose) {
    if (!parseDate(b.date)) return '날짜가 올바르지 않습니다.';
    const room = roomById(st, b.room);
    if (!room) return '방을 골라 주세요.';
    if (!Number.isInteger(b.start) || !Number.isInteger(b.end) || b.end <= b.start) return '시간을 다시 골라 주세요.';
    if (st.purposes.indexOf(b.purpose) < 0) return '용도를 골라 주세요.';
    if (!b.owner) return '예약자 이름이 없습니다.';
    const hours = dayHours(st, b.date);
    if (!hours.length) return '쉬는 날에는 예약할 수 없습니다.';
    if (b.start < hours[0] || b.end > hours[hours.length - 1] + 1) return '운영 시간(' + hours[0] + '시~' + (hours[hours.length - 1] + 1) + '시) 안에서 골라 주세요.';
    if (!loose && ended(b.date, b.start + 1, now)) return '이미 지난 시간은 예약할 수 없습니다.';
    if (!loose && room.limited && b.date > lastDate(st, now)) return room.name + josa(room.name, '은 ', '는 ') + limitText(st);
    const c = conflict(items, b, ignoreId);
    if (c) return '이미 예약이 있습니다: ' + c.start + '~' + c.end + '시 ' + c.owner;
    return '';
  }

  const byTime = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0));

  /* 같은 사람이 같은 방을 같은 용도로 이어서 쓰는 예약을 한 덩어리로 묶는다.
     화면에 보이는 한 칸이자 취소·변경의 단위다. → [{ date, room, owner, purpose, start, end, items:[원래 예약…] }] */
  function groups(items) {
    const out = [];
    items.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.room < b.room ? -1 : a.room > b.room ? 1 : a.start - b.start)).forEach(b => {
      const g = out[out.length - 1];
      if (g && g.date === b.date && g.room === b.room && g.owner === b.owner && g.purpose === b.purpose && g.end === b.start) { g.end = b.end; g.items.push(b); }
      else out.push({ date: b.date, room: b.room, owner: b.owner, purpose: b.purpose, start: b.start, end: b.end, items: [b] });
    });
    return out.sort(byTime);
  }
  /* 시(정수) 목록을 이어진 구간으로: [13,14,16] → [[13,15],[16,17]] */
  function runs(hours) {
    const out = [];
    hours.slice().sort((a, b) => a - b).forEach(h => { const r = out[out.length - 1]; if (r && r[1] === h) r[1] = h + 1; else out.push([h, h + 1]); });
    return out;
  }

  function newId() {
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    return Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
  }

  return { DEFAULTS, normalize, pad, parseDate, nowKST, addDays, weekday, ymOf, addMonths, monthsLater, monthGrid, weekDates,
           closeHour, dayHours, gridHours, roomById, lastDate, ended, slotStatus, limitText, josa, overlap, conflict, check, byTime, groups, runs, newId, COLORS };
})();
if (typeof module !== 'undefined') module.exports = Core;
