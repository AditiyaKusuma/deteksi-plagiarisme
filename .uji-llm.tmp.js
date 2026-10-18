'use strict';
/* ============================================================================
 *  Uji integrasi LLM REST API (bagian 5 server.js) memakai server LLM tiruan.
 *
 *  Instansi yang diuji (harus sudah dijalankan lebih dulu):
 *    A : PORT=3500  LLM siap, fallback simulasi aktif
 *    B : PORT=3501  LLM siap, LLM_TIMEOUT_MS=5000
 *    C : PORT=3502  LLM siap, LLM_WAJIB=true (tanpa fallback)
 *    + server LLM tiruan: .uji-llm-mock.tmp.js pada port 3600
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const APP_A  = process.env.APP_A || 'http://localhost:3500';
const APP_B  = process.env.APP_B || 'http://localhost:3501';
const APP_C  = process.env.APP_C || 'http://localhost:3502';
const MOCK   = process.env.MOCK  || 'http://localhost:3600';
const DATA_A = process.env.DATA_A || path.join(process.env.TEMP || '.', 'ippl-uji-llmA');
const KUNCI_UJI = 'uji-kunci-RAHASIA-123';

let lulus = 0;
let gagal = 0;

function cek(nama, syarat, info) {
  if (syarat) {
    lulus += 1;
    console.log(`  [OK]    ${nama}${info ? ` -> ${info}` : ''}`);
  } else {
    gagal += 1;
    console.log(`  [GAGAL] ${nama}${info ? ` -> ${info}` : ''}`);
  }
}

/* ---- PDF minimal valid untuk dokumen uji ---- */
function buatPdfUji(barisTeks) {
  const escape = (s) => String(s).replace(/([\\()])/g, '\\$1');
  const aliran = barisTeks
    .map((baris, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${escape(baris)}) Tj ET`)
    .join('\n');
  const objek = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(aliran, 'latin1')} >>\nstream\n${aliran}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offset = [];
  objek.forEach((isi, i) => {
    offset.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${isi}\nendobj\n`;
  });
  const posisiXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objek.length + 1}\n0000000000 65535 f \n`;
  offset.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objek.length + 1} /Root 1 0 R >>\nstartxref\n${posisiXref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const BARIS_DASAR = [
  'Laporan Tugas Akhir tentang deteksi plagiarisme dokumen akademik menggunakan kecerdasan buatan.',
  'Bab I Pendahuluan membahas latar belakang penelitian kemiripan dokumen dan rumusan masalah.',
  'Bab II Tinjauan Pustaka membahas penelitian terdahulu mengenai deteksi plagiarisme teks.',
  'Bab III Metodologi menjelaskan rancangan sistem pengujian dan evaluasi akurasi deteksi.',
];
const pdfSkenario = (penanda) => buatPdfUji(
  penanda ? BARIS_DASAR.concat([`Catatan pengujian internal: ${penanda}.`]) : BARIS_DASAR);

/* ---- Kirim permintaan unggah ---- */
async function unggah(base, opsi = {}) {
  const fd = new FormData();
  fd.append('nim', opsi.nim === undefined ? '11241002' : opsi.nim);
  fd.append('nama', opsi.nama === undefined ? 'Muhammad Ikhsan' : opsi.nama);
  fd.append('judul', opsi.judul === undefined
    ? 'Deteksi Plagiarisme Proposal TA Berbasis AI' : opsi.judul);
  fd.append('jenis_dokumen', opsi.jenis === undefined ? 'proposal' : opsi.jenis);
  fd.append('file', new Blob([opsi.isi || pdfSkenario(opsi.penanda)], { type: opsi.mime || 'application/pdf' }),
    opsi.namaBerkas || 'proposal-ta.pdf');
  const res = await fetch(`${base}/api/upload`, { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch (err) { body = null; }
  return { status: res.status, body };
}

const rekamanMock = () => fetch(`${MOCK}/_rekaman`).then((r) => r.json());
const hasilId = (body) => (body && body.id) || '(tidak ada id)';

(async () => {
  console.log('\n=== UJI INTEGRASI LLM REST API ===\n');

  /* ---- 0. Kesiapan layanan ---- */
  console.log('0) Kesiapan layanan');
  const healthA = await fetch(`${APP_A}/api/health`).then((r) => r.json());
  cek('A health.version = 0.5.0', healthA.version === '0.5.0', healthA.version);
  cek('A health.llm.dikonfigurasi = true', healthA.llm && healthA.llm.dikonfigurasi === true);
  cek('A health.llm.model = model-uji', healthA.llm && healthA.llm.model === 'model-uji', healthA.llm && healthA.llm.model);
  cek('A health.llm.base_url_host = localhost:3600', healthA.llm && healthA.llm.base_url_host === 'localhost:3600');
  cek('A analysis_engine = llm-rest-v1 (model-uji)',
    healthA.analysis_engine === 'llm-rest-v1 (model-uji)', healthA.analysis_engine);
  cek('A health.progress menyebut analisis LLM', /LLM/i.test(healthA.progress || ''), healthA.progress);

  const healthC = await fetch(`${APP_C}/api/health`).then((r) => r.json());
  cek('C health.llm.wajib = true', healthC.llm && healthC.llm.wajib === true);

  /* ---- 1. Analisis normal memakai LLM ---- */
  console.log('\n1) Analisis dokumen PDF asli memakai LLM nyata');
  const r1 = await unggah(APP_A);
  cek('status 201', r1.status === 201, `${r1.status} ${(r1.body && r1.body.message) || ''}`);
  if (r1.status === 201) {
    const b = r1.body;
    cek('skor dari LLM = 73', b.overall_similarity_score === 73, String(b.overall_similarity_score));
    cek('klasifikasi dari LLM = Tinggi', b.classification_level === 'Tinggi', b.classification_level);
    cek('analysis_engine = llm-rest-v1 (model-uji)', b.analysis_engine === 'llm-rest-v1 (model-uji)', b.analysis_engine);
    cek('llm.mode = llm', b.llm && b.llm.mode === 'llm');
    cek('llm.endpoint_host = localhost:3600', b.llm && b.llm.endpoint_host === 'localhost:3600');
    cek('llm.token.total = 1444', b.llm && b.llm.token && b.llm.token.total === 1444);
    cek('llm.json_mode = true', b.llm && b.llm.json_mode === true);
    cek('llm.peringatan kosong', b.llm && b.llm.peringatan === null);
    cek('llm.durasi_ms tercatat', typeof (b.llm || {}).durasi_ms === 'number', `${(b.llm || {}).durasi_ms} ms`);

    const struktur = b.structure_analysis || {};
    const kunciStruktur = Object.keys(struktur);
    cek('structure_analysis punya 4 kunci sesuai spesifikasi', kunciStruktur.length === 4
      && kunciStruktur.includes('Cover / Halaman Judul') && kunciStruktur.includes('Bab I Pendahuluan')
      && kunciStruktur.includes('Bab II Tinjauan Pustaka') && kunciStruktur.includes('Bab III Metodologi'),
      kunciStruktur.join(' | '));
    cek('alias LLM "Cover" -> true', struktur['Cover / Halaman Judul'] === true);
    cek('alias LLM "Bab 1 Pendahuluan" -> true', struktur['Bab I Pendahuluan'] === true);
    cek('Bab III Metodologi -> true', struktur['Bab III Metodologi'] === true);
    cek('kunci tambahan LLM (Daftar Pustaka) tidak bocor', kunciStruktur.includes('Daftar Pustaka') === false);

    cek('flagged_passages = 2 temuan', Array.isArray(b.flagged_passages) && b.flagged_passages.length === 2);
    const temuan = (b.flagged_passages || [])[0] || {};
    cek('temuan punya text/similarity_percentage/source_reference',
      typeof temuan.text === 'string' && temuan.text.length > 20
      && typeof temuan.similarity_percentage === 'number'
      && typeof temuan.source_reference === 'string',
      `${temuan.similarity_percentage}% - ${String(temuan.source_reference).slice(0, 40)}`);
    cek('document_metadata terisi dari form', (b.document_metadata || {}).nim === '11241002'
      && (b.document_metadata || {}).jenis_dokumen === 'Proposal Tugas Akhir');
    cek('teks_dokumen (hasil ekstraksi) tetap disertakan',
      (b.teks_dokumen || {}).format === 'pdf' && (b.teks_dokumen || {}).jumlah_kata > 10,
      `${(b.teks_dokumen || {}).jumlah_kata} kata`);
    cek('kunci API tidak bocor ke respons', JSON.stringify(b).indexOf(KUNCI_UJI) === -1);

    /* ---- 2. Permintaan yang diterima server LLM ---- */
    console.log('\n2) Bentuk permintaan yang diterima LLM');
    const rek = (await rekamanMock()).rekamanTerakhir || {};
    cek('Authorization: Bearer <kunci>', rek.authorization === `Bearer ${KUNCI_UJI}`, String(rek.authorization));
    cek('model dikirim = model-uji', rek.model === 'model-uji', String(rek.model));
    cek('prompt sistem dikirim', rek.ada_prompt_sistem === true);
    cek('response_format json_object dikirim (JSON mode)', rek.response_format
      && rek.response_format.type === 'json_object', JSON.stringify(rek.response_format));
    cek('temperature dari env = 0.2', rek.temperature === 0.2, String(rek.temperature));
    cek('teks dokumen ikut terkirim', rek.karakter_prompt_user > 200, `${rek.karakter_prompt_user} karakter`);

    /* ---- 3. Tersimpan di data/hasil-analisis.json ---- */
    console.log('\n3) Penyimpanan ke berkas JSON');
    const berkas = path.join(DATA_A, 'hasil-analisis.json');
    let isiBerkas = [];
    try { isiBerkas = JSON.parse(fs.readFileSync(berkas, 'utf8')); } catch (err) { isiBerkas = []; }
    const tersimpan = isiBerkas.find((r) => r.id === b.id);
    cek('rekaman tersimpan di hasil-analisis.json', Boolean(tersimpan), `${isiBerkas.length} rekaman di berkas`);
    cek('skor tersimpan = 73', tersimpan && tersimpan.overall_similarity_score === 73);
    cek('flagged_passages tersimpan lengkap', tersimpan
      && Array.isArray(tersimpan.flagged_passages) && tersimpan.flagged_passages.length === 2);
    cek('metadata dokumen tersimpan', tersimpan && tersimpan.document_metadata
      && tersimpan.document_metadata.nim === '11241002');
    cek('info llm tersimpan', tersimpan && tersimpan.llm && tersimpan.llm.mode === 'llm');
  }

  /* ---- 4. Toleransi format keluaran LLM ---- */
  console.log('\n4) Toleransi format keluaran LLM');
  const r4a = await unggah(APP_A, { penanda: 'SKENARIO_PAGAR' });
  cek('balasan berpagar ```json tetap terbaca', r4a.status === 201 && r4a.body.overall_similarity_score === 73,
    `${r4a.status} skor=${r4a.body && r4a.body.overall_similarity_score}`);
  const r4b = await unggah(APP_A, { penanda: 'SKENARIO_TEKS_BEBAS' });
  cek('JSON yang diselipkan dalam kalimat tetap terbaca',
    r4b.status === 201 && r4b.body.overall_similarity_score === 73,
    `${r4b.status} skor=${r4b.body && r4b.body.overall_similarity_score}`);

  /* ---- 5. Keluaran LLM tidak sah -> fallback simulasi (A) ---- */
  console.log('\n5) Keluaran LLM tidak sah -> fallback simulasi (LLM_WAJIB=false)');
  const r5a = await unggah(APP_A, { penanda: 'SKENARIO_RUSAK' });
  cek('balasan bukan JSON -> 201 dengan fallback', r5a.status === 201, String(r5a.status));
  cek('analysis_engine menandai fallback', /simulasi-llm-v1 \(fallback/.test((r5a.body || {}).analysis_engine || ''),
    (r5a.body || {}).analysis_engine);
  cek('llm.mode = simulasi-fallback', r5a.body.llm && r5a.body.llm.mode === 'simulasi-fallback');
  cek('llm.peringatan menjelaskan sebabnya', /JSON/i.test((r5a.body.llm || {}).peringatan || ''),
    (r5a.body.llm || {}).peringatan);
  cek('skor fallback 28 (mock)', r5a.body.overall_similarity_score === 28);

  const r5b = await unggah(APP_A, { penanda: 'SKENARIO_TANPA_SKOR' });
  cek('JSON tanpa overall_similarity_score -> fallback',
    r5b.status === 201 && /overall_similarity_score/i.test((r5b.body.llm || {}).peringatan || ''),
    (r5b.body.llm || {}).peringatan);

  const r5c = await unggah(APP_A, { penanda: 'SKENARIO_401' });
  cek('HTTP 401 dari LLM -> fallback + saran periksa kunci',
    r5c.status === 201 && /HTTP 401/.test((r5c.body.llm || {}).peringatan || '')
    && /LLM_API_KEY/.test((r5c.body.llm || {}).peringatan || ''),
    (r5c.body.llm || {}).peringatan);

  /* ---- 6. JSON mode ditolak penyedia -> ulang tanpa response_format ---- */
  console.log('\n6) Penyedia menolak response_format (HTTP 400) -> ulang tanpa JSON mode');
  const sebelum6 = (await rekamanMock()).jumlahPermintaan;
  const r6 = await unggah(APP_A, { penanda: 'SKENARIO_400_JSONMODE' });
  const sesudah6 = (await rekamanMock()).jumlahPermintaan;
  cek('berhasil setelah pengulangan', r6.status === 201 && r6.body.overall_similarity_score === 73,
    `${r6.status} skor=${r6.body && r6.body.overall_similarity_score}`);
  cek('dilakukan 2 permintaan (ulang sekali)', sesudah6 - sebelum6 === 2, `${sesudah6 - sebelum6} permintaan`);
  cek('permintaan terakhir tanpa response_format',
    ((await rekamanMock()).rekamanTerakhir || {}).response_format === null);
  cek('llm.json_mode = false pada rekaman',
    r6.body.llm && r6.body.llm.json_mode === false, String(r6.body.llm && r6.body.llm.json_mode));
  cek('llm.percobaan = 2', r6.body.llm && r6.body.llm.percobaan === 2);

  /* ---- 7. Validasi metadata tidak memanggil LLM ---- */
  console.log('\n7) Validasi metadata sebelum memanggil LLM');
  const sebelum7 = (await rekamanMock()).jumlahPermintaan;
  const r7 = await unggah(APP_A, { nim: 'XYZ' });
  const sesudah7 = (await rekamanMock()).jumlahPermintaan;
  cek('NIM salah -> 400', r7.status === 400, `${r7.status} ${(r7.body || {}).message}`);
  cek('tidak ada permintaan ke LLM', sesudah7 === sebelum7, `${sesudah7 - sebelum7} permintaan`);

  /* ---- 8. Batas waktu LLM ---- */
  console.log('\n8) Batas waktu LLM (instansi B, LLM_TIMEOUT_MS=5000)');
  const r8 = await unggah(APP_B, { penanda: 'SKENARIO_LAMBAT' });
  cek('melebihi batas waktu -> fallback', r8.status === 201, String(r8.status));
  cek('peringatan menyebut batas waktu', /batas waktu/i.test((r8.body.llm || {}).peringatan || ''),
    (r8.body.llm || {}).peringatan);

  /* ---- 9. LLM_WAJIB=true (instansi C) ---- */
  console.log('\n9) LLM_WAJIB=true: kesalahan LLM diteruskan ke klien');
  const r9a = await unggah(APP_C, { penanda: 'SKENARIO_401' });
  cek('HTTP 401 dari LLM -> respons 502 ke klien', r9a.status === 502, `${r9a.status} ${(r9a.body || {}).message}`);
  cek('pesan menyebut HTTP 401', /HTTP 401/i.test((r9a.body || {}).message || ''), (r9a.body || {}).message);
  const r9b = await unggah(APP_C);
  cek('dokumen normal tetap diproses LLM', r9b.status === 201
    && r9b.body.analysis_engine === 'llm-rest-v1 (model-uji)'
    && r9b.body.overall_similarity_score === 73, `${r9b.status} ${(r9b.body || {}).analysis_engine}`);

  /* ---- 10. Berkas .env tidak boleh tersaji lewat HTTP ---- */
  console.log('\n10) Perlindungan berkas konfigurasi');
  for (const jalur of ['/.env', '/.env.example', '/server.js']) {
    const res = await fetch(`${APP_A}${jalur}`);
    cek(`${jalur} ditolak`, res.status === 403, `HTTP ${res.status}`);
  }

  console.log(`\n=== HASIL: ${lulus} lulus, ${gagal} gagal ===\n`);
  process.exitCode = gagal ? 1 : 0;
})().catch((err) => {
  console.error('\n[uji] Error tak terduga:', err);
  process.exitCode = 2;
});
