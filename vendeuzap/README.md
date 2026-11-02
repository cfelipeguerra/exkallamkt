# Vendeuzap

Rastreamento de vendas que acontecem no WhatsApp, com devolução das conversões para **Meta (Conversions API)**, **Google Analytics 4 (Measurement Protocol)** e **Google Ads (conversões offline por GCLID)**. Integra com os números dos clientes via **Evolution API**.

Multi-cliente: cada cliente da agência tem sua instância da Evolution, seus pixels/tags e um relatório somente leitura.

## Como funciona

```
 Anúncio CTWA (Meta) ─────────────────────────────┐
 Link rastreável /r/slug (bio, Google, QR) ──┐     │  ctwa_clid / anúncio
 Site com a tag t.js (botões de WhatsApp) ───┤     │  vem na própria mensagem
                                             ▼     ▼
                código "VZ-AB12CD" na 1ª mensagem ─► Evolution API ─► webhook
                                                                    │
                     Vendeuzap: cria o lead com a origem ◄──────┘
                     detecta a venda (palavra-chave, etiqueta, painel ou API)
                                    │
                 fila com novas tentativas ─► Meta CAPI · GA4 · Google Ads
```

### 1. Origem do lead
| Origem | Como é identificada | Dados capturados |
|---|---|---|
| **Anúncio Click-to-WhatsApp (Meta)** | `contextInfo.externalAdReply` da mensagem recebida pela Evolution | `ctwaClid`, ID e título do anúncio, URL |
| **Link rastreável** `/r/<slug>` | Código curto anexado à mensagem pré-preenchida | `fbclid` → `fbc`, `gclid`/`gbraid`/`wbraid`, UTMs, IP, user agent |
| **Tag no site** `t.js` | Intercepta cliques em links `wa.me`, `api.whatsapp.com` e `whatsapp://` e anexa o código | Tudo acima + cookies `_fbp`, `_fbc`, `_ga` (client_id e session_id do GA4) |
| **Orgânico** | Nenhum dos anteriores | Só o telefone |

O código vai visível (`(cód. VZ-AB12CD)`) ou invisível (caracteres de largura zero), configurável por cliente. O modo visível é mais robusto; o invisível é mais discreto, mas pode se perder se o lead apagar e reescrever a mensagem.

Leads com o endereçamento novo do WhatsApp (`@lid`) são resolvidos pelo `remoteJidAlt` enviado pela Evolution.

### 2. Detecção da venda
1. **Palavra-chave** em mensagem **enviada pela empresa** (ex.: "pagamento confirmado"). O valor é lido da mensagem (`Total: R$ 389,90`, `R$ 1.250,00`) ou do último valor citado pela empresa na conversa; sem valor, usa o ticket padrão do cliente.
2. **Etiqueta do WhatsApp Business** (ex.: "Venda"), via eventos `LABELS_EDIT` e `LABELS_ASSOCIATION`. Etiqueta de "Qualificado" gera o evento de lead qualificado.
3. **Botão "Venda"** no painel.
4. **API** `POST /api/v1/sales` para n8n, CRM, checkout ou planilha (idempotente com `external_ref`).

Vendas automáticas do mesmo contato dentro de 12h são deduplicadas.

### 3. Eventos enviados
| Momento | Meta | GA4 | Google Ads |
|---|---|---|---|
| 1ª mensagem do lead (opcional) | `Lead` | `generate_lead` | ação de Lead (requer GCLID) |
| Etiqueta "qualificado" | `QualifiedLead` | `qualify_lead` | — |
| Venda | `Purchase` com valor e moeda | `purchase` com `transaction_id` | ação de Compra com valor (requer GCLID) |

**Meta: dois modos de envio.**
- **Modo oficial "business_messaging"**: usado quando o cliente tem o ID da WABA preenchido **e** o lead veio de anúncio CTWA com `ctwa_clid`. Envia `action_source: business_messaging`, `messaging_channel: whatsapp` e `user_data` com `whatsapp_business_account_id` + `ctwa_clid`. A documentação da Meta exige um dataset vinculado à WABA e um token com as permissões `whatsapp_business_management` e `whatsapp_business_manage_events`. **Atenção:** números conectados pela Evolution via Baileys (WhatsApp Web) normalmente **não** têm WABA, então este modo só se aplica a números que estão na WhatsApp Business Platform.
- **Modo padrão da CAPI** (todos os outros casos): `action_source: website` quando o lead veio de um clique registrado (com `fbc`, `fbp`, IP, user agent e `event_source_url`), ou `chat` caso contrário. Sempre envia telefone com hash SHA-256 (com e sem o 9º dígito, porque o WhatsApp às vezes entrega números brasileiros sem ele) e `external_id`. Para leads de CTWA em números sem WABA, a correspondência depende do telefone; a Meta não divulga a taxa de correspondência nesse caso, então acompanhe a "qualidade de correspondência" no Gerenciador de Eventos.

**Google Ads: dois modos.**
- **API** (`uploadClickConversions`): requer developer token, OAuth da conta MCC da agência e o ID da ação de conversão de cada cliente.
- **Feed CSV** em `/feeds/google-ads/<api_token>.csv` para *Upload agendado* via HTTPS no Google Ads. Não precisa de developer token. Valide a primeira importação pela pré-visualização do próprio Google Ads.
- Só conversões de leads que chegaram com GCLID/GBRAID/WBRAID (link rastreável ou tag do site) podem ser enviadas. Anúncios do Google que abrem o WhatsApp direto, sem passar por uma página ou link, não carregam GCLID.

**GA4:** usa o `client_id` do cookie `_ga` capturado pela tag. Sem ele, gera um id estável por contato (o evento é registrado, mas sem ligação com a sessão de origem). O Measurement Protocol aceita eventos de até 72h atrás.

Eventos com erro são tentados de novo após 1 min, 5 min, 30 min, 2h e 6h. Erros 4xx (dado inválido) não são re-tentados e ficam visíveis no painel com o payload enviado e a resposta da plataforma.

## Instalação

Requisitos: Node 20+ (ou Docker) e uma URL pública com HTTPS.

```bash
cp .env.example .env              # preencha BASE_URL, ADMIN_PASSWORD, ENCRYPTION_KEY, EVOLUTION_*
openssl rand -hex 32              # valor para ENCRYPTION_KEY (guarde em local seguro)
docker compose up -d --build
```

Sem Docker:

```bash
npm ci && npm run build && npm start
```

Dica: comece com `DRY_RUN=true` para conferir os payloads no painel antes de enviar eventos reais, e use o *código de evento de teste* da Meta no cadastro do cliente.

## Onboarding de um cliente

1. **Painel → Novo cliente**: nome, número, nome da instância da Evolution, regras de venda e credenciais (Pixel/Dataset + token da CAPI, GA4, Google Ads).
2. **Configurar automaticamente** o webhook na instância (ou cadastre manualmente na Evolution a URL exibida, com os eventos `MESSAGES_UPSERT`, `SEND_MESSAGE`, `LABELS_EDIT`, `LABELS_ASSOCIATION`).
3. **Sincronizar etiquetas**, se for usar etiquetas do WhatsApp Business.
4. Instale a **tag** no site (direto no HTML ou via Google Tag Manager como HTML personalizado) e/ou crie **links rastreáveis**.
5. Envie ao cliente o **link do relatório** (somente leitura, sem login).

## API

```bash
# Registrar venda
curl -X POST $BASE_URL/api/v1/sales \
  -H "Authorization: Bearer <api_token>" -H "Content-Type: application/json" \
  -d '{"phone":"5511999999999","value":199.90,"external_ref":"pedido-123","note":"opcional"}'
# "create_contact": true cria o contato se ele nunca falou no WhatsApp (origem orgânica)

# Consultar origem de um contato
curl $BASE_URL/api/v1/contacts/5511999999999 -H "Authorization: Bearer <api_token>"
```

Para customizar widgets de WhatsApp no site, a tag expõe `Vendeuzap.whatsappUrl('5511999999999', 'Olá!')`, que retorna a URL já rastreada.

## Rotas

| Rota | Uso |
|---|---|
| `GET /admin` | Painel da agência (Basic Auth) |
| `POST /webhooks/evolution/:token` | Webhook da Evolution (token por cliente) |
| `GET /r/:slug` | Link rastreável → redireciona para `wa.me` |
| `GET /t.js?c=<slug>` | Tag do site (`&inv=1` para código invisível) |
| `POST /api/click` | Cliques enviados pela tag |
| `POST /api/v1/sales`, `GET /api/v1/contacts/:phone` | API por cliente (Bearer) |
| `GET /feeds/google-ads/:token.csv` | Feed para upload agendado do Google Ads |
| `GET /report/:token` | Relatório do cliente |
| `GET /health` | Health check |

## Privacidade (LGPD)

- O conteúdo das mensagens **não é armazenado**: só contadores, o último valor monetário citado pela empresa e os metadados de origem.
- Tokens dos clientes ficam criptografados (AES-256-GCM) no banco.
- Telefones vão para Meta e Google apenas com hash SHA-256.
- Inclua na política de privacidade de cada cliente o uso de dados de conversa para mensuração de anúncios e o compartilhamento com Meta/Google.

## Desenvolvimento

```bash
npm install
npm test          # testes unitários e de fluxo completo (link → lead → venda → payloads)
npm run dev
```

Estrutura: `src/integrations/evolution.ts` (parser dos webhooks), `src/tracking.ts` (atribuição e detecção de venda), `src/integrations/platforms.ts` (payloads Meta/GA4/Google Ads), `src/dispatcher.ts` (fila), `src/routes/*` (HTTP e painel), `public/tag.js` (tag do site).

## Limitações conhecidas

- Os formatos de webhook foram conferidos no código-fonte da Evolution API v2 (Baileys). Se vocês usam outra versão ou o canal Cloud API dentro da Evolution, valide com um evento real antes de ir para produção (a resposta do webhook, visível no log da Evolution, informa a ação tomada: "lead criado (ctwa)", "venda por etiqueta" etc.).
- Nos testes, o `ctwaClid` foi simulado com o formato que o Baileys expõe. Confirme com um clique real em anúncio CTWA de cada cliente que o campo chega preenchido.
- As versões padrão das APIs (`META_GRAPH_VERSION=v25.0`, `GOOGLE_ADS_API_VERSION=v25`) são configuráveis. Confira periodicamente as datas de descontinuação nos changelogs da Meta e do Google.
- O SQLite atende bem uma agência com dezenas de clientes num único servidor. Para escalar horizontalmente, migre para Postgres.

## Referências

- Meta: [Conversions API for Business Messaging](https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging)
- AWS End User Messaging Social: [exemplo de payload da CAPI para WhatsApp](https://docs.aws.amazon.com/social-messaging/latest/userguide/conversions-api.html)
- Meta: [Graph API v25.0](https://developers.facebook.com/docs/graph-api/changelog/version25.0)
- Google Ads API: [UploadClickConversions](https://developers.google.com/google-ads/api/reference/rpc/latest/UploadClickConversionsRequest)
- Evolution API: [Webhooks v2](https://doc.evolution-api.com/v2/en/configuration/webhooks) e [código-fonte](https://github.com/EvolutionAPI/evolution-api)
