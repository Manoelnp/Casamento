# Passo a passo — Convite do Manoel & Raísa com PIX automático

## O que mudou no seu HTML

- A lista de presentes agora **vem do backend** (arquivo `backend/presentes.json`), em vez de estar escrita direto no JavaScript. Isso é o que permite marcar automaticamente "já foi dado".
- Cada presente escolhido agora gera um **QR Code de verdade** (antes mostrava sua chave PIX fixa).
- O site fica checando sozinho se o pagamento caiu, e quando cai, mostra "✅ Pagamento confirmado" e atualiza a lista.
- O "outro valor" (sua antiga opção de ajuda de Lua de Mel livre) também passou a gerar QR Code.
- O WhatsApp continua funcionando normalmente para o RSVP (confirmação de presença) — isso eu não toquei.

## Sua estrutura de pastas deve ficar assim

```
casamento/
├── index.html         ← substitua pelo novo (já adaptado)
├── hero.png            ← seus arquivos que já existiam
├── musica.mp3
│
└── backend/            ← pasta nova
    ├── server.js
    ├── package.json
    ├── .env.example
    └── presentes.json  ← sua lista real, já com 63 itens extraídos do seu HTML
```

---

## PARTE 1 — Conferir a lista de presentes

Abra `backend/presentes.json` e confira se ficou tudo certo — extraí os 63 itens do seu código (incluindo os repetidos "Ajuda para a Lua de Mel" com valores diferentes, que agora têm IDs únicos: 33, 43, 51, 57, 61). Se quiser adicionar, remover ou corrigir algum preço, edite esse arquivo diretamente — é só uma lista JSON.

---

## PARTE 2 — Criar sua conta no Mercado Pago

1. Crie uma conta em https://www.mercadopago.com.br (se ainda não tiver).
2. Acesse https://www.mercadopago.com.br/developers/panel e crie uma aplicação (ex: "Casamento Manoel e Raísa").
3. Copie o **Access Token de teste** primeiro — é com ele que você testa tudo sem gastar dinheiro de verdade.
4. Quando tudo estiver funcionando, troque pelo **Access Token de produção** — é nesse momento que o dinheiro passa a cair de verdade na sua conta Mercado Pago (que você depois transfere pro seu banco, ex: Banco Inter, normalmente).

---

## PARTE 3 — Rodando o backend

1. Instale o Node.js: https://nodejs.org (baixe a versão LTS)
2. No terminal:
   ```bash
   cd casamento/backend
   npm install
   ```
3. Renomeie `.env.example` para `.env` e preencha:
   ```
   MP_ACCESS_TOKEN=TEST-xxxxxxxxxxxxxxxxxxxxxxxx
   PORT=3000
   FRONTEND_URL=http://localhost:5500
   PAGADOR_EMAIL_PADRAO=convidados@exemplo.com
   ```
4. Rode:
   ```bash
   npm start
   ```
   Se aparecer `🚀 Servidor rodando em http://localhost:3000`, está pronto.

---

## PARTE 4 — Testando no seu computador

1. Abra a pasta `casamento` com a extensão **Live Server** do VS Code (botão direito no `index.html` → "Open with Live Server"). Isso é necessário porque o `fetch` não funciona se você só clicar duas vezes no arquivo.
2. Clique em "LISTA DE PRESENTES" no convite → deve aparecer a lista completa vinda do backend.
3. Clique em "PRESENTEAR" em qualquer item → deve aparecer um QR Code real de teste.
4. Para simular o pagamento em modo teste, use o simulador do Mercado Pago: https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-test/test-cards (procure por "Simulador de pagamentos PIX").
5. Depois de "pagar" no simulador, em até 3 segundos a tela deve mostrar "✅ Pagamento confirmado".

---

## PARTE 5 — Colocando no ar

### Backend (precisa ficar sempre ligado)
- **Render** (render.com) ou **Railway** (railway.app) — ambos têm plano gratuito, conectam direto no GitHub.
- Configure lá as mesmas variáveis do `.env`.

### Frontend
- Continua onde já está hospedado hoje.
- Troque a linha no `index.html`:
  ```javascript
  const API_URL = "http://localhost:3000";
  ```
  pela URL real do backend publicado, por exemplo:
  ```javascript
  const API_URL = "https://casamento-backend.onrender.com";
  ```

### Webhook (avisa o sistema quando o PIX cai de verdade)
No painel do Mercado Pago → Sua aplicação → **Webhooks**, cadastre:
```
https://SEU-BACKEND-PUBLICADO.com/webhook
```
Marque o evento **"Pagamentos"**.

### Trocar para produção
1. Troque `MP_ACCESS_TOKEN` no Render/Railway pelo token de **produção**.
2. Reinicie o backend (o próprio painel do Render/Railway reinicia sozinho quando você salva a variável).
3. Faça um teste real de R$ 1,00 pra confirmar que está tudo funcionando ponta a ponta antes do grande dia.

---

## Checklist final 💍

- [ ] Conferi a lista de presentes em `presentes.json`
- [ ] Testei escolher um presente com token de teste e vi o QR Code aparecer
- [ ] Testei o pagamento simulado e vi a confirmação automática aparecer
- [ ] Publiquei o backend (Render/Railway)
- [ ] Atualizei o `API_URL` no `index.html` pra apontar pro backend publicado
- [ ] Cadastrei o Webhook com a URL final
- [ ] Troquei para o Access Token de produção
- [ ] Fiz um teste real de R$ 1,00 ponta a ponta
- [ ] Publiquei o `index.html` atualizado no ar

Qualquer erro no terminal ou comportamento estranho no site, me manda print ou a mensagem de erro que eu te ajudo a resolver.
