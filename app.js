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
const CAMINHO_IMAGENS = './imagens_produtos';
const ARQUIVO_ENVIADOS = './enviados.json';
const PASTA_LOGS = './logs';
const MODO_TESTE = false;

const HORARIOS = [
  "08:00", "09:00", "10:00", "11:00", "12:00",
  "13:00", "14:00", "15:00", "16:00", "17:00",
  "18:00", "19:00", "20:00", "21:00", "22:00"
];

// === FUNÇÕES UTILITÁRIAS ===
const delay = (ms) => new Promise(res => setTimeout(res, ms));

function logToFile(msg) {
  const hoje = new Date().toISOString().split('T')[0];
  if (!fs.existsSync(PASTA_LOGS)) fs.mkdirSync(PASTA_LOGS);
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

function buscarImagem(nomeImagemBase) {
  const arquivos = glob.sync(path.join(CAMINHO_IMAGENS, `${nomeImagemBase}.*`));
  return arquivos[0] || null;
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

// === GOOGLE SHEETS ===
async function carregarProdutos() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: './credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = '19FMYhNhUOBbpccbpb-s6mNI93WM_FRfIHADTx9klOjA';
    const range = 'Produtos!A1:Z';

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.warn('⚠️ Nenhum dado encontrado na planilha');
      return [];
    }

    const headers = rows[0];
    return rows.slice(1).map(row => {
      let produto = {};
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

  // Validações de campos obrigatórios
  if (!produto['Caminho imagem'] || !produto['Título'] || !produto['Link Afiliado']) {
    const msg = `❌ Produto ${index} inválido. Campos obrigatórios ausentes.`;
    console.warn(msg);
    logToFile(msg);
    return;
  }

  let nomeImagem;
  try {
    nomeImagem = path.basename(produto['Caminho imagem'], path.extname(produto['Caminho imagem']));
  } catch (err) {
    const msg = `❌ Erro ao processar nome da imagem do produto ${produto['Título']}: ${err.message}`;
    console.warn(msg);
    logToFile(msg);
    return;
  }

  const caminhoImagem = buscarImagem(nomeImagem);
  if (!caminhoImagem) {
    const msg = `❌ Imagem não encontrada (${nomeImagem}) para produto "${produto['Título']}"`;
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
        const msg = `[SIMULAÇÃO] Envio para ${grupo} - Produto ${index} (${produto['Título']})`;
        console.log(msg);
        logToFile(msg);
      } else {
        await client.sendImage(grupo, caminhoImagem, path.basename(caminhoImagem), mensagem);
        const msg = `✅ Produto ${index} (${produto['Título']}) enviado para ${grupo} às ${horaAgendada}`;
        console.log(msg);
        logToFile(msg);
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
