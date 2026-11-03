'use strict';

const router = require('express').Router();
const { konfigLlm, llmSiap } = require('../lib/util');
const { STATUS_PEMERIKSAAN, SEMUA_STATUS_PEMERIKSAAN, statusRekaman, semuaRekaman, jumlahRekaman } = require('../repos/riwayat');
const { MAX_KATA_TEREKSTRAKSI, MIN_KATA_TEREKSTRAKSI, LLM_JSON_MODE, LLM_MAX_KATA, LLM_FALLBACK_SIMULASI } = require('../config');
const { publikKonfigAi } = require('../repos/konfigAi');

/* GET /api/health — status layanan */
router.get('/', (req, res) => {
  const k = konfigLlm();

  res.json({
    status: 'success',
    service: 'deteksi-plagiarisme-api',
    version: '0.6.0',
    progress: '50% (alur bertahap + status pemeriksaan)',
    llm_siap: llmSiap(),
    analysis_engine: llmSiap()
      ? `llm-${k.penyedia}-v1 (${k.model})`
      : 'simulasi-llm-v1 (fallback)',
    llm: {
      dikonfigurasi: llmSiap(),
      provider: k.penyedia,
      model: k.model,
      base_url_host: k.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
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
    total_hasil: jumlahRekaman(),
    // Sebaran status pemeriksaan (FR-11) untuk halaman Beranda/panel Admin.
    status_pemeriksaan: semuaRekaman().reduce((hitung, rekaman) => {
      const kunci = statusRekaman(rekaman);
      hitung[kunci] = (hitung[kunci] || 0) + 1;
      return hitung;
    }, {}),
    total_pengguna: require('../repos/pengguna').jumlahPengguna(),
    maks_ukuran_mb: k.maksUkuranMb,
    ai_config: {
      tersimpan: publikKonfigAi().aktif || false,
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

module.exports = router;