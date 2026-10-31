'use strict';

/* ============================================================================
 *  BASIS DATA SQLITE — Aplikasi Deteksi Plagiarisme Proposal & Laporan TA
 *  (NIM 11241002)
 *
 *  Modul ini menggantikan penyimpanan berkas JSON (data/users.json,
 *  data/ai-config.json, data/hasil-analisis.json) dengan basis data SQLite
 *  memakai modul bawaan Node.js `node:sqlite` — tanpa dependensi tambahan.
 *
 *  Tabel:
 *    pengguna          akun mahasiswa & Administrator (kata sandi = hash scrypt)
 *    dokumen           rekaman unggahan + status pemeriksaan (FR-11)
 *    hasil_analisis    skor, klasifikasi, keterangan mesin LLM
 *    struktur_dokumen  kelengkapan bagian dokumen (1 baris per bagian, UC-17)
 *    flagged_passages  kutipan terindikasi beserta urutannya (FR-08/FR-10)
 *    ai_config         konfigurasi penyedia AI (satu baris, id = 1)
 *
 *  Catatan: berkas unggahan tetap disimpan di folder data/uploads/; basis data
 *  hanya menyimpan metadata dan hasil analisisnya.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/** Koneksi aktif (null sebelum buka() dipanggil). */
let db = null;

/** Jalur berkas basis data yang sedang dipakai. */
let jalurDb = '';

/* ============================================================================
 *  SKEMA
 * ========================================================================== */

const SKEMA = `
CREATE TABLE IF NOT EXISTS pengguna (
  id              TEXT PRIMARY KEY,
  nama            TEXT NOT NULL,
  nim             TEXT,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  peran           TEXT NOT NULL,
  status          TEXT NOT NULL,
  dibuat          TEXT,
  terakhir_masuk  TEXT
);

CREATE TABLE IF NOT EXISTS dokumen (
  id                     TEXT PRIMARY KEY,
  created_at             TEXT NOT NULL,
  status_pemeriksaan     TEXT NOT NULL,
  pesan_status           TEXT,
  waktu_mulai            TEXT,
  waktu_selesai          TEXT,
  user_id                TEXT,
  user_email             TEXT,
  nim                    TEXT,
  nama                   TEXT,
  judul                  TEXT,
  jenis_dokumen          TEXT,
  berkas_nama_asli       TEXT,
  berkas_nama_tersimpan  TEXT,
  berkas_ekstensi        TEXT,
  berkas_mime            TEXT,
  berkas_ukuran_byte     INTEGER,
  berkas_ukuran          TEXT,
  teks_format            TEXT,
  teks_karakter          INTEGER,
  teks_kata              INTEGER,
  teks_halaman           INTEGER,
  teks_cuplikan          TEXT
);

CREATE INDEX IF NOT EXISTS idx_dokumen_user   ON dokumen(user_id);
CREATE INDEX IF NOT EXISTS idx_dokumen_status ON dokumen(status_pemeriksaan);

CREATE TABLE IF NOT EXISTS hasil_analisis (
  dokumen_id         TEXT PRIMARY KEY REFERENCES dokumen(id) ON DELETE CASCADE,
  skor               INTEGER,
  klasifikasi        TEXT,
  analysis_engine    TEXT,
  llm_mode           TEXT,
  llm_model          TEXT,
  llm_endpoint_host  TEXT,
  llm_json_mode      TEXT,
  llm_percobaan      INTEGER,
  llm_durasi_ms      INTEGER,
  llm_kata_terkirim  INTEGER,
  llm_dipotong       INTEGER,
  llm_bagian         INTEGER,
  llm_koreksi        INTEGER,
  llm_token_json     TEXT,
  llm_peringatan     TEXT
);

CREATE TABLE IF NOT EXISTS struktur_dokumen (
  dokumen_id  TEXT NOT NULL REFERENCES dokumen(id) ON DELETE CASCADE,
  bagian      TEXT NOT NULL,
  terdeteksi  INTEGER NOT NULL,
  PRIMARY KEY (dokumen_id, bagian)
);

CREATE TABLE IF NOT EXISTS flagged_passages (
  dokumen_id            TEXT NOT NULL REFERENCES dokumen(id) ON DELETE CASCADE,
  urutan                INTEGER NOT NULL,
  teks                  TEXT NOT NULL,
  similarity_percentage INTEGER,
  source_reference      TEXT,
  PRIMARY KEY (dokumen_id, urutan)
);

CREATE TABLE IF NOT EXISTS ai_config (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  aktif             INTEGER NOT NULL DEFAULT 0,
  penyedia          TEXT,
  model             TEXT,
  endpoint          TEXT,
  api_key           TEXT,
  suhu              REAL,
  max_token         INTEGER,
  timeout           INTEGER,
  ambang_tinggi     INTEGER,
  ambang_sedang     INTEGER,
  maks_ukuran       INTEGER,
  simpan_riwayat    INTEGER,
  tampil_sumber     INTEGER,
  koreksi_otomatis  INTEGER,
  diperbarui        TEXT,
  diperbarui_oleh   TEXT
);
`;

/* ============================================================================
 *  UTILITAS NILAI
 * ========================================================================== */

/** Koneksi aktif; melempar galat bila buka() belum dipanggil. */
function koneksi() {
  if (!db) throw new Error('Basis data belum dibuka (panggil buka() lebih dulu).');
  return db;
}

/** String atau null. */
function teks(nilai) {
  if (nilai === null || nilai === undefined) return null;
  return String(nilai);
}

/** Angka valid atau null (NaN/Infinity tidak diterima SQLite). */
function angka(nilai) {
  if (nilai === null || nilai === undefined || nilai === '') return null;
  const n = Number(nilai);
  return Number.isFinite(n) ? n : null;
}

/** Boolean -> 0/1. */
function bit(nilai) {
  return nilai === true || nilai === 1 || nilai === 'true' ? 1 : 0;
}

/** Boolean dari kolom INTEGER. */
function dariBit(nilai) {
  return nilai === 1 || nilai === true;
}

/** Objek/array -> teks JSON (untuk kolom yang jarang dipakai). */
function jsonTeks(nilai) {
  if (nilai === null || nilai === undefined) return null;
  try {
    return JSON.stringify(nilai);
  } catch (err) {
    return null;
  }
}

/** Teks JSON -> objek (null bila tidak sah). */
function dariJson(nilai) {
  if (!nilai) return null;
  try {
    return JSON.parse(nilai);
  } catch (err) {
    return null;
  }
}

/* ============================================================================
 *  KONEKSI
 * ========================================================================== */

/**
 * Membuka (dan bila perlu membuat) basis data SQLite.
 * @param {string} jalur lokasi berkas .db
 * @returns {import('node:sqlite').DatabaseSync}
 */
function buka(jalur) {
  if (db) return db;

  jalurDb = jalur;
  fs.mkdirSync(path.dirname(jalur), { recursive: true });

  db = new DatabaseSync(jalur);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SKEMA);

  return db;
}

/** Menutup koneksi (dipanggil saat proses berhenti). */
function tutup() {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    console.error('[db] gagal menutup basis data:', err.message);
  }
  db = null;
}

/** Jalur berkas basis data aktif. */
function lokasi() {
  return jalurDb;
}

/** Jumlah baris sebuah tabel (dipakai untuk memeriksa kebutuhan migrasi). */
function jumlahBaris(tabel) {
  const aman = String(tabel).replace(/[^a-z_]/gi, '');
  if (!['pengguna', 'dokumen', 'ai_config'].includes(aman)) return 0;
  const baris = koneksi().prepare(`SELECT COUNT(*) AS n FROM ${aman}`).get();
  return baris ? Number(baris.n) : 0;
}

/* ============================================================================
 *  PENGGUNA
 * ========================================================================== */

const SQL_SIMPAN_PENGGUNA = `
INSERT INTO pengguna (id, nama, nim, email, password_hash, peran, status, dibuat, terakhir_masuk)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  nama           = excluded.nama,
  nim            = excluded.nim,
  email          = excluded.email,
  password_hash  = excluded.password_hash,
  peran          = excluded.peran,
  status         = excluded.status,
  dibuat         = excluded.dibuat,
  terakhir_masuk = excluded.terakhir_masuk
`;

/**
 * Menyimpan seluruh daftar pengguna (upsert + hapus yang sudah tidak ada).
 * @param {object[]} daftar
 * @returns {boolean} true bila berhasil
 */
function simpanPengguna(daftar) {
  const data = Array.isArray(daftar) ? daftar : [];
  const idBaru = new Set(data.map((u) => String(u.id)));
  const k = koneksi();

  k.exec('BEGIN');
  try {
    const hapus = k.prepare('DELETE FROM pengguna WHERE id = ?');
    k.prepare('SELECT id FROM pengguna').all()
      .forEach((baris) => { if (!idBaru.has(baris.id)) hapus.run(baris.id); });

    const simpan = k.prepare(SQL_SIMPAN_PENGGUNA);
    data.forEach((u) => {
      simpan.run(
        teks(u.id), teks(u.nama), teks(u.nim), teks(u.email), teks(u.password_hash),
        teks(u.peran), teks(u.status), teks(u.dibuat), teks(u.terakhir_masuk),
      );
    });

    k.exec('COMMIT');
    return true;
  } catch (err) {
    k.exec('ROLLBACK');
    console.error('[db] gagal menyimpan pengguna:', err.message);
    return false;
  }
}

/**
 * Memuat seluruh pengguna.
 * @returns {object[]} urut menurut waktu dibuat (paling lama lebih dulu)
 */
function muatPengguna() {
  const baris = koneksi().prepare(`
    SELECT id, nama, nim, email, password_hash, peran, status, dibuat, terakhir_masuk
    FROM pengguna
    ORDER BY dibuat ASC
  `).all();

  return baris.map((b) => ({
    id: b.id,
    nama: b.nama,
    nim: b.nim,
    email: b.email,
    password_hash: b.password_hash,
    peran: b.peran,
    status: b.status,
    dibuat: b.dibuat,
    terakhir_masuk: b.terakhir_masuk,
  }));
}

/* ============================================================================
 *  KONFIGURASI AI
 * ========================================================================== */

/**
 * Menyimpan konfigurasi AI (satu baris, id = 1).
 * @param {object} konfig konfigurasi dari panel Admin
 * @returns {boolean} true bila berhasil
 */
function simpanKonfigAi(konfig) {
  const k = koneksi();
  const data = konfig && typeof konfig === 'object' ? konfig : {};

  try {
    k.prepare(`
      INSERT INTO ai_config (
        id, aktif, penyedia, model, endpoint, api_key, suhu, max_token, timeout,
        ambang_tinggi, ambang_sedang, maks_ukuran, simpan_riwayat, tampil_sumber,
        koreksi_otomatis, diperbarui, diperbarui_oleh
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        aktif            = excluded.aktif,
        penyedia         = excluded.penyedia,
        model            = excluded.model,
        endpoint         = excluded.endpoint,
        api_key          = excluded.api_key,
        suhu             = excluded.suhu,
        max_token        = excluded.max_token,
        timeout          = excluded.timeout,
        ambang_tinggi    = excluded.ambang_tinggi,
        ambang_sedang    = excluded.ambang_sedang,
        maks_ukuran      = excluded.maks_ukuran,
        simpan_riwayat   = excluded.simpan_riwayat,
        tampil_sumber    = excluded.tampil_sumber,
        koreksi_otomatis = excluded.koreksi_otomatis,
        diperbarui       = excluded.diperbarui,
        diperbarui_oleh  = excluded.diperbarui_oleh
    `).run(
      bit(data.aktif), teks(data.penyedia), teks(data.model), teks(data.endpoint),
      teks(data.apiKey), angka(data.suhu), angka(data.maxToken), angka(data.timeout),
      angka(data.ambangTinggi), angka(data.ambangSedang), angka(data.maksUkuran),
      bit(data.simpanRiwayat), bit(data.tampilSumber), bit(data.koreksiOtomatis),
      teks(data.diperbarui), teks(data.diperbarui_oleh),
    );
    return true;
  } catch (err) {
    console.error('[db] gagal menyimpan konfigurasi AI:', err.message);
    return false;
  }
}

/**
 * Memuat konfigurasi AI.
 * @returns {object|null} null bila panel belum pernah menyimpan konfigurasi
 */
function muatKonfigAi() {
  const b = koneksi().prepare('SELECT * FROM ai_config WHERE id = 1').get();
  if (!b) return null;

  return {
    aktif: dariBit(b.aktif),
    penyedia: b.penyedia,
    model: b.model,
    endpoint: b.endpoint,
    apiKey: b.api_key || '',
    suhu: b.suhu,
    maxToken: b.max_token,
    timeout: b.timeout,
    ambangTinggi: b.ambang_tinggi,
    ambangSedang: b.ambang_sedang,
    maksUkuran: b.maks_ukuran,
    simpanRiwayat: dariBit(b.simpan_riwayat),
    tampilSumber: dariBit(b.tampil_sumber),
    koreksiOtomatis: dariBit(b.koreksi_otomatis),
    diperbarui: b.diperbarui,
    diperbarui_oleh: b.diperbarui_oleh,
  };
}

/** true bila konfigurasi AI sudah pernah disimpan lewat panel Admin. */
function adaKonfigAi() {
  return jumlahBaris('ai_config') > 0;
}

/* ============================================================================
 *  REKAMAN DOKUMEN + HASIL ANALISIS
 * ========================================================================== */

const SQL_SIMPAN_DOKUMEN = `
INSERT INTO dokumen (
  id, created_at, status_pemeriksaan, pesan_status, waktu_mulai, waktu_selesai,
  user_id, user_email, nim, nama, judul, jenis_dokumen,
  berkas_nama_asli, berkas_nama_tersimpan, berkas_ekstensi, berkas_mime,
  berkas_ukuran_byte, berkas_ukuran,
  teks_format, teks_karakter, teks_kata, teks_halaman, teks_cuplikan
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  created_at            = excluded.created_at,
  status_pemeriksaan    = excluded.status_pemeriksaan,
  pesan_status          = excluded.pesan_status,
  waktu_mulai           = excluded.waktu_mulai,
  waktu_selesai         = excluded.waktu_selesai,
  user_id               = excluded.user_id,
  user_email            = excluded.user_email,
  nim                   = excluded.nim,
  nama                  = excluded.nama,
  judul                 = excluded.judul,
  jenis_dokumen         = excluded.jenis_dokumen,
  berkas_nama_asli      = excluded.berkas_nama_asli,
  berkas_nama_tersimpan = excluded.berkas_nama_tersimpan,
  berkas_ekstensi       = excluded.berkas_ekstensi,
  berkas_mime           = excluded.berkas_mime,
  berkas_ukuran_byte    = excluded.berkas_ukuran_byte,
  berkas_ukuran         = excluded.berkas_ukuran,
  teks_format           = excluded.teks_format,
  teks_karakter         = excluded.teks_karakter,
  teks_kata             = excluded.teks_kata,
  teks_halaman          = excluded.teks_halaman,
  teks_cuplikan         = excluded.teks_cuplikan
`;

const SQL_SIMPAN_HASIL = `
INSERT INTO hasil_analisis (
  dokumen_id, skor, klasifikasi, analysis_engine,
  llm_mode, llm_model, llm_endpoint_host, llm_json_mode, llm_percobaan,
  llm_durasi_ms, llm_kata_terkirim, llm_dipotong, llm_bagian, llm_koreksi,
  llm_token_json, llm_peringatan
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(dokumen_id) DO UPDATE SET
  skor              = excluded.skor,
  klasifikasi       = excluded.klasifikasi,
  analysis_engine   = excluded.analysis_engine,
  llm_mode          = excluded.llm_mode,
  llm_model         = excluded.llm_model,
  llm_endpoint_host = excluded.llm_endpoint_host,
  llm_json_mode     = excluded.llm_json_mode,
  llm_percobaan     = excluded.llm_percobaan,
  llm_durasi_ms     = excluded.llm_durasi_ms,
  llm_kata_terkirim = excluded.llm_kata_terkirim,
  llm_dipotong      = excluded.llm_dipotong,
  llm_bagian        = excluded.llm_bagian,
  llm_koreksi       = excluded.llm_koreksi,
  llm_token_json    = excluded.llm_token_json,
  llm_peringatan    = excluded.llm_peringatan
`;

/**
 * Menyimpan satu rekaman (dokumen + hasil + struktur + kutipan) memakai
 * statement yang sudah disiapkan pemanggil (lihat simpanRekaman).
 */
function tulisRekaman(rekaman, siap) {
  const meta = rekaman.document_metadata || {};
  const berkas = rekaman.berkas || {};
  const teksDok = rekaman.teks_dokumen || {};
  const llm = rekaman.llm || {};

  siap.dokumen.run(
    teks(rekaman.id), teks(rekaman.created_at) || new Date().toISOString(),
    teks(rekaman.status_pemeriksaan) || 'berhasil',
    teks(rekaman.pesan_status), teks(rekaman.waktu_mulai), teks(rekaman.waktu_selesai),
    teks(meta.user_id), teks(meta.user_email), teks(meta.nim), teks(meta.nama),
    teks(meta.judul), teks(meta.jenis_dokumen),
    teks(berkas.nama_asli), teks(berkas.nama_tersimpan), teks(berkas.ekstensi),
    teks(berkas.mime_type), angka(berkas.ukuran_byte), teks(berkas.ukuran),
    teks(teksDok.format), angka(teksDok.jumlah_karakter), angka(teksDok.jumlah_kata),
    angka(teksDok.jumlah_halaman), teks(teksDok.cuplikan),
  );

  // Baris hasil analisis hanya ada bila analisis pernah selesai.
  const adaSkor = angka(rekaman.overall_similarity_score) !== null
    || teks(rekaman.classification_level) !== null;

  siap.hapusHasil.run(teks(rekaman.id));
  if (adaSkor) {
    siap.hasil.run(
      teks(rekaman.id), angka(rekaman.overall_similarity_score),
      teks(rekaman.classification_level), teks(rekaman.analysis_engine),
      teks(llm.mode), teks(llm.model), teks(llm.endpoint_host), teks(llm.json_mode),
      angka(llm.percobaan), angka(llm.durasi_ms), angka(llm.jumlah_kata_terkirim),
      llm.teks_dipotong === undefined ? null : bit(llm.teks_dipotong),
      angka(llm.bagian), llm.koreksi === undefined ? null : bit(llm.koreksi),
      jsonTeks(llm.token), teks(llm.peringatan),
    );
  }

  // Struktur dokumen: satu baris per bagian.
  siap.hapusStruktur.run(teks(rekaman.id));
  const struktur = rekaman.structure_analysis;
  if (struktur && typeof struktur === 'object' && !Array.isArray(struktur)) {
    Object.keys(struktur).forEach((bagian) => {
      siap.struktur.run(teks(rekaman.id), String(bagian), bit(struktur[bagian]));
    });
  }

  // Kutipan terindikasi: urutan dipertahankan seperti keluaran LLM.
  siap.hapusKutipan.run(teks(rekaman.id));
  const temuan = Array.isArray(rekaman.flagged_passages) ? rekaman.flagged_passages : [];
  temuan.forEach((t, indeks) => {
    if (!t || typeof t !== 'object') return;
    siap.kutipan.run(
      teks(rekaman.id), indeks, teks(t.text) || '',
      angka(t.similarity_percentage),
      t.source_reference === null || t.source_reference === undefined
        ? null : teks(t.source_reference),
    );
  });
}

/**
 * Menyimpan seluruh daftar rekaman (upsert + hapus yang sudah tidak ada).
 * Dipakai oleh simpanRiwayat() di server.js setelah memori diubah.
 * @param {object[]} daftar
 * @returns {boolean} true bila berhasil
 */
function simpanRekaman(daftar) {
  const data = Array.isArray(daftar) ? daftar : [];
  const idBaru = new Set(data.map((r) => String(r.id)));
  const k = koneksi();

  k.exec('BEGIN');
  try {
    const hapus = k.prepare('DELETE FROM dokumen WHERE id = ?');
    k.prepare('SELECT id FROM dokumen').all()
      .forEach((baris) => { if (!idBaru.has(baris.id)) hapus.run(baris.id); });

    const siap = {
      dokumen: k.prepare(SQL_SIMPAN_DOKUMEN),
      hasil: k.prepare(SQL_SIMPAN_HASIL),
      hapusHasil: k.prepare('DELETE FROM hasil_analisis WHERE dokumen_id = ?'),
      struktur: k.prepare(
        'INSERT OR REPLACE INTO struktur_dokumen (dokumen_id, bagian, terdeteksi) VALUES (?, ?, ?)'),
      hapusStruktur: k.prepare('DELETE FROM struktur_dokumen WHERE dokumen_id = ?'),
      kutipan: k.prepare(`INSERT OR REPLACE INTO flagged_passages
        (dokumen_id, urutan, teks, similarity_percentage, source_reference)
        VALUES (?, ?, ?, ?, ?)`),
      hapusKutipan: k.prepare('DELETE FROM flagged_passages WHERE dokumen_id = ?'),
    };

    data.forEach((rekaman) => {
      if (!rekaman || !rekaman.id) return;
      tulisRekaman(rekaman, siap);
    });

    k.exec('COMMIT');
    return true;
  } catch (err) {
    k.exec('ROLLBACK');
    console.error('[db] gagal menyimpan rekaman:', err.message);
    return false;
  }
}

/**
 * Memuat seluruh rekaman beserta hasil analisis, struktur, dan kutipannya.
 * @returns {object[]} urut dari yang terbaru (created_at DESC)
 */
function muatRekaman() {
  const k = koneksi();

  const baris = k.prepare(`
    SELECT d.*, h.skor, h.klasifikasi, h.analysis_engine,
           h.llm_mode, h.llm_model, h.llm_endpoint_host, h.llm_json_mode,
           h.llm_percobaan, h.llm_durasi_ms, h.llm_kata_terkirim, h.llm_dipotong,
           h.llm_bagian, h.llm_koreksi, h.llm_token_json, h.llm_peringatan
    FROM dokumen d
    LEFT JOIN hasil_analisis h ON h.dokumen_id = d.id
    ORDER BY d.created_at DESC, d.id DESC
  `).all();

  if (!baris.length) return [];

  const strukturSemua = k.prepare(
    'SELECT dokumen_id, bagian, terdeteksi FROM struktur_dokumen').all();
  const kutipanSemua = k.prepare(`SELECT dokumen_id, urutan, teks, similarity_percentage,
    source_reference FROM flagged_passages ORDER BY dokumen_id, urutan`).all();

  const petaStruktur = new Map();
  strukturSemua.forEach((s) => {
    if (!petaStruktur.has(s.dokumen_id)) petaStruktur.set(s.dokumen_id, {});
    petaStruktur.get(s.dokumen_id)[s.bagian] = dariBit(s.terdeteksi);
  });

  const petaKutipan = new Map();
  kutipanSemua.forEach((t) => {
    if (!petaKutipan.has(t.dokumen_id)) petaKutipan.set(t.dokumen_id, []);
    petaKutipan.get(t.dokumen_id).push({
      text: t.teks,
      similarity_percentage: t.similarity_percentage,
      source_reference: t.source_reference,
    });
  });

  return baris.map((b) => {
    const rekaman = {
      id: b.id,
      created_at: b.created_at,
      status_pemeriksaan: b.status_pemeriksaan,
      pesan_status: b.pesan_status,
      waktu_mulai: b.waktu_mulai,
      waktu_selesai: b.waktu_selesai,
      document_metadata: {
        user_id: b.user_id,
        user_email: b.user_email,
        nim: b.nim,
        nama: b.nama,
        judul: b.judul,
        jenis_dokumen: b.jenis_dokumen,
      },
      teks_dokumen: {
        format: b.teks_format,
        jumlah_karakter: b.teks_karakter,
        jumlah_kata: b.teks_kata,
        jumlah_halaman: b.teks_halaman,
        cuplikan: b.teks_cuplikan,
      },
      berkas: {
        nama_asli: b.berkas_nama_asli,
        nama_tersimpan: b.berkas_nama_tersimpan,
        ekstensi: b.berkas_ekstensi,
        mime_type: b.berkas_mime,
        ukuran_byte: b.berkas_ukuran_byte,
        ukuran: b.berkas_ukuran,
      },
      structure_analysis: petaStruktur.get(b.id) || {},
      flagged_passages: petaKutipan.get(b.id) || [],
    };

    // Baris hasil analisis hanya ada bila analisis pernah selesai.
    if (b.skor !== null && b.skor !== undefined) {
      rekaman.status = 'success';
      rekaman.overall_similarity_score = b.skor;
      rekaman.classification_level = b.klasifikasi;
      rekaman.analysis_engine = b.analysis_engine;
      rekaman.llm = {
        mode: b.llm_mode,
        model: b.llm_model,
        endpoint_host: b.llm_endpoint_host,
        json_mode: b.llm_json_mode,
        percobaan: b.llm_percobaan,
        durasi_ms: b.llm_durasi_ms,
        jumlah_kata_terkirim: b.llm_kata_terkirim,
        teks_dipotong: b.llm_dipotong === null ? null : dariBit(b.llm_dipotong),
        bagian: b.llm_bagian,
        koreksi: b.llm_koreksi === null ? null : dariBit(b.llm_koreksi),
        token: dariJson(b.llm_token_json),
        peringatan: b.llm_peringatan,
      };
    }

    return rekaman;
  });
}

/** Menghapus satu rekaman (dokumen + hasil + struktur + kutipan). */
function hapusRekaman(id) {
  try {
    koneksi().prepare('DELETE FROM dokumen WHERE id = ?').run(teks(id));
    return true;
  } catch (err) {
    console.error('[db] gagal menghapus rekaman:', err.message);
    return false;
  }
}

/* ============================================================================
 *  INFORMASI
 * ========================================================================== */

/** Ringkasan basis data untuk /api/health dan log startup. */
function info() {
  let ukuranByte = 0;
  try {
    ukuranByte = fs.statSync(jalurDb).size;
  } catch (err) {
    ukuranByte = 0;
  }

  return {
    mesin: 'sqlite (node:sqlite)',
    berkas: jalurDb,
    ukuran_byte: ukuranByte,
    tabel: {
      pengguna: jumlahBaris('pengguna'),
      dokumen: jumlahBaris('dokumen'),
      ai_config: jumlahBaris('ai_config'),
    },
  };
}

module.exports = {
  buka,
  tutup,
  lokasi,
  info,
  jumlahBaris,
  muatPengguna,
  simpanPengguna,
  muatKonfigAi,
  simpanKonfigAi,
  adaKonfigAi,
  muatRekaman,
  simpanRekaman,
  hapusRekaman,
};
