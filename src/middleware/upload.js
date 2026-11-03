'use strict';

const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { AppError } = require('../lib/util');

// Import dari config
const { UPLOAD_DIR, MAX_FILE_SIZE, ALLOWED_EXT } = require('../config');

/** Konfigurasi penyimpanan berkas multer. */
const penyimpanan = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ekstensi = path.extname(file.originalname).toLowerCase();
    cb(null, `dokumen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ekstensi}`);
  },
});

/** Instance multer dengan konfigurasi. */
const upload = multer({
  storage: penyimpanan,
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 30 },
  fileFilter: (req, file, cb) => {
    const ekstensi = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ekstensi)) {
      return cb(new AppError(400,
        'Format berkas tidak didukung. Gunakan berkas PDF atau DOCX ' +
        '(.doc Word 97-2003 harus disimpan ulang sebagai .docx).'));
    }
    cb(null, true);
  },
});

/** Middleware: terima berkas dari permintaan. */
const terimaBerkas = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) return next(err);
    next();
  });
};

/**
 * Handler POST /api/upload — unggah + analisis langsung.
 * Handler ini akan didefinisikan di server.js dan di-set ke module ini.
 */
let tanganiUnggah = (req, res, next) => {
  next(new AppError(501, 'Handler belum diimplementasi'));
};

/**
 * Handler POST /api/documents — unggah + simpan saja (status "menunggu").
 * Handler ini akan didefinisikan di server.js dan di-set ke module ini.
 */
let tanganiSimpanDokumen = (req, res, next) => {
  next(new AppError(501, 'Handler belum diimplementasi'));
};

module.exports = {
  terimaBerkas,
  get tanganiUnggah() { return tanganiUnggah; },
  get tanganiSimpanDokumen() { return tanganiSimpanDokumen; },
  upload,
  // Export setter function agar server.js bisa assign handler asli
  setTanganiUnggah: (fn) => { tanganiUnggah = fn; },
  setTanganiSimpanDokumen: (fn) => { tanganiSimpanDokumen = fn; },
};
