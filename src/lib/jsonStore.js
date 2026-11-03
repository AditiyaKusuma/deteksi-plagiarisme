'use strict';

/* ============================================================================
 *  PENYIMPANAN BERKAS JSON — dipindahkan dari server.js bagian 2B.
 *
 *  Primitif baca/tulis berkas JSON yang dipakai lapisan repositori. Penulisan
 *  memakai berkas sementara + rename supaya berkas asli tidak pernah tertinggal
 *  dalam keadaan separuh tertulis.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const { ROOT_DIR } = require('../config');

/** Membaca berkas JSON; memakai nilai bawaan bila berkas belum ada atau rusak. */
function muatJsonBerkas(jalur, bawaan) {
  try {
    if (!fs.existsSync(jalur)) return bawaan;
    const isi = fs.readFileSync(jalur, 'utf8').trim();
    if (!isi) return bawaan;
    const parsed = JSON.parse(isi);
    return parsed === null || parsed === undefined ? bawaan : parsed;
  } catch (err) {
    console.warn(`[db] Gagal memuat ${path.relative(ROOT_DIR, jalur)}: ${err.message}. `
      + 'Data lama diabaikan dan memakai nilai bawaan.');
    return bawaan;
  }
}

/**
 * Menulis berkas JSON secara aman: berkas sementara lalu rename, supaya berkas
 * asli tidak pernah tertinggal dalam keadaan separuh tertulis.
 * @returns {boolean} true bila berhasil disimpan
 */
function simpanJsonBerkas(jalur, nilai) {
  try {
    const sementara = `${jalur}.tmp`;
    fs.writeFileSync(sementara, JSON.stringify(nilai, null, 2), 'utf8');
    fs.renameSync(sementara, jalur);
    return true;
  } catch (err) {
    console.error(`[db] Gagal menyimpan ${path.relative(ROOT_DIR, jalur)}: ${err.message}`);
    return false;
  }
}

module.exports = {
  muatJsonBerkas,
  simpanJsonBerkas,
};
