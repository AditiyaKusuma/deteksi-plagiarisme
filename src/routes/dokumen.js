'use strict';

const router = require('express').Router();
const { wajibLogin, wajibAdmin } = require('../middleware/auth');
const { terimaBerkas, tanganiUnggah, tanganiSimpanDokumen } = require('../middleware/upload');
const { STATUS_PEMERIKSAAN, statusRekaman, semuaRekaman, tambahRekaman, simpanRiwayat } = require('../repos/riwayat');
const { PUBLIC_FILES_DIR } = require('../config');
const path = require('path');

/* POST /api/upload — unggah + ekstraksi + analisis LLM (satu permintaan) */
router.post('/', wajibLogin, terimaBerkas, tanganiUnggah);

/* POST /api/documents — unggah + ekstraksi saja (FR-04), status "menunggu" */
router.post('/documents', wajibLogin, terimaBerkas, tanganiSimpanDokumen);

/* POST /api/documents/analyze — alias lama: unggah + langsung analisis */
router.post('/documents/analyze', wajibLogin, terimaBerkas, tanganiUnggah);

/* GET /api/documents/:id — informasi dokumen (FR-04) */
router.get('/:id', wajibLogin, (req, res, next) => {
  const rekaman = semuaRekaman().find(
    (r) => String(r.id || '').toLowerCase() === String(req.params.id || '').toLowerCase()) || null;

  if (!rekaman) {
    return next(new (require('../lib/util').AppError)(404,
      `Dokumen dengan id "${req.params.id}" tidak ditemukan.`));
  }

  if (!((req.pengguna && req.pengguna.peran === 'Administrator') ||
        (rekaman.document_metadata && rekaman.document_metadata.user_id === req.pengguna.id))) {
    return next(new (require('../lib/util').AppError)(403,
      'Akses ditolak: dokumen ini milik akun lain.', { id: req.params.id }));
  }

  res.json({
    status: 'success',
    id: rekaman.id,
    created_at: rekaman.created_at || null,
    status_pemeriksaan: statusRekaman(rekaman),
    pesan_status: rekaman.pesan_status || null,
    waktu_mulai: rekaman.waktu_mulai || null,
    waktu_selesai: rekaman.waktu_selesai || null,
    document_metadata: rekaman.document_metadata || null,
    berkas: rekaman.berkas || null,
    teks_dokumen: rekaman.teks_dokumen || null,
  });
});

/* POST /api/documents/:id/analyze — mulai analisis asinkron (FR-11) */
router.post('/:id/analyze', wajibLogin, (req, res, next) => {
  const rekaman = semuaRekaman().find(
    (r) => String(r.id || '').toLowerCase() === String(req.params.id || '').toLowerCase()) || null;

  if (!rekaman) {
    return next(new (require('../lib/util').AppError)(404,
      `Dokumen dengan id "${req.params.id}" tidak ditemukan.`));
  }

  if (!((req.pengguna && req.pengguna.peran === 'Administrator') ||
        (rekaman.document_metadata && rekaman.document_metadata.user_id === req.pengguna.id))) {
    return next(new (require('../lib/util').AppError)(403,
      'Akses ditolak: dokumen ini milik akun lain.', { id: req.params.id }));
  }

  const status = statusRekaman(rekaman);

  if (status === STATUS_PEMERIKSAAN.DIPROSES || rekaman.analisisBerjalan && rekaman.analisisBerjalan.has(rekaman.id)) {
    return res.status(202).json({
      status: 'success',
      id: rekaman.id,
      status_pemeriksaan: STATUS_PEMERIKSAAN.DIPROSES,
      pesan_status: rekaman.pesan_status || 'Analisis sedang berjalan.',
    });
  }
  if (status === STATUS_PEMERIKSAAN.BERHASIL) {
    return next(new (require('../lib/util').AppError)(409,
      'Dokumen ini sudah dianalisis. Hapus hasilnya jika ingin memeriksa ulang.', { id: req.params.id }));
  }

  // status "menunggu" atau "gagal" -> jalankan (mendukung periksa ulang)
  rekaman.status_pemeriksaan = STATUS_PEMERIKSAAN.DIPROSES;
  rekaman.pesan_status = 'Analisis dimulai.';
  rekaman.waktu_mulai = new Date().toISOString();
  rekaman.waktu_selesai = null;
  simpanRiwayat();

  res.status(202).json({
    status: 'success',
    id: rekaman.id,
    status_pemeriksaan: STATUS_PEMERIKSAAN.DIPROSES,
    pesan_status: rekaman.pesan_status,
  });

  // Analisis berjalan setelah respons terkirim (batas 30 detik tetap berlaku)
  setImmediate(() => { require('../services/llm/analisis').analisisDokumen({}, rekaman); });
});

module.exports = router;