'use strict';
/* ============================================================================
 *  Uji ekstraksi teks dokumen (bagian 4 server.js)
 *  Dijalankan terhadap INSTANCE UJI, bukan server port 3000 milik pengguna.
 *      $env:PORT='3500'; $env:DATA_DIR="$env:TEMP\ippl-uji"; node server.js
 *      node .uji-ekstraksi.tmp.js
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const BASE = process.env.UJI_BASE || 'http://localhost:3500';
const UPLOAD_DIR_UJI = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');

let lulus = 0;
let gagal = 0;

function cek(nama, syarat, info) {
  if (syarat) {
    lulus += 1;
    console.log(`  [OK]   ${nama}${info ? ` -> ${info}` : ''}`);
  } else {
    gagal += 1;
    console.log(`  [GAGAL] ${nama}${info ? ` -> ${info}` : ''}`);
  }
}

/** Membuat berkas DOCX minimal yang valid (atau tanpa teks bila paragraf kosong). */
async function buatDocx(paragraf) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.folder('_rels').file('.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  const isi = paragraf.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  zip.folder('word').file('document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${isi}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Mengirim satu permintaan unggah ke instance uji. */
async function unggah({ nim, nama, judul, jenis, isi, namaBerkas, mime }) {
  const fd = new FormData();
  fd.append('nim', nim === undefined ? '11241002' : nim);
  fd.append('nama', nama === undefined ? 'Muhammad Ikhsan' : nama);
  fd.append('judul', judul === undefined ? 'Deteksi Plagiarisme Proposal TA Berbasis AI' : judul);
  fd.append('jenis_dokumen', jenis === undefined ? 'proposal' : jenis);
  if (isi) {
    fd.append('file', new Blob([new Uint8Array(isi)], { type: mime || 'application/octet-stream' }), namaBerkas);
  } else if (namaBerkas) {
    fd.append('file', new Blob([], { type: mime || 'application/octet-stream' }), namaBerkas);
  }
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
}

function isiFolderUnggahan() {
  try { return fs.readdirSync(UPLOAD_DIR_UJI); } catch (e) { return []; }
}

(async () => {
  console.log(`\n=== UJI EKSTRAKSI TEKS DOKUMEN (${BASE}) ===\n`);

  /* ---- 0. Kesiapan layanan ---- */
  console.log('0) Kesiapan layanan');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  cek('health.ok', health.status === 'success');
  cek('health.ekstraksi_teks.pdf = pdf-parse', health.ekstraksi_teks && health.ekstraksi_teks.pdf === 'pdf-parse');
  cek('health.ekstraksi_teks.docx = mammoth', health.ekstraksi_teks && health.ekstraksi_teks.docx === 'mammoth');

  /* ---- 1. PDF nyata (dokumen SRS proyek) ---- */
  console.log('\n1) PDF nyata: dokumen SRS proyek');
  const pdfAsli = fs.readFileSync(path.join(__dirname, 'SRS IPPL - 11241002.docx (1).pdf'));
  const t0 = Date.now();
  const r1 = await unggah({ isi: pdfAsli, namaBerkas: 'proposal-ta.pdf', mime: 'application/pdf' });
  const durasi = Date.now() - t0;
  cek('status 201', r1.status === 201, `status=${r1.status} ${r1.body && r1.body.message ? r1.body.message : ''}`);
  if (r1.status === 201) {
    const td = r1.body.teks_dokumen || {};
    cek('teks_dokumen.format = pdf', td.format === 'pdf');
    cek('teks_dokumen.jumlah_kata > 1000', td.jumlah_kata > 1000, `${td.jumlah_kata} kata / ${td.jumlah_karakter} karakter / ${td.jumlah_halaman} halaman (${durasi} ms)`);
    cek('teks_dokumen.cuplikan terisi', typeof td.cuplikan === 'string' && td.cuplikan.length > 0, JSON.stringify(String(td.cuplikan).slice(0, 80)));
    cek('skor tetap mock 28', r1.body.overall_similarity_score === 28);
    console.log(`         id=${r1.body.id}`);

    const detail = await fetch(`${BASE}/api/results/${r1.body.id}`).then((r) => r.json());
    cek('GET /api/results/:id memuat teks_dokumen', detail.teks_dokumen && detail.teks_dokumen.jumlah_kata === td.jumlah_kata);
  }

  /* ---- 2. DOCX nyata ---- */
  console.log('\n2) DOCX nyata (dibuat dengan jszip)');
  const paragraf = Array.from({ length: 12 }, (_, i) =>
    `Bab ${i + 1} pembahasan penelitian deteksi plagiarisme proposal tugas akhir menggunakan kecerdasan buatan pada program studi informatika.`);
  const docxAsli = await buatDocx(paragraf);
  const r2 = await unggah({ isi: docxAsli, namaBerkas: 'proposal-ta.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  cek('status 201', r2.status === 201, `status=${r2.status} ${r2.body && r2.body.message ? r2.body.message : ''}`);
  if (r2.status === 201) {
    const td = r2.body.teks_dokumen || {};
    cek('teks_dokumen.format = docx', td.format === 'docx');
    cek('teks_dokumen.jumlah_kata sesuai', td.jumlah_kata >= 150, `${td.jumlah_kata} kata`);
    cek('teks DOCX benar terbaca', String(td.cuplikan).includes('plagiarisme'), JSON.stringify(String(td.cuplikan).slice(0, 70)));
  }

  /* ---- 3. Berkas rusak ---- */
  console.log('\n3) Berkas rusak (harus 400)');
  const sebelumRusak = isiFolderUnggahan().length;
  const r3 = await unggah({ isi: Buffer.from('%PDF-1.7\nini bukan berkas pdf yang sah, hanya teks biasa'), namaBerkas: 'rusak.pdf', mime: 'application/pdf' });
  cek('PDF rusak -> 400', r3.status === 400, `${r3.status}: ${r3.body && r3.body.message}`);
  cek('pesan menyebut tidak dapat dibaca', /tidak dapat dibaca|Invalid PDF|rusak/i.test((r3.body && r3.body.message) || ''));

  const r4 = await unggah({ isi: Buffer.from('PK\u0003\u0004 ini docx palsu tanpa struktur'), namaBerkas: 'rusak.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  cek('DOCX rusak -> 400', r4.status === 400, `${r4.status}: ${r4.body && r4.body.message}`);

  /* ---- 4. Teks tidak terekstraksi / terlalu pendek ---- */
  console.log('\n4) Teks tidak terekstraksi / terlalu pendek (harus 400)');
  const docxKosong = await buatDocx([]);
  const r5 = await unggah({ isi: docxKosong, namaBerkas: 'kosong.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  cek('DOCX tanpa teks -> 400', r5.status === 400, `${r5.status}: ${r5.body && r5.body.message}`);
  cek('pesan menyebut pemindaian/terlalu pendek', /pemindaian|terlalu pendek/i.test((r5.body && r5.body.message) || ''));

  const docxPendek = await buatDocx(['Halo dunia.']);
  const r6 = await unggah({ isi: docxPendek, namaBerkas: 'pendek.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  cek('DOCX 2 kata -> 400', r6.status === 400, `${r6.status}: ${r6.body && r6.body.message}`);

  /* ---- 5. Format .doc (Word 97-2003) ---- */
  console.log('\n5) Format .doc lama (lolos filter unggah, ditolak saat ekstraksi)');
  const r7 = await unggah({ isi: Buffer.from('\u00d0\u00cf\u0011\u00e0 dokumen word lama'), namaBerkas: 'lama.doc', mime: 'application/msword' });
  cek('.doc -> 400', r7.status === 400, `${r7.status}: ${r7.body && r7.body.message}`);
  cek('pesan meminta konversi ke PDF/DOCX', /DOCX|Simpan ulang/i.test((r7.body && r7.body.message) || ''));

  /* ---- 6. Tidak ada berkas tersisa setelah penolakan ---- */
  console.log('\n6) Kebersihan berkas');
  const sesudahRusak = isiFolderUnggahan().length;
  cek('tidak ada berkas tersisa dari permintaan gagal', sesudahRusak === sebelumRusak, `sebelum=${sebelumRusak}, sesudah=${sesudahRusak}`);

  /* ---- 7. Validasi metadata tetap jalan lebih dahulu ---- */
  console.log('\n7) Validasi metadata didahulukan (tanpa biaya ekstraksi)');
  const r8 = await unggah({ nim: 'ABC', isi: pdfAsli, namaBerkas: 'proposal-ta.pdf', mime: 'application/pdf' });
  cek('NIM salah -> 400', r8.status === 400 && /nim/i.test((r8.body && r8.body.message) || ''), `${r8.status}: ${r8.body && r8.body.message}`);
  const r9 = await unggah({ judul: '', isi: pdfAsli, namaBerkas: 'proposal-ta.pdf', mime: 'application/pdf' });
  cek('judul kosong -> 400', r9.status === 400 && /judul/i.test((r9.body && r9.body.message) || ''), `${r9.status}: ${r9.body && r9.body.message}`);

  console.log(`\n=== HASIL: ${lulus} lulus, ${gagal} gagal ===\n`);
  process.exitCode = gagal ? 1 : 0;
})().catch((err) => {
  console.error('\n[uji] Error tak terduga:', err);
  process.exitCode = 2;
});
