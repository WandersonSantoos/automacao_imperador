const { google } = require('googleapis');
(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });
  const folder = '1dz_L-DP3BV35edqJx6ZfMayD_aaM6E7U';
  const q = `'${folder}' in parents and trashed=false`;
  const r = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 5 });
  console.log('Arquivos na pasta:', r.data.files);
})().catch(e => console.error(e.response?.data || e));