# Storage Auditor & Cleaner

Utilitas audit dan pembersih penyimpanan lokal berbasis **Node.js Native** dengan Web UI Dashboard responsif, modern, dan interaktif.

## Fitur Utama

- **Pilihan Folder Target Fleksibel (Tanpa Perlu Copy-Paste Manual)**:
  - **Tombol "Upload Folder"**: Membuka pemilih folder langsung dari browser untuk memilih folder target secara visual tanpa perlu menyalin path secara manual.
  - **Tombol "Pilih dari Windows"**: Membuka dialog pemilih folder bawaan sistem Windows Explorer (`FolderBrowserDialog`) untuk memilih folder atau drive mana pun secara native.
  - **Input Path Dinamis & Drag-and-Drop**: Mendukung input manual atau *drag-and-drop* folder langsung ke area target bar (default: `C:\Users\Student\Documents\Storage-Cleaner`).
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
- **Zero Dependencies**: Berjalan murni menggunakan modul bawaan Node.js (`http`, `fs`, `path`, `crypto`, `child_process`, `os`) tanpa perlu `npm install`.
- **Auto Launch Browser**: Otomatis membuka Web Dashboard di browser saat skrip dijalankan.

---

## Cara Menjalankan

Cukup jalankan perintah berikut di terminal:

```bash
node storage_audit.js
```

Dashboard akan otomatis terbuka di browser pada alamat:
`http://localhost:3888`