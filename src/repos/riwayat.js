'use strict';

/* ============================================================================
 *  REPOSITORI RIWAYAT / REKAMAN DOKUMEN — dipindahkan dari server.js bagian 2.
 *
 *  Menyimpan rekaman analisis di memori (array) dan menyinkronkannya ke SQLite
 *  lewat db.js. Semua akses ke array memori harus lewat modul ini supaya tidak
 *  ada variabel global yang ditembus dari berkas lain.
 * ========================================================================== */

const path = require('path');

const basisData = require('../../db');
const { ROOT_DIR, DB_SQLITE } = require('../config');

/**
 * Status pemeriksaan dokumen (FR-11): menunggu -> diproses -> berhasil | gagal.
 * Rekaman lama yang belum punya status_pemeriksaan dianggap sudah "berhasil".
 */
const STATUS_PEMERIKSAAN = {
  MENUNGGU: 'menunggu',
  DIPROSES: 'diproses',
  BERHASIL: 'berhasil',
  GAGAL: 'gagal',
};

/** Seluruh nilai status yang sah. */
const SEMUA_STATUS_PEMERIKSAAN = Object.keys(STATUS_PEMERIKSAAN)
  .map((kunci) => STATUS_PEMERIKSAAN[kunci]);

/** Penyimpanan di memori (array) — sumber data utama saat server berjalan. */
let dbRekaman = [];

/** Status efektif sebuah rekaman (rekaman lama -> "berhasil"). */
function statusRekaman(rekaman) {
  const nilai = String((rekaman && rekaman.status_pemeriksaan) || '').toLowerCase();
  return SEMUA_STATUS_PEMERIKSAAN.indexOf(nilai) === -1
    ? STATUS_PEMERIKSAAN.BERHASIL
    : nilai;
}

/** Mencari rekaman berdasarkan id (tidak peka huruf besar/kecil). */
function cariRekaman(id) {
  const kunci = String(id || '').trim().toLowerCase();
  if (!kunci) return null;
  return dbRekaman.find(
    (r) => String((r && r.id) || '').toLowerCase() === kunci) || null;
}

/** Memuat riwayat dari basis data SQLite saat server dijalankan. */
function muatRiwayat() {
  dbRekaman = basisData.muatRekaman();
  // Rekaman lama belum punya status_pemeriksaan -> tandai sudah berhasil.
  dbRekaman.forEach((rekaman) => {
    if (!rekaman || typeof rekaman !== 'object') return;
    if (!rekaman.status_pemeriksaan) {
      rekaman.status_pemeriksaan = STATUS_PEMERIKSAAN.BERHASIL;
    }
  });
  if (dbRekaman.length) {
    console.log(`[db] ${dbRekaman.length} rekaman dimuat dari `
      + `${path.relative(ROOT_DIR, DB_SQLITE)} (tabel dokumen + hasil_analisis)`);
  }
}

/** Menyimpan riwayat ke basis data (upsert seluruh rekaman di memori). */
function simpanRiwayat() {
  return basisData.simpanRekaman(dbRekaman);
}

/** Seluruh rekaman di memori (referensi langsung, jangan diubah strukturnya). */
function semuaRekaman() {
  return dbRekaman;
}

/** Jumlah rekaman di memori. */
function jumlahRekaman() {
  return dbRekaman.length;
}

/** Menambahkan rekaman baru di urutan teratas. */
function tambahRekaman(rekaman) {
  dbRekaman.unshift(rekaman);
  return rekaman;
}

/** Mengambil rekaman berdasarkan indeks array (untuk route hapus). */
function ambilRekaman(indeks) {
  return dbRekaman[indeks] || null;
}

/** Menghapus rekaman berdasarkan indeks array; mengembalikan rekaman terhapus. */
function hapusRekaman(indeks) {
  const [dihapus] = dbRekaman.splice(indeks, 1);
  return dihapus || null;
}

module.exports = {
  STATUS_PEMERIKSAAN,
  SEMUA_STATUS_PEMERIKSAAN,
  statusRekaman,
  cariRekaman,
  muatRiwayat,
  simpanRiwayat,
  semuaRekaman,
  jumlahRekaman,
  tambahRekaman,
  ambilRekaman,
  hapusRekaman,
};
