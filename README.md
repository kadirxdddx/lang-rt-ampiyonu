# Masa Club — 3D online langırt

İki kişinin aynı oda koduyla tarayıcıdan oynadığı 3D langırt oyunu. Three.js masayı çizer; Node.js sunucusu maçın fiziğini, skoru ve süresini yönetir. Bilgisayar ve dokunmatik tablet aynı maça katılabilir.

## Bilgisayarda çalıştırma

Node.js 22 veya üzeri gerekir. Proje klasöründe:

```sh
npm install
npm start
```

Tarayıcıda `http://localhost:3000` aç. Dosyayı çift tıklayarak `file://` adresinden açmak yerine bu adresi kullan; JavaScript modülleri ve online bağlantı sunucudan yüklenir. Aynı ağdaki tablette bilgisayarın yerel IP adresiyle `http://BILGISAYARIN-IP-ADRESI:3000` açılabilir; bilgisayarın güvenlik duvarı bu bağlantıya izin vermelidir.

## Arkadaşınla oynama

1. İkiniz de aynı site adresini açın.
2. Biriniz oda oluştursun ve oda kodunu arkadaşına versin.
3. Diğeri kodla odaya katılsın.
4. İkiniz de hazır olduğunuzda maç başlar. Her oyuncu kendi üç çubuğunu ayrı ayrı yönetir.

Sohbet oda içindedir. İnternet kısa süreli kesilirse maç durur ve oyuncunun yeri 60 saniye boyunca yeniden bağlantı için tutulur. Bağlantı döndüğünde oyuncular yeniden hazır verir. Sunucu yeniden başlarsa veya yeni sürüm yayınlanırsa bellekteki odalar, skorlar ve sohbet kaybolur; yeni oda oluşturulur. Yeni sürümü yayınladıktan sonra iki oyuncu da sayfayı yenilemelidir.

## Mevcut Render adresine yayınlama

Kullanılan adres: <https://lang-rt-ampiyonu.onrender.com>

GitHub'daki güncel depo: <https://github.com/kadirxdddx/lang-rt-ampiyonu>, dal: `main`. Yerel Git uzak adresi eski `Nazyas` hesabını gösteriyorsa gönderimden önce doğru depoyu seç.

Mevcut Render **Web Service** ayarlarında bağlı deponun ve dalın bunlar olduğunu kontrol et. Aynı servisi güncellemek mevcut site adresini korur. Ayarlar:

| Ayar | Değer |
| --- | --- |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Environment: `NODE_ENV` | `production` |
| Environment: `NODE_VERSION` | `22` |

`PORT` Render tarafından sağlanır; sunucu bu portta `0.0.0.0` üzerinde dinler. Site dosyaları ve `/ws` WebSocket bağlantısı aynı Node servisinden sunulur.

Değişiklikleri bağlı dala gönder. Render'da otomatik yayın açıksa yeni commit yayınlanır; kapalıysa mevcut servisin **Manual Deploy → Deploy latest commit** seçeneğini kullan. Yayın tamamlandığında `/health` yanıtında `ok: true` görünmeli. Ardından iki tarayıcıdan yeni oda oluşturup katılma, hazır olma, çubuk hareketleri ve sohbeti kontrol et. [Render yayınlama belgeleri](https://render.com/docs/deploys)

`render.yaml`, tek Node servisi için Blueprint yapılandırmasıdır. Elle oluşturulan mevcut serviste bu dosyayı değiştirmek panel ayarlarını kendiliğinden güncellemez; yukarıdaki değerleri mevcut servise uygula. Yeni bir Blueprint oluşturmak mevcut servisi otomatik olarak devralmaz.

Yapılandırmada bölge zorlanmaz. Türkiye'den bağlantı gecikmesini azaltmak için yeni bir servis kurulacaksa Frankfurt değerlendirilebilir. Render, mevcut servisin bölgesinin değiştirilmesini desteklemez; bölge değişikliği yeni servis gerektirir ve yeni adres doğurabilir. [Render bölgeleri](https://render.com/docs/regions)

## Mimari

- `server.js`: HTTP dosyaları, `/health`, `/ws`, oda kodları, hazır durumu, sohbet ve yeniden bağlanma.
- `shared/game.js`: 120 Hz sabit adımla sunucuda çalışan maç fiziği. Gol ve çarpışma kararlarını sunucu verir.
- `client.js`: oyuncu girdileri, bağlantı ve arayüz. Sunucudan saniyede 30 durum güncellemesi alır.
- `scene.js`: Three.js ile 3D masa, oyuncular, top ve kamera.
- `index.html` ve `styles.css`: bilgisayar ve tablet arayüzü.

Odalar tek sunucu işleminin belleğinde tutulur. Yatay ölçekleme için ortak oda yönetimi veya oyuncuları aynı işleme yönlendiren ek bir katman gerekir. Bu sürüm tek Node servisinde çalışır. Mevcut Godot dosyaları ayrı prototip olarak korunur; web sunucusu onları kullanmaz.

## Kontroller

```sh
node --test tests/*.test.js
```

Testler fizik kurallarını ve sunucunun iki oyuncu arasındaki oda akışını denetler. Gerçek tabletin grafik hızı ve internet gecikmesi ayrıca iki cihazla denenmelidir.
