'use strict';

/* ============================================================================
 *  REPOSITORI KONFIGURASI AI — dipindahkan dari server.js bagian 2B.2.
 *
 *  Menyimpan konfigurasi penyedia AI (panel Admin) di tabel `ai_config` lewat
 *  db.js, dengan nilai bawaan yang mengikuti variabel .env.
 * ========================================================================== */

const basisData = require('../../db');
const {
  LLM_BASE_URL, LLM_MODEL_NAME, LLM_TEMPERATURE, LLM_TIMEOUT_MS,
  LLM_PROVIDER, MAKS_UKURAN_BAWAAN_MB,
} = require('../config');

/** Penyedia AI yang dikenali (sama dengan pilihan pada admin-ai.html). */
const PENYEDIA_AI = ['openai', 'gemini', 'anthropic', 'mistral', 'ollama', 'lainnya'];

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

/** Nilai bawaan konfigurasi AI — mengikuti pengaturan .env. */
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

/** Konfigurasi AI yang sedang aktif (referensi langsung, hanya untuk dibaca). */
function konfigAiSaatIni() {
  return konfigAi;
}

/** Mengganti konfigurasi aktif di memori (tanpa menyimpan ke basis data). */
function setKonfigAi(nilai) {
  konfigAi = nilai;
  return konfigAi;
}

/** Memuat konfigurasi AI dari basis data (bila sudah pernah disimpan). */
function muatKonfigAi() {
  const tersimpan = basisData.muatKonfigAi();
  konfigAi = tersimpan && typeof tersimpan === 'object' && !Array.isArray(tersimpan)
    ? { ...konfigAiBawaan(), ...tersimpan }
    : konfigAiBawaan();
  return konfigAi;
}

/** Menyimpan konfigurasi AI ke basis data. */
function simpanKonfigAi() {
  return basisData.simpanKonfigAi(konfigAi);
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

module.exports = {
  PENYEDIA_AI,
  providerAktif,
  konfigAiBawaan,
  konfigAiSaatIni,
  setKonfigAi,
  muatKonfigAi,
  simpanKonfigAi,
  samarkanKunci,
  publikKonfigAi,
};
