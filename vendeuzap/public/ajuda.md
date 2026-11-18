# Como conectar a Meta, o Google Analytics e o Google Ads

O Vendeuzap envia cada venda, e cada conversa nova, para as plataformas de anúncio do cliente. Configure só as que o cliente usa. Os nomes dos menus da Meta e do Google mudam de tempos em tempos, então algum botão pode estar com um nome um pouco diferente.

## Antes de começar

1. **WhatsApp conectado:** na aba **Instalação**, o passo 1 precisa estar com ✓ "Recebendo mensagens".
2. **Combine com a equipe do cliente como a venda será marcada:**
   - uma frase de confirmação enviada pela equipe, como "pagamento confirmado" (de preferência com o valor: "Total: R$ 350,00");
   - a etiqueta **Venda** no app WhatsApp Business;
   - ou o botão **Registrar venda**, na aba **Conversas**.
3. **Valor padrão:** em **Configurações**, preencha "Valor usado quando a conversa não informa o valor" com o ticket médio. Com 0, uma venda sem valor chega às plataformas como R$ 0.
4. **Modo simulação:** se aparecer uma faixa amarela "Modo simulação ativo" no topo do painel, nada está sendo enviado de verdade. Quem administra o servidor precisa trocar `DRY_RUN=true` por `DRY_RUN=false` no Coolify e reiniciar o app.

## Meta

### 1. Escolher o conjunto de dados (Pixel)

**Se o cliente já tem um pixel usado nas campanhas, use esse mesmo.** Abra o **Gerenciador de Eventos**, encontre o pixel em **Fontes de dados** e copie o número de **Identificação**. Pixel duplicado divide os dados e atrapalha a otimização.

**Se o cliente não tem pixel:**

1. **Gerenciador de Eventos** › **Conectar fontes de dados** › **Web** › **Avançar**.
2. Escolha **Configurar a API de Conversões**. Não escolha "Configurar o Pixel da Meta", que serve para instalar código no site.
3. Dê um nome, por exemplo `Nome do Cliente - Vendeuzap`, e escolha a configuração **manual**, não por parceiro.
4. Se aparecer a tela de seleção de parâmetros, ela só gera um guia de instruções e não muda o envio. Se quiser preencher:
   - detalhes do evento: deixe os já marcados e marque **Identificação do evento**;
   - informações do cliente: **Telefone**, **Identificação externa**, **País**, **Endereço IP**, **Agente de usuário**, **fbc** e **fbp**;
   - no evento Comprar, em parâmetros adicionais: **Valor** e **Moeda**.

> Não use a opção **Mensagens**. Ela é a API de Conversões oficial do WhatsApp e só funciona com números na API oficial (WhatsApp Business Platform).

### 2. Gerar o token de acesso

1. Abra o conjunto de dados › aba **Configurações**.
2. Na seção **API de Conversões**, clique em **Gerar token de acesso**.
3. Copie o token na hora. Ele aparece uma vez só.

### 3. Preencher no Vendeuzap

No cliente › **Configurações** › **Meta (Facebook e Instagram)**:

- **ID do Pixel (conjunto de dados):** o número de Identificação.
- **Token da API de Conversões:** o token do passo 2. Ele fica guardado criptografado.
- Deixe em branco o campo **WABA**, em Opções avançadas. Ele só serve para números na API oficial.

Clique em **Salvar alterações**.

### 4. Testar

1. No Gerenciador de Eventos, abra o conjunto de dados › **Testar eventos** e copie o código de teste (algo como `TEST12345`).
2. No Vendeuzap, em **Configurações** › **Meta** › **Opções avançadas**, cole em **Código de evento de teste** e salve.
3. Na aba **Conversas**, clique em **Registrar venda** num contato de teste.
4. Em até um minuto:
   - a aba **Envios** mostra **✓ Meta**;
   - em **Testar eventos**, aparece o evento **Purchase** recebido pelo **servidor**.

Para testar o evento **Lead**, mande uma mensagem de um número que nunca falou com o cliente. O Lead só é enviado na primeira conversa de cada contato.

### 5. Apagar o código de teste

**Não pule este passo.** Com o código de teste preenchido, a Meta trata os eventos como teste e não os usa para atribuir vendas nem otimizar campanhas. Apague o campo e salve.

### Onde ver os resultados

- No **Gerenciador de Anúncios**, personalize as colunas e adicione **Compras** e **Valor de conversão de compras**.
- Campanhas otimizadas para conversões podem usar o evento **Purchase** desse pixel.
- Depois de alguns dias, confira em **Gerenciador de Eventos** › **Qualidade da correspondência de eventos**. Quando o lead vem direto de um anúncio de WhatsApp, a Meta liga a venda ao anúncio pelo telefone do comprador.

## Google Analytics 4

1. No GA4 do cliente: **Administrador** › **Fluxos de dados** › clique no fluxo do site. Copie o **ID da métrica** (`G-XXXXXXXXXX`).
2. Na mesma tela, abra **Chaves secretas da API do Measurement Protocol** › **Criar**. Dê o nome `Vendeuzap` e copie o **valor**.
3. No Vendeuzap: **Configurações** › **Google Analytics 4**. Cole os dois e salve.
4. Depois que os primeiros eventos chegarem: **Administrador** › **Eventos principais** › marque `purchase` e `generate_lead`. Eles só aparecem na lista depois de chegarem pela primeira vez.

Os eventos podem levar de 24 a 48 horas para aparecer nos relatórios padrão. Se a tag do Vendeuzap estiver no site, a venda fica ligada à sessão de origem do visitante no GA4.

## Google Ads

### Antes de começar

O Google Ads só recebe vendas de quem **clicou num anúncio do Google** e chegou ao WhatsApp por:

- uma **página do site com a tag do Vendeuzap** (aba Instalação, passo 4), o caminho mais seguro;
- ou um **link rastreável do Vendeuzap** como destino do anúncio. O Google pode reprovar anúncios que redirecionam para outro domínio, então prefira o site.

Se o anúncio abre o WhatsApp direto, não existe identificador do clique (gclid) e a venda não tem como ir para o Google Ads.

Confira também: **Administrador** › **Configurações da conta** › **Marcação automática** precisa estar **ativada**.

### 1. Criar a conversão no Google Ads

1. **Metas** › **Conversões** › **Resumo** › **+ Criar ação de conversão**.
2. **Importar** › **Outras fontes de dados ou CRMs** › **Acompanhar conversões de cliques** › **Continuar**.
3. Preencha:
   - **Categoria:** Compra
   - **Nome:** `Venda WhatsApp` (anote exatamente como escreveu)
   - **Valor:** usar valores diferentes para cada conversão
   - **Contagem:** Todas
   - **Janela de conversão:** 90 dias
4. **Salvar**.

### 2. Preencher no Vendeuzap

No cliente › **Configurações** › **Google Ads**:

- **ID do cliente Google Ads:** o número no canto superior direito do Google Ads (`123-456-7890`).
- **Nome da conversão de venda:** `Venda WhatsApp`, exatamente igual ao passo 1, com as mesmas maiúsculas, minúsculas e espaços.

Clique em **Salvar alterações**.

### 3. Copiar a URL de importação

No cliente › **Instalação** › **Integrações avançadas** › **Importação agendada no Google Ads**. A URL termina em `.csv`.

> Essa URL contém um código secreto. Não compartilhe.

### 4. Agendar a importação no Google Ads

1. **Metas** › **Conversões** › **Uploads** › **+** › **Programações**.
2. **Fonte:** HTTPS. Cole a URL do passo 3.
3. **Nome de usuário** e **Senha:** `vendeuzap` nos dois. O Vendeuzap não confere esses campos, porque a proteção é o código secreto da URL.
4. **Selecionar dados:** não precisa de filtro. Clique em **Avançar**.
5. **Mapear campos:**

| Campo do Google Ads | Coluna do arquivo |
|---|---|
| Data/hora da conversão | `Conversion_Time` |
| ID da transação | `Order_ID` |
| Origem do evento | Nenhum |
| GCLID | `Google_Click_ID` |
| Valor da conversão | `Conversion_Value` |
| Moeda | `Conversion_Currency` |
| Nome / ação de conversão | `Conversion_Name` ou a ação **Venda WhatsApp** |

6. Nas seções opcionais, deixe em branco **Melhoria da medição** (GBRAID, WBRAID, Endereço IP) e **Atributos do user agent e da sessão**. Em **Consentimento**, use **Não especificado** se o Google pedir um valor.
7. **Análise:** confira se a ação é **Venda WhatsApp** e a frequência é **diária**. Salve.

### Depois de agendar

- O arquivo traz as vendas dos últimos 60 dias que vieram de clique no Google. O código da transação (`Order_ID`) evita contar a mesma venda duas vezes.
- Enquanto não houver nenhuma venda vinda do Google, o arquivo traz uma **linha de exemplo** (`EXEMPLO-VENDEUZAP-IGNORAR`). O histórico de uploads vai mostrar **1 linha com erro** por dia. Isso é esperado: a linha não vira conversão e some quando a primeira venda real chegar.
- Em **Metas** › **Conversões** › **Uploads**, o histórico mostra quantas linhas foram aceitas e quantas tiveram erro.

## Problemas comuns

| O que aparece | O que fazer |
|---|---|
| Faixa amarela "Modo simulação ativo" | Trocar `DRY_RUN=true` por `DRY_RUN=false` no Coolify e reiniciar o app. |
| **✕ Meta** na aba Envios | Abra **Detalhes técnicos**. Erro de token (código 190) pede um token novo, gerado no passo 2 da Meta. |
| A venda não aparece | A frase precisa sair do WhatsApp do cliente, com as palavras juntas e na mesma ordem. Etiquetas só funcionam no app WhatsApp Business. Vendas automáticas do mesmo contato em menos de 12 horas contam uma vez só. |
| **– Google Ads** (não se aplica) na aba Envios | O lead não veio de clique num anúncio do Google. É esperado. |
| Google: "pelo menos uma linha de dados válidos" | Peça para atualizar o Vendeuzap (Redeploy no Coolify) e tente de novo. |
| Evento de teste não aparece na Meta | Confira se o código de teste está salvo e se o modo simulação está desligado. |
