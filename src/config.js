'use strict';

/* ============================================================================
 *  KONFIGURASI TERPUSAT — Aplikasi Deteksi Plagiarisme Proposal & Laporan TA
 *  (NIM 11241002)
 *
 *  Modul ini adalah satu-satunya tempat pembacaan process.env untuk konfigurasi
 *  aplikasi (kecuali AUTH_SECRET yang masih dibaca di server.js bagian 7B).
 *  Dipindahkan dari server.js bagian 1 pada migrasi bertahap.
 *
 *  PENTING: dotenv harus sudah dimuat SEBELUM modul ini di-require, karena
 *  nilai di bawah dibaca sekali saat modul dimuat.
 * ========================================================================== */

const path = require('path');

// ROOT_DIR = akar proyek (folder di atas src/), supaya jalur data/public tetap
// sama seperti ketika kode masih berada di server.js.
const ROOT_DIR = path.join(__dirname, '..');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const UI_DIR = path.join(ROOT_DIR, 'public');   // berkas frontend (HTML)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// ---- Basis data (SQLite) + berkas JSON lama sebagai sumber migrasi --------
const DB_SQLITE = path.join(DATA_DIR, 'ippl.db');              // basis data utama
const DB_FILE = path.join(DATA_DIR, 'hasil-analisis.json');    // lama (sumber migrasi)
const USERS_FILE = path.join(DATA_DIR, 'users.json');          // lama (sumber migrasi)
const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-config.json');  // lama (sumber migrasi)
const SESI_DICABUT_FILE = path.join(DATA_DIR, 'sesi-dicabut.json'); // daftar logout

// Batas ukuran berkas unggahan.
//   MAX_FILE_SIZE  : plafon keras middleware multer. Sengaja tidak dapat diubah
//                    dari panel Admin supaya server tidak kehabisan memori.
//   MAKS_UKURAN_MB : plafon tertinggi yang boleh dipilih Admin pada panel
//                    "Pengaturan AI" (field maksUkuran, 1-50 MB). Batas yang
//                    benar-benar berlaku diambil dari konfigLlm().maksUkuranMb.
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAKS_UKURAN_MB = 50;
// Batas ukuran bawaan yang berlaku (dan tampil pada panel Pengaturan AI).
const MAKS_UKURAN_BAWAAN_MB = 10;

// Format berkas yang lolos filter unggah. Catatan: ".doc" (Word 97-2003) lolos
// filter ini, tetapi ditolak pada tahap ekstraksi teks (lihat services/ekstraksi)
// karena mammoth hanya membaca DOCX; pesannya meminta konversi ke PDF/DOCX.
const ALLOWED_EXT = ['.pdf', '.doc', '.docx'];

// Ambang minimal jumlah kata hasil ekstraksi. Berkas hasil pemindaian/gambar
// (teksnya tidak terekstraksi) tidak layak dianalisis, jadi ditolak dengan 400.
const MIN_KATA_TEREKSTRAKSI = 10;

// Origin frontend yang diizinkan. Default '*' agar upload.html & result.html
// dapat dipanggil baik dari http://localhost:3000 maupun dari file:// (origin 'null').
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ---- Konfigurasi LLM/AI (diisi melalui berkas .env — lihat .env.example) ----
//   LLM_API_KEY       : kunci API penyedia LLM. Dibaca HANYA di backend
//                       dan tidak pernah dikirim ke frontend, tidak pernah
//                       ditulis ke log, dan tidak ikut tersimpan.
//   LLM_MODEL_NAME    : nama model, mis. "gpt-4o-mini" / "gemini-2.0-flash"
//                       / "deepseek-chat" (alias lama: LLM_MODEL)
//   LLM_PROVIDER      : 'auto' | 'openai' | 'gemini'
//                       auto -> Gemini bila base URL memuat "generativelanguage"
//                       atau nama model diawali "gemini"; selain itu OpenAI.
//   LLM_BASE_URL      : alamat REST API.
//                       OpenAI : https://api.openai.com/v1
//                       Gemini : https://generativelanguage.googleapis.com/v1beta
//   LLM_TIMEOUT_MS    : batas waktu satu panggilan API, MAKSIMAL 60 detik
//   LLM_MAX_KATA      : batas kata teks yang dikirim, MAKSIMAL 8.000 kata
//   LLM_TEMPERATURE   : kreativitas keluaran (0 = paling konsisten)
//   LLM_JSON_MODE     : 'auto' | 'on' | 'off' -> JSON mode / structured output
//   LLM_FALLBACK_SIMULASI : 'true' -> pakai data mock saat LLM gagal (khusus
//                       demo tanpa kunci API). Default 'false': kegagalan
//                       LLM dikembalikan sebagai HTTP 500 yang rapi.
const LLM_API_KEY = String(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const LLM_BASE_URL = String(process.env.LLM_BASE_URL || 'https://api.openai.com/v1')
  .trim().replace(/\/+$/, '');
const LLM_MODEL_NAME = String(process.env.LLM_MODEL_NAME || process.env.LLM_MODEL
  || 'gpt-4o-mini').trim();
const LLM_PROVIDER = String(process.env.LLM_PROVIDER || 'auto').trim().toLowerCase();
// Batas waktu panggilan API LLM: maksimal 60 detik (dinaikkan dari 30s untuk
// mendukung dokumen besar dengan cold-start LLM; retries sukses ~21,8s).
const LLM_TIMEOUT_MS = Math.min(Math.max(Number(process.env.LLM_TIMEOUT_MS) || 60000, 1000), 60000);
// Teks yang dikirim ke LLM: maksimal 8.000 kata pertama (hemat token).
const LLM_MAX_KATA = Math.min(Math.max(Number(process.env.LLM_MAX_KATA) || 8000, 200), 8000);
const LLM_TEMPERATURE = Number.isFinite(Number(process.env.LLM_TEMPERATURE))
  ? Number(process.env.LLM_TEMPERATURE) : 0.2;
const LLM_JSON_MODE = String(process.env.LLM_JSON_MODE || 'auto').trim().toLowerCase();
const LLM_FALLBACK_SIMULASI =
  String(process.env.LLM_FALLBACK_SIMULASI || 'false').trim().toLowerCase() === 'true';

module.exports = {
  ROOT_DIR,
  PORT,
  HOST,
  UI_DIR,
  DATA_DIR,
  UPLOAD_DIR,
  DB_SQLITE,
  DB_FILE,
  USERS_FILE,
  AI_CONFIG_FILE,
  SESI_DICABUT_FILE,
  MAX_FILE_SIZE,
  MAKS_UKURAN_MB,
  MAKS_UKURAN_BAWAAN_MB,
  ALLOWED_EXT,
  MIN_KATA_TEREKSTRAKSI,
  CORS_ORIGIN,
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MODEL_NAME,
  LLM_PROVIDER,
  LLM_TIMEOUT_MS,
  LLM_MAX_KATA,
  LLM_TEMPERATURE,
  LLM_JSON_MODE,
  LLM_FALLBACK_SIMULASI,
};
