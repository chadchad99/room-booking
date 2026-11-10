/* 관리자 설정 — 접속 열쇠를 확인하고, 공용 비밀번호로 잠근 lock.json 내용을 만든다.
   열쇠와 비밀번호는 이 브라우저 안에서만 쓰이고 저장하지 않는다. */
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  // 깃허브 페이지 주소(계정.github.io/저장소/)에서 저장소 이름을 짐작한다
  const host = /^([\w-]+)\.github\.io$/.exec(location.hostname);
  const first = location.pathname.split('/').filter(Boolean)[0] || '';
  const siteRepo = host && first && !/\.html$/.test(first) ? host[1] + '/' + first : '';
  if (siteRepo) $('#repo').value = siteRepo + '-data';
  else if (local) $('#repo').value = 'dev/room-booking-data';

  const say = (text, info) => { const m = $('#msg'); m.textContent = text || ''; m.className = 'msg' + (info ? ' info' : ''); };

  $('#show').addEventListener('change', e => { $('#pw1').type = $('#pw2').type = e.target.checked ? 'text' : 'password'; });
  $('#suggest').addEventListener('click', () => {
    const p = Lock.suggest();
    $('#pw1').value = p; $('#pw2').value = p;
    $('#show').checked = true; $('#pw1').type = $('#pw2').type = 'text';
    say('추천 비밀번호를 넣었습니다. 잊지 않게 따로 적어 두세요.', true);
  });

  $('#f').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#make');
    if (btn.disabled) return;
    const repo = $('#repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const token = $('#token').value.trim(), pw = $('#pw1').value, pw2 = $('#pw2').value;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return say('자료 저장소를 "계정이름/저장소이름" 모양으로 적어 주세요.');
    if (!token) return say('접속 열쇠를 붙여 넣어 주세요.');
    const weak = Lock.weakness(pw);
    if (weak) return say('비밀번호: ' + weak);
    if (Lock.clean(pw) !== Lock.clean(pw2)) return say('비밀번호 두 칸이 서로 다릅니다.');

    btn.disabled = true; $('#result').hidden = true;
    try {
      say('접속 열쇠를 확인하는 중…', true);
      const cfg = { token, repo, branch: 'main' };
      if (local) cfg.api = '/mockapi';
      let store = new GitHubStore(cfg);
      const res = await store.call('GET', store.api + '/repos/' + repo);
      if (res.status === 401) return say('접속 열쇠가 올바르지 않습니다. 만료되었거나 일부만 복사된 것 같습니다.');
      if (res.status === 404) return say('이 열쇠로는 저장소 ' + repo + '에 닿지 않습니다. 저장소 이름과, 열쇠를 만들 때 이 저장소를 골랐는지 확인해 주세요.');
      if (!res.ok) throw await store.fail(res);
      const info = await res.json();
      if (info.default_branch && info.default_branch !== cfg.branch) { cfg.branch = info.default_branch; store = new GitHubStore(cfg); }

      say('읽고 쓸 수 있는지 확인하는 중…', true);
      try {
        const v = await store.mutate('check.json', () => ({ checked: Core.nowKST().stamp }), '설정 확인');
        await store.remove('check.json', v.sha, '설정 확인 끝');
      } catch (err) {
        if (err.code === 'forbidden') return say('읽기만 되고 쓰기가 안 됩니다. 열쇠 권한에서 Contents를 Read and write로 바꿔 다시 만들어 주세요.');
        throw err;
      }
      const cur = await store.get('settings.json');
      if (!cur.data) await store.put('settings.json', Object.assign(Core.normalize(null), { rev: 1 }), null, '처음 설정');

      say('잠금 파일을 만드는 중…', true);
      const text = JSON.stringify(await Lock.create(pw, cfg));
      await Lock.open(pw, JSON.parse(text));      // 다시 열리는지 확인
      $('#out').value = text;
      $('#result').hidden = false;
      $('#token').value = '';      // 열쇠는 지우고, 비밀번호는 적어 둘 수 있게 칸에 남겨 둔다
      say('');
      if (siteRepo) {
        let exists = false;
        try { exists = (await fetch('lock.json', { cache: 'no-store' })).ok; } catch (err) { /* 모르면 새 파일로 */ }
        const a = $('#gh');
        a.href = 'https://github.com/' + siteRepo + (exists ? '/edit/main/lock.json' : '/new/main?filename=lock.json&value=' + encodeURIComponent(text));
        a.hidden = false;
      }
      $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      say((err && err.message) || '알 수 없는 오류가 생겼습니다.');
      if (!(err instanceof StoreError)) console.error(err);
    } finally { btn.disabled = false; }
  });

  $('#copy').addEventListener('click', async () => {
    const out = $('#out');
    try { await navigator.clipboard.writeText(out.value); }
    catch (err) { out.focus(); out.select(); try { document.execCommand('copy'); } catch (e2) { /* 직접 복사 */ } }
    $('#copy').textContent = '복사했습니다';
    setTimeout(() => { $('#copy').textContent = '복사'; }, 2000);
  });
})();
