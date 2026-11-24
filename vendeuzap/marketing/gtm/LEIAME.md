# Rastreamento do site do Vendeuzap

Eventos enviados ao dataLayer (GTM-NMVW6JT7):

| Evento | Onde | Dados |
|---|---|---|
| `view_item_list` | Visitante chega na seção de planos | `ecommerce.items` |
| `alterar_ciclo` | Troca entre mensal e anual | `ciclo` |
| `begin_checkout` | Clique em assinar (abre a Stripe) | `plano`, `ciclo`, `ecommerce.value` |
| `clique_whatsapp` | Qualquer botão de WhatsApp | `local` (topo, abertura, plano_agencias, cliente_div, final, obrigado) |
| `video_play` | Play manual no vídeo | |
| `purchase` | Página `obrigado.html`, depois do pagamento | `ecommerce.transaction_id` (ID do checkout), `value` real da Stripe, `user_data` com e-mail e telefone em SHA-256 |
| `purchase_teste` | Igual ao anterior, mas para compras de teste (`cs_test_`) | não aciona as tags de compra |

O valor da compra vem do Vendeuzap (`GET /api/checkout/:session_id`), que recebe a compra pelo webhook da Stripe. Se o webhook atrasar mais de ~7 segundos, a página usa o valor do plano do endereço. Cada compra é enviada uma vez por navegador.

`vendeuzap-gtm.json` é o contêiner para importar no GTM (Admin → Importar contêiner → Mesclar). Troque os valores das 4 constantes `CONST - ...` antes de publicar.
