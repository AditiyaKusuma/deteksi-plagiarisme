'use strict';
/* Skrip uji sementara — aman dihapus setelah dipakai.
 *
 * CATATAN: sejak server.js melakukan EKSTRAKSI TEKS NYATA (pdf-parse/mammoth),
 * berkas PDF/DOCX palsu ditolak dengan HTTP 400. Skrip ini kini membuat PDF
 * minimal yang valid (berisi teks > MIN_KATA_TEREKSTRAKSI) agar skenario
 * unggah sukses tetap dapat diuji.
 */
const BASE = process.env.BASE || 'http://localhost:3500';

function line(t) { console.log('\n===== ' + t + ' ====='); }

/** Membuat PDF 1 halaman minimal yang valid dan berisi teks nyata. */
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
  pdf += `trailer\n<< /Size ${objek.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${posisiXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

async function main() {
  const pdfAsli = buatPdfUji([
    'Aplikasi Deteksi Plagiarisme Proposal dan Laporan Tugas Akhir Menggunakan Kecerdasan Buatan.',
    'Bab I Pendahuluan membahas latar belakang penelitian mengenai kemiripan dokumen akademik.',
    'Bab II Tinjauan Pustaka membahas penelitian terdahulu tentang deteksi plagiarisme teks.',
    'Bab III Metodologi menjelaskan rancangan sistem, pengumpulan data, dan pengujian akurasi.',
  ]);
  let pdf = new Blob([pdfAsli], { type: 'application/pdf' });

  line('1. POST /api/upload');
  let fd = new FormData();
  fd.append('nim', '11241002');
  fd.append('nama', 'Muhammad Ikhsan');
  fd.append('judul', 'Deteksi Plagiarisme Proposal TA Berbasis AI');
  fd.append('jenis_dokumen', 'proposal');
  fd.append('file', pdf, 'proposal-ta.pdf');
  let res = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  let body = await res.json();
  console.log('HTTP', res.status, JSON.stringify(body, null, 2));
  const id = body.id;

  line('2. GET /api/results/:id');
  res = await fetch(BASE + '/api/results/' + id);
  console.log('HTTP', res.status, '| id cocok:', (await res.json()).id === id);

  line('3. GET /api/history');
  res = await fetch(BASE + '/api/history');
  const hist = await res.json();
  console.log('HTTP', res.status, '| X-Total-Count:', res.headers.get('x-total-count'), '| total:', hist.total, '| count:', hist.count);

  line('4. Filter riwayat');
  res = await fetch(BASE + '/api/history?nim=99999999');
  console.log('nim=99999999 (harus 0) ->', (await res.json()).total);
  res = await fetch(BASE + '/api/history?q=ikhsan');
  console.log('q=ikhsan ->', (await res.json()).total);
  res = await fetch(BASE + '/api/history?klasifikasi=Rendah');
  console.log('klasifikasi=Rendah ->', (await res.json()).total);

  line('5. NIM tidak valid (harus 400)');
  fd = new FormData();
  fd.append('nim', 'abc');
  fd.append('judul', 'Judul Uji Validasi');
  fd.append('file', pdf, 'x.pdf');
  res = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  console.log('HTTP', res.status, JSON.stringify(await res.json()));

  line('6. Tanpa berkas (harus 400)');
  fd = new FormData();
  fd.append('nim', '11241002');
  fd.append('judul', 'Judul Tanpa Berkas');
  res = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  console.log('HTTP', res.status, JSON.stringify(await res.json()));

  line('7. Ekstensi .txt (harus 400)');
  fd = new FormData();
  fd.append('nim', '11241002');
  fd.append('judul', 'Judul Ekstensi Salah');
  fd.append('file', new Blob([Buffer.from('halo')], { type: 'text/plain' }), 'catatan.txt');
  res = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  console.log('HTTP', res.status, JSON.stringify(await res.json()));

  line('8. Alias POST /api/documents & /api/documents/analyze');
  fd = new FormData();
  fd.append('nim', '11241002');
  fd.append('judul', 'Uji Alias Endpoint Dokumen');
  fd.append('file', pdf, 'a.pdf');
  res = await fetch(BASE + '/api/documents', { method: 'POST', body: fd });
  console.log('POST /api/documents ->', res.status);
  fd = new FormData();
  fd.append('nim', '11241002');
  fd.append('judul', 'Uji Alias Analyze');
  fd.append('file', pdf, 'b.pdf');
  res = await fetch(BASE + '/api/documents/analyze', { method: 'POST', body: fd });
  console.log('POST /api/documents/analyze ->', res.status, '| id:', (await res.json()).id);

  line('9. GET /api/results/PLG-TIDAKADA (harus 404)');
  res = await fetch(BASE + '/api/results/PLG-TIDAKADA');
  console.log('HTTP', res.status, JSON.stringify(await res.json()));

  line('10. Jalur internal via HTTP statis (harus ditolak)');
  for (const p of ['/data/hasil-analisis.json', '/server.js', '/package.json', '/node_modules/express/package.json']) {
    console.log(p, '->', (await fetch(BASE + p)).status);
  }

  line('11. Penyajian frontend');
  for (const p of ['/', '/index.html', '/upload.html', '/result.html']) {
    const r = await fetch(BASE + p);
    console.log(p, '->', r.status, r.headers.get('content-type'));
  }

  line('12. DELETE /api/results/:id');
  res = await fetch(BASE + '/api/results/' + id, { method: 'DELETE' });
  console.log('HTTP', res.status, JSON.stringify(await res.json()));
  console.log('cek ulang setelah hapus ->', (await fetch(BASE + '/api/results/' + id)).status);

  line('13. Bersihkan data uji');
  const all = await (await fetch(BASE + '/api/history?limit=200')).json();
  for (const r of all.data) {
    console.log('hapus', r.id, '->', (await fetch(BASE + '/api/results/' + r.id, { method: 'DELETE' })).status);
  }
  console.log('sisa rekaman:', (await (await fetch(BASE + '/api/history')).json()).total);
}

main().catch((e) => { console.error('GAGAL:', e); process.exit(1); });
