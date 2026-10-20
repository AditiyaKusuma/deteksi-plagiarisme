'use strict';

/* ============================================================================
 *  Aplikasi Deteksi Plagiarisme Proposal & Laporan Tugas Akhir Menggunakan AI
 *  Backend REST API — Progress 30% (Mock Data / Simulasi Respon LLM)
 *
 *  File    : server.js
 *  Jalan   : npm install  &&  npm start
 *  Basis   : SRS/SDD Aplikasi Deteksi Plagiarisme (NIM 11241002)
 *
 *  STRUKTUR
 *    public/   -> halaman frontend (index.html, upload.html, login*.html, admin-*.html)
 *    data/     -> users.json, ai-config.json, hasil-analisis.json, uploads/
 *    tests/    -> skrip uji manual (.uji-*.tmp.js)
 *    docs/     -> dokumen SRS/SDD proyek
 *    logs/     -> log pengujian (.smoke-*.log)
 *
 *  ENDPOINT
 *    GET    /api/health                  -> status layanan
 *    POST   /api/upload                  -> unggah berkas, ekstraksi teks, analisis LLM (JSON mode)
 *    POST   /api/documents               -> alias /api/upload (FormData: judul, nim, jenis, file)
 *    POST   /api/documents/analyze       -> alias /api/upload
 *    GET    /api/results                 -> daftar hasil analisis (lihat juga /api/history)
 *    GET    /api/results/:id             -> detail satu hasil analisis
 *    GET    /api/history                 -> riwayat pemeriksaan (+ filter nim, klasifikasi, paging)
 *    DELETE /api/results/:id             -> hapus satu hasil analisis
 *    POST   /api/auth/register           -> pendaftaran akun mahasiswa (UC-01)
 *    POST   /api/auth/login              -> autentikasi mahasiswa & admin (UC-02) -> token sesi
 *    GET    /api/admin/users             -> daftar pengguna terdaftar (UC-09)   [admin]
 *    GET    /api/admin/documents         -> seluruh dokumen yang diunggah (UC-10) [admin]
 *    GET    /api/admin/histories         -> seluruh riwayat pemeriksaan (UC-11)  [admin]
 *    GET    /api/admin/ai-config         -> baca konfigurasi penyedia AI (UC-12) [admin]
 *    POST   /api/admin/ai-config         -> simpan konfigurasi penyedia AI (UC-13) [admin]
 *
 *  OTENTIKASI
 *    Akun disimpan di data/users.json (kata sandi = hash scrypt, bukan teks
 *    biasa); konfigurasi AI di data/ai-config.json. Rute bertanda [admin]
 *    memerlukan header "Authorization: Bearer <token>" dari hasil login
 *    akun berperan Administrator.
 *
 *  CATATAN PROGRESS
 *    Jalur utama analisis: EKSTRAKSI TEKS NYATA dari berkas PDF (pdf-parse) dan
 *    DOCX (mammoth), lalu dikirim ke LLM (OpenAI atau Gemini) melalui REST API
 *    dengan JSON mode / structured output (prompt engineering pada bagian 5).
 *    Panggilan LLM dibatasi maksimal 30 detik, dan teks yang dikirim maksimal
 *    8.000 kata pertama. Bila panggilan gagal (error API, timeout, atau JSON
 *    tidak sah), server membalas HTTP 500 dengan pesan yang rapi tanpa membuat
 *    proses Node.js berhenti. Khusus demo tanpa kunci API,
 *    LLM_FALLBACK_SIMULASI=true mengaktifkan data mock progress 30%.
 * ========================================================================== */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Pustaka ekstraksi teks dokumen (lihat bagian 4)
const { PDFParse } = require('pdf-parse');   // PDF  -> PDFParse#getText()
const mammoth = require('mammoth');          // DOCX -> mammoth.extractRawText()

// Memuat variabel lingkungan dari berkas .env (LLM_API_KEY, LLM_MODEL_NAME, dst.).
// Harus dijalankan SEBELUM bagian 1 membaca process.env. Contoh isi: .env.example
const hasilDotenv  = require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const DOTENV_TERMUAT = !hasilDotenv.error;

/* ==========================================================================
 * 1. KONFIGURASI
 * ======================================================================== */

const PORT           = Number(process.env.PORT) || 3000;
const HOST           = process.env.HOST || '0.0.0.0';
const ROOT_DIR       = __dirname;
const UI_DIR         = path.join(ROOT_DIR, 'public');   // berkas frontend (HTML) — lihat bagian 9
const DATA_DIR       = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const UPLOAD_DIR     = path.join(DATA_DIR, 'uploads');
const DB_FILE        = path.join(DATA_DIR, 'hasil-analisis.json');
const USERS_FILE     = path.join(DATA_DIR, 'users.json');        // akun mahasiswa & admin (bagian 2B.1)
const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-config.json');    // konfigurasi penyedia AI (bagian 2B.2)

// Batas ukuran berkas unggahan.
//   MAX_FILE_SIZE  : plafon keras middleware multer. Sengaja tidak dapat diubah
//                    dari panel Admin supaya server tidak kehabisan memori.
//   MAKS_UKURAN_MB : plafon tertinggi yang boleh dipilih Admin pada panel
//                    "Pengaturan AI" (field maksUkuran, 1-50 MB). Batas yang
//                    benar-benar berlaku diambil dari konfigLlm().maksUkuranMb.
const MAX_FILE_SIZE  = 50 * 1024 * 1024;
const MAKS_UKURAN_MB = 50;
// Batas ukuran bawaan yang berlaku (dan tampil pada panel Pengaturan AI).
const MAKS_UKURAN_BAWAAN_MB = 10;

// Format berkas yang lolos filter unggah. Catatan: ".doc" (Word 97-2003) lolos
// filter ini, tetapi ditolak pada tahap ekstraksi teks (lihat bagian 4) karena
// mammoth hanya membaca DOCX; pesannya meminta konversi ke PDF/DOCX.
const ALLOWED_EXT    = ['.pdf', '.doc', '.docx'];

// Ambang minimal jumlah kata hasil ekstraksi. Berkas hasil pemindaian/gambar
// (teksnya tidak terekstraksi) tidak layak dianalisis, jadi ditolak dengan 400.
const MIN_KATA_TEREKSTRAKSI = 10;

// Origin frontend yang diizinkan. Default '*' agar upload.html & result.html
// dapat dipanggil baik dari http://localhost:3000 maupun dari file:// (origin 'null').
const CORS_ORIGIN    = process.env.CORS_ORIGIN || '*';

// ---- Konfigurasi LLM/AI (diisi melalui berkas .env — lihat .env.example) ----
//   LLM_API_KEY       : kunci API penyedia LLM. Dibaca HANYA di backend
//                       (server.js) dan tidak pernah dikirim ke frontend,
//                       tidak pernah ditulis ke log, dan tidak ikut tersimpan.
//   LLM_MODEL_NAME    : nama model, mis. "gpt-4o-mini" / "gemini-2.0-flash"
//                       / "deepseek-chat" (alias lama: LLM_MODEL)
//   LLM_PROVIDER      : 'auto' | 'openai' | 'gemini'
//                       auto -> Gemini bila base URL memuat "generativelanguage"
//                       atau nama model diawali "gemini"; selain itu OpenAI.
//   LLM_BASE_URL      : alamat REST API.
//                       OpenAI : https://api.openai.com/v1
//                       Gemini : https://generativelanguage.googleapis.com/v1beta
//   LLM_TIMEOUT_MS    : batas waktu satu panggilan API, MAKSIMAL 30 detik
//   LLM_MAX_KATA      : batas kata teks yang dikirim, MAKSIMAL 8.000 kata
//   LLM_TEMPERATURE   : kreativitas keluaran (0 = paling konsisten)
//   LLM_JSON_MODE     : 'auto' | 'on' | 'off' -> JSON mode / structured output
//   LLM_FALLBACK_SIMULASI : 'true' -> pakai data mock saat LLM gagal (khusus
//                       demo tanpa kunci API). Default 'false': kegagalan
//                       LLM dikembalikan sebagai HTTP 500 yang rapi.
const LLM_API_KEY     = String(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const LLM_BASE_URL    = String(process.env.LLM_BASE_URL || 'https://api.openai.com/v1')
  .trim().replace(/\/+$/, '');
const LLM_MODEL_NAME  = String(process.env.LLM_MODEL_NAME || process.env.LLM_MODEL
  || 'gpt-4o-mini').trim();
const LLM_PROVIDER    = String(process.env.LLM_PROVIDER || 'auto').trim().toLowerCase();
// Batas waktu panggilan API LLM: maksimal 30 detik sesuai spesifikasi.
const LLM_TIMEOUT_MS  = Math.min(Math.max(Number(process.env.LLM_TIMEOUT_MS) || 30000, 1000), 30000);
// Teks yang dikirim ke LLM: maksimal 8.000 kata pertama (hemat token).
const LLM_MAX_KATA    = Math.min(Math.max(Number(process.env.LLM_MAX_KATA) || 8000, 200), 8000);
const LLM_TEMPERATURE = Number.isFinite(Number(process.env.LLM_TEMPERATURE))
  ? Number(process.env.LLM_TEMPERATURE) : 0.2;
const LLM_JSON_MODE   = String(process.env.LLM_JSON_MODE || 'auto').trim().toLowerCase();
const LLM_FALLBACK_SIMULASI =
  String(process.env.LLM_FALLBACK_SIMULASI || 'false').trim().toLowerCase() === 'true';

/* ==========================================================================
 * 2. PERSIAPAN DIREKTORI & PENYIMPANAN (MEMORI + BERKAS JSON)
 * ======================================================================== */

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Penyimpanan di memori (array) — sumber data utama saat server berjalan. */
let dbHasilAnalisis = [];

/** Memuat riwayat dari berkas JSON saat server dijalankan. */
function muatRiwayat() {
  const parsed = muatJsonBerkas(DB_FILE, []);
  dbHasilAnalisis = Array.isArray(parsed) ? parsed : [];
  if (dbHasilAnalisis.length) {
    console.log(`[db] ${dbHasilAnalisis.length} hasil analisis dimuat dari ${path.relative(ROOT_DIR, DB_FILE)}`);
  }
}

/** Menyimpan riwayat ke berkas JSON secara aman (tulis sementara lalu rename). */
function simpanRiwayat() {
  return simpanJsonBerkas(DB_FILE, dbHasilAnalisis);
}

/* ==========================================================================
 * 2B. PENYIMPANAN PENGGUNA & KONFIGURASI AI
 *     - data/users.json     : akun mahasiswa & Administrator. Kata sandi
 *                             disimpan sebagai hash scrypt, bukan teks biasa.
 *     - data/ai-config.json : konfigurasi penyedia AI dari panel Admin (D4).
 *     Kedua berkas berada di bawah /data sehingga tidak pernah disajikan
 *     melalui HTTP (lihat daftar JALUR_INTERNAL pada bagian 9).
 * ======================================================================== */

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

/* ---- 2B.1 Pengguna (data/users.json) ------------------------------------ */

const PERAN_MAHASISWA = 'Mahasiswa';
const PERAN_ADMIN     = 'Administrator';
const STATUS_AKTIF    = 'Aktif';
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
    const asli     = Buffer.from(bagian[2], 'hex');
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

/** Memuat data pengguna; membuat berkas + akun contoh saat pertama kali jalan. */
function muatPengguna() {
  if (!fs.existsSync(USERS_FILE)) {
    dbPengguna = penggunaBawaan();
    simpanPengguna();
    console.log(`[db] ${path.relative(ROOT_DIR, USERS_FILE)} dibuat dengan `
      + `${dbPengguna.length} akun contoh (1 Mahasiswa, 1 Administrator).`);
    return;
  }

  const parsed = muatJsonBerkas(USERS_FILE, []);
  dbPengguna = Array.isArray(parsed) ? parsed : [];
  console.log(`[db] ${dbPengguna.length} pengguna dimuat dari ${path.relative(ROOT_DIR, USERS_FILE)}`);
}

/** Menyimpan data pengguna ke berkas JSON. */
function simpanPengguna() {
  return simpanJsonBerkas(USERS_FILE, dbPengguna);
}

/** Mencari pengguna berdasarkan email (tanpa membedakan huruf besar/kecil). */
function cariPenggunaEmail(email) {
  const kunci = String(email || '').trim().toLowerCase();
  if (!kunci) return null;
  return dbPengguna.find((u) => String(u.email || '').toLowerCase() === kunci) || null;
}

/* ---- 2B.2 Konfigurasi penyedia AI (data/ai-config.json) ------------------ */

/** Penyedia AI yang dikenali (sama dengan pilihan pada admin-ai.html). */
const PENYEDIA_AI = ['openai', 'gemini', 'anthropic', 'mistral', 'ollama', 'lainnya'];

/** Nilai bawaan konfigurasi AI — mengikuti pengaturan .env (bagian 1). */
function konfigAiBawaan() {
  return {
    aktif: false,
    penyedia: providerAktif(),
    model: LLM_MODEL_NAME,
    endpoint: LLM_BASE_URL,
    apiKey: '',
    suhu: LLM_TEMPERATURE,
    maxToken: 4096,
    timeout: Math.round(LLM_TIMEOUT_MS / 1000),
    ambangTinggi: 50,
    ambangSedang: 20,
    maksUkuran: MAKS_UKURAN_BAWAAN_MB,
    simpanRiwayat: true,
    tampilSumber: true,
    koreksiOtomatis: false,
    diperbarui: null,
    diperbarui_oleh: null,
  };
}

/** Konfigurasi AI aktif di memori. */
let konfigAi = konfigAiBawaan();

/** Memuat konfigurasi AI dari data/ai-config.json (bila sudah pernah disimpan). */
function muatKonfigAi() {
  const tersimpan = muatJsonBerkas(AI_CONFIG_FILE, null);
  konfigAi = tersimpan && typeof tersimpan === 'object' && !Array.isArray(tersimpan)
    ? { ...konfigAiBawaan(), ...tersimpan }
    : konfigAiBawaan();
  return konfigAi;
}

/** Menyimpan konfigurasi AI ke berkas JSON. */
function simpanKonfigAi() {
  return simpanJsonBerkas(AI_CONFIG_FILE, konfigAi);
}

/** Menyamarkan kunci API: hanya 4 karakter terakhir yang terlihat. */
function samarkanKunci(kunci) {
  const teks = String(kunci || '');
  if (!teks) return '';
  return teks.length <= 4 ? '*'.repeat(teks.length) : `${'*'.repeat(8)}${teks.slice(-4)}`;
}

/**
 * Bentuk konfigurasi AI yang aman dikirim ke klien: kunci API disamarkan dan
 * nilai aslinya tidak pernah keluar dari backend.
 */
function publikKonfigAi() {
  return {
    aktif: konfigAi.aktif,
    penyedia: konfigAi.penyedia,
    model: konfigAi.model,
    endpoint: konfigAi.endpoint,
    apiKey: samarkanKunci(konfigAi.apiKey),
    apiKey_tersimpan: String(konfigAi.apiKey || '').length > 0,
    suhu: konfigAi.suhu,
    maxToken: konfigAi.maxToken,
    timeout: konfigAi.timeout,
    ambangTinggi: konfigAi.ambangTinggi,
    ambangSedang: konfigAi.ambangSedang,
    maksUkuran: konfigAi.maksUkuran,
    simpanRiwayat: konfigAi.simpanRiwayat !== false,
    tampilSumber: konfigAi.tampilSumber !== false,
    koreksiOtomatis: konfigAi.koreksiOtomatis === true,
    diperbarui: konfigAi.diperbarui || null,
    diperbarui_oleh: konfigAi.diperbarui_oleh || null,
  };
}

/* ==========================================================================
 * 3. UTILITAS
 * ======================================================================== */

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

/* ==========================================================================
 * 4. EKSTRAKSI TEKS DOKUMEN — pdf-parse (PDF) & mammoth (DOCX)
 *    Mengubah berkas unggahan menjadi TEKS NYATA yang siap dianalisis.
 *    Skor/klasifikasi tetap mock, tetapi masukan teksnya sudah asli.
 * ======================================================================== */

/**
 * Menentukan cara ekstraksi berdasarkan ekstensi/MIME berkas.
 * @returns {'pdf'|'docx'|null} null bila format belum didukung ekstraksi
 */
function jenisDokumenEkstraksi(filePath, mimeType) {
  const ekstensi = path.extname(String(filePath || '')).toLowerCase();
  const mime     = String(mimeType || '').toLowerCase();

  if (ekstensi === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (
    ekstensi === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  return null;
}

/** Merapikan teks hasil ekstraksi: seragamkan baris baru & buang spasi berlebih. */
function rapikanTeks(teks) {
  return String(teks || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Menghitung jumlah kata dari teks yang sudah dirapikan. */
function hitungKata(teks) {
  const bersih = String(teks || '').trim();
  return bersih ? bersih.split(/\s+/).length : 0;
}

/**
 * Mengekstraksi teks dari berkas dokumen yang tersimpan di disk.
 *   PDF  -> pdf-parse : new PDFParse({ data }).getText()
 *   DOCX -> mammoth   : mammoth.extractRawText({ path })
 *
 * @param {string} filePath jalur berkas hasil unggahan (sudah tersimpan)
 * @param {string} mimeType mime type dari multer (sebagai cadangan ekstensi)
 * @param {string} [namaAsli] nama berkas asli dari pengguna (untuk pesan galat)
 * @returns {Promise<{format:string, teks:string, karakter:number, kata:number, halaman:number|null}>}
 * @throws {AppError} 400 bila berkas rusak, terproteksi, atau teks tidak terekstraksi
 */
async function ekstraksiTeksDokumen(filePath, mimeType, namaAsli) {
  const namaBerkas = String(namaAsli || path.basename(String(filePath || '')));
  const format     = jenisDokumenEkstraksi(filePath, mimeType);

  /* ---- Format belum didukung ekstraksi (mis. .doc Word 97-2003) ---- */
  if (!format) {
    const ekstensi = path.extname(String(filePath || '')).toLowerCase() || '(tanpa ekstensi)';
    throw new AppError(400,
      `Berkas "${namaBerkas}" berformat ${ekstensi} sehingga teksnya belum dapat diekstraksi. ` +
      'Simpan ulang dokumen sebagai PDF atau DOCX (.docx), lalu unggah kembali.',
      { format: ekstensi });
  }

  let teks    = '';
  let halaman = null;

  try {
    if (format === 'pdf') {
      const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
      try {
        const keluaran = await parser.getText();
        teks    = keluaran.text;
        halaman = keluaran.total || (Array.isArray(keluaran.pages) ? keluaran.pages.length : null);
      } finally {
        await parser.destroy().catch(() => { /* sudah dilepas -> diabaikan */ });
      }
    } else {
      const keluaran = await mammoth.extractRawText({ path: filePath });
      teks = keluaran.value;
    }
  } catch (err) {
    throw new AppError(400,
      `Berkas "${namaBerkas}" tidak dapat dibaca (${err.message}). ` +
      'Pastikan berkas PDF/DOCX tidak rusak dan tidak terproteksi kata sandi.',
      { format, penyebab: err.message });
  }

  const teksBersih = rapikanTeks(teks);
  const jumlahKata = hitungKata(teksBersih);

  /* ---- Teks kosong / terlalu pendek (mis. PDF hasil pemindaian) ---- */
  if (!teksBersih || jumlahKata < MIN_KATA_TEREKSTRAKSI) {
    const pesan = !teksBersih
      ? `Teks tidak dapat diekstraksi dari berkas "${namaBerkas}". ` +
        'Kemungkinan dokumen hasil pemindaian (gambar) tanpa lapisan teks. ' +
        'Unggah PDF/DOCX yang teksnya dapat diseleksi, bukan hasil scan.'
      : `Teks dari berkas "${namaBerkas}" terlalu pendek (${jumlahKata} kata). ` +
        `Minimal ${MIN_KATA_TEREKSTRAKSI} kata agar dapat dianalisis.`;
    throw new AppError(400, pesan, { format, jumlah_kata: jumlahKata });
  }

  return {
    format,
    teks: teksBersih,
    karakter: teksBersih.length,
    kata: jumlahKata,
    halaman,
  };
}

/** Meringkas hasil ekstraksi untuk disimpan pada rekaman hasil analisis. */
function ringkasEkstraksi(ekstraksi) {
  return {
    format: ekstraksi.format,
    jumlah_karakter: ekstraksi.karakter,
    jumlah_kata: ekstraksi.kata,
    jumlah_halaman: ekstraksi.halaman,
    cuplikan: ekstraksi.teks.slice(0, 300),
  };
}

/* ==========================================================================
 * 5. ANALISIS DOKUMEN DENGAN LLM (REST API + JSON MODE)
 *    Jalur utama: teks hasil ekstraksi (bagian 4) dikirim ke LLM melalui REST
 *    API dan diminta balas JSON terstruktur. Fungsi mock lama
 *    simulasikanAnalisis() kini hanya dipakai sebagai FALLBACK (5.7) agar
 *    aplikasi tetap dapat didemokan tanpa kunci API.
 * ======================================================================== */

/* ---- 5.1 Ambang klasifikasi & struktur yang diperiksa ------------------- */
/**
 * Ambang klasifikasi indikasi plagiarisme.
 * Nilai ambang mengikuti panel Admin ("Pengaturan AI"): ambangTinggi (bawaan 50)
 * dan ambangSedang (bawaan 20), sehingga Admin dapat menyesuaikannya tanpa
 * mengubah kode.
 *   >= ambangTinggi -> Tinggi
 *   >= ambangSedang -> Sedang
 *   <  ambangSedang -> Rendah
 */
function klasifikasiIndikasi(skor) {
  const ambang = konfigLlm();
  if (skor >= ambang.ambangTinggi) return 'Tinggi';
  if (skor >= ambang.ambangSedang) return 'Sedang';
  return 'Rendah';
}

/** Kunci structure_analysis yang wajib ada pada keluaran LLM. */
const STRUKTUR_DOKUMEN = [
  'Cover / Halaman Judul',
  'Bab I Pendahuluan',
  'Bab II Tinjauan Pustaka',
  'Bab III Metodologi',
];

/**
 * Alias nama bagian yang sering dipakai LLM (angka Romawi/Arab, nama pendek).
 * Pencocokan dilakukan setelah tanda baca & spasi dibuang (lihat kunciLonggar).
 */
const ALIAS_STRUKTUR = {
  'Cover / Halaman Judul': ['cover / halaman judul', 'cover', 'halaman judul', 'judul'],
  'Bab I Pendahuluan':     ['bab i pendahuluan', 'bab 1 pendahuluan', 'pendahuluan', 'bab i'],
  'Bab II Tinjauan Pustaka': ['bab ii tinjauan pustaka', 'bab 2 tinjauan pustaka', 'tinjauan pustaka', 'bab ii'],
  'Bab III Metodologi':    ['bab iii metodologi', 'bab 3 metodologi', 'metodologi', 'metode penelitian', 'bab iii'],
};

/* ---- 5.2 Utilitas konversi & pembatas nilai ----------------------------- */

/** Mengubah nilai apa pun menjadi angka; NaN bila tidak dapat dikonversi. */
function keAngka(nilai, bawaan = NaN) {
  const angka = Number(nilai);
  return Number.isFinite(angka) ? angka : bawaan;
}

/** Membatasi angka pada rentang min..max. */
function batasiAngka(nilai, min, max) {
  if (!Number.isFinite(nilai)) return nilai;
  return Math.min(Math.max(nilai, min), max);
}

/** Mengubah nilai apa pun (true / 'true' / 'ya' / 1) menjadi boolean. */
function keBoolean(nilai) {
  if (typeof nilai === 'boolean') return nilai;
  const teks = String(nilai === undefined || nilai === null ? '' : nilai).trim().toLowerCase();
  return ['true', 'ya', 'yes', '1', 'ada', 'terdapat', 'lengkap'].includes(teks);
}

/** Menyeragamkan kunci untuk pencocokan longgar (huruf kecil, tanpa simbol). */
function kunciLonggar(teks) {
  return String(teks || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* ---- 5.3 Konfigurasi LLM efektif --------------------------------------- */
/**
 * Nilai dasar LLM tetap berasal dari .env (bagian 1). Namun begitu Admin
 * menyimpan konfigurasi pada panel "Pengaturan AI", berkas data/ai-config.json
 * (bagian 2B.2) menimpa nilai dasar itu — termasuk kunci API, model, ambang
 * klasifikasi, dan batas ukuran berkas. Dengan cara ini panel Admin benar-benar
 * mengendalikan analisis LLM saat aplikasi berjalan.
 */

/** true bila panel Admin pernah menyimpan konfigurasi ke data/ai-config.json. */
function panelAiTersimpan() {
  return fs.existsSync(AI_CONFIG_FILE);
}

/**
 * Penyedia AI yang dipakai runtime: 'gemini' (gaya generateContent) atau
 * 'openai' (gaya chat/completions). Pilihan panel Admin dipakai bila berkas
 * konfigurasinya sudah tersimpan; bila belum, penyedia ditebak dari .env.
 * Penyedia 'anthropic', 'mistral', 'ollama', dan 'lainnya' memakai gaya
 * chat/completions karena alamatnya diatur sendiri oleh Admin.
 */
function penyediaEfektif() {
  const pilihan = panelAiTersimpan() ? String(konfigAi.penyedia || '').toLowerCase() : '';
  if (PENYEDIA_AI.includes(pilihan)) return pilihan === 'gemini' ? 'gemini' : 'openai';
  return providerAktif();
}

/**
 * Konfigurasi LLM yang benar-benar dipakai untuk analisis dokumen.
 * Nilai dari panel Admin diambil apa adanya (sudah divalidasi saat disimpan),
 * lalu dibatasi lagi di sini sebagai sabuk pengaman.
 * @returns {{aktif:boolean, dariPanel:boolean, penyedia:string, model:string,
 *   endpoint:string, apiKey:string, butuhKunci:boolean, suhu:number,
 *   maxToken:number, timeoutDetik:number, timeoutMs:number, ambangTinggi:number,
 *   ambangSedang:number, maksUkuranMb:number, simpanRiwayat:boolean,
 *   tampilSumber:boolean, koreksiOtomatis:boolean}}
 */
function konfigLlm() {
  const dariPanel  = panelAiTersimpan();
  const penyedia   = penyediaEfektif();
  const penyediaPanel = dariPanel ? String(konfigAi.penyedia || '').toLowerCase() : '';
  const timeoutDetik = batasiAngka(keAngka(konfigAi.timeout, LLM_TIMEOUT_MS / 1000), 5, 120);

  return {
    // Bila panel belum pernah disimpan, layanan mengikuti .env (aktif).
    aktif: dariPanel ? konfigAi.aktif === true : true,
    dariPanel,
    penyedia,
    // Penyedia lokal (ollama) tidak memerlukan kunci API.
    butuhKunci: penyediaPanel !== 'ollama',
    model: String(konfigAi.model || LLM_MODEL_NAME).trim() || LLM_MODEL_NAME,
    endpoint: String(konfigAi.endpoint || LLM_BASE_URL).trim().replace(/\/+$/, '') || LLM_BASE_URL,
    apiKey: String(konfigAi.apiKey || '').trim() || LLM_API_KEY,
    suhu: batasiAngka(keAngka(konfigAi.suhu, LLM_TEMPERATURE), 0, 1),
    maxToken: batasiAngka(keAngka(konfigAi.maxToken, 4096), 256, 32000),
    timeoutDetik,
    // Spesifikasi membatasi satu panggilan LLM maksimal 30 detik.
    timeoutMs: Math.min(Math.round(timeoutDetik * 1000), 30000),
    ambangTinggi: batasiAngka(keAngka(konfigAi.ambangTinggi, 50), 1, 100),
    ambangSedang: batasiAngka(keAngka(konfigAi.ambangSedang, 20), 0, 100),
    maksUkuranMb: batasiAngka(keAngka(konfigAi.maksUkuran, MAKS_UKURAN_BAWAAN_MB),
      1, MAKS_UKURAN_MB),
    simpanRiwayat: konfigAi.simpanRiwayat !== false,
    tampilSumber: konfigAi.tampilSumber !== false,
    // Belum dipakai runtime: hanya disimpan sebagai pilihan panel Admin.
    koreksiOtomatis: konfigAi.koreksiOtomatis === true,
  };
}

/** true bila layanan AI diaktifkan dan kunci API-nya tersedia. */
function llmSiap() {
  const k = konfigLlm();
  return k.aktif && (!k.butuhKunci || k.apiKey.length > 0);
}

/** Host endpoint LLM (tanpa kunci API) untuk ditampilkan pada log & rekaman. */
function hostLLM() {
  const endpoint = konfigLlm().endpoint;
  try {
    return new URL(endpoint).host;
  } catch (err) {
    return endpoint;
  }
}

/** Alamat chat/completions lengkap (endpoint panel boleh sudah lengkap). */
function alamatOpenAI(k) {
  return /\/chat\/completions$/i.test(k.endpoint) ? k.endpoint : `${k.endpoint}/chat/completions`;
}

/** Alamat generateContent Gemini lengkap (endpoint panel boleh sudah lengkap). */
function alamatGemini(k) {
  const dasar = /\/models$/i.test(k.endpoint) ? k.endpoint.replace(/\/models$/i, '') : k.endpoint;
  return `${dasar}/models/${encodeURIComponent(k.model)}:generateContent`;
}

/**
 * Penyedia LLM yang dipakai: 'openai' (gaya /chat/completions) atau 'gemini'.
 * LLM_PROVIDER=auto menebak dari base URL dan nama model.
 */
function providerAktif() {
  if (LLM_PROVIDER === 'openai' || LLM_PROVIDER === 'gemini') return LLM_PROVIDER;
  const dasar = LLM_BASE_URL.toLowerCase();
  if (dasar.includes('generativelanguage') || dasar.includes('gemini')) return 'gemini';
  if (/^gemini/i.test(LLM_MODEL_NAME)) return 'gemini';
  return 'openai';
}

/* ---- 5.4 Prompt engineering (peran, aturan, skema JSON) ----------------- */

/** Skema keluaran terstruktur yang diminta dari LLM. */
const SKEMA_KELUARAN = {
  overall_similarity_score: 'number 0-100',
  classification_level: '"Rendah" | "Sedang" | "Tinggi"',
  structure_analysis: {
    'Cover / Halaman Judul': 'boolean',
    'Bab I Pendahuluan': 'boolean',
    'Bab II Tinjauan Pustaka': 'boolean',
    'Bab III Metodologi': 'boolean',
  },
  flagged_passages: [
    {
      text: 'string (kutipan persis dari dokumen, maksimal 300 karakter)',
      similarity_percentage: 'number 0-100',
      source_reference: 'string (perkiraan sumber/referensi)',
    },
  ],
};

/** Prompt sistem — instruksi KETAT sesuai spesifikasi (bagian 5.4). */
const PROMPT_SISTEM_INTI = 'Anda adalah sistem penguji orisinalitas dokumen akademik '
  + 'proposal dan laporan TA. Tugas Anda adalah menganalisis teks yang diberikan, '
  + 'mengidentifikasi indikasi kemiripan/plagiarisme, memeriksa kelengkapan struktur bab, '
  + 'dan mengembalikan keluaran STRICTLY dalam format JSON tanpa teks tambahan di luar JSON.';

/**
 * System message lengkap: instruksi ketat di atas, dilanjutkan skema JSON dan
 * aturan penilaian. Skema disertakan agar keluaran benar-benar terstruktur
 * (nama kunci sama persis), bukan hanya "JSON yang valid".
 *
 * Ambang klasifikasi pada aturan diambil dari konfigurasi efektif (konfigLlm)
 * sehingga prompt selalu sejalan dengan ambang yang dipakai server saat
 * menetapkan classification_level pada rekaman hasil.
 * @returns {string} system message untuk LLM
 */
function promptSistem() {
  const k = konfigLlm();

  return [
    PROMPT_SISTEM_INTI,
    '',
    'SKEMA JSON YANG WAJIB DIIKUTI (nama kunci sama persis, tanpa kunci tambahan):',
    JSON.stringify(SKEMA_KELUARAN, null, 2),
    '',
    'ATURAN',
    '- Balas HANYA satu objek JSON valid: tanpa penjelasan, tanpa markdown, tanpa pagar kode.',
    '- overall_similarity_score: bilangan 0-100 (persentase kemiripan keseluruhan).',
    `- classification_level: "Rendah" bila skor < ${k.ambangSedang}, `
      + `"Sedang" bila ${k.ambangSedang}-${k.ambangTinggi - 1}, `
      + `"Tinggi" bila >= ${k.ambangTinggi}.`,
    '- structure_analysis: bernilai boolean; true hanya bila bagian itu benar-benar ada di dokumen.',
    '- flagged_passages: maksimal 10 temuan, diurutkan dari persentase terbesar.',
    '- Isi "text" dengan kutipan PERSIS dari dokumen, bukan karangan (maksimal 300 karakter).',
    '- Bila tidak ada indikasi kemiripan, kirim flagged_passages sebagai array kosong.',
    '- Seluruh isi balasan memakai bahasa Indonesia.',
  ].join('\n');
}

/**
 * Menyusun pesan yang dikirim ke LLM: prompt sistem + data dokumen.
 * @param {object} meta metadata dokumen (nim, nama, judul, jenis_dokumen)
 * @param {string} teks teks dokumen yang akan dianalisis
 * @param {{dipotong:boolean, totalKata:number}} infoPanjang keterangan panjang teks
 * @returns {{system:string, user:string}}
 */
function susunPromptAnalisis(meta, teks, infoPanjang) {
  return {
    system: promptSistem(),
    user: [
      'DATA DOKUMEN',
      `- NIM            : ${meta.nim}`,
      `- Nama Mahasiswa : ${meta.nama}`,
      `- Judul          : ${meta.judul}`,
      `- Jenis Dokumen  : ${meta.jenis_dokumen}`,
      `- Jumlah Kata    : ${infoPanjang.totalKata}`
        + (infoPanjang.dipotong ? ' (hanya sebagian awal yang dikirim)' : ''),
      '',
      'TEKS DOKUMEN',
      '"""',
      teks,
      '"""',
      '',
      'Analisis dokumen di atas, lalu balas dengan satu objek JSON sesuai skema.',
    ].join('\n'),
  };
}

/**
 * Memotong teks dokumen agar tidak melebihi LLM_MAX_KATA sebelum dikirim,
 * supaya biaya token tetap terkendali.
 * @returns {{teks:string, dipotong:boolean, kataTerkirim:number}}
 */
function siapkanTeksUntukLLM(teks) {
  const kata = String(teks || '').split(/\s+/).filter(Boolean);
  if (kata.length <= LLM_MAX_KATA) {
    return { teks: kata.join(' '), dipotong: false, kataTerkirim: kata.length };
  }
  return {
    teks: `${kata.slice(0, LLM_MAX_KATA).join(' ')}\n`
      + `[...teks dipotong pada ${LLM_MAX_KATA} kata pertama dari total ${kata.length} kata...]`,
    dipotong: true,
    kataTerkirim: LLM_MAX_KATA,
  };
}

/* ---- 5.5 Pemanggilan REST API LLM --------------------------------------- */

/** Ringkasan pesan galat dari penyedia LLM — aman, tanpa membocorkan kunci. */
function ringkasGalatLLM(teksRespons) {
  try {
    const data = JSON.parse(teksRespons);
    const pesan = data && data.error && (data.error.message || data.error.type);
    if (pesan) return `Pesan penyedia: ${String(pesan).slice(0, 300)}`;
  } catch (err) { /* bukan JSON -> pakai teks mentah */ }
  const potongan = String(teksRespons || '').trim().slice(0, 300);
  return potongan ? `Respons: ${potongan}` : '';
}

/** Menyusun AppError dari respons galat penyedia LLM (aman, tanpa kunci API). */
function galatDariPenyedia(status, teksRespons) {
  const saran = (status === 401 || status === 403)
    ? ' Periksa kembali kunci API pada panel "Pengaturan AI" '
      + '(tersimpan di data/ai-config.json) atau LLM_API_KEY pada berkas .env.'
    : '';
  return new AppError(status === 400 ? 400 : 502,
    `Layanan LLM menolak permintaan (HTTP ${status}).${saran} `
    + ringkasGalatLLM(teksRespons),
    { status_llm: status });
}

/**
 * Satu panggilan API LLM memakai konfigurasi efektif (konfigLlm): model,
 * suhu, batas token, kunci API, dan batas waktu dari panel Admin/.env.
 * Penyedia (OpenAI/Gemini) dipilih oleh penyediaEfektif().
 * @param {{system:string, user:string}} prompt
 * @param {boolean} pakaiJsonMode gunakan JSON mode / structured output
 * @returns {Promise<{isi:string, model:string, penggunaan:object|null}>}
 * @throws {AppError} 400/502/504 bila panggilan gagal
 */
async function kirimPermintaanLLM(prompt, pakaiJsonMode) {
  const k = konfigLlm();
  const pengendali = new AbortController();
  const pewaktu = setTimeout(() => pengendali.abort(), k.timeoutMs);

  try {
    return k.penyedia === 'gemini'
      ? await panggilApiGemini(prompt, pakaiJsonMode, pengendali.signal)
      : await panggilApiOpenAI(prompt, pakaiJsonMode, pengendali.signal);
  } catch (err) {
    if (err instanceof AppError) throw err;   // galat dari penyedia -> teruskan
    if (err.name === 'AbortError') {
      throw new AppError(504, `Panggilan API LLM melebihi batas waktu ${k.timeoutMs} ms.`);
    }
    throw new AppError(502,
      `Gagal menghubungi layanan LLM di ${k.endpoint} (${err.message}).`);
  } finally {
    clearTimeout(pewaktu);
  }
}

/** Panggilan OpenAI API (termasuk penyedia kompatibel): POST {base}/chat/completions. */
async function panggilApiOpenAI(prompt, pakaiJsonMode, signal) {
  const k = konfigLlm();
  const muatan = {
    model: k.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: k.suhu,
    max_tokens: k.maxToken,
  };
  if (pakaiJsonMode) muatan.response_format = { type: 'json_object' }; // JSON mode

  const res = await fetch(alamatOpenAI(k), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${k.apiKey}`, // kunci API hanya dipakai di backend
    },
    body: JSON.stringify(muatan),
    signal,
  });

  const isiRespons = await res.text();
  if (!res.ok) throw galatDariPenyedia(res.status, isiRespons);

  let data;
  try {
    data = JSON.parse(isiRespons);
  } catch (err) {
    throw new AppError(502, 'Respons LLM bukan JSON yang valid.');
  }

  const isi = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;

  if (!isi || !String(isi).trim()) {
    throw new AppError(502,
      'Respons LLM tidak memuat isi analisis (choices[0].message.content kosong).');
  }

  return {
    isi: String(isi),
    model: data.model || k.model,
    penggunaan: data.usage || null,
  };
}

/** Panggilan Gemini API: POST {base}/models/{model}:generateContent. */
async function panggilApiGemini(prompt, pakaiJsonMode, signal) {
  const k = konfigLlm();
  const generationConfig = {
    temperature: k.suhu,
    maxOutputTokens: k.maxToken,
  };
  if (pakaiJsonMode) generationConfig.responseMimeType = 'application/json'; // JSON mode

  const res = await fetch(alamatGemini(k), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Kunci dikirim lewat header (bukan query string) agar tidak bocor ke log URL.
      'x-goog-api-key': k.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      generationConfig,
    }),
    signal,
  });

  const isiRespons = await res.text();
  if (!res.ok) throw galatDariPenyedia(res.status, isiRespons);

  let data;
  try {
    data = JSON.parse(isiRespons);
  } catch (err) {
    throw new AppError(502, 'Respons Gemini bukan JSON yang valid.');
  }

  const kandidat = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const bagian = kandidat && kandidat.content && Array.isArray(kandidat.content.parts)
    ? kandidat.content.parts : [];
  const isi = bagian.map((p) => (p && p.text) || '').join('').trim();

  if (!isi) {
    const blokir = data && data.promptFeedback && data.promptFeedback.blockReason
      ? ` Permintaan diblokir oleh Gemini (${data.promptFeedback.blockReason}).`
      : '';
    throw new AppError(502, `Respons Gemini tidak memuat isi analisis.${blokir}`,
      { finish_reason: (kandidat && kandidat.finishReason) || null });
  }

  const penggunaan = data.usageMetadata ? {
    prompt_tokens: data.usageMetadata.promptTokenCount === undefined
      ? null : data.usageMetadata.promptTokenCount,
    completion_tokens: data.usageMetadata.candidatesTokenCount === undefined
      ? null : data.usageMetadata.candidatesTokenCount,
    total_tokens: data.usageMetadata.totalTokenCount === undefined
      ? null : data.usageMetadata.totalTokenCount,
  } : null;

  return { isi, model: data.modelVersion || k.model, penggunaan };
}

/**
 * Mengirim prompt ke LLM dan mengembalikan isi balasannya.
 * Pada LLM_JSON_MODE=auto, bila penyedia menolak JSON mode (HTTP 400),
 * panggilan diulang sekali tanpa JSON mode.
 * @returns {Promise<{isi:string, model:string, penggunaan:object|null,
 *                    json_mode:boolean, percobaan:number}>}
 * @throws {AppError} 400/502/504 bila panggilan gagal
 */
async function panggilLLM(prompt) {
  let pakaiJsonMode = LLM_JSON_MODE !== 'off';
  const bolehUlang  = LLM_JSON_MODE === 'auto';
  let percobaan     = 0;

  for (;;) {
    percobaan += 1;
    try {
      const keluaran = await kirimPermintaanLLM(prompt, pakaiJsonMode);
      return { ...keluaran, json_mode: pakaiJsonMode, percobaan };
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 400 && bolehUlang && pakaiJsonMode) {
        console.warn('[llm] JSON mode ditolak penyedia (HTTP 400); '
          + 'mencoba ulang tanpa JSON mode.');
        pakaiJsonMode = false;
        continue;
      }
      throw err;
    }
  }
}

/* ---- 5.6 Membaca & memvalidasi keluaran LLM ----------------------------- */

/** Mengubah teks balasan LLM menjadi objek JSON (toleran terhadap markdown). */
function uraiKeluaranLLM(teks) {
  let isi = String(teks || '').trim();
  if (!isi) throw new AppError(502, 'Keluaran LLM kosong.');

  // Buang pembungkus markdown ```json ... ``` bila ada.
  const pagar = isi.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (pagar) isi = pagar[1].trim();

  try {
    return JSON.parse(isi);
  } catch (err) { /* lanjut: ambil objek JSON yang tampak paling lengkap */ }

  const awal  = isi.indexOf('{');
  const akhir = isi.lastIndexOf('}');
  if (awal !== -1 && akhir > awal) {
    try {
      return JSON.parse(isi.slice(awal, akhir + 1));
    } catch (err) { /* gagal juga */ }
  }

  throw new AppError(502, 'Keluaran LLM tidak dapat dibaca sebagai JSON terstruktur.',
    { cuplikan: isi.slice(0, 300) });
}

/**
 * Memvalidasi & menormalkan keluaran LLM agar selalu sesuai kontrak frontend
 * (result.html): skor 0-100, klasifikasi Rendah/Sedang/Tinggi, 4 kunci
 * structure_analysis, dan daftar flagged_passages.
 * @throws {AppError} 502 bila bentuk data tidak dapat dipakai
 */
function normalisasiHasilLLM(mentah) {
  if (!mentah || typeof mentah !== 'object' || Array.isArray(mentah)) {
    throw new AppError(502, 'Keluaran LLM bukan objek JSON.');
  }

  /* ---- skor kemiripan ---- */
  const nilaiSkor = mentah.overall_similarity_score !== undefined
    ? mentah.overall_similarity_score
    : (mentah.skor !== undefined ? mentah.skor : mentah.similarity_score);
  const skor = batasiAngka(keAngka(nilaiSkor), 0, 100);
  if (!Number.isFinite(skor)) {
    throw new AppError(502,
      'Keluaran LLM tidak memuat "overall_similarity_score" berupa angka.');
  }

  /* ---- klasifikasi ---- */
  const labelKlasifikasi = String(mentah.classification_level || mentah.klasifikasi || '')
    .trim().toLowerCase();
  const klasifikasi = ['Rendah', 'Sedang', 'Tinggi']
    .find((k) => k.toLowerCase() === labelKlasifikasi) || klasifikasiIndikasi(skor);

  /* ---- kelengkapan struktur (pencocokan nama kunci secara longgar) ---- */
  const mentahStruktur = mentah.structure_analysis || mentah.struktur || {};
  const petaStruktur   = new Map();
  if (mentahStruktur && typeof mentahStruktur === 'object' && !Array.isArray(mentahStruktur)) {
    Object.keys(mentahStruktur).forEach((kunci) => {
      petaStruktur.set(kunciLonggar(kunci), keBoolean(mentahStruktur[kunci]));
    });
  }

  const structure_analysis = {};
  STRUKTUR_DOKUMEN.forEach((nama) => {
    const alias = ALIAS_STRUKTUR[nama] || [nama];
    const nilaiDitemukan = alias
      .map((a) => petaStruktur.get(kunciLonggar(a)))
      .filter((v) => v !== undefined);
    // Tidak disebut LLM -> dianggap belum terdeteksi (false).
    structure_analysis[nama] = nilaiDitemukan.length ? nilaiDitemukan.some(Boolean) : false;
  });

  /* ---- kutipan terindikasi ---- */
  const mentahTemuan = Array.isArray(mentah.flagged_passages)
    ? mentah.flagged_passages
    : (Array.isArray(mentah.temuan) ? mentah.temuan : []);

  const flagged_passages = mentahTemuan
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const nilaiPersen = t.similarity_percentage !== undefined
        ? t.similarity_percentage
        : t.similarity;
      return {
        text: String(t.text || t.kutipan || t.teks || '').trim().slice(0, 500),
        similarity_percentage: Math.round(batasiAngka(keAngka(nilaiPersen, 0), 0, 100)),
        source_reference: String(t.source_reference || t.sumber || t.referensi
          || 'Tidak disebutkan').trim(),
      };
    })
    .filter((t) => t.text.length > 0)
    .slice(0, 25);

  return {
    status: 'success',
    overall_similarity_score: Math.round(skor),
    classification_level: klasifikasi,
    structure_analysis,
    flagged_passages,
  };
}

/**
 * Analisis dokumen memakai LLM sungguhan.
 * @returns {Promise<{hasil:object, info:object}>}
 * @throws {AppError} 502/504 bila layanan LLM gagal atau keluarannya tidak sah
 */
async function analisisDenganLLM(meta, ekstraksi) {
  const teksSiap = siapkanTeksUntukLLM(ekstraksi.teks);
  const prompt   = susunPromptAnalisis(meta, teksSiap.teks, {
    dipotong: teksSiap.dipotong,
    totalKata: ekstraksi.kata,
  });

  const mulai = Date.now();
  const balasan = await panggilLLM(prompt);
  const hasil   = normalisasiHasilLLM(uraiKeluaranLLM(balasan.isi));

  return {
    hasil,
    info: {
      mode: 'llm',
      label: `llm-${penyediaEfektif()}-v1 (${balasan.model})`,
      model: balasan.model,
      endpoint_host: hostLLM(),
      json_mode: balasan.json_mode,
      percobaan: balasan.percobaan,
      durasi_ms: Date.now() - mulai,
      jumlah_kata_terkirim: teksSiap.kataTerkirim,
      teks_dipotong: teksSiap.dipotong,
      token: balasan.penggunaan ? {
        prompt: balasan.penggunaan.prompt_tokens === undefined ? null : balasan.penggunaan.prompt_tokens,
        completion: balasan.penggunaan.completion_tokens === undefined ? null : balasan.penggunaan.completion_tokens,
        total: balasan.penggunaan.total_tokens === undefined ? null : balasan.penggunaan.total_tokens,
      } : null,
      peringatan: null,
    },
  };
}

/* ---- 5.7 FALLBACK simulasi (hanya bila LLM_FALLBACK_SIMULASI=true) ------- */

/** Template kutipan terindikasi untuk fallback simulasi. */
const CONTOH_KUTIPAN = {
  text: 'Pengembangan aplikasi deteksi plagiarisme menggunakan kecerdasan buatan berbasis Large Language Model...',
  similarity_percentage: 85,
  source_reference: "Repository TA 2024 - 'Deteksi Plagiat Teks Menggunakan LLM'",
};

/**
 * FALLBACK: balasan JSON tiruan (data mock progress 30%).
 * Dipakai HANYA bila LLM_FALLBACK_SIMULASI=true, yaitu untuk demo tanpa kunci
 * API. Pada pengaturan bawaan (false), kegagalan LLM dibalas HTTP 500.
 * @returns {object} hasil analisis inti (metadata ditambahkan analisisDokumen)
 */
function simulasikanAnalisis() {
  const skor = 28; // skor simulasi tetap sesuai spesifikasi progress 30%

  return {
    status: 'success',
    overall_similarity_score: skor,
    classification_level: klasifikasiIndikasi(skor),
    structure_analysis: {
      'Cover / Halaman Judul': true,
      'Bab I Pendahuluan': true,
      'Bab II Tinjauan Pustaka': true,
      'Bab III Metodologi': false,
    },
    flagged_passages: [
      {
        text: CONTOH_KUTIPAN.text,
        similarity_percentage: CONTOH_KUTIPAN.similarity_percentage,
        source_reference: CONTOH_KUTIPAN.source_reference,
      },
    ],
  };
}

/** Info mesin analisis ketika jalur fallback simulasi yang dipakai. */
function infoFallback(peringatan) {
  return {
    mode: 'simulasi-fallback',
    label: 'simulasi-llm-v1 (fallback, mock data progress 30%)',
    model: null,
    endpoint_host: null,
    json_mode: null,
    percobaan: 0,
    durasi_ms: 0,
    jumlah_kata_terkirim: null,
    teks_dipotong: false,
    token: null,
    peringatan,
  };
}

/** Melengkapi hasil analisis dengan metadata dokumen & ringkasan teks. */
function lengkapiAnalisis(hasilInti, meta, ekstraksi) {
  return {
    ...hasilInti,
    document_metadata: {
      nim: meta.nim,
      nama: meta.nama,
      judul: meta.judul,
      jenis_dokumen: meta.jenis_dokumen,
    },
    // Ringkasan teks nyata hasil ekstraksi (bagian 4) yang dikirim ke LLM.
    teks_dokumen: ringkasEkstraksi(ekstraksi),
  };
}

/**
 * Menjalankan analisis dokumen memakai LLM yang sesungguhnya.
 *
 * Ketentuan kegagalan (bagian 4 spesifikasi): bila panggilan LLM gagal karena
 * error API, timeout, atau JSON tidak sah, hasilnya adalah AppError berstatus
 * 500 dengan pesan yang rapi — server Node.js tetap berjalan (tidak crash).
 * Khusus demo tanpa kunci API, LLM_FALLBACK_SIMULASI=true mengaktifkan data
 * mock sebagai ganti error.
 *
 * @param {object} meta metadata dokumen
 * @param {object} ekstraksi hasil ekstraksiTeksDokumen()
 * @returns {Promise<{analisis:object, info:object}>}
 * @throws {AppError} 500 bila analisis LLM gagal dan fallback dimatikan
 */
async function analisisDokumen(meta, ekstraksi) {
  /* ---- LLM belum dikonfigurasi ---- */
  if (!llmSiap()) {
    const pesan = 'Analisis AI belum dikonfigurasi: aktifkan layanan AI dan isi kunci API '
      + 'pada panel Admin "Pengaturan AI" (data/ai-config.json), atau isi LLM_API_KEY pada berkas .env.';
    if (!LLM_FALLBACK_SIMULASI) {
      console.error(`[llm] ${pesan}`);
      throw new AppError(500, pesan, {
        penyedia: penyediaEfektif(), model: konfigLlm().model, llm_dikonfigurasi: false,
      });
    }
    console.warn(`[llm] ${pesan} -> memakai fallback simulasi (LLM_FALLBACK_SIMULASI=true).`);
    return {
      analisis: lengkapiAnalisis(simulasikanAnalisis(), meta, ekstraksi),
      info: infoFallback(pesan),
    };
  }

  /* ---- Panggilan LLM: error API / timeout / JSON tidak sah ---- */
  try {
    const keluaran = await analisisDenganLLM(meta, ekstraksi);
    return {
      analisis: lengkapiAnalisis(keluaran.hasil, meta, ekstraksi),
      info: keluaran.info,
    };
  } catch (err) {
    const sebab = err.message || 'kesalahan tidak dikenal pada layanan LLM';

    if (!LLM_FALLBACK_SIMULASI) {
      // Diteruskan ke middleware error sebagai HTTP 500 yang rapi.
      console.error(`[llm] ${sebab}`);
      throw new AppError(500,
        `Analisis AI gagal: ${sebab}`,
        {
          penyedia: penyediaEfektif(),
          model: konfigLlm().model,
          status_llm: err.statusCode || null,
          ...(err.detail ? { detail_llm: err.detail } : {}),
        });
    }

    const alasan = `analisis LLM gagal: ${sebab}`;
    console.warn(`[llm] ${alasan} -> memakai fallback simulasi.`);
    return {
      analisis: lengkapiAnalisis(simulasikanAnalisis(), meta, ekstraksi),
      info: infoFallback(alasan),
    };
  }
}

/* ==========================================================================
 * 6. KONFIGURASI MULTER (UNGGAH BERKAS)
 * ======================================================================== */

const penyimpanan = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ekstensi = path.extname(file.originalname).toLowerCase();
    cb(null, `dokumen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ekstensi}`);
  },
});

const upload = multer({
  storage: penyimpanan,
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 30 },
  fileFilter: (req, file, cb) => {
    const ekstensi = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ekstensi)) {
      return cb(new AppError(400,
        'Format berkas tidak didukung. Gunakan berkas PDF, DOC, atau DOCX.'));
    }
    cb(null, true);
  },
});

/* ==========================================================================
 * 7. APLIKASI EXPRESS + CORS
 * ======================================================================== */

const app = express();

app.disable('x-powered-by');

// ---- CORS: agar upload.html & result.html dapat memanggil API dari origin lain
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((o) => o.trim()),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Total-Count'],
  maxAge: 86400,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---- Log permintaan sederhana
app.use((req, res, next) => {
  const mulai = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - mulai} ms)`);
  });
  next();
});

/* ==========================================================================
 * 7B. OTENTIKASI — TOKEN SESI (HMAC-SHA256)
 *     Tanpa dependensi tambahan: token = base64url(payload).base64url(ttd),
 *     dengan tanda tangan HMAC memakai AUTH_SECRET dari .env. Bila AUTH_SECRET
 *     kosong, kunci acak dibuat per proses sehingga semua sesi hangus saat
 *     server dijalankan ulang.
 * ======================================================================== */

const AUTH_SECRET = String(process.env.AUTH_SECRET || '').trim()
  || crypto.randomBytes(32).toString('hex');
const AUTH_SECRET_DARI_ENV = String(process.env.AUTH_SECRET || '').trim().length > 0;

// Masa berlaku token sesi: 1-168 jam (bawaan 12 jam).
const AUTH_TTL_MS = Math.min(Math.max(Number(process.env.AUTH_TTL_JAM) || 12, 1), 168) * 3600 * 1000;

/** Base64url (aman dipakai pada header/URL) dari string atau Buffer. */
function keBase64Url(nilai) {
  return Buffer.from(nilai).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mengubah kembali base64url menjadi Buffer. */
function dariBase64Url(teks) {
  return Buffer.from(String(teks).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Tanda tangan HMAC-SHA256 atas payload (base64url). */
function tandaTanganSesi(payloadBase64Url) {
  return keBase64Url(
    crypto.createHmac('sha256', AUTH_SECRET).update(payloadBase64Url).digest(),
  );
}

/**
 * Menerbitkan token sesi untuk pengguna yang berhasil masuk.
 * @returns {{token:string, payload:object}}
 */
function buatTokenSesi(user) {
  const sekarang = Date.now();
  const payload = {
    sub: user.id,
    nama: user.nama,
    email: user.email,
    peran: user.peran,
    iat: sekarang,
    exp: sekarang + AUTH_TTL_MS,
  };
  const payloadBase64Url = keBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return {
    token: `${payloadBase64Url}.${tandaTanganSesi(payloadBase64Url)}`,
    payload,
  };
}

/**
 * Memverifikasi token sesi. Token sah bila tanda tangannya cocok dan belum
 * kedaluwarsa.
 * @returns {object|null} payload sesi, atau null bila token tidak sah
 */
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
    return payload;
  } catch (err) {
    return null;
  }
}

/** Mengambil token dari header "Authorization: Bearer <token>". */
function ambilTokenPermintaan(req) {
  const cocok = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (cocok) return cocok[1].trim();
  return String(req.get('x-auth-token') || '').trim(); // alternatif untuk alat uji
}

/** Middleware: permintaan harus menyertakan token sesi yang sah. */
function wajibLogin(req, res, next) {
  const payload = bacaTokenSesi(ambilTokenPermintaan(req));
  if (!payload) {
    return next(new AppError(401,
      'Akses ditolak: token sesi tidak ada atau sudah kedaluwarsa. '
      + 'Masuk melalui POST /api/auth/login lalu kirim header '
      + '"Authorization: Bearer <token>".'));
  }

  const pengguna = dbPengguna.find((u) => u.id === payload.sub) || null;
  if (!pengguna) {
    return next(new AppError(401, 'Akses ditolak: akun pemilik token tidak ditemukan.'));
  }
  if (String(pengguna.status) !== STATUS_AKTIF) {
    return next(new AppError(403, 'Akses ditolak: akun ini sedang tidak aktif.'));
  }

  req.pengguna = pengguna;
  req.sesi     = payload;
  next();
}

/** Middleware: khusus Administrator (panel Admin, UC-09 s/d UC-13). */
function wajibAdmin(req, res, next) {
  if (!req.pengguna || req.pengguna.peran !== PERAN_ADMIN) {
    return next(new AppError(403, 'Akses ditolak: fitur ini khusus Administrator.'));
  }
  next();
}

/* ==========================================================================
 * 8. RUTE API
 * ======================================================================== */

const router = express.Router();

/* -------------------------- GET /api/health ------------------------------ */
router.get('/health', (req, res) => {
  const k = konfigLlm();

  res.json({
    status: 'success',
    service: 'deteksi-plagiarisme-api',
    version: '0.6.0',
    progress: llmSiap() ? '50% (analisis LLM nyata)' : '30% (LLM belum dikonfigurasi)',
    analysis_engine: llmSiap()
      ? `llm-${k.penyedia}-v1 (${k.model})`
      : 'simulasi-llm-v1 (fallback)',
    llm: {
      dikonfigurasi: llmSiap(),
      provider: k.penyedia,
      model: k.model,
      base_url_host: hostLLM(),
      json_mode: LLM_JSON_MODE,
      max_kata: LLM_MAX_KATA,
      timeout_ms: k.timeoutMs,
      max_token: k.maxToken,
      suhu: k.suhu,
      fallback_simulasi: LLM_FALLBACK_SIMULASI,
    },
    ekstraksi_teks: {
      pdf: 'pdf-parse',
      docx: 'mammoth',
      min_kata: MIN_KATA_TEREKSTRAKSI,
    },
    total_hasil: dbHasilAnalisis.length,
    total_pengguna: dbPengguna.length,
    maks_ukuran_mb: k.maksUkuranMb,
    ai_config: {
      tersimpan: fs.existsSync(AI_CONFIG_FILE),
      aktif: k.aktif,
      penyedia: k.penyedia,
      model: k.model,
      ambang_tinggi: k.ambangTinggi,
      ambang_sedang: k.ambangSedang,
      maks_ukuran_mb: k.maksUkuranMb,
      simpan_riwayat: k.simpanRiwayat,
      tampil_sumber: k.tampilSumber,
      koreksi_otomatis: k.koreksiOtomatis,
    },
    waktu_server: new Date().toISOString(),
  });
});

/* ------------------------- POST /api/upload ------------------------------ */
/**
 * Menerima berkas (PDF/DOC/DOCX) dan metadata:
 *   nim, nama, judul, jenis_dokumen  (alias: jenis / jenisKode / judul_dokumen)
 * Field berkas: "file" (alias: dokumen, berkas).
 *
 * Alur: validasi berkas -> validasi metadata -> EKSTRAKSI TEKS (bagian 4)
 *       -> kirim teks ke LLM dengan JSON mode (bagian 5) -> simpan hasilnya.
 */
async function tanganiUnggah(req, res, next) {
  const berkas = (req.files && req.files[0]) || null;

  try {
    /* ---- 8.1 Validasi berkas ---- */
    if (!berkas) {
      throw new AppError(400,
        'Berkas dokumen wajib diunggah pada field "file" (multipart/form-data).');
    }
    if (!berkas.size) {
      throw new AppError(400, 'Berkas kosong atau tidak dapat dibaca.');
    }
    // Batas ukuran mengikuti panel Admin "Pengaturan AI" (field maksUkuran).
    const batasMb = konfigLlm().maksUkuranMb;
    if (berkas.size > batasMb * 1024 * 1024) {
      throw new AppError(400,
        `Ukuran berkas ${ukuranTerbaca(berkas.size)} melebihi batas ${batasMb} MB `
        + 'yang ditetapkan pada panel Pengaturan AI.',
        { maks_ukuran_mb: batasMb, ukuran_byte: berkas.size });
    }

    /* ---- 8.2 Validasi metadata ---- */
    const nim           = ambilField(req.body, 'nim', 'NIM', 'nim_mahasiswa', 'nimMahasiswa');
    const nama          = ambilField(req.body, 'nama', 'nama_mahasiswa', 'namaMahasiswa', 'nama_mhs');
    const judul         = ambilField(req.body, 'judul', 'judul_dokumen', 'judulDokumen', 'title');
    const jenisMasukan  = ambilField(req.body, 'jenis_dokumen', 'jenisDokumen', 'jenis', 'jenisKode', 'type');

    if (!nim) throw new AppError(400, 'Metadata "nim" wajib diisi.');
    if (!/^[0-9]{8,12}$/.test(nim)) {
      throw new AppError(400, 'Metadata "nim" harus berupa angka 8-12 digit.', { nim });
    }
    if (!judul) throw new AppError(400, 'Metadata "judul" wajib diisi.');
    if (judul.length < 5) {
      throw new AppError(400, 'Metadata "judul" minimal 5 karakter.', { judul });
    }

    const jenisDokumen = normalisasiJenisDokumen(jenisMasukan);

    /* ---- 8.3 Ekstraksi teks dokumen (PDF: pdf-parse, DOCX: mammoth) ---- */
    const ekstraksi = await ekstraksiTeksDokumen(berkas.path, berkas.mimetype, berkas.originalname);
    console.log(`[ekstraksi] ${berkas.originalname}: format=${ekstraksi.format}, ` +
      `${ekstraksi.kata} kata, ${ekstraksi.karakter} karakter` +
      (ekstraksi.halaman ? `, ${ekstraksi.halaman} halaman` : ''));

    /* ---- 8.4 Kirim teks ke LLM, minta keluaran JSON terstruktur ---- */
    const waktuProses = new Date();
    const { analisis, info } = await analisisDokumen({
      nim,
      nama: nama || 'Tidak disebutkan',
      judul,
      jenis_dokumen: jenisDokumen,
    }, ekstraksi);

    console.log(`[analisis] ${info.label} | skor ${analisis.overall_similarity_score}% `
      + `(${analisis.classification_level}) | ${analisis.flagged_passages.length} temuan `
      + `| ${info.durasi_ms} ms${info.peringatan ? ` | peringatan: ${info.peringatan}` : ''}`);

    /* ---- 8.5 Bentuk rekaman yang disimpan ---- */
    const rekaman = {
      ...analisis,
      id: buatIdHasil(waktuProses),
      created_at: waktuProses.toISOString(),
      analysis_engine: info.label,
      // Keterangan mesin analisis (tanpa kunci API) untuk keperluan audit.
      llm: {
        mode: info.mode,
        model: info.model,
        endpoint_host: info.endpoint_host,
        json_mode: info.json_mode,
        percobaan: info.percobaan,
        durasi_ms: info.durasi_ms,
        jumlah_kata_terkirim: info.jumlah_kata_terkirim,
        teks_dipotong: info.teks_dipotong,
        token: info.token,
        peringatan: info.peringatan,
      },
      berkas: {
        nama_asli: berkas.originalname,
        nama_tersimpan: berkas.filename,
        ekstensi: path.extname(berkas.originalname).toLowerCase(),
        mime_type: berkas.mimetype,
        ukuran_byte: berkas.size,
        ukuran: ukuranTerbaca(berkas.size),
      },
    };

    /* ---- 8.6 Panel Admin: tampilkan sumber & simpan riwayat ---- */
    // "Tampilkan sumber kemiripan" (tampilSumber) dimatikan -> rujukan sumber
    // tidak ikut dikirim ke klien maupun disimpan pada rekaman.
    const pengaturan = konfigLlm();
    if (!pengaturan.tampilSumber && Array.isArray(rekaman.flagged_passages)) {
      rekaman.flagged_passages = rekaman.flagged_passages.map((temuan) => ({
        ...temuan,
        source_reference: null,
      }));
    }

    /* ---- 8.7 Simpan ke memori + berkas JSON ---- */
    if (pengaturan.simpanRiwayat) {
      dbHasilAnalisis.unshift(rekaman);
      simpanRiwayat();
    } else {
      // Riwayat tidak disimpan (panel Admin); hasil tetap dikembalikan ke
      // pemanggil sehingga halaman hasil masih dapat ditampilkan.
      console.log('[simpan] simpanRiwayat=false -> hasil tidak dimasukkan ke riwayat.');
    }

    res.status(201).json(rekaman);
  } catch (err) {
    hapusBerkas(berkas); // jangan tinggalkan berkas bila permintaan ditolak
    next(err);
  }
}

// Middleware multer: terima field berkas dengan beberapa nama yang lazim dipakai.
const terimaBerkas = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) return next(err);
    // rapikan: hanya pertahankan berkas dari field yang dikenali (field lain tetap diterima)
    next();
  });
};

router.post('/upload', terimaBerkas, tanganiUnggah);
router.post('/documents', terimaBerkas, tanganiUnggah);          // alias dipakai di upload.html
router.post('/documents/analyze', terimaBerkas, tanganiUnggah);  // alias "analyze" (lihat proses.html)

/* ---------------------- GET /api/history & /api/results ------------------ */
/** Filter & paging sederhana untuk daftar riwayat. */
function daftarRiwayat(query) {
  const nim        = ambilField(query, 'nim');
  const klasifikasi = ambilField(query, 'classification_level', 'klasifikasi');
  const kataKunci  = ambilField(query, 'q').toLowerCase();
  const dari       = ambilField(query, 'dari', 'tanggal_dari');       // batas awal (ISO)
  const sampai     = ambilField(query, 'sampai', 'tanggal_sampai');   // batas akhir (ISO)
  const limit      = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset     = Math.max(parseInt(query.offset, 10) || 0, 0);

  let data = dbHasilAnalisis.slice();

  if (nim) {
    data = data.filter((r) => r.document_metadata && r.document_metadata.nim === nim);
  }
  if (klasifikasi) {
    data = data.filter((r) => (r.classification_level || '').toLowerCase() === klasifikasi.toLowerCase());
  }
  if (dari) {
    data = data.filter((r) => String(r.created_at || '') >= dari);
  }
  if (sampai) {
    // Bila hanya tanggal (YYYY-MM-DD) yang dikirim, ikutkan seluruh hari tersebut.
    const batas = /^\d{4}-\d{2}-\d{2}$/.test(sampai) ? `${sampai}T23:59:59.999Z` : sampai;
    data = data.filter((r) => String(r.created_at || '') <= batas);
  }
  if (kataKunci) {
    data = data.filter((r) => {
      const meta = r.document_metadata || {};
      return [meta.judul, meta.nama, meta.nim, meta.jenis_dokumen]
        .some((nilai) => String(nilai || '').toLowerCase().includes(kataKunci));
    });
  }

  return { total: data.length, limit, offset, data: data.slice(offset, offset + limit) };
}

router.get('/history', (req, res) => {
  const { total, limit, offset, data } = daftarRiwayat(req.query);
  res.set('X-Total-Count', String(total));
  res.json({
    status: 'success',
    total,
    count: data.length,
    limit,
    offset,
    data,
  });
});

router.get('/results', (req, res) => {
  const { total, limit, offset, data } = daftarRiwayat(req.query);
  res.set('X-Total-Count', String(total));
  res.json({
    status: 'success',
    total,
    count: data.length,
    limit,
    offset,
    data,
  });
});

/* --------------------------- GET /api/results/:id ------------------------ */
router.get('/results/:id', (req, res, next) => {
  const id = String(req.params.id || '').trim();
  const rekaman = dbHasilAnalisis.find((r) => r.id.toLowerCase() === id.toLowerCase());

  if (!rekaman) {
    return next(new AppError(404, `Hasil analisis dengan id "${id}" tidak ditemukan.`));
  }
  res.json(rekaman);
});

/* -------------------------- DELETE /api/results/:id --------------------- */
router.delete('/results/:id', (req, res, next) => {
  const id = String(req.params.id || '').trim();
  const indeks = dbHasilAnalisis.findIndex((r) => r.id.toLowerCase() === id.toLowerCase());

  if (indeks === -1) {
    return next(new AppError(404, `Hasil analisis dengan id "${id}" tidak ditemukan.`));
  }

  const [dihapus] = dbHasilAnalisis.splice(indeks, 1);
  simpanRiwayat();

  if (dihapus.berkas && dihapus.berkas.nama_tersimpan) {
    const jalur = path.join(UPLOAD_DIR, dihapus.berkas.nama_tersimpan);
    fs.promises.unlink(jalur).catch(() => { /* berkas sudah tidak ada -> diabaikan */ });
  }

  res.json({ status: 'success', message: `Hasil analisis ${id} dihapus.`, id });
});

/* ==========================================================================
 * 8.7 OTENTIKASI AKUN (UC-01, UC-02)
 * ======================================================================== */

/** Format email yang diterima (sama dengan validasi di login.html). */
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* -------------------- POST /api/auth/register (UC-01) -------------------- */
/**
 * Pendaftaran akun mahasiswa.
 * Body: { nama, email, password, nim? }
 * Exception UC-01: email sudah terdaftar -> HTTP 409.
 */
router.post('/auth/register', (req, res, next) => {
  try {
    const body  = req.body || {};
    const nama  = ambilField(body, 'nama', 'nama_lengkap', 'namaLengkap', 'name');
    const email = ambilField(body, 'email', 'surel', 'username').toLowerCase();
    const sandi = String(body.password === undefined ? (body.sandi || body.kata_sandi || '') : body.password);
    const nim   = ambilField(body, 'nim', 'NIM', 'nim_mahasiswa', 'nimMahasiswa');
    const peran = ambilField(body, 'peran', 'role').toLowerCase();

    if (nama.length < 3) {
      throw new AppError(400, 'Field "nama" wajib diisi, minimal 3 karakter.', { field: 'nama' });
    }
    if (nama.length > 60) {
      throw new AppError(400, 'Field "nama" maksimal 60 karakter.', { field: 'nama' });
    }
    if (!RE_EMAIL.test(email)) {
      throw new AppError(400, 'Field "email" tidak berformat email yang sah.', { email });
    }
    if (sandi.length < 8) {
      throw new AppError(400, 'Field "password" minimal 8 karakter.', { field: 'password' });
    }
    if (nim && !/^[0-9]{8,12}$/.test(nim)) {
      throw new AppError(400, 'Field "nim" harus berupa angka 8-12 digit.', { nim });
    }
    if (peran && peran !== PERAN_MAHASISWA.toLowerCase()) {
      throw new AppError(400, 'Pendaftaran ini hanya untuk akun Mahasiswa.', { peran });
    }
    if (cariPenggunaEmail(email)) {
      throw new AppError(409, `Email ${email} sudah terdaftar. `
        + 'Silakan masuk atau gunakan email lain.', { email });
    }

    const pengguna = {
      id: buatIdPengguna(),
      nama,
      nim: nim || null,
      email,
      password_hash: hashPassword(sandi),
      peran: PERAN_MAHASISWA,
      status: STATUS_AKTIF,
      dibuat: new Date().toISOString(),
      terakhir_masuk: null,
    };

    dbPengguna.push(pengguna);
    if (!simpanPengguna()) {
      dbPengguna.pop(); // jangan tinggalkan akun yang gagal disimpan
      throw new AppError(500, 'Pendaftaran gagal: data pengguna tidak dapat disimpan.');
    }

    console.log(`[auth] pendaftaran baru: ${pengguna.email} (${pengguna.peran})`);
    res.status(201).json({
      status: 'success',
      message: 'Pendaftaran berhasil. Silakan masuk dengan akun barumu.',
      user: publikPengguna(pengguna),
    });
  } catch (err) {
    next(err);
  }
});

/* --------------------- POST /api/auth/login (UC-02) ---------------------- */
/**
 * Autentikasi akun mahasiswa & Administrator.
 * Body: { email, password, peran? }  — "peran" opsional untuk memaksa peran
 * tertentu (mis. halaman Admin mengirim peran: "Administrator").
 * Balasan berisi token sesi (Authorization: Bearer) + data pengguna.
 */
router.post('/auth/login', (req, res, next) => {
  try {
    const body  = req.body || {};
    const email = ambilField(body, 'email', 'surel', 'username').toLowerCase();
    const sandi = String(body.password === undefined ? (body.sandi || body.kata_sandi || '') : body.password);
    const peranDiminta = ambilField(body, 'peran', 'role').toLowerCase();

    if (!email || !sandi) {
      throw new AppError(400, 'Field "email" dan "password" wajib diisi.');
    }

    const pengguna = cariPenggunaEmail(email);

    // Pesan sengaja disamakan untuk email tidak dikenal dan kata sandi salah
    // supaya keberadaan akun tidak dapat ditebak dari pesan galat.
    if (!pengguna || !periksaPassword(sandi, pengguna.password_hash)) {
      console.warn(`[auth] gagal masuk: ${email || '(email kosong)'}`);
      throw new AppError(401, 'Data akun tidak sesuai. Periksa kembali email dan password.');
    }
    if (String(pengguna.status) !== STATUS_AKTIF) {
      throw new AppError(403, 'Akun ini sedang tidak aktif. Hubungi Administrator.');
    }
    if (peranDiminta && peranDiminta !== String(pengguna.peran).toLowerCase()) {
      throw new AppError(403, `Akun ini berperan ${pengguna.peran}, bukan ${peranDiminta}.`, {
        peran: pengguna.peran,
      });
    }

    pengguna.terakhir_masuk = new Date().toISOString();
    simpanPengguna();

    const { token, payload } = buatTokenSesi(pengguna);
    console.log(`[auth] masuk: ${pengguna.email} (${pengguna.peran})`);

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

/* ==========================================================================
 * 8.8 PANEL ADMIN (UC-09 s/d UC-13) — wajib token Administrator
 * ======================================================================== */

/** Ringkasan aktivitas per NIM dari riwayat analisis (untuk tabel pengguna). */
function ringkasAktivitasPengguna() {
  const peta = new Map();

  dbHasilAnalisis.forEach((rekaman) => {
    const meta = rekaman.document_metadata || {};
    const nim  = String(meta.nim || '');
    if (!nim) return;

    const data = peta.get(nim) || {
      jumlah_dokumen: 0, jumlah_pemeriksaan: 0, total_skor: 0, terakhir: null,
    };
    data.jumlah_dokumen += 1;
    if (typeof rekaman.overall_similarity_score === 'number') {
      data.jumlah_pemeriksaan += 1;
      data.total_skor += rekaman.overall_similarity_score;
    }
    const waktu = rekaman.created_at || null;
    if (waktu && (!data.terakhir || waktu > data.terakhir)) data.terakhir = waktu;

    peta.set(nim, data);
  });

  return peta;
}

/* ------------------- GET /api/admin/users (UC-09) ------------------------ */
/** Daftar pengguna terdaftar beserta ringkasan aktivitasnya. */
router.get('/admin/users', wajibLogin, wajibAdmin, (req, res) => {
  const kataKunci = ambilField(req.query, 'q').toLowerCase();
  const peran     = ambilField(req.query, 'peran', 'role');
  const status    = ambilField(req.query, 'status');
  const urut      = ambilField(req.query, 'urut', 'sort').toLowerCase();
  const limit     = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset    = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const aktivitas = ringkasAktivitasPengguna();

  let data = dbPengguna.map((pengguna) => {
    const ringkas = aktivitas.get(String(pengguna.nim || '')) || null;
    return {
      ...publikPengguna(pengguna),
      jumlah_dokumen: ringkas ? ringkas.jumlah_dokumen : 0,
      jumlah_pemeriksaan: ringkas ? ringkas.jumlah_pemeriksaan : 0,
      rata_rata_skor: ringkas && ringkas.jumlah_pemeriksaan
        ? Math.round(ringkas.total_skor / ringkas.jumlah_pemeriksaan) : null,
      terakhir_memeriksa: ringkas ? ringkas.terakhir : null,
    };
  });

  if (peran) {
    data = data.filter((u) => String(u.peran).toLowerCase() === peran.toLowerCase());
  }
  if (status) {
    data = data.filter((u) => String(u.status).toLowerCase() === status.toLowerCase());
  }
  if (kataKunci) {
    data = data.filter((u) => [u.nama, u.email, u.nim, u.peran, u.status]
      .some((nilai) => String(nilai || '').toLowerCase().includes(kataKunci)));
  }

  if (urut === 'nama') {
    data.sort((a, b) => String(a.nama).localeCompare(String(b.nama)));
  } else if (urut === 'dokumen') {
    data.sort((a, b) => b.jumlah_dokumen - a.jumlah_dokumen);
  } else if (urut === 'terakhir') {
    data.sort((a, b) => String(b.terakhir_memeriksa || '').localeCompare(String(a.terakhir_memeriksa || '')));
  } else {
    // Bawaan: akun terbaru lebih dulu.
    data.sort((a, b) => String(b.dibuat || '').localeCompare(String(a.dibuat || '')));
  }

  const halaman = data.slice(offset, offset + limit);
  res.set('X-Total-Count', String(data.length));
  res.json({
    status: 'success',
    total: data.length,
    count: halaman.length,
    limit,
    offset,
    ringkasan: {
      mahasiswa: dbPengguna.filter((u) => u.peran === PERAN_MAHASISWA).length,
      administrator: dbPengguna.filter((u) => u.peran === PERAN_ADMIN).length,
      aktif: dbPengguna.filter((u) => u.status === STATUS_AKTIF).length,
    },
    data: halaman,
  });
});

/* ----------------- GET /api/admin/documents (UC-10) ---------------------- */
/** Seluruh dokumen yang sudah diunggah & dianalisis oleh semua pengguna. */
router.get('/admin/documents', wajibLogin, wajibAdmin, (req, res) => {
  const kataKunci = ambilField(req.query, 'q').toLowerCase();
  const nim       = ambilField(req.query, 'nim');
  const jenis     = ambilField(req.query, 'jenis_dokumen', 'jenis').toLowerCase();
  const limit     = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset    = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let data = dbHasilAnalisis.map((rekaman) => {
    const meta   = rekaman.document_metadata || {};
    const berkas = rekaman.berkas || {};
    return {
      id: rekaman.id || null,
      nim: meta.nim || null,
      nama: meta.nama || null,
      judul: meta.judul || null,
      jenis_dokumen: meta.jenis_dokumen || null,
      berkas: {
        nama_asli: berkas.nama_asli || null,
        ekstensi: berkas.ekstensi || null,
        mime_type: berkas.mime_type || null,
        ukuran: berkas.ukuran || null,
        ukuran_byte: typeof berkas.ukuran_byte === 'number' ? berkas.ukuran_byte : null,
      },
      skor: typeof rekaman.overall_similarity_score === 'number'
        ? rekaman.overall_similarity_score : null,
      klasifikasi: rekaman.classification_level || null,
      jumlah_temuan: Array.isArray(rekaman.flagged_passages) ? rekaman.flagged_passages.length : 0,
      diunggah_pada: rekaman.created_at || null,
      diperiksa: typeof rekaman.overall_similarity_score === 'number',
      analysis_engine: rekaman.analysis_engine || null,
    };
  });

  if (nim) {
    data = data.filter((d) => String(d.nim || '') === nim);
  }
  if (jenis) {
    data = data.filter((d) => String(d.jenis_dokumen || '').toLowerCase().includes(jenis));
  }
  if (kataKunci) {
    data = data.filter((d) => [d.judul, d.nama, d.nim, d.jenis_dokumen, d.berkas.nama_asli]
      .some((nilai) => String(nilai || '').toLowerCase().includes(kataKunci)));
  }

  data.sort((a, b) => String(b.diunggah_pada || '').localeCompare(String(a.diunggah_pada || '')));

  const halaman = data.slice(offset, offset + limit);
  const totalUkuran = data.reduce((jumlah, d) => jumlah + (d.berkas.ukuran_byte || 0), 0);

  res.set('X-Total-Count', String(data.length));
  res.json({
    status: 'success',
    total: data.length,
    count: halaman.length,
    limit,
    offset,
    jumlah_byte_total: totalUkuran,
    jumlah_terbaca_total: ukuranTerbaca(totalUkuran),
    data: halaman,
  });
});

/* ----------------- GET /api/admin/histories (UC-11) ---------------------- */
/** Seluruh riwayat pemeriksaan (semua pengguna) + ringkasan klasifikasi. */
router.get('/admin/histories', wajibLogin, wajibAdmin, (req, res) => {
  const { total, limit, offset, data } = daftarRiwayat(req.query);

  const skor = dbHasilAnalisis
    .map((r) => r.overall_similarity_score)
    .filter((n) => typeof n === 'number');

  res.set('X-Total-Count', String(total));
  res.json({
    status: 'success',
    total,
    count: data.length,
    limit,
    offset,
    ringkasan_klasifikasi: {
      Tinggi: dbHasilAnalisis.filter((r) => r.classification_level === 'Tinggi').length,
      Sedang: dbHasilAnalisis.filter((r) => r.classification_level === 'Sedang').length,
      Rendah: dbHasilAnalisis.filter((r) => r.classification_level === 'Rendah').length,
    },
    rata_rata_skor: skor.length
      ? Math.round(skor.reduce((jumlah, n) => jumlah + n, 0) / skor.length) : null,
    data,
  });
});

/* ------------ GET & POST /api/admin/ai-config (UC-12, UC-13) ------------- */

/** Mengambil angka konfigurasi dari body; melempar 400 bila di luar rentang. */
function angkaKonfig(nilai, bawaan, min, max, nama) {
  if (nilai === undefined || nilai === null || nilai === '') return bawaan;
  const angka = Number(nilai);
  if (!Number.isFinite(angka)) {
    throw new AppError(400, `Field "${nama}" harus berupa angka.`, { field: nama });
  }
  if (angka < min || angka > max) {
    throw new AppError(400, `Field "${nama}" harus berada pada rentang ${min}-${max}.`,
      { field: nama, nilai: angka });
  }
  return angka;
}

/** Mengambil nilai boolean konfigurasi dari body (bila tidak dikirim, tetap). */
function booleanKonfig(nilai, bawaan) {
  if (nilai === undefined || nilai === null || nilai === '') return bawaan;
  return keBoolean(nilai);
}

/** Membaca konfigurasi penyedia AI. Kunci API selalu dalam bentuk tersamar. */
router.get('/admin/ai-config', wajibLogin, wajibAdmin, (req, res) => {
  res.json({
    status: 'success',
    tersimpan: fs.existsSync(AI_CONFIG_FILE),
    catatan: 'Kunci API hanya disimpan di server (data/ai-config.json) dan '
      + 'dikirim kembali dalam bentuk tersamar.',
    config: publikKonfigAi(),
  });
});

/**
 * Menyimpan konfigurasi penyedia AI (panel Admin, D4).
 * Aturan field "apiKey":
 *   - tidak dikirim / kosong / masih tersamar (diawali "*") -> nilai lama tetap dipakai
 *   - teks minimal 8 karakter -> kunci diganti
 *   - null -> kunci dihapus
 */
router.post('/admin/ai-config', wajibLogin, wajibAdmin, (req, res, next) => {
  try {
    const body = req.body || {};
    const baru = { ...konfigAi };

    baru.aktif = booleanKonfig(body.aktif, baru.aktif);

    const penyedia = ambilField(body, 'penyedia', 'provider').toLowerCase();
    if (penyedia) {
      if (!PENYEDIA_AI.includes(penyedia)) {
        throw new AppError(400, `Field "penyedia" harus salah satu dari: ${PENYEDIA_AI.join(', ')}.`,
          { field: 'penyedia' });
      }
      baru.penyedia = penyedia;
    }

    const model = ambilField(body, 'model', 'model_name', 'nama_model');
    if (body.model !== undefined || body.model_name !== undefined || body.nama_model !== undefined) {
      if (model.length < 2 || model.length > 80) {
        throw new AppError(400, 'Field "model" wajib diisi, 2-80 karakter.', { field: 'model' });
      }
      baru.model = model;
    }

    const endpoint = ambilField(body, 'endpoint', 'base_url', 'alamat_api');
    if (endpoint) {
      if (!/^https?:\/\/[^\s]+$/i.test(endpoint)) {
        throw new AppError(400, 'Field "endpoint" harus berupa URL http/https yang sah.',
          { field: 'endpoint' });
      }
      baru.endpoint = endpoint.replace(/\/+$/, '');
    }

    const adaApiKey = body.apiKey !== undefined || body.api_key !== undefined;
    const nilaiApiKey = body.apiKey !== undefined ? body.apiKey : body.api_key;
    if (adaApiKey) {
      if (nilaiApiKey === null) {
        baru.apiKey = ''; // permintaan menghapus kunci tersimpan
      } else {
        const bersih = String(nilaiApiKey).trim();
        const tersamar = bersih.startsWith('*');
        if (bersih && !tersamar) {
          if (bersih.length < 8) {
            throw new AppError(400, 'Field "apiKey" minimal 8 karakter.', { field: 'apiKey' });
          }
          baru.apiKey = bersih;
        }
        // kosong atau tersamar -> kunci lama dipertahankan
      }
    }
    // Kunci API wajib tersedia untuk mengaktifkan layanan: boleh dari panel
    // (data/ai-config.json) maupun dari .env (LLM_API_KEY).
    if (baru.aktif && !String(baru.apiKey || '').length && !LLM_API_KEY
        && baru.penyedia !== 'ollama') {
      throw new AppError(400, 'Kunci API wajib diisi sebelum layanan AI diaktifkan.', {
        field: 'apiKey', penyedia: baru.penyedia,
      });
    }

    baru.suhu         = angkaKonfig(body.suhu !== undefined ? body.suhu : body.temperature,
      baru.suhu, 0, 1, 'suhu');
    baru.maxToken     = angkaKonfig(body.maxToken !== undefined ? body.maxToken : body.max_token,
      baru.maxToken, 256, 32000, 'maxToken');
    baru.timeout      = angkaKonfig(body.timeout, baru.timeout, 5, 120, 'timeout');
    baru.ambangTinggi = angkaKonfig(body.ambangTinggi !== undefined ? body.ambangTinggi : body.ambang_tinggi,
      baru.ambangTinggi, 0, 100, 'ambangTinggi');
    baru.ambangSedang = angkaKonfig(body.ambangSedang !== undefined ? body.ambangSedang : body.ambang_sedang,
      baru.ambangSedang, 0, 100, 'ambangSedang');
    baru.maksUkuran   = angkaKonfig(body.maksUkuran !== undefined ? body.maksUkuran : body.maks_ukuran,
      baru.maksUkuran, 1, 50, 'maksUkuran');

    if (baru.ambangTinggi <= baru.ambangSedang) {
      throw new AppError(400, 'Ambang "Tinggi" harus lebih besar daripada ambang "Sedang".', {
        ambangTinggi: baru.ambangTinggi, ambangSedang: baru.ambangSedang,
      });
    }

    baru.simpanRiwayat  = booleanKonfig(
      body.simpanRiwayat !== undefined ? body.simpanRiwayat : body.simpan_riwayat, baru.simpanRiwayat);
    baru.tampilSumber   = booleanKonfig(
      body.tampilSumber !== undefined ? body.tampilSumber : body.tampil_sumber, baru.tampilSumber);
    baru.koreksiOtomatis = booleanKonfig(
      body.koreksiOtomatis !== undefined ? body.koreksiOtomatis : body.koreksi_otomatis,
      baru.koreksiOtomatis);

    baru.diperbarui      = new Date().toISOString();
    baru.diperbarui_oleh = req.pengguna.email;

    konfigAi = baru;
    if (!simpanKonfigAi()) {
      throw new AppError(500, 'Konfigurasi AI gagal disimpan ke data/ai-config.json.');
    }

    console.log(`[ai-config] disimpan oleh ${req.pengguna.email}: `
      + `${konfigAi.penyedia}/${konfigAi.model}, aktif=${konfigAi.aktif}`);

    res.json({
      status: 'success',
      message: 'Konfigurasi layanan AI berhasil disimpan.',
      catatan: 'Nilai ini tersimpan di sisi server; kunci API dikembalikan dalam bentuk tersamar.',
      config: publikKonfigAi(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Menguji koneksi ke penyedia AI memakai konfigurasi yang tersimpan
 * (tombol "Uji Koneksi" pada admin-ai.html). Permintaannya sengaja sangat
 * pendek supaya hemat token: satu pesan kecil yang meminta balasan JSON.
 * Kegagalan diteruskan sebagai AppError (400/502/504) dengan pesan aman.
 */
router.post('/admin/ai-config/test', wajibLogin, wajibAdmin, async (req, res, next) => {
  try {
    const k = konfigLlm();

    if (!k.aktif) {
      throw new AppError(400,
        'Layanan AI sedang nonaktif. Aktifkan lalu simpan konfigurasi terlebih dahulu.',
        { field: 'aktif' });
    }
    if (k.butuhKunci && !k.apiKey) {
      throw new AppError(400,
        'Kunci API belum diisi pada konfigurasi layanan AI.', { field: 'apiKey' });
    }

    const mulai = Date.now();
    const keluaran = await panggilLLM({
      system: 'Anda alat uji koneksi. Balas HANYA dengan JSON: {"ok": true}.',
      user: 'Balas dengan {"ok": true}.',
    });

    res.json({
      status: 'success',
      terhubung: true,
      message: 'Layanan AI dapat dihubungi.',
      catatan: `Model ${keluaran.model} merespons dalam ${Date.now() - mulai} ms `
        + `(penyedia ${k.penyedia}${k.dariPanel ? ', dari panel Admin' : ', dari .env'}).`,
      penyedia: k.penyedia,
      model: keluaran.model,
      endpoint_host: hostLLM(),
      durasi_ms: Date.now() - mulai,
      json_mode: keluaran.json_mode,
      percobaan: keluaran.percobaan,
    });
  } catch (err) {
    next(err);
  }
});

app.use('/api', router);

/* ==========================================================================
 * 9. PENYAJIAN FILE FRONTEND (folder public/)
 *    Halaman HTML ada di public/index.html, public/upload.html, dan seterusnya;
 *    root statis diarahkan ke folder itu sehingga URL lama tetap sama
 *    (mis. http://localhost:3000/upload.html). Sekaligus menjadi "server lokal"
 *    sehingga sessionStorage/localStorage berjalan normal pada origin yang sama.
 * ======================================================================== */

// Sabuk pengaman tambahan: berkas internal (server.js, package.json, .env,
// data/) memang sudah berada di luar folder statis, tetapi jalur ini tetap
// ditolak bila sewaktu-waktu root statis diubah lagi.
const JALUR_INTERNAL = [
  /^\/data(\/|$)/i,
  /^\/uploads(\/|$)/i,
  /^\/node_modules(\/|$)/i,
  /^\/tests(\/|$)/i,
  /^\/logs(\/|$)/i,
  /^\/docs(\/|$)/i,
  /^\/server\.js$/i,
  /^\/package(-lock)?\.json$/i,
  /^\/\./,
];

app.use((req, res, next) => {
  if (JALUR_INTERNAL.some((pola) => pola.test(req.path))) {
    return next(new AppError(403, 'Akses ke jalur internal ditolak.'));
  }
  next();
});

app.use(express.static(UI_DIR, {
  index: 'index.html',
  extensions: ['html'],
  dotfiles: 'deny',
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

/* ==========================================================================
 * 10. PENANGANAN 404 & ERROR
 * ======================================================================== */

app.use((req, res, next) => {
  next(new AppError(404, `Rute tidak ditemukan: ${req.method} ${req.originalUrl}`));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Error dari multer (batas ukuran, jumlah berkas, dst.)
  if (err instanceof multer.MulterError) {
    const pesan = err.code === 'LIMIT_FILE_SIZE'
      ? `Ukuran berkas melebihi batas maksimal ${ukuranTerbaca(MAX_FILE_SIZE)}.`
      : `Permintaan unggah berkas tidak valid (${err.code}).`;
    return res.status(400).json({ status: 'error', message: pesan });
  }

  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) console.error('[error]', err);

  res.status(statusCode).json({
    status: 'error',
    message: err.message || 'Terjadi kesalahan pada server.',
    ...(err.detail ? { detail: err.detail } : {}),
  });
});

/* ==========================================================================
 * 11. MENJALANKAN SERVER
 * ======================================================================== */

muatRiwayat();
muatPengguna();
muatKonfigAi();

const server = app.listen(PORT, HOST, () => {
  const alamat = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('');
  console.log('  Aplikasi Deteksi Plagiarisme Proposal & Laporan Tugas Akhir');
  console.log('  Backend API — analisis LLM + ekstraksi teks nyata');
  console.log('  ------------------------------------------------------------');
  console.log(`  Frontend   : http://${alamat}:${PORT}/index.html`);
  console.log(`  Unggah     : http://${alamat}:${PORT}/upload.html`);
  console.log(`  Hasil      : http://${alamat}:${PORT}/result.html`);
  console.log(`  API health : http://${alamat}:${PORT}/api/health`);
  console.log(`  CORS origin: ${CORS_ORIGIN}`);
  console.log(`  Berkas .env: ${DOTENV_TERMUAT ? 'dimuat' : 'tidak ada (memakai nilai bawaan)'}`);
  console.log(`  Analisis AI: ${llmSiap()
    ? `LLM ${konfigLlm().penyedia.toUpperCase()} (${konfigLlm().model} @ ${hostLLM()}, `
      + `json_mode=${LLM_JSON_MODE}, maks ${LLM_MAX_KATA} kata, `
      + `timeout ${konfigLlm().timeoutMs} ms)${konfigLlm().dariPanel ? ' [panel Admin]' : ' [.env]'}`
    : 'BELUM DIKONFIGURASI — aktifkan layanan AI pada panel Admin atau isi LLM_API_KEY pada .env'
      + (LLM_FALLBACK_SIMULASI ? ' (fallback simulasi aktif)' : '')}`);
  console.log(`  Penyimpanan: ${path.relative(ROOT_DIR, DB_FILE) || DB_FILE}`);
  console.log(`  Pengguna   : ${dbPengguna.length} akun (${path.relative(ROOT_DIR, USERS_FILE)})`);
  console.log(`  Konfig AI  : ${fs.existsSync(AI_CONFIG_FILE)
    ? `${path.relative(ROOT_DIR, AI_CONFIG_FILE)} (aktif=${konfigLlm().aktif}, `
      + `ambang ${konfigLlm().ambangSedang}/${konfigLlm().ambangTinggi}, `
      + `maks ${konfigLlm().maksUkuranMb} MB)`
    : 'belum ada — memakai nilai bawaan .env'}`);
  console.log(`  Autentikasi: token HMAC sesi ${Math.round(AUTH_TTL_MS / 3600000)} jam, `
    + `AUTH_SECRET ${AUTH_SECRET_DARI_ENV ? 'dari .env' : 'acak per proses (sesi hangus saat restart)'}`);
  console.log('');
});

// Penutupan yang rapi: pastikan riwayat tersimpan sebelum proses berakhir.
['SIGINT', 'SIGTERM'].forEach((sinyal) => {
  process.on(sinyal, () => {
    console.log(`\n[server] Menerima ${sinyal}, menyimpan riwayat dan menghentikan layanan...`);
    simpanRiwayat();
    server.close(() => process.exit(0));
  });
});

module.exports = app;
