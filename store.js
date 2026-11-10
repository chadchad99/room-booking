/* 자료 저장 — 비공개 깃허브 저장소의 파일을 읽고 쓴다.
   settings.json        방·운영 시간·직원 명단
   bookings/2026-11.json  그 달의 예약 { v, rev, items:[{ id, date, start, end, room, purpose, owner, at, series? }] }
   저장할 때마다 깃허브에 변경 기록(커밋)이 남는다. */
'use strict';

class StoreError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || 0; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const Utf8 = {
  toB64(s) { const a = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < a.length; i += 0x8000) bin += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(bin); },
  fromB64(s) { const bin = atob(String(s).replace(/\s/g, '')); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new TextDecoder().decode(a); }
};

class GitHubStore {
  constructor(cfg) {
    if (!cfg || !cfg.token || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo || '')) throw new StoreError('config', '접속 정보가 올바르지 않습니다.');
    this.token = cfg.token; this.repo = cfg.repo; this.branch = cfg.branch || 'main';
    // 시험용 서버(/mockapi)는 내 PC(localhost)에서만 쓴다
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^\/[\w/-]*$/.test(cfg.api || '');
    this.api = local ? cfg.api.replace(/\/+$/, '') : 'https://api.github.com';
    this.cache = new Map();   // path → { data, sha, etag, wroteAt }
  }

  url(path) { return this.api + '/repos/' + this.repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/'); }

  async call(method, url, body, etag) {
    const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + this.token, 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try {
      return await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ctl.signal });
    } catch (e) {
      throw new StoreError('network', e.name === 'AbortError' ? '응답이 너무 늦습니다. 잠시 후 다시 해 주세요.' : '인터넷 연결을 확인해 주세요.');
    } finally { clearTimeout(timer); }
  }
  req(method, path, body, etag) {
    return this.call(method, this.url(path) + (method === 'GET' ? '?ref=' + encodeURIComponent(this.branch) : ''), body, etag);
  }
  /* 저장소에 닿는지 확인 → HTTP 상태 (200이면 정상, 401 열쇠 문제, 404 저장소 없음·권한 없음) */
  async ping() { return (await this.call('GET', this.api + '/repos/' + this.repo)).status; }

  async fail(res) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch (e) { /* 본문 없음 */ }
    const s = res.status;
    if (s === 401) return new StoreError('auth', '접속 열쇠가 만료되었거나 바뀌었습니다. 비밀번호를 다시 넣어 주세요.', s);
    if (s === 429 || (s === 403 && (res.headers.get('X-RateLimit-Remaining') === '0' || res.headers.get('Retry-After') || /rate limit/i.test(msg))))
      return new StoreError('rate', '요청이 몰려 잠시 막혔습니다. 1~2분 뒤에 다시 해 주세요.', s);
    if (s === 403) return new StoreError('forbidden', '접속 열쇠에 이 저장소를 쓸 권한이 없습니다.', s);
    if (s === 404) return new StoreError('notfound', '자료 저장소를 찾을 수 없습니다.', s);
    if (s >= 500) return new StoreError('server', '깃허브 서버에 일시적인 문제가 있습니다. 잠시 후 다시 해 주세요.', s);
    return new StoreError('error', '저장소 오류가 생겼습니다. (' + s + ')', s);
  }

  /* 파일 읽기. 없으면 data = null. 바뀌지 않았으면 가지고 있던 것을 그대로 돌려준다. */
  async get(path) {
    const c = this.cache.get(path);
    const res = await this.req('GET', path, null, c && c.etag);
    if (res.status === 304 && c) return c;
    const fresh = c && c.wroteAt && Date.now() - c.wroteAt < 15000;   // 방금 내가 쓴 파일
    if (res.status === 404) {
      if (fresh && c.data) return c;                                   // 쓰자마자 '없음'이 오면 늦게 온 응답으로 본다
      const v = { data: null, sha: null, etag: null };
      this.cache.set(path, v); return v;
    }
    if (!res.ok) throw await this.fail(res);
    let data, json;
    try { json = await res.json(); data = JSON.parse(Utf8.fromB64(json.content)); }
    catch (e) { throw new StoreError('data', '저장된 자료(' + path + ')를 읽을 수 없습니다. 관리자에게 알려 주세요.'); }
    if (fresh && c.data && (c.data.rev || 0) > ((data && data.rev) || 0)) return c;   // 내가 쓴 것보다 오래된 응답
    const v = { data, sha: json.sha, etag: res.headers.get('ETag') };
    this.cache.set(path, v); return v;
  }

  async put(path, data, sha, message) {
    const body = { message, content: Utf8.toB64(JSON.stringify(data, null, 1) + '\n'), branch: this.branch };
    if (sha) body.sha = sha;
    const res = await this.req('PUT', path, body);
    if (res.status === 409 || res.status === 422) throw new StoreError('conflict', '다른 사람이 먼저 저장했습니다.', res.status);
    if (!res.ok) throw await this.fail(res);
    const json = await res.json();
    const v = { data, sha: json.content.sha, etag: null, wroteAt: Date.now() };
    this.cache.set(path, v); return v;
  }

  async remove(path, sha, message) {
    const res = await this.req('DELETE', path, { message, sha, branch: this.branch });
    if (!res.ok && res.status !== 404) throw await this.fail(res);
    this.cache.delete(path);
  }

  /* 최신 내용을 읽어 fn으로 고친 뒤 저장한다. 그 사이 다른 사람이 저장했으면 다시 읽어서 되풀이한다.
     fn(현재 내용 또는 null) → 새 내용. undefined를 돌려주면 저장하지 않는다. 규칙에 어긋나면 fn이 오류를 던진다. */
  async mutate(path, fn, message) {
    for (let i = 0; i < 6; i++) {
      const cur = await this.get(path);
      const next = fn(cur.data ? JSON.parse(JSON.stringify(cur.data)) : null);
      if (next === undefined) return cur;
      next.rev = ((cur.data && cur.data.rev) || 0) + 1;
      try { return await this.put(path, next, cur.sha, typeof message === 'function' ? message() : message); }
      catch (e) {
        if (e.code !== 'conflict') throw e;
        const c = this.cache.get(path); if (c) c.etag = null;          // 다음에는 조건 없이 새로 읽는다
        await sleep(200 + Math.random() * 300 * (i + 1));
      }
    }
    throw new StoreError('busy', '지금 저장하는 사람이 많습니다. 잠시 후 다시 해 주세요.');
  }
}

/* ---------- 예약 자료 ---------- */
const Data = {
  store: null,
  settings: Core.normalize(null),
  hasSettings: false,

  path: ym => 'bookings/' + ym + '.json',
  items: v => (v && v.data && Array.isArray(v.data.items) ? v.data.items : []),
  group(list) { const m = new Map(); list.forEach(b => { const ym = Core.ymOf(b.date); if (!m.has(ym)) m.set(ym, []); m.get(ym).push(b); }); return m; },
  describe(list) {
    const b = list[0]; if (!b) return '';
    const room = Core.roomById(this.settings, b.room);
    const one = (+b.date.slice(5, 7)) + '/' + (+b.date.slice(8)) + '(' + '일월화수목금토'[Core.weekday(b.date)] + ') ' + b.start + '~' + b.end + '시 ' + (room ? room.name : b.room);
    return list.length > 1 ? list.length + '건 (' + one + ' 등)' : one;
  },

  async loadSettings() {
    const v = await this.store.get('settings.json');
    this.hasSettings = !!v.data;
    this.settings = Core.normalize(v.data);
    return this.settings;
  },
  async saveSettings(next, who) {
    const doc = Object.assign(Core.normalize(next), { updated: Core.nowKST().stamp, updatedBy: who });
    const v = await this.store.mutate('settings.json', () => JSON.parse(JSON.stringify(doc)), '설정 바꿈 · ' + who);
    this.hasSettings = true;
    this.settings = Core.normalize(v.data);
    return this.settings;
  },

  async month(ym) { return this.items(await this.store.get(this.path(ym))); },
  /* 이미 읽어 둔 내용 (없으면 null) — 저장 직후 화면에 바로 반영할 때 쓴다 */
  cached(ym) { const v = this.store && this.store.cache.get(this.path(ym)); return v ? this.items(v) : null; },
  sha(path) { const v = this.store && this.store.cache.get(path); return v ? (v.sha || '-') + ':' + ((v.data && v.data.rev) || 0) : ''; },

  /* 예약 넣기. 규칙에 걸리는 것은 빼고 넣는다 → { added, skipped:[{ b, why }] }
     loose: 지난 날짜·기간 제한을 보지 않는다(기존 예약을 옮겨 올 때만 쓴다). */
  async add(list, who, loose) {
    const added = [], skipped = [];
    for (const [ym, group] of this.group(list)) {
      let ok = [], no = [];
      await this.store.mutate(this.path(ym), cur => {
        const doc = cur && Array.isArray(cur.items) ? cur : { v: 1, items: [] };
        const now = Core.nowKST();
        ok = []; no = [];
        group.forEach(b => { const why = Core.check(this.settings, doc.items, b, now, null, !!loose); if (why) no.push({ b, why }); else { doc.items.push(b); ok.push(b); } });
        if (!ok.length) return undefined;
        doc.items.sort(Core.byTime);
        return doc;
      }, () => (loose ? '옮겨 옴 ' : '예약 ') + this.describe(ok) + ' · ' + who);
      added.push(...ok); skipped.push(...no);
    }
    return { added, skipped };
  },

  /* 예약 취소 → 실제로 지운 건수 */
  async cancel(list, who) {
    let n = 0;
    for (const [ym, group] of this.group(list)) {
      const ids = new Set(group.map(b => b.id)); let gone = [];
      await this.store.mutate(this.path(ym), cur => {
        gone = cur && Array.isArray(cur.items) ? cur.items.filter(x => ids.has(x.id)) : [];
        if (!gone.length) return undefined;
        cur.items = cur.items.filter(x => !ids.has(x.id));
        return cur;
      }, () => '취소 ' + this.describe(gone) + ' · ' + who);
      n += gone.length;
    }
    return n;
  },

  /* 반복 예약에서 이 날짜부터 뒤의 것을 모두 취소 → 지운 건수 */
  async cancelSeries(b, who) {
    let n = 0;
    for (let i = 0, ym = Core.ymOf(b.date); i < 4; i++, ym = Core.addMonths(ym, 1)) {
      let gone = [];
      await this.store.mutate(this.path(ym), cur => {
        const now = Core.nowKST();
        const hit = x => x.series && x.series === b.series && x.owner === b.owner && x.date >= b.date && !Core.ended(x.date, x.end, now);
        gone = cur && Array.isArray(cur.items) ? cur.items.filter(hit) : [];
        if (!gone.length) return undefined;
        cur.items = cur.items.filter(x => !hit(x));
        return cur;
      }, () => '취소 ' + this.describe(gone) + ' · ' + who);
      n += gone.length;
    }
    return n;
  },

  /* 예약 바꾸기 (날짜·시간·방·용도). next는 같은 id를 가진 새 내용 */
  async change(old, next, who) {
    const rule = why => new StoreError('rule', why);
    const gone = () => new StoreError('gone', '이미 취소된 예약입니다.');
    const msg = () => '변경 ' + this.describe([old]) + ' → ' + this.describe([next]) + ' · ' + who;
    if (Core.ymOf(old.date) === Core.ymOf(next.date)) {
      await this.store.mutate(this.path(Core.ymOf(old.date)), cur => {
        const i = cur && Array.isArray(cur.items) ? cur.items.findIndex(x => x.id === old.id) : -1;
        if (i < 0) throw gone();
        const why = Core.check(this.settings, cur.items, next, Core.nowKST(), old.id);
        if (why) throw rule(why);
        cur.items[i] = next; cur.items.sort(Core.byTime);
        return cur;
      }, msg);
      return;
    }
    const cur = await this.month(Core.ymOf(old.date));
    if (!cur.some(x => x.id === old.id)) throw gone();
    const r = await this.add([next], who);
    if (!r.added.length) throw rule(r.skipped[0].why);
    await this.cancel([old], who);
  }
};
