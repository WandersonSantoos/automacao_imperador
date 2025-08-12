# 📢 Automação de Envio de Produtos no WhatsApp

Este projeto automatiza o envio de mensagens de promoções e produtos para grupos do WhatsApp em horários pré-definidos utilizando **WPP Connect** e dados carregados diretamente de uma planilha no **Google Sheets**.

---

## 🚀 Funcionalidades
- Envio automático de mensagens com:
  - Nome do produto
  - Descrição
  - Preço original e promocional
  - Cupom (apenas quando disponível)
  - Link de compra
  - Imagem do produto (Google Drive ou local)
- Agendamento de envios a cada hora, com base em horários configurados.
- Registro de envios para evitar duplicidade no mesmo dia.
- Log automático dos envios e erros.
- Fallback para buscar imagens localmente caso não encontre no Google Drive.

---

## 📦 Tecnologias Utilizadas
- [Node.js](https://nodejs.org/)
- [WPP Connect](https://wppconnect.io/)
- [Google APIs](https://developers.google.com/apis-explorer) (Sheets e Drive)
- [node-cron](https://www.npmjs.com/package/node-cron) para agendamentos
- [glob](https://www.npmjs.com/package/glob) para busca de arquivos locais

---

## ⚙️ Configuração

### 1️⃣ Clonar o repositório
```bash
git clone https://github.com/WandersonSantoos/automacao_imperador.git
cd automacao_imperador
