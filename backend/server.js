require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const DB_PATH = path.join(__dirname, 'presentes.json');

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const paymentClient = new Payment(client);
const preferenceClient = new Preference(client);

// Detecta se estamos usando token de TESTE (começa com "TEST-") ou de
// PRODUÇÃO (começa com "APP_USR-"). Usado para só ativar o truque de
// aprovação automática quando estivermos testando.
const MODO_TESTE = (process.env.MP_ACCESS_TOKEN || '').startsWith('TEST-');

// ---------- "Banco de dados" simples em arquivo JSON ----------

function lerPresentes() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function salvarPresentes(presentes) {
  fs.writeFileSync(DB_PATH, JSON.stringify(presentes, null, 2));
}

function buscarPresente(id) {
  return lerPresentes().find((p) => p.id === String(id));
}

function atualizarPresente(id, dadosNovos) {
  const presentes = lerPresentes();
  const index = presentes.findIndex((p) => p.id === String(id));
  if (index === -1) return null;
  presentes[index] = { ...presentes[index], ...dadosNovos };
  salvarPresentes(presentes);
  return presentes[index];
}

function buscarPresentePorPaymentId(paymentId) {
  return lerPresentes().find((p) => String(p.payment_id) === String(paymentId));
}

// Libera presentes reservados há mais de 30 minutos que não foram pagos
function liberarReservasExpiradas() {
  const presentes = lerPresentes();
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

  if (mudou) salvarPresentes(presentes);
}
setInterval(liberarReservasExpiradas, 5 * 60 * 1000);

// ---------------------------- Rotas ----------------------------

// Lista todos os presentes (o frontend usa isso para montar a lista e já
// mostrar quais foram dados)
app.get('/presentes', (req, res) => {
  liberarReservasExpiradas();
  res.json(lerPresentes());
});

// Gera o PIX para um presente específico da lista
app.post('/reservar/:id', async (req, res) => {
  const { id } = req.params;
  const presente = buscarPresente(id);

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

    atualizarPresente(id, {
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
  const presente = buscarPresente(id);

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

    atualizarPresente(id, {
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

// Consulta de status por ID do presente (lista fixa)
app.get('/status/:id', (req, res) => {
  const presente = buscarPresente(req.params.id);
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
        atualizarPresente(info.external_reference, { status: 'comprado' });
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
