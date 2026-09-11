require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const DB_PATH = path.join(__dirname, 'presentes.json'); // usado só como "semente" inicial
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CHAVE_PRESENTES = 'presentes';

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const paymentClient = new Payment(client);
const preferenceClient = new Preference(client);

// Detecta se estamos usando token de TESTE (começa com "TEST-") ou de
// PRODUÇÃO (começa com "APP_USR-"). Usado para só ativar o truque de
// aprovação automática quando estivermos testando.
const MODO_TESTE = (process.env.MP_ACCESS_TOKEN || '').startsWith('TEST-');

// ---------- "Banco de dados" no Upstash Redis (permanente, não some quando o servidor reinicia) ----------

async function upstashGet(chave) {
  const res = await fetch(`${UPSTASH_URL}/get/${chave}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const dados = await res.json();
  return dados.result;
}

async function upstashSet(chave, valorTexto) {
  await fetch(`${UPSTASH_URL}/set/${chave}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: valorTexto,
  });
}

async function lerPresentes() {
  const valor = await upstashGet(CHAVE_PRESENTES);
  if (valor) return JSON.parse(valor);

  // Primeira vez rodando (Upstash ainda vazio): semeia com a lista inicial
  // do arquivo presentes.json que veio no projeto.
  const inicial = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  await upstashSet(CHAVE_PRESENTES, JSON.stringify(inicial));
  return inicial;
}

async function salvarPresentes(presentes) {
  await upstashSet(CHAVE_PRESENTES, JSON.stringify(presentes));
}

// ---------- Confirmações de presença (RSVP), guardadas do mesmo jeito ----------

const CHAVE_CONFIRMACOES = 'confirmacoes';

async function lerConfirmacoes() {
  const valor = await upstashGet(CHAVE_CONFIRMACOES);
  return valor ? JSON.parse(valor) : [];
}

async function salvarConfirmacao(confirmacao) {
  const confirmacoes = await lerConfirmacoes();
  confirmacoes.push({ ...confirmacao, data: new Date().toISOString() });
  await upstashSet(CHAVE_CONFIRMACOES, JSON.stringify(confirmacoes));
}

async function buscarPresente(id) {
  const presentes = await lerPresentes();
  return presentes.find((p) => p.id === String(id));
}

async function atualizarPresente(id, dadosNovos) {
  const presentes = await lerPresentes();
  const index = presentes.findIndex((p) => p.id === String(id));
  if (index === -1) return null;
  presentes[index] = { ...presentes[index], ...dadosNovos };
  await salvarPresentes(presentes);
  return presentes[index];
}

// Libera presentes reservados há mais de 30 minutos que não foram pagos
async function liberarReservasExpiradas() {
  const presentes = await lerPresentes();
  const agora = Date.now();
  let mudou = false;

  presentes.forEach((p) => {
    if (p.status === 'reservado' && p.reservadoEm && agora - p.reservadoEm > 30 * 60 * 1000) {
      p.status = 'disponivel';
      delete p.reservadoEm;
      delete p.payment_id;
      mudou = true;
    }
  });

  if (mudou) await salvarPresentes(presentes);
}
setInterval(() => {
  liberarReservasExpiradas().catch((erro) => console.error('Erro ao liberar reservas expiradas:', erro));
}, 5 * 60 * 1000);

// ---------------------------- Rotas ----------------------------

// Lista todos os presentes (o frontend usa isso para montar a lista e já
// mostrar quais foram dados)
app.get('/presentes', async (req, res) => {
  await liberarReservasExpiradas();
  res.json(await lerPresentes());
});

// Gera o PIX para um presente específico da lista
app.post('/reservar/:id', async (req, res) => {
  const { id } = req.params;
  const presente = await buscarPresente(id);

  if (!presente) return res.status(404).json({ erro: 'Presente não encontrado' });
  if (presente.status !== 'disponivel') {
    return res.status(400).json({ erro: 'Esse presente já foi escolhido por outra pessoa' });
  }

  try {
    const resultado = await paymentClient.create({
      body: {
        transaction_amount: Number(presente.valor),
        description: `Presente de casamento: ${presente.nome}`,
        payment_method_id: 'pix',
        payer: {
          email: process.env.PAGADOR_EMAIL_PADRAO,
          // Só em modo TESTE: esse nome faz o Mercado Pago aprovar o PIX
          // sozinho, poucos segundos depois de criado. Em produção esse
          // campo nem é enviado, então não interfere no pagador real.
          ...(MODO_TESTE ? { first_name: 'APRO' } : {}),
        },
        external_reference: presente.id,
      },
    });

    await atualizarPresente(id, {
      status: 'reservado',
      payment_id: resultado.id,
      reservadoEm: Date.now(),
    });

    res.json({
      payment_id: resultado.id,
      qr_code_base64: resultado.point_of_interaction.transaction_data.qr_code_base64,
      copia_e_cola: resultado.point_of_interaction.transaction_data.qr_code,
    });
  } catch (erro) {
    console.error('Erro ao criar pagamento:', erro);
    res.status(500).json({ erro: 'Não foi possível gerar o PIX. Tente novamente.' });
  }
});

// Gera o PIX para um valor livre ("Ajuda para a Lua de Mel" / outro valor)
app.post('/personalizado', async (req, res) => {
  const { valor } = req.body;
  const valorNumerico = Number(valor);

  if (!valorNumerico || valorNumerico <= 0) {
    return res.status(400).json({ erro: 'Valor inválido' });
  }

  try {
    const resultado = await paymentClient.create({
      body: {
        transaction_amount: valorNumerico,
        description: 'Presente de casamento - valor livre',
        payment_method_id: 'pix',
        payer: {
          email: process.env.PAGADOR_EMAIL_PADRAO,
          ...(MODO_TESTE ? { first_name: 'APRO' } : {}),
        },
      },
    });

    res.json({
      payment_id: resultado.id,
      qr_code_base64: resultado.point_of_interaction.transaction_data.qr_code_base64,
      copia_e_cola: resultado.point_of_interaction.transaction_data.qr_code,
    });
  } catch (erro) {
    console.error('Erro ao criar pagamento personalizado:', erro);
    res.status(500).json({ erro: 'Não foi possível gerar o PIX. Tente novamente.' });
  }
});

// Gera o link de pagamento no CARTÃO (com parcelamento) para um presente
// específico da lista. O convidado é redirecionado pra uma página segura
// do Mercado Pago, digita os dados do cartão lá, e volta pro site depois.
app.post('/cartao/:id', async (req, res) => {
  const { id } = req.params;
  const presente = await buscarPresente(id);

  if (!presente) return res.status(404).json({ erro: 'Presente não encontrado' });
  if (presente.status !== 'disponivel') {
    return res.status(400).json({ erro: 'Esse presente já foi escolhido por outra pessoa' });
  }

  try {
    const preferencia = await preferenceClient.create({
      body: {
        items: [
          {
            title: `Presente de casamento: ${presente.nome}`,
            quantity: 1,
            unit_price: Number(presente.valor),
            currency_id: 'BRL',
          },
        ],
        external_reference: presente.id,
        back_urls: {
          success: process.env.FRONTEND_URL,
          failure: process.env.FRONTEND_URL,
          pending: process.env.FRONTEND_URL,
        },
        auto_return: 'approved',
      },
    });

    await atualizarPresente(id, {
      status: 'reservado',
      payment_id: preferencia.id,
      reservadoEm: Date.now(),
    });

    res.json({
      link_pagamento: MODO_TESTE ? preferencia.sandbox_init_point : preferencia.init_point,
    });
  } catch (erro) {
    console.error('Erro ao criar checkout de cartão:', erro);
    res.status(500).json({ erro: 'Não foi possível iniciar o pagamento no cartão.' });
  }
});

// Mesma coisa, mas para o valor livre ("outro valor")
app.post('/cartao-personalizado', async (req, res) => {
  const { valor } = req.body;
  const valorNumerico = Number(valor);

  if (!valorNumerico || valorNumerico <= 0) {
    return res.status(400).json({ erro: 'Valor inválido' });
  }

  try {
    const preferencia = await preferenceClient.create({
      body: {
        items: [
          {
            title: 'Presente de casamento - valor livre',
            quantity: 1,
            unit_price: valorNumerico,
            currency_id: 'BRL',
          },
        ],
        back_urls: {
          success: process.env.FRONTEND_URL,
          failure: process.env.FRONTEND_URL,
          pending: process.env.FRONTEND_URL,
        },
        auto_return: 'approved',
      },
    });

    res.json({
      link_pagamento: MODO_TESTE ? preferencia.sandbox_init_point : preferencia.init_point,
    });
  } catch (erro) {
    console.error('Erro ao criar checkout de cartão (valor livre):', erro);
    res.status(500).json({ erro: 'Não foi possível iniciar o pagamento no cartão.' });
  }
});

// Salva uma confirmação de presença (RSVP). O frontend também abre o
// WhatsApp junto, então isso é só um registro organizado de backup.
app.post('/rsvp', async (req, res) => {
  const { tipo, nomes, resposta } = req.body;

  if (!tipo || !Array.isArray(nomes) || nomes.length === 0 || !resposta) {
    return res.status(400).json({ erro: 'Dados incompletos' });
  }

  try {
    await salvarConfirmacao({ tipo, nomes, resposta });
    res.json({ ok: true });
  } catch (erro) {
    console.error('Erro ao salvar confirmação de presença:', erro);
    res.status(500).json({ erro: 'Não foi possível salvar a confirmação.' });
  }
});

// Consulta de status por ID do presente (lista fixa)
app.get('/status/:id', async (req, res) => {
  const presente = await buscarPresente(req.params.id);
  if (!presente) return res.status(404).json({ erro: 'Presente não encontrado' });
  res.json({ status: presente.status });
});

// Consulta de status por ID do pagamento (funciona tanto para a lista fixa
// quanto para o valor personalizado — usado pelo frontend enquanto aguarda)
app.get('/status-pagamento/:paymentId', async (req, res) => {
  try {
    const info = await paymentClient.get({ id: req.params.paymentId });
    res.json({ status: info.status }); // pending | approved | rejected | etc.
  } catch (erro) {
    console.error('Erro ao consultar pagamento:', erro);
    res.status(500).json({ erro: 'Erro ao consultar pagamento' });
  }
});

// Webhook: o Mercado Pago chama isso automaticamente quando o PIX é pago
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' && data && data.id) {
      const info = await paymentClient.get({ id: data.id });

      if (info.status === 'approved' && info.external_reference) {
        await atualizarPresente(info.external_reference, { status: 'comprado' });
        console.log(`✅ Presente ${info.external_reference} confirmado como pago!`);
      } else if (info.status === 'approved') {
        console.log(`✅ Contribuição livre confirmada (pagamento ${data.id})`);
      }
    }

    res.sendStatus(200);
  } catch (erro) {
    console.error('Erro no webhook:', erro);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
