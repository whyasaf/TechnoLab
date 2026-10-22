export const metadata = { title: "Gizlilik ve Aydınlatma Metni — Technolab" };

export default function Privacy() {
  return (
    <main className="msgs priv">
      <h1>Gizlilik ve aydınlatma</h1>
      <p className="msgs-sum">Technolab, bireysel bir projedir. Bu sayfa kişisel verilerinin nasıl ele alındığını anlatır.</p>

      <h2>Veri sorumlusu</h2>
      <p>whyasaf (bireysel proje sahibi). Başvuru için: <a href="https://github.com/whyasaf/TechnoLab/issues">GitHub deposundaki “Issues” bölümü</a>.</p>

      <h2>Hangi veriler işlenir?</h2>
      <ul>
        <li>
          <b>Geri bildirim formu (isteğe bağlı):</b> 👍/👎 oyun, seçtiğin sebep, yazdığın mesaj, kullandığın ses kaynağı
          türü (sekme/mikrofon/dosya), BPM ve hassasiyet ayarı, YouTube video kimliği ve tarayıcı bilgisi.
          E-posta ya da ad sorulmaz. Mesaja kişisel bilgi yazmamanı rica ederiz.
        </li>
        <li>
          <b>Müzik ve ses:</b> Mikrofon ya da sekme sesi yalnızca tarayıcında analiz edilir, kaydedilmez ve sunucuya
          gönderilmez. Dosyaların bilgisayarından çıkmaz.
        </li>
        <li>
          <b>Hafıza özelliği:</b> Bir YouTube şarkısı için öğrenilen ışık planı (zaman bilgisi) yalnızca tarayıcının
          yerel depolamasında tutulur, sunucuya gönderilmez. “Hafızayı sil” ile ya da tarayıcı verilerini temizleyerek
          silebilirsin.
        </li>
        <li>Çerez kullanılmaz, reklam ya da analiz/takip aracı yoktur.</li>
        <li>
          <b>Teknik kayıtlar:</b> Barındırma sağlayıcısı (Vercel), hizmetin işleyişi için IP adresi gibi standart sunucu
          kayıtlarını kendi sistemlerinde tutabilir. Form kötüye kullanımını sınırlamak için IP adresi yalnızca kısa
          süreliğine bellekte sayılır, mesajla birlikte saklanmaz.
        </li>
      </ul>

      <h2>Amaç</h2>
      <p>Geri bildirimler yalnızca siteyi geliştirmek için okunur.</p>

      <h2>Saklama süresi</h2>
      <p>En yeni 1000 mesaj tutulur; son mesajdan 180 gün sonra tüm kayıtlar otomatik silinir.</p>

      <h2>Aktarım</h2>
      <p>
        Site Vercel üzerinde yayınlanır, mesajlar Upstash (Redis) üzerinde, Avrupa’daki (Frankfurt) bir sunucuda saklanır.
        Bu hizmetler yurt dışında bulunduğundan verilerin yurt dışında işlenmesi söz konusudur. Veriler satılmaz ve
        reklam amacıyla kullanılmaz.
      </p>

      <h2>Haklarınız</h2>
      <p>
        6698 sayılı KVKK’nın 11. maddesi kapsamında verinin işlenip işlenmediğini öğrenme, düzeltilmesini ya da
        silinmesini isteme gibi haklara sahipsin. Mesajlar kimliksiz olduğundan, silme talebinde mesajın içeriğini ya da
        gönderim zamanını belirtmen gerekir.
      </p>

      <p className="note">
        <a href="/">← Siteye dön</a>
      </p>
    </main>
  );
}
