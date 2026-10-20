/* ============================================================================
 *  ippl-api.js — Jembatan bersama antara halaman frontend dan backend REST API
 *  Aplikasi Deteksi Plagiarisme Proposal & Laporan Tugas Akhir (NIM 11241002)
 *
 *  Berkas ini menyatukan hal-hal yang sebelumnya ditulis ulang di setiap
 *  halaman (alamat backend, token sesi, fetch, format tanggal/ukuran),
 *  sehingga login.html, riwayat.html, proses.html, dan seluruh halaman
 *  admin-*.html memakai satu sumber yang sama.
 *
 *  PEMAKAIAN SINGKAT
 *    IPPL.wajibMasuk({ peran: 'Administrator' });     // guard + pengalihan
 *    IPPL.minta('/api/history').then(function (hasil) { ... });
 *    IPPL.minta('/api/admin/users', { query: { q: 'adi' } });
 *    IPPL.minta('/api/admin/ai-config', { metode: 'POST', body: { ... } });
 *
 *  Semua fungsi yang berkomunikasi dengan server mengembalikan Promise dan
 *  menolak (reject) dengan objek Error yang memiliki properti:
 *    err.status  -> kode HTTP (bila server menjawab)
 *    err.detail  -> objek detail tambahan dari server (bila ada)
 *    err.network -> true bila server tidak dapat dihubungi
 *    err.timeout -> true bila permintaan melewati batas waktu
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ======================================================================
   * 1. KUNCI PENYIMPANAN & ALAMAT BACKEND
   * ==================================================================== */

  // Sesi disimpan di sessionStorage: hilang saat tab/browser ditutup.
  var KUNCI_TOKEN      = 'ipplToken';      // token Bearer dari POST /api/auth/login
  var KUNCI_SESI       = 'sesiPengguna';   // sesi Mahasiswa (dipakai halaman lama)
  var KUNCI_SESI_ADMIN = 'sesiAdmin';      // sesi Administrator (dipakai halaman admin-*)

  // Batas waktu bawaan satu permintaan API (ms). Analisis dokumen memakai
  // nilai lebih besar karena perlu menunggu ekstraksi + panggilan LLM.
  var TIMEOUT_BAWAAN  = 15000;
  var TIMEOUT_UNGGAH  = 120000;

  /* Alamat backend. Bila halaman disajikan oleh server yang sama (http/https),
     origin dipakai langsung sehingga port mengikuti server; bila halaman dibuka
     dari berkas lokal (file://), backend diakses pada http://localhost:3000. */
  var API_BASE = (function () {
    if (/^https?:$/.test(global.location.protocol) && global.location.host) {
      return global.location.protocol + '//' + global.location.host;
    }
    return 'http://localhost:3000';
  })();

  /* ======================================================================
   * 2. PENYIMPANAN SESI
   * ==================================================================== */

  function bacaJson(storage, kunci, bawaan) {
    try {
      var raw = storage.getItem(kunci);
      return raw ? JSON.parse(raw) : bawaan;
    } catch (err) {
      return bawaan;
    }
  }

  function tulisJson(storage, kunci, nilai) {
    try {
      storage.setItem(kunci, JSON.stringify(nilai));
      return true;
    } catch (err) {
      return false;
    }
  }

  function hapusKunci(kunci) {
    try { global.sessionStorage.removeItem(kunci); } catch (err) { /* diabaikan */ }
  }

  /** true bila sessionStorage dapat dipakai (mis. tidak diblokir mode privat). */
  function storageTersedia() {
    try {
      global.sessionStorage.setItem('__uji_ippl', '1');
      global.sessionStorage.removeItem('__uji_ippl');
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Token Bearer yang sedang aktif (string kosong bila belum masuk). */
  function token() {
    return String(bacaJson(global.sessionStorage, KUNCI_TOKEN, '') || '');
  }

  /** Sesi aktif dalam bentuk ringkas { nama, nim, email, peran, masuk }. */
  function sesi() {
    var admin = bacaJson(global.sessionStorage, KUNCI_SESI_ADMIN, null);
    if (admin && admin.peran === 'Administrator') return admin;
    return bacaJson(global.sessionStorage, KUNCI_SESI, null);
  }

  /** Sesi Administrator aktif, atau null bila bukan Administrator. */
  function sesiAdmin() {
    var s = sesi();
    return s && s.peran === 'Administrator' ? s : null;
  }

  /**
   * Menyimpan hasil POST /api/auth/login: token Bearer + data sesi.
   * Sesi Mahasiswa disimpan di 'sesiPengguna', Administrator di 'sesiAdmin'
   * agar halaman admin yang sudah ada tetap menemukan sesinya.
   * @returns {boolean} true bila token berhasil disimpan
   */
  function simpanLogin(balasan) {
    var data  = balasan || {};
    var user  = data.user || {};
    var ringkas = {
      nama:  user.nama  || (data.sesi && data.sesi.nama)  || 'Pengguna',
      nim:   user.nim   || (data.sesi && data.sesi.nim)   || '',
      email: user.email || (data.sesi && data.sesi.email) || '',
      peran: user.peran || (data.sesi && data.sesi.peran) || 'Mahasiswa',
      masuk: (data.sesi && data.sesi.masuk) || new Date().toISOString(),
      kedaluwarsa: data.kedaluwarsa || null,
      id: user.id || null
    };

    hapusKunci(KUNCI_TOKEN);
    hapusKunci(KUNCI_SESI);
    hapusKunci(KUNCI_SESI_ADMIN);

    var tokenTersimpan = tulisJson(global.sessionStorage, KUNCI_TOKEN, String(data.token || ''));
    if (ringkas.peran === 'Administrator') {
      tulisJson(global.sessionStorage, KUNCI_SESI_ADMIN, ringkas);
    }
    tulisJson(global.sessionStorage, KUNCI_SESI, ringkas);
    return tokenTersimpan && !!data.token;
  }

  /** Mengakhiri sesi: token & sesi dihapus, lalu diarahkan ke halaman masuk. */
  function keluar(halaman) {
    hapusKunci(KUNCI_TOKEN);
    hapusKunci(KUNCI_SESI);
    hapusKunci(KUNCI_SESI_ADMIN);
    global.location.href = halaman || 'login.html';
  }

  /* ======================================================================
   * 3. PENJAGA HALAMAN (GUARD)
   * ==================================================================== */

  /** Nama berkas halaman saat ini + query string (untuk parameter ?next=). */
  function halamanSekarang() {
    var berkas = String(global.location.pathname || '').split('/').pop() || 'index.html';
    return berkas + (global.location.search || '');
  }

  /** Mengarahkan pengguna ke halaman masuk yang sesuai dengan perannya. */
  function alihkanKeMasuk(peran) {
    var halaman = peran === 'Administrator' ? 'login-admin.html' : 'login.html';
    global.location.replace(halaman + '?next=' + encodeURIComponent(halamanSekarang()));
  }

  /**
   * Memastikan halaman hanya dapat dibuka oleh pengguna yang sudah masuk.
   * @param {{peran?:string}} [opsi] peran yang diwajibkan (mis. 'Administrator')
   * @returns {object|null} sesi aktif, atau null bila pengguna sudah dialihkan
   */
  function wajibMasuk(opsi) {
    opsi = opsi || {};
    var s = sesi();
    var perluAdmin = opsi.peran === 'Administrator';

    if (!s || !token()) {
      if (storageTersedia()) {
        alihkanKeMasuk(perluAdmin ? 'Administrator' : 'Mahasiswa');
        return null;
      }
      return null; // storage diblokir -> halaman berjalan tanpa sesi
    }

    if (perluAdmin && s.peran !== 'Administrator') {
      alihkanKeMasuk('Administrator');
      return null;
    }

    return s;
  }

  /* ======================================================================
   * 4. PEMANGGILAN API
   * ==================================================================== */

  /** Menyusun URL lengkap dari jalur API dan objek query opsional. */
  function urlApi(jalur, query) {
    var url = /^https?:\/\//i.test(jalur) ? jalur : API_BASE + jalur;
    if (!query) return url;

    var bagian = [];
    Object.keys(query).forEach(function (kunci) {
      var nilai = query[kunci];
      if (nilai === undefined || nilai === null || nilai === '') return;
      bagian.push(encodeURIComponent(kunci) + '=' + encodeURIComponent(String(nilai)));
    });
    if (!bagian.length) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + bagian.join('&');
  }

  /** Menyusun Error yang seragam dari respons gagal. */
  function buatGalat(pesan, tambahan) {
    var err = new Error(pesan);
    Object.keys(tambahan || {}).forEach(function (kunci) { err[kunci] = tambahan[kunci]; });
    return err;
  }

  /**
   * Memanggil endpoint backend dengan header Authorization otomatis.
   * @param {string} jalur mis. '/api/history'
   * @param {{metode?:string, body?:object|FormData, query?:object,
   *          timeout?:number, headers?:object, tanpaToken?:boolean}} [opsi]
   * @returns {Promise<any>} isi balasan yang sudah diurai sebagai JSON
   */
  function minta(jalur, opsi) {
    opsi = opsi || {};

    var pengendali = global.AbortController ? new global.AbortController() : null;
    var batas      = opsi.timeout || TIMEOUT_BAWAAN;
    var jamPasir   = pengendali
      ? global.setTimeout(function () { pengendali.abort(); }, batas)
      : null;

    var headers = opsi.headers || {};
    var badan   = opsi.body;

    // Objek biasa dikirim sebagai JSON; FormData dikirim apa adanya (multipart).
    var formData = global.FormData && badan instanceof global.FormData;
    if (badan !== undefined && badan !== null && !formData) {
      headers['Content-Type'] = 'application/json';
      badan = JSON.stringify(badan);
    }
    if ((badan === undefined || badan === null) && !headers['Content-Type']) {
      delete headers['Content-Type'];
    }

    headers.Accept = headers.Accept || 'application/json';
    if (!opsi.tanpaToken && !headers.Authorization) {
      var t = token();
      if (t) headers.Authorization = 'Bearer ' + t;
    }

    function selesai() { if (jamPasir) global.clearTimeout(jamPasir); }

    return fetch(urlApi(jalur, opsi.query), {
      method: opsi.metode || (badan ? 'POST' : 'GET'),
      headers: headers,
      body: badan === undefined ? null : badan,
      signal: pengendali ? pengendali.signal : undefined
    }).then(function (res) {
      return res.text().then(function (teks) {
        selesai();

        var data = null;
        try { data = teks ? JSON.parse(teks) : null; } catch (err) { data = null; }

        if (!res.ok) {
          var pesan = (data && (data.message || data.error))
            || ('Server membalas HTTP ' + res.status + ' tanpa keterangan.');

          // Token tidak sah / kedaluwarsa -> sesi lama dibersihkan.
          if (res.status === 401) {
            hapusKunci(KUNCI_TOKEN);
            hapusKunci(KUNCI_SESI);
            hapusKunci(KUNCI_SESI_ADMIN);
          }

          throw buatGalat(pesan, {
            status: res.status,
            detail: (data && data.detail) || null,
            jalur: jalur
          });
        }

        if (data === null) {
          throw buatGalat('Respons server tidak dapat dibaca sebagai JSON.', { jalur: jalur });
        }
        return data;
      });
    }, function (err) {
      selesai();
      if (err && err.name === 'AbortError') {
        throw buatGalat('Permintaan melebihi batas waktu ' + Math.round(batas / 1000) + ' detik.',
          { timeout: true, jalur: jalur });
      }
      throw buatGalat('Tidak dapat menghubungi backend ' + API_BASE
        + ' (server belum berjalan atau diblokir CORS).', { network: true, jalur: jalur });
    });
  }

  /** Pesan galat siap tampil (tanpa HTML) dari Error hasil minta(). */
  function pesanGalat(err) {
    if (!err) return 'Terjadi kesalahan tidak dikenal.';
    if (err.network) return err.message;
    if (err.status === 401) return 'Sesi kamu sudah berakhir. Silakan masuk kembali.';
    if (err.status === 403) return err.message || 'Akses ditolak.';
    return err.message || 'Permintaan gagal diproses.';
  }

  /** Login ke backend. @returns {Promise<object>} balasan /api/auth/login */
  function masuk(email, password, peran) {
    var body = { email: email, password: password };
    if (peran) body.peran = peran;
    return minta('/api/auth/login', { body: body, tanpaToken: true, timeout: 20000 })
      .then(function (data) {
        if (!simpanLogin(data)) {
          throw buatGalat('Penyimpanan browser diblokir sehingga sesi tidak dapat dibuat. '
            + 'Aktifkan cookie/site data lalu coba lagi.');
        }
        return data;
      });
  }

  /** Pendaftaran akun Mahasiswa (UC-01). */
  function daftar(nama, email, password, nim) {
    var body = { nama: nama, email: email, password: password };
    if (nim) body.nim = nim;
    return minta('/api/auth/register', { body: body, tanpaToken: true, timeout: 20000 });
  }

  /** Meringkas data pengguna untuk disimpan di navbar halaman. */
  function tampilkanNama(idElemen, s) {
    var el = global.document.getElementById(idElemen);
    if (!el) return;
    var sesiAktif = s || sesi();
    el.textContent = sesiAktif && sesiAktif.nama ? sesiAktif.nama : 'Tamu';
    if (sesiAktif && sesiAktif.email) el.title = sesiAktif.email;
  }

  /* ======================================================================
   * 5. UTILITAS TAMPILAN (dipakai bersama seluruh halaman)
   * ==================================================================== */

  /** Mengamankan teks sebelum dimasukkan ke innerHTML. */
  function esc(nilai) {
    return String(nilai === undefined || nilai === null ? '' : nilai)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 1048576 -> "1.0 MB" */
  function formatBytes(bytes) {
    var angka = Number(bytes);
    if (!angka) return '0 B';
    var satuan = ['B', 'KB', 'MB', 'GB'];
    var i = Math.min(Math.floor(Math.log(angka) / Math.log(1024)), satuan.length - 1);
    return (angka / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + satuan[i];
  }

  /** Waktu ISO -> "18 Oktober 2026, 21.05" (atau '-' bila kosong). */
  function formatWaktu(iso) {
    if (!iso) return '-';
    var t = new Date(iso);
    if (isNaN(t.getTime())) return String(iso);
    try {
      return t.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
        + ', ' + t.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      return t.toISOString();
    }
  }

  /** Waktu ISO -> "18 Okt 2026" (ringkas, untuk tabel). */
  function formatTanggal(iso) {
    if (!iso) return '-';
    var t = new Date(iso);
    if (isNaN(t.getTime())) return String(iso);
    try {
      return t.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (err) {
      return t.toISOString().slice(0, 10);
    }
  }

  /** Tingkat klasifikasi + kelas Bootstrap untuk badge/bar (ambang 50% & 20%). */
  function tingkat(skor, ambangTinggi, ambangSedang) {
    var tinggi = Number(ambangTinggi) || 50;
    var sedang = Number(ambangSedang) || 20;
    if (skor >= tinggi) {
      return { label: 'Tinggi', cls: 'bg-danger-subtle text-danger-emphasis border border-danger', bar: 'bg-danger' };
    }
    if (skor >= sedang) {
      return { label: 'Sedang', cls: 'bg-warning-subtle text-warning-emphasis border border-warning', bar: 'bg-warning' };
    }
    return { label: 'Rendah', cls: 'bg-success-subtle text-success-emphasis border border-success', bar: 'bg-success' };
  }

  function angkaAtauNol(nilai) {
    var angka = Number(nilai);
    return isNaN(angka) ? 0 : angka;
  }

  /* ======================================================================
   * 6. ANTARMUKA PUBLIK
   * ==================================================================== */

  global.IPPL = {
    // Konfigurasi & kunci penyimpanan
    API_BASE: API_BASE,
    KUNCI_TOKEN: KUNCI_TOKEN,
    KUNCI_SESI: KUNCI_SESI,
    KUNCI_SESI_ADMIN: KUNCI_SESI_ADMIN,
    TIMEOUT_BAWAAN: TIMEOUT_BAWAAN,
    TIMEOUT_UNGGAH: TIMEOUT_UNGGAH,

    // Sesi
    token: token,
    sesi: sesi,
    sesiAdmin: sesiAdmin,
    simpanLogin: simpanLogin,
    keluar: keluar,
    masuk: masuk,
    daftar: daftar,
    wajibMasuk: wajibMasuk,
    alihkanKeMasuk: alihkanKeMasuk,
    halamanSekarang: halamanSekarang,
    storageTersedia: storageTersedia,

    // Pemanggilan API
    minta: minta,
    urlApi: urlApi,
    pesanGalat: pesanGalat,

    // Utilitas tampilan
    esc: esc,
    formatBytes: formatBytes,
    formatWaktu: formatWaktu,
    formatTanggal: formatTanggal,
    tingkat: tingkat,
    angka: angkaAtauNol,
    tampilkanNama: tampilkanNama,

    // Penyimpanan umum (cadangan bila berkas lama masih memakainya)
    bacaJson: bacaJson,
    tulisJson: tulisJson
  };
})(window);
