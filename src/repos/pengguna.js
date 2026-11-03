'use strict';

/* ============================================================================
 *  REPOSITORI PENGGUNA — dipindahkan dari server.js bagian 2B.1.
 *
 *  Akun mahasiswa & Administrator disimpan di tabel `pengguna` (SQLite) lewat
 *  db.js, dengan kata sandi sebagai hash scrypt (bukan teks biasa).
 * ========================================================================== */

const path = require('path');
const crypto = require('crypto');

const basisData = require('../../db');
const { ROOT_DIR, DB_SQLITE } = require('../config');

const PERAN_MAHASISWA = 'Mahasiswa';
const PERAN_ADMIN = 'Administrator';
const STATUS_AKTIF = 'Aktif';
const STATUS_NONAKTIF = 'Nonaktif';

/** Penyimpanan pengguna di memori — sumber data utama saat server berjalan. */
let dbPengguna = [];

/** Membuat ID pengguna: USR-XXXXXXXX. */
function buatIdPengguna() {
  return `USR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Meng-hash kata sandi memakai scrypt (bawaan Node.js, tanpa dependensi baru).
 * Format tersimpan: "scrypt$<garam-hex>$<kunci-hex>".
 */
function hashPassword(sandi) {
  const garam = crypto.randomBytes(16).toString('hex');
  const kunci = crypto.scryptSync(String(sandi), garam, 64).toString('hex');
  return `scrypt$${garam}$${kunci}`;
}

/**
 * Memeriksa kata sandi terhadap hash tersimpan memakai perbandingan waktu-tetap
 * (mencegah analisis waktu respons).
 * @returns {boolean} true bila kata sandi cocok
 */
function periksaPassword(sandi, tersimpan) {
  try {
    const bagian = String(tersimpan || '').split('$');
    if (bagian.length !== 3 || bagian[0] !== 'scrypt') return false;
    const dihitung = crypto.scryptSync(String(sandi), bagian[1], 64);
    const asli = Buffer.from(bagian[2], 'hex');
    if (dihitung.length !== asli.length) return false;
    return crypto.timingSafeEqual(dihitung, asli);
  } catch (err) {
    return false; // hash rusak / garam tidak sah -> anggap tidak cocok
  }
}

/** Bentuk pengguna yang aman dikirim ke klien (tanpa hash kata sandi). */
function publikPengguna(user) {
  return {
    id: user.id,
    nama: user.nama,
    nim: user.nim || null,
    email: user.email,
    peran: user.peran,
    status: user.status,
    dibuat: user.dibuat || null,
    terakhir_masuk: user.terakhir_masuk || null,
  };
}

/**
 * Akun contoh agar halaman login yang sudah ada (login.html & login-admin.html)
 * dapat langsung dipakai: aditiya@example.com / aditiya123 (Mahasiswa) dan
 * admin@example.com / admin123 (Administrator).
 */
function penggunaBawaan() {
  const sekarang = new Date().toISOString();
  return [
    {
      id: buatIdPengguna(),
      nama: 'Aditiya Kusuma',
      nim: '11241002',
      email: 'aditiya@example.com',
      password_hash: hashPassword('aditiya123'),
      peran: PERAN_MAHASISWA,
      status: STATUS_AKTIF,
      dibuat: sekarang,
      terakhir_masuk: null,
    },
    {
      id: buatIdPengguna(),
      nama: 'Administrator Sistem',
      nim: null,
      email: 'admin@example.com',
      password_hash: hashPassword('admin123'),
      peran: PERAN_ADMIN,
      status: STATUS_AKTIF,
      dibuat: sekarang,
      terakhir_masuk: null,
    },
  ];
}

/** Memuat data pengguna; membuat akun contoh saat basis data masih kosong. */
function muatPengguna() {
  dbPengguna = basisData.muatPengguna();

  if (!dbPengguna.length) {
    dbPengguna = penggunaBawaan();
    simpanPengguna();
    console.log(`[db] tabel pengguna kosong -> ${dbPengguna.length} akun contoh dibuat `
      + '(1 Mahasiswa, 1 Administrator).');
    return;
  }

  console.log(`[db] ${dbPengguna.length} pengguna dimuat dari `
    + `${path.relative(ROOT_DIR, DB_SQLITE)} (tabel pengguna)`);
}

/** Menyimpan data pengguna ke basis data. */
function simpanPengguna() {
  return basisData.simpanPengguna(dbPengguna);
}

/** Mencari pengguna berdasarkan email (tanpa membedakan huruf besar/kecil). */
function cariPenggunaEmail(email) {
  const kunci = String(email || '').trim().toLowerCase();
  if (!kunci) return null;
  return dbPengguna.find((u) => String(u.email || '').toLowerCase() === kunci) || null;
}

/** Mencari pengguna berdasarkan id (dipakai middleware sesi). */
function cariPenggunaId(id) {
  const kunci = String(id || '').trim();
  if (!kunci) return null;
  return dbPengguna.find((u) => u.id === kunci) || null;
}

/** Seluruh pengguna di memori (referensi langsung, untuk daftar admin). */
function semuaPengguna() {
  return dbPengguna;
}

/** Jumlah pengguna terdaftar. */
function jumlahPengguna() {
  return dbPengguna.length;
}

/**
 * Menambahkan pengguna baru lalu menyimpannya. Bila penyimpanan gagal, akun
 * yang baru ditambahkan dibatalkan supaya memori dan basis data tetap sama.
 * @returns {boolean} true bila tersimpan
 */
function tambahPengguna(pengguna) {
  dbPengguna.push(pengguna);
  if (!simpanPengguna()) {
    dbPengguna.pop();
    return false;
  }
  return true;
}

module.exports = {
  PERAN_MAHASISWA,
  PERAN_ADMIN,
  STATUS_AKTIF,
  STATUS_NONAKTIF,
  buatIdPengguna,
  hashPassword,
  periksaPassword,
  publikPengguna,
  muatPengguna,
  simpanPengguna,
  cariPenggunaEmail,
  cariPenggunaId,
  semuaPengguna,
  jumlahPengguna,
  tambahPengguna,
};
