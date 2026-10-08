# Storage Auditor & Cleaner

Utilitas audit dan pembersih penyimpanan lokal berbasis **Node.js Native** dengan Web UI Dashboard responsif, modern, dan interaktif.

## Fitur Utama

- **Input Path Target Dinamis**: Mendukung pemindaian path folder apa pun secara dinamis langsung dari antarmuka Web UI (default: `C:\Users\Student\Documents\Storage-Cleaner`) tanpa hardcoding.
- **Pemindaian Rekursif & SHA-256**: Memindai seluruh direktori dan subdirektori secara rekursif, mengumpulkan metadata file (nama, path absolut, ukuran file, waktu modifikasi) dan menghitung checksum SHA-256 (64-karakter hex).
- **Pengelompokan Duplikat Cerdas**: Mengidentifikasi file kembar yang memiliki isi identik berdasarkan hash SHA-256 (meskipun nama file dan ekstensinya berbeda).
- **Deteksi File Raksasa (> 3 MB)**: Menandai file yang ukurannya melebihi ambang batas 3 MB (3.000 KB) untuk perhatian khusus.
- **Deteksi File Sampah Sementara**: Mengidentifikasi file sementara (`.tmp`, `.temp`, `~*`).
- **Dashboard Responsif Modern**:
  - 4 Kartu Metrik: **Total File**, **Total Kapasitas**, **File Raksasa**, dan **Potensi Hemat Ruang**.
  - **Accordion Grup Duplikat**: Menampilkan detail file asli (*Original*) yang aman dipertahankan dan file salinan (*Duplicate*) yang dapat dibersihkan.
  - **Tabel File Raksasa**: Menampilkan file berukuran besar beserta path dan tanggal modifikasi.
  - **Tabel File Sampah (.tmp)**.
  - **Eksplorer Semua File**.
- **Pembersihan In-Place dengan Konfirmasi Interaktif**:
  - Modal konfirmasi menampilkan rincian file yang akan dihapus dan perkiraan ruang yang dibebaskan.
  - Eksekusi langsung di tempat (*in-place*, bukan membuat salinan atau memindahkan file).
  - Wajib mempertahankan 1 file asli per kelompok duplikat dan menghapus file duplikat kembar serta file `.tmp`.
- **Zero Dependencies**: Berjalan murni menggunakan modul bawaan Node.js (`http`, `fs`, `path`, `crypto`, `child_process`) tanpa perlu `npm install`.
- **Auto Launch Browser**: Otomatis membuka Web Dashboard di browser saat skrip dijalankan.

---

## Cara Menjalankan

Cukup jalankan perintah berikut di terminal:

```bash
node storage_audit.js
```

Dashboard akan otomatis terbuka di browser pada alamat:
`http://localhost:3888`

---

## Spesifikasi Teknis

- **Runtime**: Node.js (v18+)
- **Modul Native**:
  - `http` - HTTP Server dan REST API endpoint
  - `fs` / `fs.promises` - Operasi filesystem rekursif & pembersihan in-place
  - `path` - Penanganan path lintas platform
  - `crypto` - Streaming SHA-256 hash digest
  - `child_process` - Eksekusi otomatis pembuka browser bawaan sistem operasi