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
