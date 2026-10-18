'use strict';
/* ============================================================================
 *  Server LLM TIRUAN — untuk menguji integrasi REST API LLM pada server.js
 *  tanpa memakai kunci API sungguhan.
 *
 *  Skenario dipilih otomatis berdasarkan kata kunci di dalam teks dokumen:
 *    SKENARIO_PAGAR          -> balasan JSON dibungkus ```json ... ```
 *    SKENARIO_TEKS_BEBAS     -> JSON diselipkan di dalam kalimat
 *    SKENARIO_RUSAK          -> balasan bukan JSON
 *    SKENARIO_TANPA_SKOR     -> JSON tanpa overall_similarity_score
 *    SKENARIO_401            -> menolak dengan HTTP 401
 *    SKENARIO_400_JSONMODE   -> HTTP 400 bila response_format dikirim
 *    SKENARIO_LAMBAT         -> lambat 6,5 detik (uji batas waktu)
 *    (tanpa penanda)         -> hasil analisis normal
 *
 *  GET /_rekaman -> permintaan terakhir yang diterima (untuk pemeriksaan uji)
 * ========================================================================== */

const http = require('http');

const PORT = Number(process.env.MOCK_PORT) || 3600;

let jumlahPermintaan = 0;
let rekamanTerakhir  = null;

/** Hasil analisis contoh yang dikembalikan LLM tiruan. */
const HASIL_NORMAL = {
  overall_similarity_score: 73,
  classification_level: 'Tinggi',
  structure_analysis: {
    'Cover': true,
    'Bab 1 Pendahuluan': true,          // sengaja beda format (uji normalisasi)
    'Bab II Tinjauan Pustaka': true,
    'Bab III Metodologi': true,
    'Daftar Pustaka': false,
  },
  flagged_passages: [
    {
      text: 'Sistem deteksi plagiarisme dibangun menggunakan model bahasa besar untuk membandingkan dokumen akademik.',
      similarity_percentage: 91,
      source_reference: "Jurnal Ilmiah 2023 - 'Deteksi Kemiripan Dokumen Akademik'",
    },
    {
      text: 'Metodologi penelitian menggunakan pendekatan kuantitatif dengan pengujian akurasi sistem.',
      similarity_percentage: 64,
      source_reference: 'Repository TA 2022 - Universitas Contoh',
    },
  ],
};

function balas(res, status, objek) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(objek));
}

function balasSukses(res, konten, model) {
  balas(res, 200, {
    id: 'chatcmpl-uji',
    object: 'chat.completion',
    model: model || 'model-uji',
    choices: [{ index: 0, message: { role: 'assistant', content: konten }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1234, completion_tokens: 210, total_tokens: 1444 },
  });
}

const server = http.createServer((req, res) => {
  const alamat = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && alamat.pathname === '/_rekaman') {
    return balas(res, 200, { jumlahPermintaan, rekamanTerakhir });
  }
  if (req.method !== 'POST' || alamat.pathname !== '/v1/chat/completions') {
    return balas(res, 404, { error: { message: `Rute tiruan tidak ditemukan: ${req.method} ${alamat.pathname}` } });
  }

  let badan = '';
  req.on('data', (potongan) => { badan += potongan; });
  req.on('end', async () => {
    let muatan = {};
    try { muatan = JSON.parse(badan); } catch (err) { muatan = {}; }

    const pesan = muatan.messages || [];
    const isiUser = ((pesan.find((m) => m.role === 'user') || {}).content) || '';

    jumlahPermintaan += 1;
    rekamanTerakhir = {
      authorization: req.headers.authorization || null,
      model: muatan.model || null,
      temperature: muatan.temperature,
      response_format: muatan.response_format || null,
      ada_prompt_sistem: pesan.some((m) => m.role === 'system'),
      karakter_prompt_user: isiUser.length,
      waktu: new Date().toISOString(),
    };

    if (isiUser.includes('SKENARIO_401')) {
      return balas(res, 401, {
        error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' },
      });
    }
    if (isiUser.includes('SKENARIO_400_JSONMODE') && muatan.response_format) {
      return balas(res, 400, {
        error: { message: 'response_format is not supported by this model' },
      });
    }
    if (isiUser.includes('SKENARIO_LAMBAT')) {
      await new Promise((selesai) => setTimeout(selesai, 6500));
      return balasSukses(res, JSON.stringify(HASIL_NORMAL), muatan.model);
    }
    if (isiUser.includes('SKENARIO_RUSAK')) {
      return balasSukses(res, 'Maaf, dokumen ini belum dapat saya analisis saat ini.', muatan.model);
    }
    if (isiUser.includes('SKENARIO_TANPA_SKOR')) {
      return balasSukses(res, JSON.stringify({
        classification_level: 'Rendah', structure_analysis: {}, flagged_passages: [],
      }), muatan.model);
    }
    if (isiUser.includes('SKENARIO_PAGAR')) {
      return balasSukses(res, `\`\`\`json\n${JSON.stringify(HASIL_NORMAL, null, 2)}\n\`\`\``, muatan.model);
    }
    if (isiUser.includes('SKENARIO_TEKS_BEBAS')) {
      return balasSukses(res,
        `Berikut hasil analisis dokumen Anda: ${JSON.stringify(HASIL_NORMAL)} Semoga membantu.`,
        muatan.model);
    }

    return balasSukses(res, JSON.stringify(HASIL_NORMAL), muatan.model);
  });
});

server.listen(PORT, () => {
  console.log(`[mock-llm] server LLM tiruan siap di http://localhost:${PORT}/v1`);
});
