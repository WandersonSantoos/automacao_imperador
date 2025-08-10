// === DEPENDÊNCIAS ===
const wppconnect = require('@wppconnect-team/wppconnect');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const glob = require('glob');

// === CONFIGURAÇÕES ===
const LISTAR_GRUPOS = false;
const GRUPOS = [
  '120363421554028346@g.us',
  '120363402322780461@g.us'
];

// Pasta LOCAL (fallback opcional)
const CAMINHO_IMAGENS = './imagens_produtos';

const ARQUIVO_ENVIADOS = './enviados.json';
const PASTA_LOGS = './logs';
const MODO_TESTE = false;

// Horários (HH:mm)
const HORARIOS = [
  "08:00", "09:00", "10:00", "11:00", "12:00",
  "13:00", "14:00", "15:00", "16:00", "17:00",
  "18:00", "19:00", "20:00", "21:00", "22:00"
];

// === GOOGLE: IDs E ALCANCES ===
const SPREADSHEET_ID = '19FMYhNhUOBbpccbpb-s6mNI93WM_FRfIHADTx9klOjA';
const SHEET_RANGE = 'Produtos!A1:Z';

// 👉 Insira aqui o ID da pasta do Drive onde estão as imagens
const DRIVE_FOLDER_ID = '1dz_L-DP3BV35edqJx6ZfMayD_aaM6E7U';

// Escopos: Sheets readonly + Drive com permissão de leitura/escrita (para tornar arquivos públicos)
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive'
];

// Auth global para reutilizar
let gAuth = null;

// === FUNÇÕES UTILITÁRIAS ===
const delay = (ms) => new Promise(res => setTimeout(res, ms));

function logToFile(msg) {
  const hoje = new Date().toISOString().split('T')[0];
  if (!fs.existsSync(PASTA_LOGS)) fs.mkdirSync(PASTA_LOGS, { recursive: true });
  fs.appendFileSync(`${PASTA_LOGS}/log-${hoje}.txt`, `[${new Date().toLocaleTimeString()}] ${msg}\n`);
}

function carregarEnviados() {
  if (!fs.existsSync(ARQUIVO_ENVIADOS)) fs.writeFileSync(ARQUIVO_ENVIADOS, JSON.stringify([]));
  return JSON.parse(fs.readFileSync(ARQUIVO_ENVIADOS));
}

function salvarEnviado(produto, hora) {
  const enviados = carregarEnviados();
  enviados.push({
    id: `${produto['Título']} | ${hora} | ${new Date().toISOString().split('T')[0]}`
  });
  fs.writeFileSync(ARQUIVO_ENVIADOS, JSON.stringify(enviados, null, 2));
}

function montarMensagem(produto) {
  const precoDe = parseFloat(produto['De']) || 0;
  const precoPor = parseFloat(produto['Por']) || 0;

  const formatarReal = (valor) => valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });

  return `🛍️ *${produto['Título']}*
📄 _${produto['Descrição']}_

💸 *DE:* ~${formatarReal(precoDe)}~
🔥 *POR:* ${formatarReal(precoPor)}

🎟️ *Cupom:* ${produto['Cupom'] || 'N/A'}
🔗 *Compre aqui:* ${produto['Link Afiliado']}`.trim();
}

// === GOOGLE AUTH ===
async function getGoogleAuth() {
  if (gAuth) return gAuth;
  gAuth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: GOOGLE_SCOPES
  });
  return gAuth;
}

// === GOOGLE SHEETS ===
async function carregarProdutos() {
  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_RANGE
    });
    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.warn('⚠️ Nenhum dado encontrado na planilha');
      return [];
    }

    const headers = rows[0];
    return rows.slice(1).map(row => {
      const produto = {};
      headers.forEach((coluna, i) => {
        produto[coluna] = row[i] || '';
      });
      return produto;
    });

  } catch (err) {
    console.error('❌ Erro ao ler dados do Google Sheets:', err.message);
    logToFile(`❌ Erro ao ler Google Sheets: ${err.message}`);
    return [];
  }
}

// === GOOGLE DRIVE (busca por nome + garantir link público) ===
function nomeBaseDaPlanilha(valor) {
  // Aceita nome com extensão, caminho, ou apenas nome base
  if (!valor) return '';
  const soNome = path.basename(valor); // remove diretórios se houver
  return path.basename(soNome, path.extname(soNome)); // remove extensão
}

async function ensureFileIsPublic(drive, fileId) {
  // Verifica permissões atuais
  const perms = await drive.permissions.list({ fileId });
  const hasAnyone = (perms.data.permissions || []).some(
    p => p.type === 'anyone' && (p.role === 'reader' || p.role === 'commenter' || p.role === 'writer')
  );
  if (!hasAnyone) {
    // Torna público como leitor
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });
  }
}

async function buscarImagemNoDrivePorNome(nomeBase) {
  if (!nomeBase) return null;
  const auth = await getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });

  // 1) Tenta correspondência mais “estrita” pelo início do nome (sem extensão)
  let query =
    `'${DRIVE_FOLDER_ID}' in parents and trashed=false and mimeType contains 'image/' and name contains '${nomeBase.replace(/'/g, "\\'")}'`;

  // Busca, priorizando os mais recentes
  let res = await drive.files.list({
    q: query,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType)',
    pageSize: 10
  });

  // Se nada achou, retorna null
  const files = res.data.files || [];
  if (files.length === 0) return null;

  // Escolha do arquivo:
  // - Preferir nome que comece exatamente pelo nomeBase
  let file = files.find(f => f.name.toLowerCase().startsWith(nomeBase.toLowerCase())) || files[0];

  // Garantir que está público
  await ensureFileIsPublic(drive, file.id);

  // Monta link direto
  const directUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
  return { url: directUrl, fileName: file.name };
}

// === FALLBACK LOCAL (opcional) ===
function buscarImagemLocal(nomeBase) {
  if (!nomeBase) return null;
  const arquivos = glob.sync(path.join(CAMINHO_IMAGENS, `${nomeBase}.*`));
  if (arquivos[0]) {
    return { path: arquivos[0], fileName: path.basename(arquivos[0]) };
  }
  return null;
}

// === RESOLVER FONTE DA IMAGEM (Drive primeiro, depois local) ===
async function resolverImagem(produto) {
  // A planilha deve ter um campo com o "nome" da imagem (ex.: "tenis_nike" ou "tenis_nike.jpg").
  // Ajuste aqui o nome da coluna conforme sua planilha.
  const valorPlanilha = produto['Caminho imagem'] || produto['Imagem'] || produto['Foto'] || '';
  const base = nomeBaseDaPlanilha(valorPlanilha);

  // 1) Tenta no Drive
  const driveHit = await buscarImagemNoDrivePorNome(base);
  if (driveHit) return { tipo: 'url', caminho: driveHit.url, nome: driveHit.fileName };

  // 2) Fallback: tenta local
  const localHit = buscarImagemLocal(base);
  if (localHit) return { tipo: 'file', caminho: localHit.path, nome: localHit.fileName };

  return null;
}

// === ENVIO DE PRODUTO ===
async function enviarProduto(produto, index, client, horaAgendada) {
  const enviados = carregarEnviados();
  const idProdutoHoje = `${produto['Título']} | ${horaAgendada} | ${new Date().toISOString().split('T')[0]}`;

  if (enviados.some(e => e.id === idProdutoHoje)) {
    const msg = `⚠️ Produto ${index} (${produto['Título']}) já foi enviado às ${horaAgendada} hoje.`;
    console.log(msg);
    logToFile(msg);
    return;
  }

  // Validações mínimas
  if (!produto['Título'] || !produto['Link Afiliado']) {
    const msg = `❌ Produto ${index} inválido. Campos obrigatórios ausentes (Título/Link Afiliado).`;
    console.warn(msg);
    logToFile(msg);
    return;
  }

  // Resolve imagem (Drive -> Local)
  const img = await resolverImagem(produto);
  if (!img) {
    const msg = `❌ Imagem não encontrada para "${produto['Título']}" (verifique nome/arquivo na pasta do Drive).`;
    console.warn(msg);
    logToFile(msg);
    return;
  }

  const mensagem = montarMensagem(produto);

  for (const grupo of GRUPOS) {
    try {
      const isConnected = await client.isConnected();
      if (!isConnected) {
        const msg = `❌ Cliente desconectado antes do envio para ${grupo}`;
        console.warn(msg);
        logToFile(msg);
        continue;
      }

      if (MODO_TESTE) {
        const msg = `[SIMULAÇÃO] Envio para ${grupo} - Produto ${index} (${produto['Título']}) - IMG: ${img.caminho}`;
        console.log(msg);
        logToFile(msg);
      } else {
        if (img.tipo === 'url') {
          await client.sendImage(grupo, img.caminho, img.nome, mensagem);
        } else {
          await client.sendImage(grupo, img.caminho, img.nome, mensagem);
        }
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

// === INICIALIZAÇÃO PRINCIPAL ===
wppconnect.create({
  headless: true,
  puppeteerOptions: {
    args: ['--no-sandbox']
  }
}).then(async (client) => {

  if (LISTAR_GRUPOS) {
    console.log('\n📢 LISTANDO GRUPOS DISPONÍVEIS:\n');
    await client.waitForLogin();
    await new Promise(res => setTimeout(res, 5000));
    const chats = await client.listChats();
    const grupos = chats.filter(c => c.isGroup);
    grupos.forEach(g => {
      console.log(`📛 Nome: ${g.name}`);
      console.log(`🆔 ID: ${g.id._serialized}`);
      console.log('------------------------------');
    });
    return;
  }

  // Estado da sessão
  client.onStateChange((state) => {
    console.log('📶 Estado da sessão:', state);
    if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(state)) {
      client.useHere();
    }
  });

  // Garante auth carregado
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

}).catch((error) => {
  const msg = `❌ Erro ao iniciar WppConnect: ${error.message}`;
  console.error(msg);
  logToFile(`${msg}\n${error.stack}`);
});

// === ERROS GLOBAIS ===
process.on('unhandledRejection', (reason, promise) => {
  const msg = `❌ Rejeição não tratada: ${reason}`;
  console.error(msg);
  logToFile(msg);
});
