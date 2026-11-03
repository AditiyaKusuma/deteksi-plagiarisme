'use strict';

const router = require('express').Router();
const { wajibLogin, wajibAdmin } = require('../middleware/auth');
const { ambilField, publikKonfigAi, samarkanKunci, konfigAiSaatIni } = require('../lib/util');
const { STATUS_PEMERIKSAAN, semuaRekaman, jumlahRekaman, semuaPengguna, PERAN_MAHASISWA, PERAN_ADMIN, STATUS_AKTIF } = require('../repos/riwayat');
const { muatPengguna, simpanPengguna, cariPenggunaEmail, buatIdPengguna, hashPassword, publikPengguna: pubPengguna } = require('../repos/pengguna');
const { PENYEDIA_AI, providerAktif, konfigAiSaatIni: getKonfigAi, simpanKonfigAi } = require('../repos/konfigAi');
const { MAX_KATA_TEREKSTRAKSI } = require('../config');
const path = require('path');

/* GET /api/admin/users (UC-09) — daftar pengguna terdaftar */
router.get('/users', wajibLogin, wajibAdmin, (req, res) => {
  const { total, limit, offset, data } = require('../repos/pengguna').jumlahPengguna ? // placeholder
    // Actually let's use the repos directly
    semuaPengguna().slice(offset, offset + limit) : [];

  const halaman = data.slice(offset, offset + limit);
  res.set('X-Total-Count', String(data.length));

  res.json({
    status: 'success',
    total: data.length,
    count: halaman.length,
    limit,
    offset,
    data: halaman.map(pubPengguna),
    mahasiswa: semuaPengguna().filter((u) => u.peran === PERAN_MAHASISWA).length,
    administrator: semuaPengguna().filter((u) => u.peran === PERAN_ADMIN).length,
    aktif: semuaPengguna().filter((u) => u.status === STATUS_AKTIF).length,
  });
});

/* GET /api/admin/documents (UC-10) — seluruh dokumen yang diunggah */
router.get('/documents', wajibLogin, wajibAdmin, (req, res) => {
  const kataKunci = ambilField(req.query, 'q').toLowerCase();
  const nim = ambilField(req.query, 'nim');
  const jenis = ambilField(req.query, 'jenis_dokumen', 'jenis').toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let data = semuaRekaman().map((rekaman) => {
    const meta = rekaman.document_metadata || {};
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
      skor: typeof rekaman.overall_similarity_score === 'number' ? rekaman.overall_similarity_score : null,
      klasifikasi: rekaman.classification_level || null,
      // FR-11: status pemeriksaan apa adanya (menunggu/diproses/berhasil/gagal).
      status_pemeriksaan: rekaman.status_pemeriksaan || null,
      pesan_status: rekaman.pesan_status || null,
      waktu_mulai: rekaman.waktu_mulai || null,
      waktu_selesai: rekaman.waktu_selesai || null,
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
    data = data.filter((d) => [d.judul, d.nama, d.nim, d.jenis_dokumen, d.berkas && d.berkas.nama_asli]
      .some((nilai) => String(nilai || '').toLowerCase().includes(kataKunci)));
  }

  data.sort((a, b) => String(b.diunggah_pada || '').localeCompare(String(a.diunggah_pada || '')));

  const halaman = data.slice(offset, offset + limit);
  const totalUkuran = data.reduce((jumlah, d) => jumlah + (d.berkas && typeof d.berkas.ukuran_byte === 'number' ? d.berkas.ukuran_byte : 0), 0);

  res.set('X-Total-Count', String(data.length));
  res.json({
    status: 'success',
    total: data.length,
    count: halaman.length,
    limit,
    offset,
    jumlah_byte_total: totalUkuran,
    jumlah_terbaca_total: require('../lib/util').ukuranTerbaca(totalUkuran),
    data: halaman,
  });
});

/* GET /api/admin/histories (UC-11) — seluruh riwayat pemeriksaan */
router.get('/histories', wajibLogin, wajibAdmin, (req, res) => {
  const daftarRiwayat = semuaRekaman();
  const total = daftarRiwayat.length;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const data = daftarRiwayat.slice(offset, offset + limit);

  const skor = semuaRekaman()
    .map((r) => r.overall_similarity_score)
    .filter((n) => typeof n === 'number');

  res.set('X-Total-Count', String(total));
  res.json({
    status: 'success',
    total: total,
    count: data.length,
    limit,
    offset,
    ringkasan_klasifikasi: {
      Tinggi: semuaRekaman().filter((r) => r.classification_level === 'Tinggi').length,
      Sedang: semuaRekaman().filter((r) => r.classification_level === 'Sedang').length,
      Rendah: semuaRekaman().filter((r) => r.classification_level === 'Rendah').length,
    },
    rata_rata_skor: skor.length
      ? Math.round(skor.reduce((jumlah, n) => jumlah + n, 0) / skor.length) : null,
    data,
  });
});

/* GET /api/admin/ai-config (UC-12) — baca konfigurasi penyedia AI */
router.get('/ai-config', wajibLogin, wajibAdmin, (req, res) => {
  res.json({
    status: 'success',
    tersimpan: require('../db').adaKonfigAi ? require('../db').adaKonfigAi() : false,
    catatan: 'Kunci API hanya disimpan di server (data/ai-config.json) dan dikirim kembali dalam bentuk tersemar.',
    config: publikKonfigAi(),
  });
});

/* POST /api/admin/ai-config (UC-13) — simpan konfigurasi penyedia AI */
router.post('/ai-config', wajibLogin, wajibAdmin, (req, res, next) => {
  try {
    const body = req.body || {};
    const baru = { ...konfigAiSaatIni() };

    baru.aktif = require('../lib/util').booleanKonfig(body.aktif, baru.aktif);

    const penyedia = ambilField(body, 'penyedia', 'provider').toLowerCase();
    if (penyedia) {
      if (!PENYEDIA_AI.includes(penyedia)) {
        throw new (require('../lib/util').AppError)(400, `Field "penyedia" harus salah satu dari: ${PENYEDIA_AI.join(', ')}.`, {
          field: 'penyedia',
        });
      }
      baru.penyedia = penyedia;
    }

    const model = ambilField(body, 'model', 'model_name', 'nama_model');
    if (body.model !== undefined || body.model_name !== undefined || body.nama_model !== undefined) {
      if (model.length < 2 || model.length > 80) {
        throw new (require('../lib/util').AppError)(400, 'Field "model" wajib diisi, 2-80 karakter.', { field: 'model' });
      }
      baru.model = model;
    }

    const endpoint = ambilField(body, 'endpoint', 'base_url', 'alamat_api');
    if (endpoint) {
      if (!/^https?:\/\/[^\s]+$/i.test(endpoint)) {
        throw new (require('../lib/util').AppError)(400, 'Field "endpoint" harus berupa URL http/https yang sah.', {
          field: 'endpoint',
        });
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
        if (bersih && !tersemar) {
          if (bersih.length < 8) {
            throw new (require('../lib/util').AppError)(400, 'Field "apiKey" minimal 8 karakter.', { field: 'apiKey' });
          }
          baru.apiKey = bersih;
        }
        // kosong atau tersamar -> kunci lama dipertahankan
      }
    }
    // Kunci API wajib tersedia untuk mengaktifkan layanan: boleh dari panel
    // (data/ai-config.json) maupun dari .env (LLM_API_KEY).
    if (baru.aktif && !String(baru.apiKey || '').length && !require('../server').LLM_API_KEY
        && baru.penyedia !== 'ollama') {
      throw new (require('../lib/util').AppError)(400, 'Kunci API wajib diisi sebelum layanan AI diaktifkan.', {
        field: 'apiKey', penyedia: baru.penyedia,
      });
    }

    baru.suhu = require('../lib/util').angkaKonfig(body.suhu !== undefined ? body.suhu : body.temperature,
      baru.suhu, 0, 1, 'suhu');
    baru.maxToken = require('../lib/util').angkaKonfig(body.maxToken !== undefined ? body.maxToken : body.max_token,
      baru.maxToken, 256, 32000, 'maxToken');
    baru.timeout = require('../lib/util').angkaKonfig(body.timeout, baru.timeout, 5, 120, 'timeout');
    baru.ambangTinggi = require('../lib/util').angkaKonfig(body.ambangTinggi !== undefined ? body.ambangTinggi : body.ambang_tinggi,
      baru.ambangTinggi, 0, 100, 'ambangTinggi');
    baru.ambangSedang = require('../lib/util').angkaKonfig(body.ambangSedang !== undefined ? body.ambangSedang : body.ambang_sedang,
      baru.ambangSedang, 0, 100, 'ambangSedang');
    baru.maksUkuran = require('../lib/util').angkaKonfig(body.maksUkuran !== undefined ? body.maksUkuran : body.maks_ukuran,
      baru.maksUkuran, 1, 50, 'maksUkuran');

    if (baru.ambangTinggi <= baru.ambangSedang) {
      throw new (require('../lib/util').AppError)(400, 'Ambang "Tinggi" harus lebih besar daripada ambang "Sedang".', {
        ambangTinggi: baru.ambangTinggi, ambangSedang: baru.ambangSedang,
      });
    }

    baru.simpanRiwayat = require('../lib/util').booleanKonfig(
      body.simpanRiwayat !== undefined ? body.simpanRiwayat : body.simpan_riwayat, baru.simpanRiwayat);
    baru.tampilSumber = require('../lib/util').booleanKonfig(
      body.tampilSumber !== undefined ? body.tampilSumber : body.tampil_sumber, baru.tampilSumber);
    baru.koreksiOtomatis = require('../lib/util').booleanKonfig(
      body.koreksiOtomatis !== undefined ? body.koreksiOtomatis : body.koreksi_otomatis, baru.koreksiOtomatis);

    baru.diperbarui = new Date().toISOString();
    baru.diperbarui_oleh = req.pengguna.email;

    setKonfigAi(baru);
    if (!simpanKonfigAi()) {
      throw new (require('../lib/util').AppError)(500, 'Konfigurasi AI gagal disimpan ke data/ai-config.json.');
    }

    console.log(`[ai-config] disimpan oleh ${req.pengguna.email}: `      + `${baru.penyedia}/${baru.model}, aktif=${baru.aktif}`);

    res.json({
      status: 'success',
      message: 'Konfigurasi layanan AI berhasil disimpan.',
      catatan: 'Nilai ini tersimpan di sisi server; kunci API dikembalikan dalam bentuk tersemar.',
      config: publikKonfigAi(),
    });
  } catch (err) {
    next(err);
  }
});

/* POST /api/admin/ai-config/test (UC-13) — tes koneksi ke penyedia AI */
router.post('/ai-config/test', wajibLogin, wajibAdmin, async (req, res, next) => {
  try {
    const k = require('../lib/util').konfigLlm();
    // Jalankan panggilan LLM pendek dengan AbortController & timeout
    const { AbortController } = await import('abort-controller');
    const signal = new AbortController();
    const timeout = setTimeout(() => signal.abort(), k.timeoutMs);
    let percobaan = 0;
    let ulangSibuk = 0;

    const pengendali = new AbortController();
    const percobaanMax = 3;

    while (percobaan < percobaanMax) {
      try {
        percobaan++;
        const resS = await require('../services/llm/providers').kirimPermintaanLLM(
          `Test koneksi: model=${k.model}, provider=${k.penyedia}`,
          LLM_JSON_MODE !== 'off',
          signal);
        clearTimeout(timeout);
        res.json({
          status: 'success',
          message: `Koneksi ke ${k.penyedia} sukses pada percobaan ${percobainya}`,
          response_singkat: resS.substring(0, 200),
        });
        break;
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new (require('../lib/util').AppError)(504, 'Timeout menunggu respons LLM');
        }
        if (err.status === 429 || err.status === 500) {
          ulangSibuk++;
          const jeda = ulangSibuk * 2000;
          await new Promise(r => setTimeout(r, jeda));
          continue;
        }
        // Status aman, tidak akan kebocor ke klien
        throw new (require('../lib/util').AppError)(400, `Kesalahan layanan: ${err.message || 'tidak dikenal'}`);
      }
    }

    if (percobaan >= percobaanMax) {
      throw new (require('../lib/util').AppError)(500, 'Semua percobaan koneksi gagal');
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;