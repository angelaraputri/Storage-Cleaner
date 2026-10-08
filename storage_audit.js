/**
 * Storage Auditor & Cleaner (storage_audit.js)
 * 
 * Sistem Audit & Pembersihan Penyimpanan Berbasis Node.js Native
 * Menggunakan modul bawaan: http, fs, path, crypto, child_process
 * Tanpa dependensi eksternal (zero npm dependencies).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const DEFAULT_PORT = 3888;
const DEFAULT_TARGET_DIR = 'C:\\Users\\Student\\Documents\\Storage-Cleaner';
const GIANT_FILE_THRESHOLD_BYTES = 3 * 1024 * 1024; // 3 MB (3.145.728 bytes / > 3.000 KB)

// Helper format ukuran file
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Menghitung hash SHA-256 dari file secara streaming
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

// Pindai folder secara rekursif
async function scanDirectoryRecursive(dirPath, fileList = [], scanErrors = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    scanErrors.push(`Gagal membaca direktori ${dirPath}: ${err.message}`);
    return { fileList, scanErrors };
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        // Skip .git folder agar tidak memperlambat pemindaian repository internal
        if (entry.name === '.git' || entry.name === 'node_modules') {
          continue;
        }
        await scanDirectoryRecursive(fullPath, fileList, scanErrors);
      } else if (entry.isFile()) {
        const stats = await fs.promises.stat(fullPath);
        const hash = await computeFileHash(fullPath);
        const ext = path.extname(entry.name).toLowerCase();
        const isTmp = ext === '.tmp' || entry.name.toLowerCase().endsWith('.temp') || entry.name.startsWith('~');

        fileList.push({
          name: entry.name,
          fullPath: fullPath,
          sizeBytes: stats.size,
          sizeFormatted: formatBytes(stats.size),
          mtime: stats.mtime,
          mtimeMs: stats.mtimeMs,
          hashSha256: hash,
          isGiant: stats.size >= GIANT_FILE_THRESHOLD_BYTES,
          isTmp: isTmp
        });
      }
    } catch (err) {
      scanErrors.push(`Gagal memproses file ${fullPath}: ${err.message}`);
    }
  }

  return { fileList, scanErrors };
}

// Analisis hasil pemindaian
function analyzeFiles(files, targetFolder, scanDurationMs, scanErrors) {
  let totalBytes = 0;
  const giantFiles = [];
  const tmpFiles = [];
  const hashMap = new Map();

  for (const file of files) {
    totalBytes += file.sizeBytes;

    if (file.isGiant) {
      giantFiles.push(file);
    }

    if (file.isTmp) {
      tmpFiles.push(file);
    }

    if (!hashMap.has(file.hashSha256)) {
      hashMap.set(file.hashSha256, []);
    }
    hashMap.get(file.hashSha256).push(file);
  }

  // Mengelompokkan duplikat (file dengan SHA-256 identik)
  const duplicateGroups = [];
  let potentialDuplicateSavingsBytes = 0;

  for (const [hash, groupFiles] of hashMap.entries()) {
    if (groupFiles.length > 1) {
      // Urutkan berdasarkan waktu modifikasi tertua (mtimeMs terendah) sebagai file asli
      groupFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

      // File pertama ditandai sebagai asli, sisanya sebagai duplikat salinan
      const processedGroup = groupFiles.map((f, idx) => ({
        ...f,
        isOriginal: idx === 0
      }));

      const perFileSize = groupFiles[0].sizeBytes;
      const wastedCount = groupFiles.length - 1;
      const wastedBytes = wastedCount * perFileSize;
      potentialDuplicateSavingsBytes += wastedBytes;

      duplicateGroups.push({
        hash: hash,
        perFileSize: perFileSize,
        perFileSizeFormatted: formatBytes(perFileSize),
        wastedBytes: wastedBytes,
        wastedBytesFormatted: formatBytes(wastedBytes),
        fileCount: groupFiles.length,
        files: processedGroup
      });
    }
  }

  // Urutkan grup duplikat berdasarkan potensi hemat terbesar
  duplicateGroups.sort((a, b) => b.wastedBytes - a.wastedBytes);

  // Urutkan file raksasa dari yang terbesar
  giantFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);

  // Hitung total potensi hemat (duplikat + file .tmp yang bukan bagian dari duplikat yang sudah dihitung)
  let tmpSavingsBytes = 0;
  for (const tmp of tmpFiles) {
    // Jika tmp file bukan duplikat berlebih, tambahkan ukurannya
    const inDup = duplicateGroups.some(g => g.files.some(f => f.fullPath === tmp.fullPath && !f.isOriginal));
    if (!inDup) {
      tmpSavingsBytes += tmp.sizeBytes;
    }
  }
  const totalPotentialSavingsBytes = potentialDuplicateSavingsBytes + tmpSavingsBytes;

  return {
    targetFolder,
    scanTimestamp: new Date().toISOString(),
    scanDurationMs,
    totalFiles: files.length,
    totalBytes: totalBytes,
    totalBytesFormatted: formatBytes(totalBytes),
    giantFilesCount: giantFiles.length,
    giantFilesTotalBytes: giantFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
    giantFilesTotalBytesFormatted: formatBytes(giantFiles.reduce((acc, f) => acc + f.sizeBytes, 0)),
    giantFiles: giantFiles,
    duplicateGroupsCount: duplicateGroups.length,
    duplicateGroups: duplicateGroups,
    tmpFilesCount: tmpFiles.length,
    tmpFiles: tmpFiles,
    potentialSavingsBytes: totalPotentialSavingsBytes,
    potentialSavingsFormatted: formatBytes(totalPotentialSavingsBytes),
    allFiles: files,
    scanErrors
  };
}

// In-Place Cleanup Function: Menghapus duplikat salinan dan file .tmp
async function cleanStorage(targetFolder, filesToDelete) {
  const deletedFiles = [];
  const errors = [];
  let freedBytes = 0;

  for (const filePath of filesToDelete) {
    try {
      // Pastikan file berada di dalam target folder untuk keamanan
      const resolvedTarget = path.resolve(targetFolder).toLowerCase();
      const resolvedFile = path.resolve(filePath).toLowerCase();

      if (!resolvedFile.startsWith(resolvedTarget)) {
        errors.push({
          path: filePath,
          error: 'Ditolak: File berada di luar folder target yang diizinkan.'
        });
        continue;
      }

      if (fs.existsSync(filePath)) {
        const stats = await fs.promises.stat(filePath);
        const size = stats.size;
        await fs.promises.unlink(filePath);
        freedBytes += size;
        deletedFiles.push({
          path: filePath,
          sizeBytes: size,
          sizeFormatted: formatBytes(size)
        });
      }
    } catch (err) {
      errors.push({
        path: filePath,
        error: err.message
      });
    }
  }

  return {
    freedBytes,
    freedBytesFormatted: formatBytes(freedBytes),
    deletedFiles,
    errors
  };
}

// Generate test sample files untuk kemudahan pengujian
async function generateSampleFiles(targetFolder) {
  const sampleDir = path.join(targetFolder, 'Sample_Audit_Files');
  await fs.promises.mkdir(sampleDir, { recursive: true });

  const subDir = path.join(sampleDir, 'Sub_Folder_Arsip');
  await fs.promises.mkdir(subDir, { recursive: true });

  // 1. File Duplikat 1: Modul Belajar PDF (Isi identik)
  const contentModul = Buffer.from('=== MATERI MODUL RESMI STORAGE CLEANER 2026 ===\n'.repeat(500));
  await fs.promises.writeFile(path.join(sampleDir, 'modul_panduan.pdf'), contentModul);
  await fs.promises.writeFile(path.join(sampleDir, 'modul_panduan_SALINAN.pdf'), contentModul);
  await fs.promises.writeFile(path.join(subDir, 'modul_panduan_BACKUP_2026.pdf'), contentModul);

  // 2. File Duplikat 2: Dokumen Kontrak TXT
  const contentKontrak = Buffer.from('--- DOKUMEN PERJANJIAN & KONTRAK KERJA ---\n'.repeat(300));
  await fs.promises.writeFile(path.join(sampleDir, 'kontrak_kerja.docx'), contentKontrak);
  await fs.promises.writeFile(path.join(subDir, 'kontrak_kerja_COPY.docx'), contentKontrak);

  // 3. File Raksasa (> 3 MB) - Ukuran 3.5 MB
  const giantPath = path.join(sampleDir, 'database_dump_archive.bin');
  const giantChunk = Buffer.alloc(1024 * 1024, 'A'); // 1 MB buffer
  const writeStream = fs.createWriteStream(giantPath);
  for (let i = 0; i < 3.5; i++) {
    writeStream.write(giantChunk);
  }
  await new Promise(resolve => writeStream.end(resolve));

  // 4. File Sampah Sementara (.tmp)
  await fs.promises.writeFile(path.join(sampleDir, 'cache_session_01.tmp'), 'TEMP_CACHE_SESSION_DATA_#992318');
  await fs.promises.writeFile(path.join(subDir, 'build_indexer.tmp'), 'TEMP_BUILD_INDEXER_DATA_#110293');
  await fs.promises.writeFile(path.join(sampleDir, '~draft_unsaved.tmp'), 'OFFICE_AUTO_RECOVERY_CACHE');

  // 5. File Normal Unik
  await fs.promises.writeFile(path.join(sampleDir, 'catatan_penting.txt'), 'Ini adalah catatan unik yang tidak memiliki duplikat.');

  return {
    sampleDir,
    message: 'File sampel (Duplikat, File Raksasa > 3MB, dan File .tmp) berhasil dibuat!'
  };
}

// HTML Dashboard Generator
function renderHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storage Auditor & Cleaner</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0A0D14;
      --bg-surface: #121826;
      --bg-card: #182234;
      --bg-card-hover: #1E2B42;
      --border: rgba(255, 255, 255, 0.08);
      --border-focus: #3B82F6;
      --text-main: #F1F5F9;
      --text-muted: #94A3B8;
      --text-dim: #64748B;
      --primary: #3B82F6;
      --primary-hover: #2563EB;
      --success: #10B981;
      --warning: #F59E0B;
      --danger: #EF4444;
      --danger-hover: #DC2626;
      --purple: #8B5CF6;
      --cyan: #06B6D4;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    body {
      background-color: var(--bg-dark);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }

    /* Ambient background glow */
    .bg-glow {
      position: fixed;
      top: -200px;
      left: 20%;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.15) 0%, rgba(139, 92, 246, 0.05) 50%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      max-width: 1240px;
      margin: 0 auto;
      padding: 32px 24px;
      position: relative;
      z-index: 1;
      width: 100%;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 24px rgba(59, 130, 246, 0.35);
    }

    .brand-icon svg {
      width: 26px;
      height: 26px;
      color: white;
    }

    .brand-text h1 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(to right, #FFFFFF, #CBD5E1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-text p {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 400;
    }

    .header-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    /* Target Directory Control Bar */
    .target-bar {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px 20px;
      margin-bottom: 28px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(12px);
    }

    .target-label {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 10px;
    }

    .target-input-group {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .target-input-wrapper {
      position: relative;
      flex: 1;
      min-width: 280px;
    }

    .target-input-wrapper svg {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      color: var(--text-dim);
    }

    .target-input {
      width: 100%;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 13px 14px 13px 44px;
      color: var(--text-main);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13.5px;
      transition: all 0.2s ease;
    }

    .target-input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      border-radius: 10px;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      text-decoration: none;
      white-space: nowrap;
    }

    .btn svg {
      width: 18px;
      height: 18px;
    }

    .btn-primary {
      background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%);
      color: white;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);
    }

    .btn-primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%);
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.45);
    }

    .btn-secondary {
      background: var(--bg-card);
      color: var(--text-main);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--bg-card-hover);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .btn-danger {
      background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%);
      color: white;
      box-shadow: 0 4px 14px rgba(220, 38, 38, 0.35);
    }

    .btn-danger:hover:not(:disabled) {
      background: linear-gradient(135deg, #DC2626 0%, #B91C1C 100%);
      transform: translateY(-1px);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    /* Metric Cards Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 18px;
      margin-bottom: 28px;
    }

    .metric-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px;
      position: relative;
      overflow: hidden;
      transition: all 0.25s ease;
    }

    .metric-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.12);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.25);
    }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .metric-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .metric-icon-box {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .metric-icon-box.blue {
      background: rgba(59, 130, 246, 0.12);
      color: #60A5FA;
    }

    .metric-icon-box.purple {
      background: rgba(139, 92, 246, 0.12);
      color: #A78BFA;
    }

    .metric-icon-box.amber {
      background: rgba(245, 158, 11, 0.12);
      color: #FBBF24;
    }

    .metric-icon-box.emerald {
      background: rgba(16, 185, 129, 0.12);
      color: #34D399;
    }

    .metric-icon-box svg {
      width: 22px;
      height: 22px;
    }

    .metric-value {
      font-size: 28px;
      font-weight: 800;
      color: var(--text-main);
      letter-spacing: -0.5px;
      margin-bottom: 6px;
      font-feature-settings: "tnum";
    }

    .metric-desc {
      font-size: 12.5px;
      color: var(--text-dim);
    }

    .metric-highlight {
      color: #34D399;
      font-weight: 600;
    }

    /* Actions Bar */
    .actions-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 28px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .actions-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
      background: rgba(16, 185, 129, 0.12);
      color: #34D399;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }

    /* Tab Controls */
    .tab-nav {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
      padding-bottom: 2px;
      overflow-x: auto;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 600;
      padding: 10px 18px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .tab-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.04);
    }

    .tab-btn.active {
      color: var(--primary);
      background: rgba(59, 130, 246, 0.1);
    }

    .tab-badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--bg-card);
      color: var(--text-muted);
    }

    .tab-btn.active .tab-badge {
      background: var(--primary);
      color: white;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
      animation: fadeIn 0.25s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Accordion Duplicate Groups */
    .accordion-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .accordion-item {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      transition: border-color 0.2s;
    }

    .accordion-item:hover {
      border-color: rgba(255, 255, 255, 0.14);
    }

    .accordion-header {
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      background: var(--bg-surface);
      gap: 16px;
      flex-wrap: wrap;
    }

    .accordion-header:hover {
      background: var(--bg-card);
    }

    .dup-group-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      min-width: 260px;
    }

    .dup-count-badge {
      background: rgba(239, 68, 68, 0.14);
      color: #F87171;
      padding: 4px 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
    }

    .dup-title {
      font-size: 14.5px;
      font-weight: 700;
      color: var(--text-main);
    }

    .dup-hash {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-dim);
      background: var(--bg-card);
      padding: 3px 8px;
      border-radius: 6px;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dup-savings-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: #34D399;
      background: rgba(16, 185, 129, 0.1);
      padding: 6px 12px;
      border-radius: 8px;
    }

    .accordion-arrow {
      width: 20px;
      height: 20px;
      color: var(--text-muted);
      transition: transform 0.25s ease;
    }

    .accordion-item.open .accordion-arrow {
      transform: rotate(180deg);
    }

    .accordion-body {
      display: none;
      padding: 0 20px 20px 20px;
      border-top: 1px solid var(--border);
      background: rgba(10, 13, 20, 0.4);
    }

    .accordion-item.open .accordion-body {
      display: block;
    }

    /* File List inside Group */
    .file-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      margin-top: 12px;
      background: var(--bg-card);
      border-radius: 10px;
      border: 1px solid var(--border);
      gap: 14px;
      flex-wrap: wrap;
    }

    .file-row.original {
      border-color: rgba(16, 185, 129, 0.35);
      background: rgba(16, 185, 129, 0.05);
    }

    .file-row.duplicate {
      border-color: rgba(239, 68, 68, 0.25);
    }

    .file-details {
      flex: 1;
      min-width: 220px;
    }

    .file-name-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .file-name {
      font-weight: 600;
      font-size: 13.5px;
      color: var(--text-main);
    }

    .file-path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11.5px;
      color: var(--text-muted);
      word-break: break-all;
    }

    .badge-original {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(16, 185, 129, 0.2);
      color: #34D399;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .badge-duplicate {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(239, 68, 68, 0.15);
      color: #F87171;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .file-size-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px;
      color: var(--text-main);
      font-weight: 600;
    }

    /* Table Styles for Giant Files */
    .table-container {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
    }

    .custom-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    .custom-table th {
      background: var(--bg-card);
      padding: 14px 18px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
    }

    .custom-table td {
      padding: 14px 18px;
      font-size: 13px;
      color: var(--text-main);
      border-bottom: 1px solid var(--border);
    }

    .custom-table tr:last-child td {
      border-bottom: none;
    }

    .custom-table tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .giant-tag {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(245, 158, 11, 0.15);
      color: #FBBF24;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .empty-state {
      padding: 50px 20px;
      text-align: center;
      color: var(--text-muted);
    }

    .empty-state svg {
      width: 48px;
      height: 48px;
      color: var(--text-dim);
      margin-bottom: 14px;
    }

    .empty-state h3 {
      font-size: 16px;
      color: var(--text-main);
      margin-bottom: 6px;
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }

    .modal-backdrop.show {
      display: flex;
      animation: fadeIn 0.2s ease;
    }

    .modal-dialog {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 20px;
      max-width: 640px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      max-height: 85vh;
    }

    .modal-header {
      padding: 22px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-title {
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .modal-body {
      padding: 24px;
      overflow-y: auto;
      flex: 1;
    }

    .modal-footer {
      padding: 18px 24px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      background: var(--bg-card);
    }

    .modal-alert {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 18px;
      font-size: 13px;
      color: #FCA5A5;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .modal-alert svg {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      color: #EF4444;
    }

    .delete-list {
      max-height: 220px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-card);
      margin-top: 12px;
    }

    .delete-item {
      padding: 10px 14px;
      font-size: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }

    .delete-item:last-child {
      border-bottom: none;
    }

    .delete-item-path {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Toast Notification */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 14px 20px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      z-index: 1100;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s ease;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    /* Loader Spinner */
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="bg-glow"></div>

  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="brand-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
            <line x1="12" y1="22.08" x2="12" y2="12"></line>
          </svg>
        </div>
        <div class="brand-text">
          <h1>Storage Auditor & Cleaner</h1>
          <p>Pemindai Rekursif Hash SHA-256 & Pembersih In-Place Native Node.js</p>
        </div>
      </div>
      <div class="header-actions">
        <button id="btnGenerateSamples" class="btn btn-secondary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
          </svg>
          Buat Data Sampel Uji
        </button>
      </div>
    </header>

    <!-- Target Directory Bar (Dynamic Path Input) -->
    <div class="target-bar">
      <div class="target-label">
        <span>LOKASI FOLDER TARGET (DINAMIS)</span>
        <span id="targetHelp">Dapat diubah secara dinamis ke folder mana pun tanpa hardcoded</span>
      </div>
      <div class="target-input-group">
        <div class="target-input-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <input type="text" id="targetFolderPath" class="target-input" value="${DEFAULT_TARGET_DIR}" placeholder="Masukkan path absolut folder target, contoh: C:\\Users\\Student\\Documents\\Storage-Cleaner">
        </div>
        <button id="btnScanFolder" class="btn btn-primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          Pindai Folder
        </button>
      </div>
    </div>

    <!-- 4 Storage Metric Cards -->
    <div class="metrics-grid">
      <!-- Card 1: Total File -->
      <div class="metric-card">
        <div class="metric-header">
          <span class="metric-title">Total File</span>
          <div class="metric-icon-box blue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalFiles">0</div>
        <div class="metric-desc" id="descTotalFiles">Belum ada pemindaian</div>
      </div>

      <!-- Card 2: Total Kapasitas -->
      <div class="metric-card">
        <div class="metric-header">
          <span class="metric-title">Total Kapasitas</span>
          <div class="metric-icon-box purple">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalSize">0 B</div>
        <div class="metric-desc" id="descTotalSize">Ukuran seluruh file</div>
      </div>

      <!-- Card 3: File Raksasa (> 3 MB) -->
      <div class="metric-card">
        <div class="metric-header">
          <span class="metric-title">File Raksasa (&gt; 3 MB)</span>
          <div class="metric-icon-box amber">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valGiantFiles">0</div>
        <div class="metric-desc" id="descGiantFiles">Ambang batas 3.000 KB</div>
      </div>

      <!-- Card 4: Potensi Hemat Ruang -->
      <div class="metric-card">
        <div class="metric-header">
          <span class="metric-title">Potensi Hemat</span>
          <div class="metric-icon-box emerald">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
          </div>
        </div>
        <div class="metric-value metric-highlight" id="valSavings">0 B</div>
        <div class="metric-desc" id="descSavings">Dari duplikat identik &amp; .tmp</div>
      </div>
    </div>

    <!-- Actions Bar -->
    <div class="actions-bar">
      <div class="actions-info">
        <span class="status-badge" id="scanStatusBadge">
          <span class="status-dot"></span>
          <span id="scanStatusText">Siap memindai</span>
        </span>
        <span style="font-size: 13px; color: var(--text-muted);" id="scanTimeDetail"></span>
      </div>
      <div>
        <button id="btnOpenCleanModal" class="btn btn-danger" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          Bersihkan Duplikat &amp; Sampah
        </button>
      </div>
    </div>

    <!-- Tab Navigation -->
    <div class="tab-nav">
      <button class="tab-btn active" data-tab="tab-duplicates">
        Grup Duplikat (SHA-256)
        <span class="tab-badge" id="badgeDupCount">0</span>
      </button>
      <button class="tab-btn" data-tab="tab-giants">
        File Raksasa (&gt; 3 MB)
        <span class="tab-badge" id="badgeGiantCount">0</span>
      </button>
      <button class="tab-btn" data-tab="tab-tmp">
        File Sampah (.tmp)
        <span class="tab-badge" id="badgeTmpCount">0</span>
      </button>
      <button class="tab-btn" data-tab="tab-all">
        Semua File
        <span class="tab-badge" id="badgeAllCount">0</span>
      </button>
    </div>

    <!-- Tab 1: Accordion Duplicates -->
    <div id="tab-duplicates" class="tab-content active">
      <div class="accordion-list" id="duplicateList">
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2"></rect>
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path>
          </svg>
          <h3>Belum ada pemindaian</h3>
          <p>Klik tombol <strong>"Pindai Folder"</strong> di atas untuk menemukan file duplikat berdasarkan hash SHA-256.</p>
        </div>
      </div>
    </div>

    <!-- Tab 2: Giant Files Table -->
    <div id="tab-giants" class="tab-content">
      <div class="table-container">
        <table class="custom-table">
          <thead>
            <tr>
              <th>Nama File</th>
              <th>Path Lokasi</th>
              <th>Ukuran</th>
              <th>Status</th>
              <th>Waktu Diubah</th>
            </tr>
          </thead>
          <tbody id="giantTableBody">
            <tr>
              <td colspan="5" style="text-align: center; padding: 36px; color: var(--text-dim);">
                Tidak ada file raksasa (&gt; 3 MB) yang terdeteksi.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 3: Temp Files Table -->
    <div id="tab-tmp" class="tab-content">
      <div class="table-container">
        <table class="custom-table">
          <thead>
            <tr>
              <th>Nama File Sampah</th>
              <th>Path Lokasi</th>
              <th>Ukuran</th>
              <th>Aksi Otomatis</th>
            </tr>
          </thead>
          <tbody id="tmpTableBody">
            <tr>
              <td colspan="4" style="text-align: center; padding: 36px; color: var(--text-dim);">
                Tidak ada file sampah (.tmp) yang ditemukan.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 4: All Files Explorer -->
    <div id="tab-all" class="tab-content">
      <div class="table-container">
        <table class="custom-table">
          <thead>
            <tr>
              <th>Nama File</th>
              <th>Ukuran</th>
              <th>Hash SHA-256 (64-char)</th>
              <th>Path Lengkap</th>
            </tr>
          </thead>
          <tbody id="allFilesTableBody">
            <tr>
              <td colspan="4" style="text-align: center; padding: 36px; color: var(--text-dim);">
                Belum ada data file yang dipindai.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Interactive Confirmation Modal for In-Place Clean -->
  <div class="modal-backdrop" id="cleanModal">
    <div class="modal-dialog">
      <div class="modal-header">
        <div class="modal-title">
          <svg style="width: 22px; height: 22px; color: #EF4444;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          Konfirmasi Pembersihan In-Place
        </div>
      </div>
      <div class="modal-body">
        <div class="modal-alert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <div>
            <strong>Peringatan Eksekusi Langsung (In-Place):</strong>
            File duplikat kembar dan file .tmp akan dihapus langsung dari lokasi folder target tanpa dipindahkan ke folder baru. <strong>1 file asli per grup duplikat dipastikan tetap aman dipertahankan.</strong>
          </div>
        </div>

        <p style="font-size: 13.5px; color: var(--text-main); margin-bottom: 8px;">
          Rincian item yang akan dibersihkan:
        </p>
        <div style="font-size: 13px; color: var(--text-muted); display: flex; gap: 16px; margin-bottom: 12px;">
          <div>Duplikat: <strong id="modalDupCount" style="color: #F87171;">0</strong> file</div>
          <div>Sampah (.tmp): <strong id="modalTmpCount" style="color: #F87171;">0</strong> file</div>
          <div>Total Ruang Bebas: <strong id="modalFreedEstimate" style="color: #34D399;">0 B</strong></div>
        </div>

        <div class="delete-list" id="modalDeleteList">
          <!-- List items to delete -->
        </div>
      </div>
      <div class="modal-footer">
        <button id="btnCancelModal" class="btn btn-secondary">Batal</button>
        <button id="btnConfirmClean" class="btn btn-danger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          Hapus Sekarang (In-Place)
        </button>
      </div>
    </div>
  </div>

  <!-- Toast Notification -->
  <div class="toast" id="toastNotification">
    <svg id="toastIcon" style="width: 20px; height: 20px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
      <polyline points="22 4 12 14.01 9 11.01"></polyline>
    </svg>
    <span id="toastMessage" style="font-size: 13.5px; font-weight: 500;"></span>
  </div>

  <script>
    let currentAuditData = null;

    // Toast helper
    function showToast(message, isError = false) {
      const toast = document.getElementById('toastNotification');
      const toastMsg = document.getElementById('toastMessage');
      const toastIcon = document.getElementById('toastIcon');
      
      toastMsg.innerText = message;
      toastIcon.style.color = isError ? '#EF4444' : '#10B981';
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 4000);
    }

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-tab');
        document.getElementById(targetId).classList.add('active');
      });
    });

    // Pindai Folder Function
    async function performScan() {
      const folderPath = document.getElementById('targetFolderPath').value.trim();
      if (!folderPath) {
        showToast('Silakan masukkan path folder target.', true);
        return;
      }

      const btnScan = document.getElementById('btnScanFolder');
      const originalBtnContent = btnScan.innerHTML;
      btnScan.disabled = true;
      btnScan.innerHTML = '<div class="spinner"></div> Memindai...';

      document.getElementById('scanStatusText').innerText = 'Sedang memindai rekursif...';
      document.getElementById('scanStatusBadge').style.color = '#60A5FA';

      try {
        const response = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Gagal memindai folder.');
        }

        currentAuditData = data;
        updateUI(data);
        showToast('Pemindaian selesai dalam ' + data.scanDurationMs + ' ms!');
      } catch (err) {
        showToast(err.message, true);
        document.getElementById('scanStatusText').innerText = 'Gagal memindai';
        document.getElementById('scanStatusBadge').style.color = '#EF4444';
      } finally {
        btnScan.disabled = false;
        btnScan.innerHTML = originalBtnContent;
      }
    }

    // Update UI berdasarkan data hasil audit
    function updateUI(data) {
      document.getElementById('valTotalFiles').innerText = data.totalFiles.toLocaleString();
      document.getElementById('descTotalFiles').innerText = 'Dipindai dalam ' + data.scanDurationMs + ' ms';

      document.getElementById('valTotalSize').innerText = data.totalBytesFormatted;
      document.getElementById('descTotalSize').innerText = 'Total ' + data.totalBytes.toLocaleString() + ' bytes';

      document.getElementById('valGiantFiles').innerText = data.giantFilesCount.toLocaleString();
      document.getElementById('descGiantFiles').innerText = data.giantFilesCount > 0 ? data.giantFilesTotalBytesFormatted : 'Ambang batas > 3 MB';

      document.getElementById('valSavings').innerText = data.potentialSavingsFormatted;
      document.getElementById('descSavings').innerText = data.duplicateGroupsCount + ' grup duplikat, ' + data.tmpFilesCount + ' file .tmp';

      document.getElementById('badgeDupCount').innerText = data.duplicateGroupsCount;
      document.getElementById('badgeGiantCount').innerText = data.giantFilesCount;
      document.getElementById('badgeTmpCount').innerText = data.tmpFilesCount;
      document.getElementById('badgeAllCount').innerText = data.totalFiles;

      document.getElementById('scanStatusText').innerText = 'Pemindaian Aktif';
      document.getElementById('scanStatusBadge').style.color = '#10B981';
      document.getElementById('scanTimeDetail').innerText = 'Terakhir: ' + new Date().toLocaleTimeString();

      // Enable tombol Bersihkan jika ada potensi hemat > 0
      const btnClean = document.getElementById('btnOpenCleanModal');
      btnClean.disabled = data.potentialSavingsBytes === 0;

      // Render Accordion Duplikat
      renderDuplicateAccordion(data.duplicateGroups);

      // Render Tabel File Raksasa
      renderGiantTable(data.giantFiles);

      // Render Tabel File Temp
      renderTmpTable(data.tmpFiles);

      // Render Semua File
      renderAllFilesTable(data.allFiles);
    }

    // Render Accordion Duplikat
    function renderDuplicateAccordion(groups) {
      const container = document.getElementById('duplicateList');
      if (!groups || groups.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <h3>Tidak Ada Duplikat Identik</h3>
            <p>Folder ini bersih dari file kembar dengan hash SHA-256 yang sama.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = groups.map((group, idx) => {
        const originalFile = group.files.find(f => f.isOriginal) || group.files[0];
        const filesHtml = group.files.map(f => \`
          <div class="file-row \${f.isOriginal ? 'original' : 'duplicate'}">
            <div class="file-details">
              <div class="file-name-line">
                <span class="file-name">\${escapeHtml(f.name)}</span>
                \${f.isOriginal 
                  ? '<span class="badge-original"><svg style="width:12px;height:12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> ASLI (Dipertahankan)</span>' 
                  : '<span class="badge-duplicate"><svg style="width:12px;height:12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> DUPLIKAT (Akan Dihapus)</span>'}
              </div>
              <div class="file-path">\${escapeHtml(f.fullPath)}</div>
            </div>
            <div class="file-size-badge">\${f.sizeFormatted}</div>
          </div>
        \`).join('');

        return \`
          <div class="accordion-item \${idx === 0 ? 'open' : ''}">
            <div class="accordion-header" onclick="toggleAccordion(this)">
              <div class="dup-group-meta">
                <span class="dup-count-badge">\${group.fileCount} File Kembar</span>
                <span class="dup-title">\${escapeHtml(originalFile.name)}</span>
                <span class="dup-hash" title="SHA-256: \${group.hash}">Hash: \${group.hash.substring(0, 16)}...</span>
              </div>
              <div style="display:flex; align-items:center; gap: 14px;">
                <div class="dup-savings-badge">
                  Potensi Hemat: +\${group.wastedBytesFormatted}
                </div>
                <svg class="accordion-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>
            <div class="accordion-body">
              \${filesHtml}
            </div>
          </div>
        \`;
      }).join('');
    }

    function toggleAccordion(header) {
      const item = header.parentElement;
      item.classList.toggle('open');
    }

    // Render Tabel File Raksasa
    function renderGiantTable(giants) {
      const tbody = document.getElementById('giantTableBody');
      if (!giants || giants.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="5" style="text-align: center; padding: 36px; color: var(--text-dim);">
              Tidak ada file yang melebihi ambang batas 3 MB.
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = giants.map(f => \`
        <tr>
          <td style="font-weight: 600;">\${escapeHtml(f.name)}</td>
          <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-muted); word-break: break-all;">\${escapeHtml(f.fullPath)}</td>
          <td style="font-family: 'JetBrains Mono', monospace; font-weight: 700; color: #FBBF24;">\${f.sizeFormatted}</td>
          <td><span class="giant-tag">&gt; 3 MB Raksasa</span></td>
          <td style="color: var(--text-dim); font-size: 12px;">\${new Date(f.mtime).toLocaleString()}</td>
        </tr>
      \`).join('');
    }

    // Render Tabel Temp Files
    function renderTmpTable(tmpFiles) {
      const tbody = document.getElementById('tmpTableBody');
      if (!tmpFiles || tmpFiles.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="4" style="text-align: center; padding: 36px; color: var(--text-dim);">
              Tidak ada file sampah (.tmp) yang ditemukan.
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = tmpFiles.map(f => \`
        <tr>
          <td style="font-weight: 600; color: #F87171;">\${escapeHtml(f.name)}</td>
          <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-muted); word-break: break-all;">\${escapeHtml(f.fullPath)}</td>
          <td style="font-family: 'JetBrains Mono', monospace; font-weight: 600;">\${f.sizeFormatted}</td>
          <td><span class="badge-duplicate">Siap Dibersihkan</span></td>
        </tr>
      \`).join('');
    }

    // Render Semua File
    function renderAllFilesTable(files) {
      const tbody = document.getElementById('allFilesTableBody');
      if (!files || files.length === 0) {
        tbody.innerHTML = \`<tr><td colspan="4" style="text-align: center; padding: 36px;">Kosong.</td></tr>\`;
        return;
      }

      tbody.innerHTML = files.slice(0, 100).map(f => \`
        <tr>
          <td style="font-weight: 600;">\${escapeHtml(f.name)}</td>
          <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px;">\${f.sizeFormatted}</td>
          <td style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted);" title="\${f.hashSha256}">\${f.hashSha256.substring(0, 24)}...</td>
          <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-dim); word-break: break-all;">\${escapeHtml(f.fullPath)}</td>
        </tr>
      \`).join('');
    }

    // Helper escape HTML
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/[&<>"']/g, function(m) {
        switch (m) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          case "'": return '&#39;';
        }
      });
    }

    // Modal Konfirmasi Pembersihan In-Place
    const modal = document.getElementById('cleanModal');
    let itemsToClean = [];

    document.getElementById('btnOpenCleanModal').addEventListener('click', () => {
      if (!currentAuditData) return;

      itemsToClean = [];
      const deleteListEl = document.getElementById('modalDeleteList');
      deleteListEl.innerHTML = '';

      let dupCount = 0;
      let tmpCount = 0;

      // Kumpulkan file duplikat (abaikan file asli)
      for (const group of currentAuditData.duplicateGroups) {
        for (const file of group.files) {
          if (!file.isOriginal) {
            itemsToClean.push(file.fullPath);
            dupCount++;
            deleteListEl.innerHTML += \`
              <div class="delete-item">
                <span class="delete-item-path" title="\${escapeHtml(file.fullPath)}">\${escapeHtml(file.fullPath)}</span>
                <span class="badge-duplicate">\${file.sizeFormatted}</span>
              </div>
            \`;
          }
        }
      }

      // Kumpulkan file .tmp (jika belum termasuk di itemsToClean)
      for (const tmp of currentAuditData.tmpFiles) {
        if (!itemsToClean.includes(tmp.fullPath)) {
          itemsToClean.push(tmp.fullPath);
          tmpCount++;
          deleteListEl.innerHTML += \`
            <div class="delete-item">
              <span class="delete-item-path" title="\${escapeHtml(tmp.fullPath)}">\${escapeHtml(tmp.fullPath)}</span>
              <span class="badge-duplicate">\${tmp.sizeFormatted} (.tmp)</span>
            </div>
          \`;
        }
      }

      document.getElementById('modalDupCount').innerText = dupCount;
      document.getElementById('modalTmpCount').innerText = tmpCount;
      document.getElementById('modalFreedEstimate').innerText = currentAuditData.potentialSavingsFormatted;

      modal.classList.add('show');
    });

    document.getElementById('btnCancelModal').addEventListener('click', () => {
      modal.classList.remove('show');
    });

    // Eksekusi Konfirmasi Pembersihan In-Place
    document.getElementById('btnConfirmClean').addEventListener('click', async () => {
      const folderPath = document.getElementById('targetFolderPath').value.trim();
      const btnConfirm = document.getElementById('btnConfirmClean');
      btnConfirm.disabled = true;
      btnConfirm.innerHTML = '<div class="spinner"></div> Menghapus in-place...';

      try {
        const response = await fetch('/api/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderPath,
            filesToDelete: itemsToClean
          })
        });

        const resData = await response.json();
        if (!response.ok) {
          throw new Error(resData.error || 'Gagal membersihkan file.');
        }

        modal.classList.remove('show');
        showToast('Berhasil membersihkan ' + resData.deletedFiles.length + ' file in-place! Kapasitas hemat: ' + resData.freedBytesFormatted);

        // Auto-refresh scan setelah pembersihan
        await performScan();
      } catch (err) {
        showToast(err.message, true);
      } finally {
        btnConfirm.disabled = false;
        btnConfirm.innerHTML = '<svg style="width:18px;height:18px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Hapus Sekarang (In-Place)';
      }
    });

    // Generate sample files
    document.getElementById('btnGenerateSamples').addEventListener('click', async () => {
      const folderPath = document.getElementById('targetFolderPath').value.trim();
      const btn = document.getElementById('btnGenerateSamples');
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div> Membuat Sampel...';

      try {
        const response = await fetch('/api/generate-samples', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Gagal membuat file sampel.');

        showToast(data.message);
        // Otomatis pindai setelah file sampel dibuat
        await performScan();
      } catch (err) {
        showToast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg style="width:18px;height:18px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path></svg> Buat Data Sampel Uji';
      }
    });

    // Pindai folder tombol click
    document.getElementById('btnScanFolder').addEventListener('click', performScan);

    // Enter pada input path
    document.getElementById('targetFolderPath').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') performScan();
    });

    // Otomatis jalankan pemindaian pertama kali halaman dibuka
    window.addEventListener('DOMContentLoaded', () => {
      performScan();
    });
  </script>
</body>
</html>`;
}

// Handler request HTTP
async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET / -> Serve Web Dashboard
  if (req.method === 'GET' && parsedUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHTML());
    return;
  }

  // Helper untuk membaca request body JSON
  const getRequestBody = () => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e7) { // 10MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', err => reject(err));
  });

  // POST /api/scan -> Memindai folder target
  if (req.method === 'POST' && parsedUrl.pathname === '/api/scan') {
    try {
      const payload = await getRequestBody();
      const targetDir = payload.folderPath || DEFAULT_TARGET_DIR;

      if (!fs.existsSync(targetDir)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Folder target tidak ditemukan: ${targetDir}` }));
        return;
      }

      const stat = await fs.promises.stat(targetDir);
      if (!stat.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Path bukan merupakan direktori: ${targetDir}` }));
        return;
      }

      const startTime = Date.now();
      const { fileList, scanErrors } = await scanDirectoryRecursive(targetDir);
      const scanDurationMs = Date.now() - startTime;

      const result = analyzeFiles(fileList, targetDir, scanDurationMs, scanErrors);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/clean -> In-Place Pembersihan duplikat & sampah
  if (req.method === 'POST' && parsedUrl.pathname === '/api/clean') {
    try {
      const payload = await getRequestBody();
      const targetFolder = payload.folderPath || DEFAULT_TARGET_DIR;
      const filesToDelete = payload.filesToDelete || [];

      if (!Array.isArray(filesToDelete) || filesToDelete.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Daftar file yang akan dibersihkan kosong.' }));
        return;
      }

      const cleanResult = await cleanStorage(targetFolder, filesToDelete);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cleanResult));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/generate-samples -> Buat data sampel untuk pengujian
  if (req.method === 'POST' && parsedUrl.pathname === '/api/generate-samples') {
    try {
      const payload = await getRequestBody();
      const targetFolder = payload.folderPath || DEFAULT_TARGET_DIR;

      const sampleResult = await generateSampleFiles(targetFolder);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sampleResult));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404 Not Found
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// Buka browser otomatis
function openBrowser(url) {
  const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${startCmd} ${url}`, err => {
    if (err) {
      console.log(`[Info] Silakan buka browser secara manual di: ${url}`);
    }
  });
}

// Start Server dengan port fallback jika port sudah digunakan
function startServer(port = DEFAULT_PORT) {
  const server = http.createServer(handleRequest);

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} sedang digunakan, mencoba port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Terjadi kesalahan server:', err);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log('='.repeat(65));
    console.log('   STORAGE AUDITOR & CLEANER (Node.js Native)');
    console.log('='.repeat(65));
    console.log(` Server aktif di       : ${url}`);
    console.log(` Target folder default: ${DEFAULT_TARGET_DIR}`);
    console.log(` Dukungan runtime     : Node.js (http, fs, path, crypto)`);
    console.log(' Membuka dashboard di browser secara otomatis...');
    console.log(' Tekan Ctrl+C untuk menghentikan server.');
    console.log('='.repeat(65));

    openBrowser(url);
  });
}

// Eksekusi utama
startServer();
