(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const modes = {
    login: ['Hesabına giriş yap', 'Giriş yap', true, false],
    signup: ['Hesap oluştur', 'Doğrulama kodu gönder', true, false],
    confirm: ['E-posta adresini doğrula', 'Doğrula ve giriş yap', false, true],
    recover: ['Şifreni yenile', 'Yenileme kodu gönder', false, false],
    reset: ['Yeni şifreni belirle', 'Şifreyi yenile', true, true]
  };
  let mode = 'login', currentUser = null;
  let channel;
  try { channel = new BroadcastChannel('reader-account-session'); } catch {}
  function notify() { channel?.postMessage('changed'); }
  function message(text, error = false) { $('message').textContent = text; $('message').dataset.error = String(error); }
  function showMode(next) {
    mode = next;
    const [heading, submit, hasPassword, hasCode] = modes[mode];
    $('heading').textContent = heading; $('submit').textContent = submit;
    $('passwordField').hidden = !hasPassword; $('password').disabled = !hasPassword;
    $('password').required = hasPassword; $('password').value = '';
    $('password').minLength = ['signup', 'reset'].includes(mode) ? 12 : 1;
    $('password').autocomplete = ['signup', 'reset'].includes(mode) ? 'new-password' : 'current-password';
    $('codeField').hidden = !hasCode; $('code').required = hasCode; $('code').disabled = !hasCode; $('code').value = '';
  }
  async function api(path, data) {
    const response = await fetch('/api/auth/' + path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error || 'İşlem tamamlanamadı.'), { status: response.status });
    return result;
  }
  async function loadUser() {
    try {
      const data = await api('me'); currentUser = data.user;
      $('authForm').hidden = true; $('authModes').hidden = true; $('signedIn').hidden = false;
      $('heading').textContent = 'Kitaplığına hoş geldin'; $('identity').textContent = data.user.email;
      $('membership').textContent = data.membership.active ? 'Uygulamaya erişiminiz aktif.' : 'Uygulamaya erişiminiz şu anda aktif değil. Yerel kayıtlarınız korunur. Üyelik için site yöneticisiyle iletişime geçin.';
      $('openReader').hidden = !data.membership.active;
      return true;
    } catch (error) {
      currentUser = null;
      $('authForm').hidden = false; $('authModes').hidden = false; $('signedIn').hidden = true;
      if (error.status !== 401) message(error.message, true);
      return false;
    }
  }
  $('authModes').addEventListener('click', event => { const next = event.target.dataset.mode; if (modes[next]) { showMode(next); message(''); } });
  $('authForm').addEventListener('submit', async event => {
    event.preventDefault(); $('submit').disabled = true; message('İşlem yapılıyor…');
    const email = $('email').value.trim(), password = $('password').value, code = $('code').value.trim();
    try {
      const data = { email, ...(modes[mode][2] ? { password } : {}), ...(modes[mode][3] ? { code } : {}) };
      const result = await api(mode, data);
      $('password').value = ''; $('code').value = '';
      if (mode === 'signup') { showMode('confirm'); message(result.message); }
      else if (mode === 'recover') { showMode('reset'); message(result.message); }
      else if (mode === 'reset') { notify(); showMode('login'); message(result.message); }
      else { notify(); message(''); await loadUser(); }
    } catch (error) { message(error.message || 'Bağlantı kurulamadı. Tekrar deneyin.', true); }
    finally { $('submit').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    $('logout').disabled = true;
    try { await api('logout', {}); notify(); location.replace('/account'); }
    catch (error) { message(error.message, true); $('logout').disabled = false; }
  });
  $('transferConsent').addEventListener('change', () => { $('transfer').disabled = !$('transferConsent').checked; });
  $('transfer').addEventListener('click', async () => {
    if (!currentUser || !$('transferConsent').checked) return;
    $('transfer').disabled = true; $('openReader').hidden = true;
    try {
      // Recheck server identity before assigning any legacy local records.
      const live = await api('me');
      if (live.user.id !== currentUser.id) throw Error('Hesap değişti. Sayfayı yenileyin.');
      const count = await window.createReaderStorage(currentUser.id).importLegacy();
      $('transferStatus').textContent = `${count} yerel kayıt kopyalandı. Eski kayıtlar korundu. Kitaplığı açabilirsiniz.`;
    } catch (error) { $('transferStatus').textContent = 'Aktarım tamamlanamadı: ' + error.message + ' Eski kayıtlar silinmedi; yeniden deneyebilirsiniz.'; }
    finally { $('transfer').disabled = !$('transferConsent').checked; await loadUser(); }
  });
  channel?.addEventListener('message', () => location.reload());
  if (new URLSearchParams(location.search).has('expired')) message('Oturumunuz sona erdi. Yeniden giriş yapın. Yerel kayıtlarınız korunur.');
  loadUser();
})();
