'use strict';

/* =======================
 *  DEPENDÊNCIAS
 * ======================= */
const wppconnect = require('@wppconnect-team/wppconnect');
const puppeteer = require('puppeteer'); // para usar o Chromium compatível
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const glob = require('glob');

/* =======================
 *  CONFIGURAÇÕES
 * ======================= */

// Use 'bundled' para Chromium do puppeteer (recomendado após updates do Chrome)
// ou 'system' para apontar para o Chrome instalado.
const CHROME_MODE = 'bundled'; // 'bundled' | 'system'
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'; // se usar 'system', ajuste aqui

const LISTAR_GRUPOS = false;
const GRUPOS = [
  '120363421554028346@g.us', // Meus Arquivos
  '120363402322780461@g.us', // Promos & Cupons VIP #01 - Teste
  '120363418219347721@g.us'  // Imperador da Promo #01
];

// Pasta LOCAL (fallback opcional)
const CAMINHO_IMAGENS = './imagens_produtos';

const ARQUIVO_ENVIADOS = './enviados.json';
const PASTA_LOGS = './logs';
const MODO_TESTE = false;

// Horários (HH:mm)
const HORARIOS = [
  '08:00','09:00','10:00','11:00','12:00',
  '13:00','14:00','15:00','16:00','17:00',
  '18:00','19:00','20:00','21:00','22:00'
];

/* =======================
 *  GOOGLE: IDs E ALCANCES
 * ======================= */
const SPREADSHEET_ID = '19FMYhNhUOBbpccbpb-s6mNI93WM_FRfIHADTx9klOjA';
const SHEET_RANGE = 'Produtos!A1:Z';

// Pasta do Drive que contém as imagens
const DRIVE_FOLDER_ID = '1dz_L-DP3BV35edqJx6ZfMayD_aaM6E7U';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive'
];

let gAuth = null;

/* =======================
 *  UTILS
 * ======================= */
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const hojeISO = () => new Date().toISOString().split('T')[0];

function ensureDirs() {
  if (!fs.existsSync(PASTA_LOGS)) fs.mkdirSync(PASTA_LOGS, { recursive: true });
  if (!fs.existsSync(ARQUIVO_ENVIADOS)) fs.writeFileSync(ARQUIVO_ENVIADOS, JSON.stringify([]));
}
ensureDirs();

function logToFile(msg) {
  const file = `${PASTA_LOGS}/log-${hojeISO()}.txt`;
  fs.appendFileSync(file, `[${new Date().toLocaleTimeString()}] ${msg}\n`);
}

function carregarEnviados() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_ENVIADOS, 'utf8'));
  } catch {
    return [];
  }
}

function salvarEnviado(produto, hora) {
  const enviados = carregarEnviados();
  enviados.push({
    id: `${produto['Título']} | ${hora} | ${hojeISO()}`
  });
  fs.writeFileSync(ARQUIVO_ENVIADOS, JSON.stringify(enviados, null, 2));
}

// Converte "R$ 3.899,00" -> 3899.00
function parseBRL(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatBRL(n) {
  return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function montarMensagem(produto) {
  const precoDe = parseBRL(produto['De']);
  const precoPor = parseBRL(produto['Por']);

  const cupom = (produto['Cupom'] || '').toString().trim();
  const temCupom = cupom && !['N/A', 'NA', '-', '0', 'NULL', 'NONE'].includes(cupom.toUpperCase());

  const linhas = [
    `🛍️ *${produto['Título']}*`,
    produto['Descrição'] ? `📄 _${produto['Descrição']}_` : null,
    precoDe ? `\n💸 *DE:* ~${formatBRL(precoDe)}~` : null,
    `🔥 *POR:* ${formatBRL(precoPor)}`,
    temCupom ? `\n🎟️ *Cupom:* ${cupom}` : null,
    `🔗 *Compre aqui:* ${produto['Link Afiliado']}`
  ].filter(Boolean);

  return linhas.join('\n').trim();
}

/* =======================
 *  GOOGLE AUTH
 * ======================= */
async function getGoogleAuth() {
  if (gAuth) return gAuth;
  gAuth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: GOOGLE_SCOPES
  });
  return gAuth;
}

/* =======================
 *  GOOGLE SHEETS
 * ======================= */
async function carregarProdutos() {
  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_RANGE
    });
    const rows = data.values || [];
    if (!rows.length) {
      console.warn('⚠️ Nenhum dado encontrado na planilha');
      return [];
    }
    const headers = rows[0];
    return rows.slice(1).map((row) => {
      const p = {};
      headers.forEach((col, i) => (p[col] = row[i] || ''));
      return p;
    });
  } catch (err) {
    console.error('❌ Erro ao ler Google Sheets:', err.message);
    logToFile(`❌ Erro ao ler Google Sheets: ${err.message}`);
    return [];
  }
}

/* =======================
 *  GOOGLE DRIVE (imagens)
 * ======================= */
function nomeBaseDaPlanilha(valor) {
  if (!valor) return '';
  const soNome = path.basename(valor);
  return path.basename(soNome, path.extname(soNome));
}

async function ensureFileIsPublic(drive, fileId) {
  try {
    const perms = await drive.permissions.list({ fileId });
    const hasAnyone = (perms.data.permissions || []).some(
      (p) => p.type === 'anyone' && ['reader', 'commenter', 'writer'].includes(p.role)
    );
    if (!hasAnyone) {
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' }
      });
    }
  } catch (e) {
    logToFile(`⚠️ Falha ao garantir permissão pública: ${e.message}`);
  }
}

async function buscarImagemNoDrivePorNome(nomeBase) {
  if (!nomeBase) return null;
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });

  const query = `'${DRIVE_FOLDER_ID}' in parents and trashed=false and mimeType contains 'image/' and name contains '${nomeBase.replace(/'/g, "\\'")}'`;

  const res = await drive.files.list({
    q: query,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType)',
    pageSize: 10
  });

  const files = res.data.files || [];
  if (!files.length) return null;

  const file =
    files.find((f) => f.name.toLowerCase().startsWith(nomeBase.toLowerCase())) || files[0];

  await ensureFileIsPublic(drive, file.id);
  const directUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
  return { url: directUrl, fileName: file.name };
}

/* =======================
 *  FALLBACK LOCAL (imagens)
 * ======================= */
function buscarImagemLocal(nomeBase) {
  if (!nomeBase) return null;
  const arquivos = glob.sync(path.join(CAMINHO_IMAGENS, `${nomeBase}.*`));
  if (arquivos[0]) {
    return { path: arquivos[0], fileName: path.basename(arquivos[0]) };
  }
  return null;
}

/* =======================
 *  RESOLVER FONTE DA IMAGEM
 * ======================= */
async function resolverImagem(produto) {
  const valorPlanilha = produto['Caminho imagem'] || produto['Imagem'] || produto['Foto'] || '';
  const base = nomeBaseDaPlanilha(valorPlanilha);

  const driveHit = await buscarImagemNoDrivePorNome(base);
  if (driveHit) return { tipo: 'url', caminho: driveHit.url, nome: driveHit.fileName };

  const localHit = buscarImagemLocal(base);
  if (localHit) return { tipo: 'file', caminho: localHit.path, nome: localHit.fileName };

  return null;
}

/* =======================
 *  ENVIO DE PRODUTO
 * ======================= */
async function enviarProduto(produto, index, client, horaAgendada) {
  const enviados = carregarEnviados();
  const idProdutoHoje = `${produto['Título']} | ${horaAgendada} | ${hojeISO()}`;

  if (enviados.some((e) => e.id === idProdutoHoje)) {
    const msg = `⚠️ Produto ${index} (${produto['Título']}) já foi enviado às ${horaAgendada} hoje.`;
    console.log(msg);
    logToFile(msg);
    return;
  }

  if (!produto['Título'] || !produto['Link Afiliado']) {
    const msg = `❌ Produto ${index} inválido. Campos obrigatórios ausentes (Título/Link Afiliado).`;
    console.warn(msg);
    logToFile(msg);
    return;
  }

  const img = await resolverImagem(produto);
  if (!img) {
    const msg = `❌ Imagem não encontrada para "${produto['Título']}" (verifique no Drive/pasta local).`;
    console.warn(msg);
    logToFile(msg);
    return;
  }

  const mensagem = montarMensagem(produto);

  for (const grupo of GRUPOS) {
    try {
      const isConnected = await client.isConnected();
      if (!isConnected) {
        const m = `❌ Cliente desconectado antes do envio para ${grupo}`;
        console.warn(m);
        logToFile(m);
        continue;
      }

      if (MODO_TESTE) {
        const sim = `[SIMULAÇÃO] Envio para ${grupo} - Produto ${index} (${produto['Título']}) - IMG: ${img.caminho}`;
        console.log(sim);
        logToFile(sim);
      } else {
        await client.sendImage(grupo, img.caminho, img.nome, mensagem);
        const ok = `✅ Produto ${index} (${produto['Título']}) enviado para ${grupo} às ${horaAgendada}`;
        console.log(ok);
        logToFile(`${ok} [IMG:${img.tipo === 'url' ? 'Drive' : 'Local'} -> ${img.caminho}]`);
      }

      await delay(1000);
    } catch (err) {
      const msg = `❌ Erro ao enviar para ${grupo} (Produto: ${produto['Título']}): ${err.message}\n${err.stack}`;
      console.error(msg);
      logToFile(msg);
    }
  }

  if (!MODO_TESTE) salvarEnviado(produto, horaAgendada);
}

/* =======================
 *  INICIALIZAÇÃO WPP CONNECT
 * ======================= */
(async () => {
  try {
    // Opções de browser/puppeteer robustas
    const puppeteerOptions = {
      executablePath:
        CHROME_MODE === 'system' ? CHROME_PATH : puppeteer.executablePath(),
      headless: 'new'
    };

    const client = await wppconnect.create({
      session: 'browser',
      debug: false,
      headless: true, // coloque false para ver a janela
      useChrome: true,
      browserArgs: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox'
      ],
      puppeteerOptions,
      tokenStore: 'file',
      folderNameToken: 'tokens',
      folderNameBrowser: 'tokens'
    });

    if (LISTAR_GRUPOS) {
      console.log('\n📢 LISTANDO GRUPOS DISPONÍVEIS:\n');
      await client.waitForLogin();
      await delay(3000);
      const chats = await client.listChats();
      const grupos = chats.filter((c) => c.isGroup);
      grupos.forEach((g) => {
        console.log(`📛 Nome: ${g.name}`);
        console.log(`🆔 ID: ${g.id._serialized}`);
        console.log('------------------------------');
      });
      return;
    }

    client.onStateChange((state) => {
      console.log('📶 Estado da sessão:', state);
      if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(state)) {
        client.useHere();
      }
    });

    await getGoogleAuth();
    const produtos = await carregarProdutos();

    if (produtos.length < HORARIOS.length) {
      const msg = `⚠️ Menos produtos (${produtos.length}) do que horários (${HORARIOS.length})`;
      console.warn(msg);
      logToFile(msg);
    }

    HORARIOS.forEach((horaAgendada, i) => {
      const [hora, minuto] = horaAgendada.split(':');

      cron.schedule(`${minuto} ${hora} * * *`, async () => {
        const produto = produtos[i];
        if (produto) {
          await enviarProduto(produto, i, client, horaAgendada);
        } else {
          const msg = `⚠️ Nenhum produto definido para o horário ${horaAgendada}`;
          console.log(msg);
          logToFile(msg);
        }
      });

      const msg = `⏰ Produto ${i} agendado para ${horaAgendada}`;
      console.log(msg);
      logToFile(msg);
    });

    // Tratativas globais
    process.on('unhandledRejection', (reason) => {
      const msg = `❌ Rejeição não tratada: ${reason}`;
      console.error(msg);
      logToFile(msg);
    });
  } catch (error) {
    const msg = `❌ Erro ao iniciar WppConnect: ${error && error.message ? error.message : error}`;
    console.error(msg);
    logToFile(`${msg}\n${error && error.stack ? error.stack : ''}`);
  }
})();
