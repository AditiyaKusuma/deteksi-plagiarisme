'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const { wajibLogin, cabutSesiToken } = require('../middleware/auth');
const { buatIdPengguna, hashPassword, periksaPassword, publikPengguna, cariPenggunaEmail, tambahPengguna, simpanPengguna } = require('../repos/pengguna');
const { ambilField } = require('../lib/util');

/** Membuat token sesi untuk pengguna yang berhasil login. */
function buatTokenSesi(user) {
  const AUTH_SECRET = process.env.AUTH_SECRET || 'default-secret-key-change-in-production';
  const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
  
  function keBase64Url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  
  function tandaTanganSesi(payloadBase64Url) {
    return keBase64Url(
      crypto.createHmac('sha256', AUTH_SECRET).update(payloadBase64Url).digest(),
    );
  }

  const sekarang = Date.now();
  const payload = {
    sub: user.id,
    nama: user.nama,
    email: user.email,
    peran: user.peran,
    jti: crypto.randomBytes(9).toString('hex'),
    iat: sekarang,
    exp: sekarang + AUTH_TTL_MS,
  };
  const payloadBase64Url = keBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return {
    token: `${payloadBase64Url}.${tandaTanganSesi(payloadBase64Url)}`,
    payload,
  };
}

/* Format email yang diterima (sama dengan validasi di login.html). */
const RE_EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/* POST /api/auth/register (UC-01) — Pendaftaran akun mahasiswa */
router.post('/auth/register', (req, res, next) => {
  try {
    const body = req.body || {};
    const nama = ambilField(body, 'nama', 'nama_lengkap', 'namaLengkap', 'name');
    const email = ambilField(body, 'email', 'surel', 'username').toLowerCase();
    const sandi = String(body.password === undefined ? (body.sandi || body.kata_sandi || '') : body.password);
    const nim = ambilField(body, 'nim', 'NIM', 'nim_mahasiswa', 'nimMahasiswa');
    const peran = ambilField(body, 'peran', 'role').toLowerCase();

    if (nama.length < 3) {
      throw new (require('../lib/util').AppError)(400, 'Field "nama" wajib diisi, minimal 3 karakter.', { field: 'nama' });
    }
    if (nama.length > 60) {
      throw new (require('../lib/util').AppError)(400, 'Field "nama" maksimal 60 karakter.', { field: 'nama' });
    }
    if (!RE_EMAIL_REGEX.test(email)) {
      throw new (require('../lib/util').AppError)(400, 'Field "email" tidak berformat email yang sah.', { email });
    }
    if (sandi.length < 8) {
      throw new (require('../lib/util').AppError)(400, 'Field "password" minimal 8 karakter.', { field: 'password' });
    }
    if (nim && !/^[0-9]{8,12}$/.test(nim)) {
      throw new (require('../lib/util').AppError)(400, 'Field "nim" harus berupa angka 8-12 digit.', { nim });
    }
    if (peran && peran !== 'mahasiswa') {
      throw new (require('../lib/util').AppError)(400, 'Pendaftaran ini hanya untuk akun Mahasiswa.', { peran });
    }
    if (cariPenggunaEmail(email)) {
      throw new (require('../lib/util').AppError)(409, `Email ${email} sudah terdaftar. `        + 'Silakan masuk atau gunakan email lain.', { email });
    }

    const pengguna = {
      id: buatIdPengguna(),
      nama,
      nim: nim || null,
      email,
      password_hash: hashPassword(sandi),
      peran: 'Mahasiswa',
      status: 'Aktif',
      dibuat: new Date().toISOString(),
      terakhir_masuk: null,
    };

    if (!tambahPengguna(pengguna)) {
      throw new (require('../lib/util').AppError)(500, 'Pendaftaran gagal: data pengguna tidak dapat disimpan.');
    }

    res.status(201).json({
      status: 'success',
      message: 'Pendaftaran berhasil. Silakan masuk dengan akun barumu.',
      user: publikPengguna(pengguna),
    });
  } catch (err) {
    next(err);
  }
});

/* POST /api/auth/login (UC-02) — Autentikasi akun mahasiswa & Administrator */
router.post('/auth/login', (req, res, next) => {
  try {
    const body = req.body || {};
    const email = ambilField(body, 'email', 'surel', 'username').toLowerCase();
    const sandi = String(body.password === undefined ? (body.sandi || body.kata_sandi || '') : body.password);
    const peranDiminta = ambilField(body, 'peran', 'role').toLowerCase();

    if (!email || !sandi) {
      throw new (require('../lib/util').AppError)(400, 'Field "email" dan "password" wajib diisi.');
    }

    const pengguna = cariPenggunaEmail(email);

    // Pesan sengaja disamakan untuk email tidak dikenal dan kata sandi salah
    // supaya keberadaan akun tidak dapat ditebak dari pesan galat.
    if (!pengguna || !periksaPassword(sandi, pengguna.password_hash)) {
      console.warn(`[auth] gagal masuk: ${email || '(email kosong)'}`);
      throw new (require('../lib/util').AppError)(401, 'Data akun tidak sesuai. Periksa kembali email dan password.');
    }
    if (String(pengguna.status) !== 'Aktif') {
      throw new (require('../lib/util').AppError)(403, 'Akun ini sedang tidak aktif. Hubungi Administrator.');
    }
    if (peranDiminta && peranDiminta !== String(pengguna.peran).toLowerCase()) {
      throw new (require('../lib/util').AppError)(403, `Akun ini berperan ${pengguna.peran}, bukan ${peranDiminta}.`, {
        peran: pengguna.peran,
      });
    }

    pengguna.terakhir_masuk = new Date().toISOString();
    simpanPengguna();

    const { token, payload } = buatTokenSesi(pengguna);

    res.json({
      status: 'success',
      message: `Selamat datang, ${pengguna.nama}.`,
      token,
      tipe: 'Bearer',
      kedaluwarsa: new Date(payload.exp).toISOString(),
      user: publikPengguna(pengguna),
      // Bentuk sesi siap pakai untuk sessionStorage pada login.html / login-admin.html.
      sesi: {
        nama: pengguna.nama,
        nim: pengguna.nim || '',
        email: pengguna.email,
        peran: pengguna.peran,
        masuk: new Date(payload.iat).toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/* POST /api/auth/logout (UC-08/14) — Mengakhiri sesi aktif */
router.post('/auth/logout', wajibLogin, (req, res) => {
  const dicabut = require('../server').cabutSesi ? require('../server').cabutSesi(req.sesi) : true;
  console.log(`[auth] keluar: ${req.pengguna.email}${dicabut ? '' : ' (token tanpa jti)'}`);

  res.json({
    status: 'success',
    message: 'Sesi berhasil diakhiri. Silakan masuk kembali bila diperlukan.',
    dicabut,
  });
});

module.exports = router;