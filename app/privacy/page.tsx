import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Kebijakan Privasi | Universality",
  description: "Data yang diproses Universality, sesi Discord, fitur AI, penyimpanan, dan cara mengajukan permintaan penghapusan.",
};

export default function Privacy() {
  return (
    <LegalPage title="Kebijakan Privasi" introduction="Universality dikelola oleh administrator bot untuk komunitas Discord. Kebijakan ini mencakup bot dan dashboard profilnya, dengan pemrosesan sesuai fitur yang digunakan dan pengaturan server.">
      <section>
        <h2>Data bot dan tujuannya</h2>
        <ul>
          <li>ID pengguna dan ID server Discord digunakan untuk mengaitkan aktivitas serta data dengan anggota dan server yang sesuai.</li>
          <li>Konten pesan yang memenuhi syarat diproses untuk menghitung kata dan memeriksa duplikasi dalam perhitungan aktivitas. Konten pesan terakhir untuk pemeriksaan duplikasi ditahan di RAM, tanpa jaminan batas waktu penghapusan tertentu.</li>
          <li>XP, poin, level, dan metadata aktivitas voice digunakan untuk progres serta perhitungan aktivitas komunitas. Bot tidak merekam suara.</li>
          <li>Saldo ekonomi, inventori, dan progres quest digunakan untuk menjalankan fitur hadiah dan aktivitas virtual.</li>
          <li>Data pelacakan staf dan laporan digunakan untuk pengelolaan serta evaluasi aktivitas staf sesuai fitur server.</li>
        </ul>
      </section>
      <section>
        <h2>Login Discord dan data dashboard</h2>
        <p>Dashboard meminta izin OAuth Discord <code>identify</code> dan <code>guilds</code> untuk menampilkan identitas akun (ID, username, nama tampilan) dan daftar server (ID dan nama). Dashboard tidak meminta kata sandi Discord.</p>
        <p>Access token disimpan dalam cookie sesi terenkripsi dan HttpOnly, bukan di localStorage. Cookie menggunakan SameSite=Lax dan Secure saat memakai HTTPS. Sesi dibatasi paling lama 8 jam dan berakhir lebih awal jika masa berlaku token lebih singkat. Cookie sementara untuk alur login berlaku 10 menit. Logout menghapus cookie sesi dan cookie alur login dari browser.</p>
        <p>Backend menggunakan ID pengguna dari sesi Discord, keanggotaan server, dan level terbaru dari bot untuk memeriksa akses serta kuota slot. Preferensi background disimpan per ID pengguna dan ID server di database layanan Supabase. Data gambar mencakup kepemilikan, slot, status pemrosesan, revisi, metadata gambar, dan referensi internal file hasil pemrosesan.</p>
        <p>localStorage hanya digunakan untuk draft demo pilihan background di browser ini, bukan token OAuth atau gambar pribadi. Draft tidak otomatis diterapkan ke bot. Kamu dapat menghapusnya melalui tombol Reset draft atau pengaturan penyimpanan situs di browser. Logout mengakhiri sesi browser, bukan menghapus preferensi, gambar tersimpan, atau data aktivitas bot.</p>
      </section>
      <section>
        <h2>Gambar pribadi dan visibilitas kartu</h2>
        <p>Upload menerima JPG, PNG, atau WebP statis maksimal 3 MiB (3.145.728 byte). Backend memproses ulang gambar menjadi PNG 1000×560 piksel dengan crop tengah (centered cover) dan membuang metadata yang tidak diperlukan. Metadata layanan dan gambar hasil pemrosesan tetap diperlukan untuk menyediakan background.</p>
        <p>Gambar hasil pemrosesan disimpan dalam bucket privat Supabase Storage dan diakses melalui backend yang memeriksa izin. Gambar pribadi tidak otomatis menjadi katalog publik dan hanya dapat dipilih pemiliknya untuk server terkait. Ini bukan jaminan bahwa gambar tidak akan terlihat oleh orang lain: hasil kartu <code>/profile</code> yang diposting ke Discord terlihat oleh pengguna yang dapat mengakses kanal tersebut.</p>
        <p>Menghapus gambar sumber tidak menarik kembali kartu yang sudah diposting di Discord, salinan yang dibuat pengguna lain, atau backup. Penyimpanan dan penghapusan salinan oleh Discord maupun pihak lain mengikuti proses mereka sendiri.</p>
        <p>Slot berlaku per pengguna per server berdasarkan level terbaru: level 0–19 mendapat 0 slot, level 20–44 mendapat 1 slot, level 45–64 mendapat 2 slot, dan level 65 ke atas mendapat maksimal 3 slot. Jika level turun, gambar tetap disimpan dan slot berlebih dikunci. Jika gambar pada slot terkunci sedang aktif, kartu kembali memakai background bawaan.</p>
      </section>
      <section>
        <h2>Pertanyaan ke AI</h2>
        <p>Saat memakai <code>/ai-ask</code>, pertanyaan yang kamu masukkan dikirim bersama konteks dokumentasi bot ke penyedia model eksternal untuk menghasilkan jawaban. Konfigurasi bawaan mendukung Groq dan Google AI Studio, dengan percobaan ke penyedia cadangan jika terjadi kegagalan tertentu. Penyedia yang dipakai bergantung pada konfigurasi aktif administrator.</p>
        <p>Alur ini mengirim pertanyaan yang diajukan, bukan seluruh percakapan server secara otomatis. Pertanyaan dan jawaban dapat terlihat di kanal Discord tempat perintah dijalankan, sesuai pengaturan balasan bot. Jangan masukkan informasi sensitif. Pemrosesan dan penyimpanan oleh penyedia mengikuti kebijakan mereka; kami tidak menjanjikan kebijakan retensi atau penggunaan pelatihan tertentu dari penyedia.</p>
      </section>
      <section>
        <h2>Penyimpanan dan masa simpan</h2>
        <p>Data persisten bot disimpan dalam database SQLite pada PC milik rekan yang digunakan sebagai server bot. Data tersebut dapat tetap tersimpan lintas restart. Data sementara tertentu berada di RAM selama proses bot berjalan.</p>
        <p>Gambar pribadi tetap disimpan sampai pengguna menghapusnya, kecuali penanganan pelanggaran kebijakan. Penurunan level tidak menghapus gambar. File upload gagal atau orphan (tidak lagi terhubung ke data gambar) dibersihkan melalui antrean cleanup. Setelah penghapusan diminta, penghapusan file penyimpanan dapat berlangsung bertahap; kami tidak menjanjikan seluruh byte, salinan, atau backup langsung terhapus.</p>
        <p>Untuk data bot dan kategori data lainnya, belum ada jaminan penghapusan otomatis setelah 30 hari atau masa simpan tetap. Data dapat dipertahankan selama masih diperlukan untuk menjalankan fitur, menangani penyalahgunaan, menyelesaikan keluhan, atau memenuhi kebutuhan administrasi yang relevan. Kami tidak menjanjikan penghapusan segera atau tenggat penyelesaian tertentu.</p>
      </section>
      <section>
        <h2>Akses, perlindungan, dan pihak ketiga</h2>
        <p>Akses pengelolaan data dibatasi kepada administrator bot dan pengelola server atau infrastruktur yang memerlukannya untuk operasional. Tampilan fitur seperti profil, peringkat, atau laporan mengikuti fungsi dan izin di server Discord.</p>
        <p>Perlindungan sesi dashboard mencakup enkripsi cookie, HttpOnly, pemeriksaan alur OAuth, serta pembatasan masa sesi. Ini bukan jaminan keamanan mutlak dan bukan pernyataan bahwa database bot terenkripsi saat disimpan.</p>
        <p>Discord memproses data untuk akun, server, interaksi bot, dan login OAuth. Perangkat server serta penyedia hosting atau infrastruktur yang digunakan memproses data yang diperlukan untuk menjalankan layanan. Penyedia AI menerima pertanyaan saat fitur AI digunakan. Layanan pihak ketiga memiliki ketentuan dan kebijakan privasi masing-masing.</p>
      </section>
      <section>
        <h2>Laporan konten</h2>
        <p>Konten ilegal, seksual eksplisit, kebencian, dan pelanggaran hak cipta dilarang. Laporkan gambar melalui <a href="https://discord.com/channels/873228006078939196/1541242307620376616" target="_blank" rel="noopener noreferrer">kanal #laporan</a> dengan menyertakan tautan pesan <code>/profile</code> dan alasan laporan. Kamu harus menjadi anggota server dukungan untuk mengakses kanal dan mengirim laporan; gunakan Dukungan Discord di bawah untuk bergabung.</p>
        <p>Laporan yang kamu kirim dapat terlihat oleh anggota yang memiliki akses ke kanal tersebut. Jangan menyertakan token, kata sandi, atau data sensitif. Kebijakan laporan menetapkan peninjauan manual oleh administrator dan penonaktifan atau penghapusan gambar yang melanggar. Operator yang berwenang adalah pemilik server atau pemegang izin Discord Administrator di server terkait, bukan Manage Server saja atau daftar ID global. Panel peninjauan dan penonaktifan gambar hanya mencakup server tersebut. Implementasi lokal sudah tersedia, tetapi aktivasi hosted masih menunggu migrasi database dan uji admin nyata. Backend memeriksa izin Discord terbaru pada setiap akses moderasi. Audit penonaktifan menyimpan ID operator, server, gambar, dan waktu dengan akses terbatas layanan, tanpa token atau isi gambar. Penonaktifan mengembalikan preferensi ke default tanpa menghapus file; pemilik tetap dapat menghapus slot melalui alur cleanup. Tidak ada moderasi otomatis atau jaminan waktu respons dan penyelesaian.</p>
      </section>
      <section>
        <h2>Permintaan penghapusan dan pertanyaan</h2>
        <p>Untuk mengajukan penghapusan data atau menyampaikan keluhan, buka Dukungan Discord di bawah dan hubungi administrator Universality. Sertakan ID pengguna dan, jika terkait, ID server beserta jenis data yang dimaksud. Administrator akan memverifikasi identitas atau kewenanganmu sebelum menangani permintaan. Jangan kirim token atau kata sandi sebagai bukti.</p>
        <p>Penanganan bergantung pada verifikasi dan cakupan data. Sebagian data mungkin perlu dipertahankan untuk kebutuhan yang dijelaskan di atas; tidak ada jaminan seluruh data di semua pihak terhapus seketika atau dalam tenggat tertentu. Data yang dikelola Discord dan penyedia eksternal mengikuti proses mereka sendiri.</p>
        <p>Opsi untuk menghentikan pelacakan per pengguna belum tersedia. Permintaan penghapusan bukan pengaturan untuk menghentikan pencatatan aktivitas berikutnya selama fitur bot masih berjalan di server.</p>
      </section>
      <section>
        <h2>Perubahan kebijakan</h2>
        <p>Kebijakan ini dapat diperbarui ketika pemrosesan data atau fitur berubah. Periksa halaman ini untuk penjelasan terbaru dan hubungi administrator melalui Dukungan Discord jika ada bagian yang perlu diperjelas.</p>
      </section>
    </LegalPage>
  );
}
