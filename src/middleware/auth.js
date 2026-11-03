'use strict';

const crypto = require('crypto');
const { AppError } = require('../lib/util');
const { cariPenggunaId, STATUS_AKTIF, PERAN_ADMIN } = require('../repos/pengguna');

// Dari server.js (impor nilai konstan)
const AUTH_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam
const AUTH_SECRET = process.env.AUTH_SECRET || 'default-secret-key-change-in-production';

// Status konstan
const STATUS_AKTIF_VALUE = 'Aktif';

/** Mengubah Buffer menjadi Base64 URL-safe. */
function keBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Mengubah Base64 URL-safe menjadi Buffer. */
function dariBase64Url(str) {
  const padding = (4 - str.length % 4) % 4;
  return Buffer.from(str + '='.repeat(padding), 'base64');
}

/** Tanda tangan HMAC untuk token sesi (payload.jti tidak disertakan). */
function tandaTanganSesi(payloadBase64Url) {
  return crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(payloadBase64Url)
    .digest()
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** Daftar sesi yang dicabut (logout). */
const sesiDicabut = new Map();

/** Memuat daftar sesi dicabut dari memori atau berkas. */
function muatSesiDicabut() {
  sesiDicabut.clear();
  // Inisialisasi kosong; dapat diperluas untuk baca dari berkas
}

/** Mencabut satu sesi. */
function cabutSesiToken(payload) {
  const jti = String((payload && payload.jti) || '').trim();
  if (!jti) return false;
  sesiDicabut.set(jti, Number(payload.exp) || (Date.now() + AUTH_TTL_MS));
  return true;
}

/** Cek apakah sesi sudah dicabut. */
function sesiSudahDicabut(payload) {
  const jti = String((payload && payload.jti) || '').trim();
  if (!jti) return false;

  const exp = sesiDicabut.get(jti);
  if (!exp) return false;
  if (exp < Date.now()) {
    sesiDicabut.delete(jti);
    return false;
  }
  return true;
}

/** Membaca token sesi dan memverifikasi tanda tangannya. */
function bacaTokenSesi(token) {
  const bagian = String(token || '').trim().split('.');
  if (bagian.length !== 2 || !bagian[0] || !bagian[1]) return null;

  const diharapkan = Buffer.from(tandaTanganSesi(bagian[0]));
  const diterima   = Buffer.from(bagian[1]);
  if (diharapkan.length !== diterima.length
      || !crypto.timingSafeEqual(diharapkan, diterima)) {
    return null;
  }

  try {
    const payload = JSON.parse(dariBase64Url(bagian[0]).toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!Number(payload.exp) || Number(payload.exp) < Date.now()) return null;
    if (sesiSudahDicabut(payload)) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

/** Mengambil token dari header Authorization. */
function ambilTokenPermintaan(req) {
  const cocok = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (cocok) return cocok[1].trim();
  return String(req.get('x-auth-token') || '').trim();
}

/** Middleware: permintaan harus menyertakan token sesi yang sah. */
function wajibLogin(req, res, next) {
  const payload = bacaTokenSesi(ambilTokenPermintaan(req));
  if (!payload) {
    return next(new AppError(401,
      'Akses ditolak: token sesi tidak ada atau sudah kedaluwarsa. ' +
      'Masuk melalui POST /api/auth/login lalu kirim header ' +
      '"Authorization: Bearer <token>".'));
  }

  const pengguna = cariPenggunaId(payload.sub);
  if (!pengguna) {
    return next(new AppError(401, 'Akses ditolak: akun pemilik token tidak ditemukan.'));
  }
  if (String(pengguna.status) !== STATUS_AKTIF_VALUE) {
    return next(new AppError(403, 'Akses ditolak: akun ini sedang tidak aktif.'));
  }

  req.pengguna = pengguna;
  req.sesi     = payload;
  next();
}

/** Middleware: khusus Administrator. */
function wajibAdmin(req, res, next) {
  if (!req.pengguna || req.pengguna.peran !== PERAN_ADMIN) {
    return next(new AppError(403, 'Akses ditolak: fitur ini khusus Administrator.'));
  }
  next();
}

module.exports = {
  wajibLogin,
  wajibAdmin,
  bacaTokenSesi,
  ambilTokenPermintaan,
  cabutSesiToken,
  sesiSudahDicabut,
  muatSesiDicabut,
};
