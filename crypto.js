/* 잠금 파일(lock.json) 만들기·열기.
   공용 비밀번호로 만든 열쇠(PBKDF2-SHA256)로 접속 정보를 암호화(AES-256-GCM)한다.
   비밀번호가 틀리면 풀리지 않으므로, 잠금 파일은 공개된 곳에 두어도 된다. */
'use strict';
const Lock = (() => {
  const ITER = 600000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = buf => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = s => { const bin = atob(String(s)); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
  const clean = pw => String(pw || '').normalize('NFC').trim();

  async function deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(clean(password)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function create(password, payload) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, ITER);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  }

  /* 비밀번호가 틀리면 code = 'bad-password' 오류 */
  async function open(password, lock) {
    const bad = () => { const e = new Error('bad-password'); e.code = 'bad-password'; return e; };
    if (!lock || lock.v !== 1 || !(lock.iter >= 100000 && lock.iter <= 5000000)) { const e = new Error('bad-lock'); e.code = 'bad-lock'; throw e; }
    let pt;
    try {
      const key = await deriveKey(password, unb64(lock.salt), lock.iter);
      pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(lock.iv) }, key, unb64(lock.ct));
    } catch (e) { throw bad(); }
    try { return JSON.parse(dec.decode(pt)); } catch (e) { throw bad(); }
  }

  /* 비밀번호 규칙: 맞으면 '', 아니면 이유 */
  function weakness(password) {
    const p = clean(password);
    if (p.length < 10) return '10자 이상으로 정해 주세요.';
    if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return '영문과 숫자를 섞어 주세요.';
    if (/^(.)\1+$/.test(p)) return '같은 글자만 반복하면 안 됩니다.';
    return '';
  }

  /* 읽고 받아 적기 쉬운 무작위 비밀번호 (예: tami-kovu-reso-27) */
  function suggest() {
    const C = 'bdfghjkmnprstvz', V = 'aeiou';
    const pick = s => { const a = new Uint32Array(1); let x; do { crypto.getRandomValues(a); x = a[0]; } while (x >= 4294967296 - (4294967296 % s.length)); return s[x % s.length]; };
    const word = () => pick(C) + pick(V) + pick(C) + pick(V);
    return word() + '-' + word() + '-' + word() + '-' + pick('23456789') + pick('0123456789');
  }

  return { create, open, weakness, suggest, clean };
})();
