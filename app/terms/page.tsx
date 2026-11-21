import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Ketentuan Layanan | Universality",
  description: "Ketentuan penggunaan bot komunitas Universality, hadiah virtual, dashboard profil, dan dukungan administrator.",
};

export default function Terms() {
  return (
    <LegalPage title="Ketentuan Layanan" introduction="Ketentuan ini menjelaskan penggunaan bot Universality dan dashboard profilnya. Halaman ini dapat dibaca tanpa login Discord.">
      <section>
        <h2>Tentang layanan</h2>
        <p>Universality dikelola oleh administrator bot untuk komunitas Discord. Bot menyediakan fitur aktivitas komunitas, seperti XP, level, poin, ekonomi virtual, inventori, quest, serta pelacakan dan laporan staf sesuai pengaturan server.</p>
        <p>Dashboard menyediakan draft demo lokal tanpa login. Setelah login Discord, kamu dapat menyimpan preferensi background per akun dan per server melalui backend layanan. Draft lokal tidak otomatis diterapkan ke bot. Penggunaan preferensi oleh perintah <code>/profile</code> bergantung pada integrasi bot; perhatikan status penyimpanan dan integrasi di aplikasi.</p>
      </section>
      <section>
        <h2>Aturan penggunaan</h2>
        <p>Dengan menggunakan layanan, kamu menyetujui ketentuan ini. Ikuti ketentuan dan pedoman komunitas Discord serta aturan server tempat bot digunakan. Gunakan akun dan fitur sesuai izin yang kamu miliki.</p>
        <p>Jangan melakukan spam, memanipulasi aktivitas untuk mendapatkan hadiah, mengeksploitasi bug, mengakali batas fitur, atau mencoba mengakses data dan pengaturan orang lain tanpa izin. Laporkan masalah kepada administrator, bukan memanfaatkannya.</p>
        <p>Administrator dapat membatasi akses atau menyesuaikan hasil aktivitas untuk menangani pelanggaran dan penyalahgunaan sesuai aturan server.</p>
      </section>
      <section>
        <h2>Upload background pribadi</h2>
        <p>Upload menerima JPG, PNG, atau WebP statis dengan ukuran maksimal 3 MiB (3.145.728 byte). Gambar diproses ulang menjadi PNG 1000×560 piksel dengan crop tengah (centered cover) dan metadata yang tidak diperlukan dibuang. SVG dan gambar animasi tidak diterima.</p>
        <p>Slot pribadi berlaku per pengguna per server berdasarkan level terbaru: level 0–19 mendapat 0 slot, level 20–44 mendapat 1 slot, level 45–64 mendapat 2 slot, dan level 65 ke atas mendapat maksimal 3 slot. Saat level turun, termasuk karena reset season, slot berlebih dikunci tanpa menghapus gambar. Jika gambar pada slot terkunci sedang aktif, kartu kembali memakai background bawaan.</p>
        <p>Gambar pribadi hanya dapat dipilih oleh pemiliknya dan tidak otomatis masuk katalog publik. Penyimpanan privat tidak membuat hasil kartu di Discord menjadi rahasia: kartu yang dikirim melalui <code>/profile</code> terlihat oleh pengguna yang dapat mengakses kanal tersebut. Menghapus gambar sumber tidak menarik kembali kartu yang sudah diposting, salinan, atau backup.</p>
        <p>Gambar pribadi tetap disimpan sampai kamu menghapusnya, kecuali penanganan pelanggaran kebijakan. Penurunan level bukan alasan penghapusan otomatis. File upload gagal atau orphan (tidak lagi terhubung ke data gambar) dibersihkan melalui antrean cleanup. Penghapusan file penyimpanan dapat berlangsung bertahap, bukan jaminan seluruh byte langsung terhapus.</p>
      </section>
      <section>
        <h2>Aturan konten dan laporan</h2>
        <p>Jangan mengunggah konten ilegal, seksual eksplisit, kebencian, atau yang melanggar hak cipta. Gunakan gambar yang kamu miliki atau yang kamu berhak gunakan.</p>
        <p>Untuk melaporkan gambar, buka <a href="https://discord.com/channels/873228006078939196/1541242307620376616" target="_blank" rel="noopener noreferrer">kanal #laporan</a> di server dukungan. Kamu harus menjadi anggota server dukungan untuk mengakses kanal dan mengirim laporan. Jika belum bergabung, gunakan tautan Dukungan Discord di bawah. Sertakan tautan pesan <code>/profile</code> dan alasan laporan; jangan sertakan data sensitif.</p>
        <p>Kebijakan penanganan laporan adalah peninjauan manual oleh administrator, lalu penonaktifan atau penghapusan gambar jika melanggar. Operator yang berwenang adalah pemilik server atau pemegang izin Discord Administrator di server terkait, bukan Manage Server saja atau daftar ID global. Panel peninjauan dan penonaktifan gambar hanya mencakup server tersebut. Implementasi lokal sudah tersedia, tetapi aktivasi hosted masih menunggu migrasi database dan uji admin nyata. Penonaktifan mengembalikan preferensi ke default tanpa menghapus file; pemilik tetap dapat menghapus slot melalui alur cleanup. Tidak ada moderasi otomatis atau jaminan waktu respons atau penyelesaian.</p>
      </section>
      <section>
        <h2>Poin, saldo, dan hadiah</h2>
        <p>XP, level, poin, saldo, dan item adalah bagian dari sistem komunitas, bukan uang sungguhan. Kami tidak menjamin nilai uang, nilai tukar, atau ketersediaan hadiah. Saldo, progres, katalog, dan aturan hadiah dapat berubah sesuai aturan server, termasuk koreksi kesalahan atau penanganan eksploitasi.</p>
        <p>Jika toko server menawarkan hadiah yang dipenuhi secara manual oleh admin, persyaratan dan pemenuhannya mengikuti keterangan hadiah serta aturan server terkait. Hubungi admin server jika ada kendala penukaran.</p>
      </section>
      <section>
        <h2>Fitur AI</h2>
        <p>Jika kamu memakai <code>/ai-ask</code>, pertanyaan yang dikirim dapat diproses oleh penyedia model eksternal. Jawaban AI bisa keliru atau tidak lengkap. Periksa informasi penting dengan administrator dan jangan kirim kata sandi, token, atau data sensitif dalam pertanyaan.</p>
      </section>
      <section>
        <h2>Ketersediaan dan perubahan layanan</h2>
        <p>Layanan disediakan sesuai kondisi yang tersedia. Kami tidak menjamin bot selalu aktif, bebas kesalahan, atau menyimpan progres tanpa kehilangan data. Pemeliharaan, gangguan Discord, perangkat server, dan perubahan fitur dapat memengaruhi akses serta hasil penggunaan.</p>
        <p>Administrator dapat memperbarui layanan dan ketentuan ini. Baca kembali halaman ini untuk mengetahui ketentuan yang berlaku sebelum melanjutkan penggunaan.</p>
      </section>
      <section>
        <h2>Privasi, keluhan, dan kontak</h2>
        <p>Kebijakan Privasi menjelaskan data yang diproses, penyimpanan, dan cara meminta penghapusan. Untuk pertanyaan, keluhan, atau permintaan terkait data, gunakan tautan Dukungan Discord di bawah dan hubungi administrator Universality. Jangan membagikan informasi sensitif di kanal publik.</p>
      </section>
    </LegalPage>
  );
}
