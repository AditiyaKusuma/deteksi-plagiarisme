'use strict';

/* ============================================================================
 *  UJI SMOKE END-TO-END — Aplikasi Deteksi Plagiarisme (NIM 11241002)
 *
 *  Menjalankan server sungguhan pada port & folder data sementara, lalu
 *  memeriksa alur utama SRS: pendaftaran (UC-01), autentikasi (UC-02),
 *  unggah (UC-03/FR-01..04), pemeriksaan AI simulasi (UC-04/FR-05..08),
 *  status (FR-11), hasil & riwayat (UC-05..07), logout yang mencabut token
 *  (UC-08/UC-14), isolasi data (NFR-02), serta panel Admin (UC-09..13).
 *
 *  Jalankan: npm test      (tanpa perlu kunci API; memakai fallback simulasi)
 * ========================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 32000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}/api`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ippl-uji-'));

let lulus = 0;
let gagal = 0;
const daftarGagal = [];

function cek(nama, syarat, keterangan) {
  if (syarat) {
    lulus += 1;
    console.log(`  \u2713 ${nama}`);
  } else {
    gagal += 1;
    daftarGagal.push(nama);
    console.log(`  \u2717 ${nama}${keterangan ? ` \u2014 ${keterangan}` : ''}`);
  }
}

/** Memanggil API dan mengurai JSON; mengembalikan { status, body }. */
async function minta(jalur, opsi) {
  opsi = opsi || {};
  const res = await fetch(BASE + jalur, opsi);
  const teks = await res.text();
  let body = null;
  try { body = teks ? JSON.parse(teks) : null; } catch (err) { body = { mentah: teks.slice(0, 200) }; }
  return { status: res.status, body };
}

function json(body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

function auth(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

/**
 * Membuat PDF 1 halaman sederhana yang teksnya dapat diekstraksi pdf-parse.
 * Dipakai sebagai berkas uji tanpa perlu menyimpan fixture biner di repo.
 */
function buatPdf(kalimat) {
  const baris = kalimat.match(/.{1,70}(\s|$)/g) || [kalimat];
  const isiTeks = baris
    .map((b, i) => `BT /F1 12 Tf 72 ${740 - i * 20} Td (${b.trim().replace(/[()\\]/g, '\\$&')}) Tj ET`)
    .join('\n');

  const objek = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(isiTeks)} >>\nstream\n${isiTeks}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offset = [];
  objek.forEach((badan, i) => {
    offset.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${badan}\nendobj\n`;
  });

  const mulaiXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objek.length + 1}\n0000000000 65535 f \n`;
  offset.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objek.length + 1} /Root 1 0 R >>\nstartxref\n${mulaiXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

async function tungguServer(proses) {
  const batas = Date.now() + 45000;
  while (Date.now() < batas) {
    if (proses.exitCode !== null) {
      throw new Error(`server berhenti lebih awal (exit ${proses.exitCode})`);
    }
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
    } catch (err) { /* server belum siap */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server tidak siap dalam 45 detik');
}

async function jalankan() {
  const logServer = [];
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR,
      AUTH_SECRET: 'rahasia-uji-smoke-ippl-11241002',
      LLM_FALLBACK_SIMULASI: 'true',
      LLM_API_KEY: '',
      CORS_ORIGIN: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => logServer.push(String(d)));
  server.stderr.on('data', (d) => logServer.push(String(d)));

  try {
    await tungguServer(server);

    /* ---------------- FR-01..04: unggah & informasi dokumen -------------- */
    console.log('\n[1] Pendaftaran, autentikasi & unggah dokumen');
    const email = `uji${Date.now()}@kampus.ac.id`;
    let r = await minta('/auth/register', json({ nama: 'Mahasiswa Uji', nim: '11241002', email, password: 'rahasia123' }));
    cek('UC-01 pendaftaran akun (201)', r.status === 201, `HTTP ${r.status}`);

    r = await minta('/auth/register', json({ nama: 'Mahasiswa Uji', nim: '11241002', email, password: 'rahasia123' }));
    cek('UC-01 exception email ganda (409)', r.status === 409, `HTTP ${r.status}`);

    r = await minta('/auth/login', json({ email, password: 'salah-sekali' }));
    cek('UC-02 exception kata sandi salah (401)', r.status === 401, `HTTP ${r.status}`);

    r = await minta('/auth/login', json({ email, password: 'rahasia123' }));
    const token = r.body && r.body.token;
    cek('UC-02 autentikasi berhasil (200 + token)', r.status === 200 && !!token, `HTTP ${r.status}`);

    const pdf = buatPdf('PROPOSAL TUGAS AKHIR DETEKSI PLAGIARISME PROPOSAL DAN LAPORAN '
      + 'TUGAS AKHIR MENGGUNAKAN ARTIFICIAL INTELLIGENCE BAGIAN JUDUL PENDAHULUAN '
      + 'TINJAUAN PUSTAKA METODOLOGI PENELITIAN HASIL DAN PEMBAHASAN KESIMPULAN '
      + 'DAFTAR PUSTAKA LAMPIRAN PENELITIAN MAHASISWA PROGRAM STUDI INFORMATIKA');

    const form = new FormData();
    form.append('judul', 'Proposal Uji Otomatis');
    form.append('nim', '11241002');
    form.append('jenis', 'proposal');
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'proposal-uji.pdf');

    r = await minta('/documents', { method: 'POST', ...auth(token), body: form });
    const id = r.body && r.body.id;
    cek('UC-03 unggah dokumen (201)', r.status === 201 && !!id, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    cek('FR-03 ekstraksi teks nyata', !!(r.body && r.body.teks_dokumen && r.body.teks_dokumen.jumlah_kata >= 10),
      r.body && r.body.teks_dokumen && `kata=${r.body.teks_dokumen.jumlah_kata}`);
    cek('FR-11 status awal "menunggu"', r.body && r.body.status_pemeriksaan === 'menunggu',
      r.body && r.body.status_pemeriksaan);

    r = await minta(`/documents/${id}`, auth(token));
    cek('FR-04 informasi dokumen dapat diambil', r.status === 200 && r.body.id === id, `HTTP ${r.status}`);

    /* ---------------- UC-04/FR-11: pemeriksaan asinkron ------------------ */
    console.log('\n[2] Pemeriksaan dokumen & status');
    r = await minta(`/documents/${id}/analyze`, { method: 'POST', ...auth(token) });
    cek('UC-04 mulai pemeriksaan (202)', r.status === 202 && r.body.status_pemeriksaan === 'diproses',
      `HTTP ${r.status}`);

    let status = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((res) => setTimeout(res, 500));
      r = await minta(`/results/${id}/status`, auth(token));
      status = r.body && r.body.status_pemeriksaan;
      if (status === 'berhasil' || status === 'gagal') break;
    }
    cek('FR-11 status akhir "berhasil"', status === 'berhasil', `status=${status}`);

    r = await minta(`/results/${id}`, auth(token));
    const rekaman = r.body || {};
    cek('FR-07 klasifikasi Rendah/Sedang/Tinggi',
      ['Rendah', 'Sedang', 'Tinggi'].includes(rekaman.classification_level), rekaman.classification_level);
    cek('FR-08 skor kemiripan numerik', typeof rekaman.overall_similarity_score === 'number',
      String(rekaman.overall_similarity_score));
    cek('UC-17 hasil pemeriksaan struktur dokumen',
      rekaman.structure_analysis && typeof rekaman.structure_analysis === 'object'
      && Object.keys(rekaman.structure_analysis).length >= 4);

    r = await minta(`/documents/${id}/analyze`, { method: 'POST', ...auth(token) });
    cek('UC-04 exception rekaman selesai tidak diperiksa ulang (409)', r.status === 409, `HTTP ${r.status}`);

    /* ---------------- UC-05..07: hasil & riwayat ------------------------- */
    console.log('\n[3] Hasil & riwayat');
    r = await minta('/history', auth(token));
    cek('FR-13 riwayat memuat rekaman milik sendiri',
      r.status === 200 && Array.isArray(r.body.data) && r.body.data.some((d) => d.id === id),
      `HTTP ${r.status}`);

    /* ---------------- NFR-02: isolasi data ------------------------------ */
    const email2 = `lain${Date.now()}@kampus.ac.id`;
    await minta('/auth/register', json({ nama: 'Mahasiswa Lain', nim: '11241003', email: email2, password: 'rahasia123' }));
    r = await minta('/auth/login', json({ email: email2, password: 'rahasia123' }));
    const token2 = r.body && r.body.token;

    r = await minta(`/results/${id}`, auth(token2));
    cek('NFR-02 pengguna lain ditolak melihat hasil (403)', r.status === 403, `HTTP ${r.status}`);

    r = await minta('/history', auth(token2));
    cek('NFR-02 riwayat pengguna lain kosong', r.status === 200 && r.body.total === 0, `total=${r.body && r.body.total}`);

    /* ---------------- UC-09..13: panel admin ---------------------------- */
    console.log('\n[4] Panel Admin');
    r = await minta('/auth/login', json({ email: 'admin@example.com', password: 'admin123', peran: 'Administrator' }));
    const tokenAdmin = r.body && r.body.token;
    cek('UC-09 autentikasi admin (200)', r.status === 200 && !!tokenAdmin, `HTTP ${r.status}`);

    r = await minta('/admin/users', auth(tokenAdmin));
    cek('UC-10 daftar pengguna', r.status === 200 && r.body.total >= 3, `HTTP ${r.status}`);

    r = await minta('/admin/documents', auth(tokenAdmin));
    const dokAdmin = (r.body && r.body.data) || [];
    cek('UC-11 daftar dokumen + status pemeriksaan',
      r.status === 200 && dokAdmin.some((d) => d.id === id && d.status_pemeriksaan === 'berhasil'),
      `HTTP ${r.status}`);

    r = await minta('/admin/histories', auth(tokenAdmin));
    cek('UC-12 seluruh riwayat pemeriksaan', r.status === 200 && r.body.total >= 1, `HTTP ${r.status}`);

    r = await minta('/admin/ai-config', auth(tokenAdmin));
    cek('UC-13 konfigurasi AI terbaca', r.status === 200 && !!r.body.config, `HTTP ${r.status}`);

    r = await minta('/admin/users', auth(token));
    cek('NFR-02 mahasiswa ditolak membuka panel admin (403)', r.status === 403, `HTTP ${r.status}`);

    /* ---------------- UC-08/UC-14: logout mencabut token ---------------- */
    console.log('\n[5] Logout & pencabutan token');
    r = await minta('/auth/logout', { method: 'POST', ...auth(tokenAdmin) });
    cek('UC-14 logout admin (200)', r.status === 200 && r.body.dicabut === true, `HTTP ${r.status}`);

    r = await minta('/admin/users', auth(tokenAdmin));
    cek('Token yang sudah logout ditolak (401)', r.status === 401, `HTTP ${r.status}`);

    r = await minta('/auth/logout', { method: 'POST', ...auth(token) });
    cek('UC-08 logout mahasiswa (200)', r.status === 200 && r.body.dicabut === true, `HTTP ${r.status}`);

    r = await minta('/history', auth(token));
    cek('Token mahasiswa yang sudah logout ditolak (401)', r.status === 401, `HTTP ${r.status}`);

    r = await minta('/auth/logout', { method: 'POST', headers: { authorization: 'Bearer token-palsu' } });
    cek('Logout dengan token tidak sah ditolak (401)', r.status === 401, `HTTP ${r.status}`);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (err) { /* diabaikan */ }
  }

  console.log('\n' + '-'.repeat(58));
  console.log(`Lulus: ${lulus} \u00b7 Gagal: ${gagal}`);
  if (gagal) {
    console.log('Uji gagal: ' + daftarGagal.join(', '));
    console.log('\n--- log server (100 baris terakhir) ---');
    console.log(logServer.join('').split('\n').slice(-100).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Semua uji smoke lulus.');
  }
}

jalankan().catch((err) => {
  console.error('UJI TIDAK DAPAT DIJALANKAN:', err.message);
  process.exitCode = 1;
});
