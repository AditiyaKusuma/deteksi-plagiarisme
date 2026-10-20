const selfsigned = require('selfsigned');
const fs = require('fs');
const path = require('path');

async function buatSertifikat() {
  try {
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    const pkey = await selfsigned.generate(attrs, { days: 365 });

    fs.writeFileSync(path.join(__dirname, 'localhost.pem'), pkey.cert);
    fs.writeFileSync(path.join(__dirname, 'localhost-key.pem'), pkey.private);

    console.log('Sertifikat SSL berhasil dibuat: localhost.pem & localhost-key.pem');
  } catch (err) {
    console.error('Gagal membuat sertifikat:', err);
  }
}

buatSertifikat();