'use strict';

/* ============================================================================
 *  UTILITAS UMUM — dipindahkan dari server.js bagian 3.
 *  Tidak bergantung pada modul proyek lain supaya aman diimpor di mana saja.
 * ========================================================================== */

const fs = require('fs');
const crypto = require('crypto');

/** Error aplikasi dengan kode HTTP agar dapat ditangani middleware error. */
class AppError extends Error {
  constructor(statusCode, message, detail) {
    super(message);
    this.statusCode = statusCode;
    this.detail = detail || null;
  }
}

/** Mengambil nilai field pertama yang terisi dari beberapa kemungkinan nama. */
function ambilField(sumber, ...namaField) {
  if (!sumber) return '';
  for (const nama of namaField) {
    const nilai = sumber[nama];
    if (nilai !== undefined && nilai !== null && String(nilai).trim() !== '') {
      return String(nilai).trim();
    }
  }
  return '';
}

/** Memformat ukuran berkas agar mudah dibaca. */
function ukuranTerbaca(bytes) {
  if (!bytes) return '0 B';
  const satuan = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), satuan.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${satuan[i]}`;
}

/** Menyeragamkan jenis dokumen dari kode form (proposal/laporan) ke label resmi. */
function normalisasiJenisDokumen(nilai) {
  const teks = String(nilai || '').toLowerCase();
  if (!teks) return 'Proposal Tugas Akhir';
  if (teks.includes('proposal')) return 'Proposal Tugas Akhir';
  if (teks.includes('laporan') || teks.includes('skripsi') || teks.includes('tugas akhir')) {
    return 'Laporan Tugas Akhir';
  }
  return String(nilai).trim();
}

/** Membuat ID hasil analisis: PLG-YYYYMMDD-XXXXXXXX. */
function buatIdHasil(tanggal = new Date()) {
  const ymd = tanggal.toISOString().slice(0, 10).replace(/-/g, '');
  return `PLG-${ymd}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Menghapus berkas unggahan secara aman. */
function hapusBerkas(file) {
  if (!file || !file.path) return;
  fs.promises.unlink(file.path).catch(() => { /* berkas sudah tidak ada -> diabaikan */ });
}

module.exports = {
  AppError,
  ambilField,
  ukuranTerbaca,
  normalisasiJenisDokumen,
  buatIdHasil,
  hapusBerkas,
};
