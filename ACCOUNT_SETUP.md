# Yerel kitaplık + hesap erişimi

## Kapsam

Sunucuda sadece Supabase Auth hesabı ve `reader_memberships` erişim kaydı tutulur.
Kitap, kelime, not, vurgu ve okuma konumu için bulut tablosu/API'si yoktur.
Mevcut çeviri servisleri çevrilecek metni almaya devam eder. Bu, hesap hizmetinden ayrıdır.

Hesap, e-posta + şifreyle açılır. Oturum çerezleri Secure, HttpOnly, SameSite=Lax'tır;
şifre/erişim/yenileme belirteci localStorage içine yazılmaz. Her okuyucu isteğinde sunucu
Supabase üzerinden kullanıcıyı ve RLS korumalı üyeliği doğrular. Pasif veya süresi dolmuş
üyelik okuyucuyu açamaz. Açık sayfa her 60 saniyede ve görünür olduğunda kontrol edilir.
Giriş internet gerektirir; bağlantı yoksa erişim kontrolü kapalı kalır. Yerel veriler silinmez.

## Supabase kurulumu (ücretsiz proje yeterli olabilir)

1. Kullanıcıya ait Supabase projesi oluşturun; e-posta doğrulamayı açık tutun.
2. `supabase/migrations/001_memberships.sql` dosyasını bir kez uygulayın.
3. Auth Site URL: `https://kitaplik.ikodynamics.com`. Gerekli yönlendirme listesine aynı adresi ekleyin.
4. Auth e-posta şablonlarında **Confirm signup** ve **Reset password** için kod gösterin:
   `<p>Üç Dilli Kitaplık doğrulama kodunuz: <strong>{{ .Token }}</strong></p>`.
   Bu uygulama bağlantı/URL içindeki oturum token'larını kabul etmez; kullanıcı kodu forma girer.
5. Üretim e-postası için kendi gönderici/SMTP ayarlarını doğrulayın. Sağlayıcının varsayılan
   test e-posta hizmetinin tüm müşterilere gönderim için yeterli olduğunu varsaymayın.
6. Proje URL'si ve publishable key alın. **service_role/secret anahtarı gerekmez ve kullanılmaz.**
7. Cloudflare Worker ortamına `SUPABASE_URL` ve `SUPABASE_PUBLISHABLE_KEY` değerlerini ekleyin.
   İkisini de Worker secret olarak saklayabilirsiniz. Değerleri Git'e veya sohbet mesajına koymayın.
8. Yeni kayıtlar başlangıçta davetle kapalıdır. Supabase üzerinden test hesapları oluşturun.
   Kullanıcıların kendi kayıtlarını açması isteniyorsa test sonrasında `ALLOW_SIGNUP=true` yapın.
   Yeni üyelikler başlangıçta ücretsiz ve aktiftir; ödeme/abonelik henüz yoktur.

## Yayına alma

`AUTH_ENABLED=false` varsayılanı mevcut okuyucuyu korur. **Bu durumda giriş koruması yoktur.**
Yapılandırma ve testler tamamlandığında `wrangler.jsonc` içindeki değeri `true` yapıp yayınlayın.
Dashboard'da değiştirilen `vars` değerleri sonraki Wrangler yayınıyla değişebileceğinden
yayın kaynağını da güncelleyin. Etkin modda eksik Supabase ayarı okuyucuyu açmaz (503).
`assets.run_worker_first=true` kritik: reader.html/legacy.html gibi dosyalara doğrudan
istek de aynı kapıdan geçer. Üretim dışı bir Worker ve ayrı test hesaplarıyla doğrulayın.
Preview Worker kullanıcıları birbirinden ayırsa da aynı üretim Supabase projesine bağlamayın.

Doğrulama: kayıt → kodla doğrulama → giriş → okuyucu → çıkış → şifre yenileme.
İki ayrı hesapla yerel kayıtların görünmediğini, pasif üyeliğin açılmadığını,
doğrudan reader.html/legacy.html erişiminin engellendiğini kontrol edin.
Node kontrolleri: `node --test tests/*.test.mjs`; build: `node scripts/build-site.cjs`.

Cloudflare AUTH_LIMITER her Cloudflare konumunda IP başına yaklaşık 60 saniyede 10 hesap değişikliği isteği sınırlar.
Supabase'in kendi hız sınırlarını da koruyun. Ortak ağdaki kullanıcılar bu kotayı paylaşır.

## Veriler ve mevcut kayıtlar

Üç mevcut IndexedDB veritabanı ve tüm okuyucu localStorage anahtarları UUID bazlı hesap
alanına yönlendirilir. Oturum değiştirirken uygulama tam sayfa yeniden açılır; bellekteki
veriler başka hesaba geçirilmez. Çıkış, yerel kayıtları silmez. Ortak cihazda işletim sistemi
ve tarayıcı profiline erişebilen kişi bu dosyaları okuyabilir: bu yöntem disk şifreleme değildir.

Hesabım sayfasındaki açık onayla aynı origin'deki eski kayıtlar hesaba **kopyalanır**.
Mevcut hedef kayıtların üzerine yazılmaz. Kaynak kayıtlar korunur. Bir tarayıcıdaki eski
alan yalnızca ilk seçilen hesaba atanır. Aktarım ağ isteği göndermez. Web Locks desteği
yoksa kullanıcı mevcut JSON/CSV aktarımını kullanır. GitHub Pages ve başka origin'lerdeki
kayıtlar otomatik okunamaz. Tarayıcı silinmesine karşı kullanıcı dışa aktarım yedeği almalıdır.

## Yönetim

Üyelikler yalnızca güvenilir yönetimden değiştirilir. Örnek (UUID'yi gerçek kullanıcıyla değiştirin):

```sql
update public.reader_memberships set status = 'suspended' where user_id = 'USER_UUID';
update public.reader_memberships set status = 'active', expires_at = null where user_id = 'USER_UUID';
```

`expires_at` gelecekteki bitiş tarihini alabilir. Kullanıcı kendi üyeliğini değiştiremez.
Ödeme sistemi, hesap silme paneli ve yönetici paneli bu sürümün kapsamında değildir.
Mevcut açık kaynak/HTML kopyaları yerel okuyucu olarak çalışmaya devam edebilir;
bu erişim kapısı, önceden indirilmiş kodu veya kullanıcının yerel verisini geri alamaz.
GitHub Pages kaynağı eski standalone uygulamayı korur. Ticari ürünün değeri ve lisansı
sunucu tarafındaki haklarla ayrıca tasarlanmalıdır; bu değişiklik DRM değildir.
