# Aplikasi Deteksi Plagiarisme Proposal & Laporan Tugas Akhir

Backend REST API + frontend untuk memeriksa indikasi plagiarisme pada dokumen
proposal/laporan tugas akhir. Teks diekstraksi nyata dari berkas PDF/DOCX,
lalu dianalisis oleh LLM (OpenAI / Gemini / penyedia kompatibel) melalui REST
API dengan **JSON mode / structured output**.

> Basis: SRS/SDD Aplikasi Deteksi Plagiarisme (NIM 11241002).

---

## Fitur Utama

- **Ekstraksi teks nyata** — PDF via `pdf-parse`, DOCX via `mammoth`.
- **Analisis LLM** — kirim teks dokumen ke LLM, balas JSON terstruktur
  (skor kemiripan, klasifikasi, bagian bermasalah, saran).
- **Autentikasi** — daftar/masuk akun mahasiswa & Administrator, token sesi
  HMAC-SHA256; kata sandi disimpan sebagai hash `scrypt` (bukan teks biasa).
- **Riwayat pemeriksaan** — daftar/detail/hapus hasil, filter NIM, klasifikasi,
  dan paging.
- **Panel Admin** — kelola pengguna, dokumen, riwayat, serta konfigurasi
  penyedia AI (penyedia, model, ambang klasifikasi, batas ukuran berkas).
- **Fallback simulasi** — mode demo tanpa kunci API (`LLM_FALLBACK_SIMULASI=true`).
- **Penanganan error rapi** — kegagalan/timeout LLM atau JSON tidak sah dibalas
  HTTP 500 tanpa mematikan proses Node.js.

## Teknologi

- Node.js (v20.16+ atau v22.3+), Express 4
- `multer` (unggah), `cors`, `dotenv`
- `pdf-parse`, `mammoth`
- `selfsigned` (opsi pembuatan sertifikat HTTPS lokal)
- Frontend HTML statis (Bootstrap Icons), client API di `public/js/ippl-api.js`

---

## Struktur Proyek

```
.
├─ server.js              # Backend REST API (Express)
├─ generate-cert.js       # Pembuat sertifikat HTTPS lokal (localhost.pem)
├─ package.json
├─ .env.example           # Templat konfigurasi (salin ke .env)
├─ public/                # Frontend (HTML)
│  ├─ index.html          # Beranda
│  ├─ upload.html         # Unggah & mulai analisis
│  ├─ result.html         # Hasil analisis
│  ├─ riwayat.html        # Riwayat (mahasiswa)
│  ├─ login.html          # Masuk/daftar mahasiswa
│  ├─ login-admin.html    # Masuk admin
│  ├─ admin-pengguna.html # UC-09
│  ├─ admin-dokumen.html  # UC-10
│  ├─ admin-riwayat.html  # UC-11
│  ├─ admin-ai.html       # UC-12 / UC-13 (konfigurasi AI)
│  └─ js/ippl-api.js      # Client API
├─ data/                  # Runtime: users.json, ai-config.json, uploads/, hasil-analisis.json
├─ docs/                  # SRS/SDD proyek
├─ tests/                 # Skrip uji manual
└─ logs/                  # Log pengujian
```

> `data/users.json`, `data/ai-config.json`, `data/uploads/`, dan `.env` tidak
> pernah disajikan lewat HTTP (diblokir di `server.js`) dan tidak di-commit.

---

## Prasyarat

- Node.js `>=20.16.0 <21` atau `>=22.3.0`
- npm

## Instalasi

```powershell
npm install
```

## Konfigurasi

Salin templat lalu isi nilainya:

```powershell
Copy-Item .env.example .env
```

Variabel penting:

| Variabel | Keterangan |
| --- | --- |
| `LLM_API_KEY` | Kunci API penyedia LLM (hanya dibaca backend, tidak pernah dikirim ke frontend). |
| `LLM_PROVIDER` | `auto` \| `openai` \| `gemini`. |
| `LLM_MODEL_NAME` | Mis. `gemini-2.0-flash`, `gpt-4o-mini`, `deepseek-chat`. |
| `LLM_BASE_URL` | Alamat REST API penyedia (tanpa garis miring di akhir). |
| `LLM_TIMEOUT_MS` | Batas waktu 1 panggilan (1000–30000 ms). |
| `LLM_MAX_KATA` | Jumlah kata yang dikirim ke LLM (200–8000, ambil awal). |
| `LLM_TEMPERATURE` | Kreativitas keluaran (0 = paling konsisten). |
| `LLM_JSON_MODE` | `auto` \| `on` \| `off`. |
| `LLM_FALLBACK_SIMULASI` | `true` = pakai data mock saat LLM gagal (demo tanpa kunci). |
| `AUTH_SECRET` | Kunci penandatangan token sesi. Kosong = acak per proses (sesi hangus saat restart). |
| `AUTH_TTL_JAM` | Masa berlaku token (1–168, bawaan 12). |
| `PORT` / `HOST` | Bawaan `3000` / `0.0.0.0`. |
| `CORS_ORIGIN` | Origin frontend diizinkan, `*` untuk semua. |
| `DATA_DIR` | Lokasi penyimpanan data; kosong = folder `data` di proyek. |

Contoh base URL penyedia:

```
OpenAI       : https://api.openai.com/v1
Gemini       : https://generativelanguage.googleapis.com/v1beta
DeepSeek     : https://api.deepseek.com/v1
Groq         : https://api.groq.com/openai/v1
OpenRouter   : https://openrouter.ai/api/v1
Ollama lokal : http://localhost:11434/v1   (LLM_API_KEY boleh diisi "ollama")
```

## Menjalankan

```powershell
npm start        # produksi
npm run dev      # mode watch (auto-restart)
```

Alamat setelah server jalan:

- Beranda: `http://localhost:3000/index.html`
- Unggah: `http://localhost:3000/upload.html`
- Hasil: `http://localhost:3000/result.html`
- Health: `http://localhost:3000/api/health`

---

## Endpoint API

| Method | Rute | Keterangan |
| --- | --- | --- |
| GET | `/api/health` | Status layanan. |
| POST | `/api/upload` | Unggah berkas (FormData: `judul`, `nim`, `jenis`, `file`), ekstraksi, analisis LLM. |
| POST | `/api/documents` | Alias `/api/upload`. |
| POST | `/api/documents/analyze` | Alias `/api/upload`. |
| GET | `/api/results` | Daftar hasil analisis. |
| GET | `/api/results/:id` | Detail satu hasil. |
| DELETE | `/api/results/:id` | Hapus satu hasil. |
| GET | `/api/history` | Riwayat (filter `nim`, `klasifikasi`, paging; perlu login). |
| POST | `/api/auth/register` | Daftar akun mahasiswa (UC-01). |
| POST | `/api/auth/login` | Masuk mahasiswa & admin (UC-02) → token sesi. |
| GET | `/api/admin/users` | Daftar pengguna (UC-09) [admin]. |
| GET | `/api/admin/documents` | Seluruh dokumen diunggah (UC-10) [admin]. |
| GET | `/api/admin/histories` | Seluruh riwayat (UC-11) [admin]. |
| GET | `/api/admin/ai-config` | Baca konfigurasi AI (UC-12) [admin]. |
| POST | `/api/admin/ai-config` | Simpan konfigurasi AI (UC-13) [admin]. |
| POST | `/api/admin/ai-config/test` | Uji koneksi penyedia AI [admin]. |

Rute bertanda **[admin]** butuh header `Authorization: Bearer <token>` dari akun
berperan Administrator.

### Format unggah

- Format diterima: `.pdf`, `.doc`, `.docx` (`.doc` Word 97-2003 ditolak saat
  ekstraksi — konversi ke PDF/DOCX).
- Minimal 10 kata berhasil diekstraksi (berkas hasil pemindaian/gambar ditolak).
- Batas ukuran berkas sesuai konfigurasi (bawaan 10 MB, maksimum panel 50 MB).

### Klasifikasi

Ambang batas tingkat indikasi (skor kemiripan) dapat diatur Admin pada panel
Pengaturan AI (`ambangSedang` / `ambangTinggi`).

---

## HTTPS Lokal (opsional)

Buat sertifikat self-signed untuk `localhost`:

```powershell
node generate-cert.js
```

Menghasilkan `localhost.pem` dan `localhost-key.pem` (berlaku 365 hari).

---

## Lisensi

MIT.
