(function () {
  'use strict';
  const account = document.querySelector('meta[name="reader-account"]').content;
  const bar = document.createElement('div');
  bar.className = 'reader-account-bar';
  const link = document.createElement('a'); link.href = '/account'; link.textContent = 'Hesabım ve yerel kayıt aktarımı';
  const exit = document.createElement('button'); exit.type = 'button'; exit.textContent = 'Çıkış yap';
  bar.append(link, exit); document.body.prepend(bar);
  const cover = document.createElement('div'); cover.className = 'reader-session-cover'; cover.hidden = true;
  const text = document.createElement('p');
  const back = document.createElement('a'); back.href = '/account'; back.textContent = 'Hesabıma git';
  const retry = document.createElement('button'); retry.textContent = 'Yeniden kontrol et';
  cover.append(text, retry, back); document.body.append(cover);
  let channel; try { channel = new BroadcastChannel('reader-account-session'); } catch {}
  function lock(message) {
    cover.hidden = false; text.textContent = message;
    for (const element of document.body.children) if (element !== cover) element.inert = true;
  }
  function unlock() {
    for (const element of document.body.children) if (element !== cover) element.inert = false;
    cover.hidden = true;
  }
  let checking;
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401) { lock('Oturum sona erdi. Yerel kayıtlarınız korunur; yeniden giriş yapın.'); return; }
        if (!response.ok) throw Error();
        const data = await response.json();
        if (data.user.id !== account) { lock('Bu tarayıcıda hesap değişti. Doğru kitaplığı açmak için hesabınıza dönün.'); return; }
        if (!data.membership.active) { lock('Uygulamaya erişiminiz aktif değil. Yerel kayıtlarınız korunur.'); return; }
        unlock();
      } catch { lock('Hesap doğrulanamadı. İnternet bağlantınızı kontrol edin. Yerel kayıtlarınız silinmedi.'); }
    })().finally(() => { checking = null; });
    return checking;
  }
  exit.addEventListener('click', async () => {
    lock('Çıkış yapılıyor…');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw Error();
      channel?.postMessage('changed'); location.replace('/account');
    } catch { lock('Çıkış tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin veya hesabım sayfasına gidin.'); }
  });
  retry.addEventListener('click', check);
  channel?.addEventListener('message', () => { lock('Hesap oturumu değişti.'); check(); });
  window.addEventListener('pageshow', () => { lock('Hesap kontrol ediliyor…'); check(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lock('Hesap kontrol ediliyor…'); check(); } });
  window.addEventListener('online', check);
  setInterval(check, 60000);
})();
