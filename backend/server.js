require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

// 🔎 DIAGNÓSTICO: captura qualquer erro que faria o processo morrer em
// silêncio, e força a mensagem a aparecer no log antes de encerrar.
process.on('uncaughtException', (err) => {
  console.error('💥 ERRO NÃO TRATADO (uncaughtException):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('💥 PROMISE REJEITADA (unhandledRejection):', err);
});

// 🔎 DIAGNÓSTICO: confirma se as variáveis de ambiente chegaram certinho
console.log('🔍 UPSTASH_REDIS_REST_URL definida?', !!process.env.UPSTASH_REDIS_REST_URL);
console.log('🔍 UPSTASH_REDIS_REST_TOKEN definida?', !!process.env.UPSTASH_REDIS_REST_TOKEN);
console.log('🔍 MP_ACCESS_TOKEN definida?', !!process.env.MP_ACCESS_TOKEN);

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const CHAVE_PRESENTES = 'presentes'; // chave única no Redis onde a lista inteira fica guardada

let redis;
try {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('✅ Cliente Redis criado com sucesso');
} catch (erro) {
  console.error('💥 ERRO ao criar cliente Redis:', erro);
}

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const paymentClient = new Payment(client);
const preferenceClient = new Preference(client);

const MODO_TESTE = (process.env.MP_ACCESS_TOKEN || '').startsWith('TEST-');

// ---------- "Banco de dados" — agora no Upstash Redis ----------

async function lerPresentes() {
  const dados = await redis.get(CHAVE_PRESENTES);
  return dados || [];
}

async function salvarPresentes(presentes) {
  await redis.set(CHAVE_PRESENTES, presentes);
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

async function buscarPresentePorPaymentId(paymentId) {
  const presentes = await lerPresentes();
  return presentes.find((p) => String(p.payment_id) === String(paymentId));
}

// Na primeira vez que o servidor rodar (Redis ainda vazio), popula a lista
// inicial a partir do arquivo presentes.seed.json que vai junto no projeto.
async function popularListaInicialSeNecessario() {
  const existente = await redis.get(CHAVE_PRESENTES);

  if (!existente) {
    const seedPath = path.join(__dirname, 'presentes.seed.json');
    const dadosIniciais = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    await redis.set(CHAVE_PRESENTES, dadosIniciais);
    console.log(`🌱 Lista inicial de ${dadosIniciais.length} presentes carregada no Redis.`);
  } else {
    console.log(`✅ Lista de presentes já existe no Redis (${existente.length} itens).`);
  }
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
  liberarReservasExpiradas().catch((erro) => console.error('Erro ao liberar reservas:', erro));
}, 5 * 60 * 1000);

// ---------------------------- Rotas ----------------------------

// Lista todos os presentes (o frontend usa isso para montar a lista e já
// mostrar quais foram dados)
app.get('/presentes', async (req, res) => {
  try {
    await liberarReservasExpiradas();
    res.json(await lerPresentes());
  } catch (erro) {
    console.error('Erro ao listar presentes:', erro);
    res.status(500).json({ erro: 'Erro ao carregar a lista de presentes' });
  }
});

// Gera o PIX para um presente específico da lista
app.post('/reservar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const presente = await buscarPresente(id);

    if (!presente) return res.status(404).json({ erro: 'Presente não encontrado' });
    if (presente.status !== 'disponivel') {
      return res.status(400).json({ erro: 'Esse presente já foi escolhido por outra pessoa' });
    }

    const resultado = await paymentClient.create({
      body: {
        transaction_amount: Number(presente.valor),
        description: `Presente de casamento: ${presente.nome}`,
        payment_method_id: 'pix',
        payer: {
          email: process.env.PAGADOR_EMAIL_PADRAO,
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
// específico da lista.
app.post('/cartao/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const presente = await buscarPresente(id);

    if (!presente) return res.status(404).json({ erro: 'Presente não encontrado' });
    if (presente.status !== 'disponivel') {
      return res.status(400).json({ erro: 'Esse presente já foi escolhido por outra pessoa' });
    }

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

// Consulta de status por ID do presente (lista fixa)
app.get('/status/:id', async (req, res) => {
  try {
    const presente = await buscarPresente(req.params.id);
    if (!presente) return res.status(404).json({ erro: 'Presente não encontrado' });
    res.json({ status: presente.status });
  } catch (erro) {
    console.error('Erro ao consultar status:', erro);
    res.status(500).json({ erro: 'Erro ao consultar status' });
  }
});

// Consulta de status por ID do pagamento
app.get('/status-pagamento/:paymentId', async (req, res) => {
  try {
    const info = await paymentClient.get({ id: req.params.paymentId });
    res.json({ status: info.status });
  } catch (erro) {
    console.error('Erro ao consultar pagamento:', erro);
    res.status(500).json({ erro: 'Erro ao consultar pagamento' });
  }
});

// Webhook: o Mercado Pago chama isso automaticamente quando o PIX (ou o
// cartão, via Checkout Pro) é pago
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

// ✅ CORREÇÃO: abre a porta IMEDIATAMENTE (o Render precisa ver isso rápido,
// senão ele mata o processo achando que travou)
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});

// Só depois disso, popula o Redis em segundo plano — sem bloquear a inicialização
popularListaInicialSeNecessario().catch((erro) => {
  console.error('💥 Erro ao popular lista inicial no Redis:', erro);
});
