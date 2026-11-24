/**
 * E-mails transacionais pelo Resend (https://resend.com). Sem RESEND_API_KEY, o e-mail não sai:
 * fica registrado no log e em `outbox` (útil em homologação e nos testes).
 */
import { config } from './config.js';
import { escapeHtml } from './lib/util.js';

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export const outbox: Email[] = [];

export async function sendEmail(email: Email, log: (msg: string) => void = console.log): Promise<boolean> {
  if (!config.email.resendApiKey) {
    outbox.push(email);
    if (outbox.length > 50) outbox.shift();
    log(`e-mail não enviado (RESEND_API_KEY ausente): "${email.subject}" para ${email.to}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.email.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(config.email.replyTo ? { reply_to: config.email.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log(`Resend HTTP ${res.status} ao enviar "${email.subject}": ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`falha ao enviar e-mail "${email.subject}": ${(err as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------------

function wrap(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#08213d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#08213d;padding:20px 28px;border-bottom:4px solid #fe7e01;color:#ffffff;font-size:20px;font-weight:bold">Vendeuzap</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3">${escapeHtml(title)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:18px 28px;background:#f3f5f9;font-size:12px;color:#56657c">Vendeuzap · rastreamento de vendas no WhatsApp</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (url: string, label: string) =>
  `<p style="margin:22px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#fe7e01;color:#08213d;font-weight:bold;text-decoration:none;padding:14px 22px;border-radius:10px">${escapeHtml(label)}</a></p>`;

const PLAN_LABEL: Record<string, string> = { essencial: 'Essencial', profissional: 'Profissional', agencia: 'Agências' };
export const planLabel = (plan: string) => PLAN_LABEL[plan] ?? plan;

export function welcomeEmail(to: string, name: string | null, plan: string, loginUrl: string): Email {
  const first = (name || '').trim().split(/\s+/)[0];
  const hi = first ? `Olá, ${first}!` : 'Olá!';
  const steps = [
    'Conectar o WhatsApp: leia o QR Code no painel com o celular do número.',
    'Escolher para onde enviar as vendas: Meta, Google Analytics e/ou Google Ads.',
    'Combinar com a equipe como a venda será marcada: frase de confirmação, etiqueta ou botão.',
  ];
  return {
    to,
    subject: 'Bem-vindo ao Vendeuzap: seu acesso está pronto',
    html: wrap('Seu acesso está pronto', `
<p>${escapeHtml(hi)} Sua assinatura do plano <b>${escapeHtml(planLabel(plan))}</b> foi confirmada.</p>
<p>Clique no botão abaixo para entrar no seu painel. Não precisa de senha: o acesso é sempre por um link enviado para este e-mail.</p>
${button(loginUrl, 'Entrar no Vendeuzap')}
<p style="margin:0 0 8px"><b>No painel, são três passos:</b></p>
<ol style="margin:0 0 16px;padding-left:20px">${steps.map((s) => `<li style="margin-bottom:6px">${escapeHtml(s)}</li>`).join('')}</ol>
<p>O passo a passo completo está na <b>Central de ajuda</b>, dentro do painel. Se preferir, responda este e-mail que a nossa equipe ajuda na instalação.</p>
<p style="font-size:13px;color:#56657c">Este link vale por 7 dias e funciona uma vez. Depois disso, peça um novo em ${escapeHtml(config.baseUrl)}/entrar.</p>`),
    text: `${hi} Sua assinatura do plano ${planLabel(plan)} foi confirmada.

Entre no seu painel (sem senha): ${loginUrl}

No painel:
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

O link vale por 7 dias e funciona uma vez. Depois, peça um novo em ${config.baseUrl}/entrar.`,
  };
}

export function loginEmail(to: string, loginUrl: string): Email {
  return {
    to,
    subject: 'Seu link de acesso ao Vendeuzap',
    html: wrap('Seu link de acesso', `
<p>Clique no botão abaixo para entrar no Vendeuzap.</p>
${button(loginUrl, 'Entrar no Vendeuzap')}
<p style="font-size:13px;color:#56657c">O link vale por 30 minutos e funciona uma vez. Se não foi você que pediu, ignore este e-mail.</p>`),
    text: `Entre no Vendeuzap: ${loginUrl}\n\nO link vale por 30 minutos e funciona uma vez. Se não foi você que pediu, ignore este e-mail.`,
  };
}

export function subscriptionEndedEmail(to: string): Email {
  return {
    to,
    subject: 'Sua assinatura do Vendeuzap foi encerrada',
    html: wrap('Assinatura encerrada', `
<p>Sua assinatura do Vendeuzap foi encerrada, e os seus números deixaram de registrar conversas e enviar vendas para as plataformas.</p>
<p>Os dados que já estavam no painel continuam guardados. Para voltar, é só assinar de novo ou responder este e-mail.</p>`),
    text: 'Sua assinatura do Vendeuzap foi encerrada, e os seus números deixaram de registrar conversas e enviar vendas. Os dados continuam guardados. Para voltar, assine de novo ou responda este e-mail.',
  };
}

export function newSubscriptionNotice(to: string, info: { name: string; email: string; plan: string; cycle: string | null; whatsapp: string | null; panelUrl: string }): Email {
  const rows: [string, string][] = [
    ['Cliente', info.name],
    ['E-mail', info.email],
    ['Plano', `${planLabel(info.plan)}${info.cycle ? ` (${info.cycle})` : ''}`],
    ['WhatsApp informado', info.whatsapp || 'não informado'],
  ];
  return {
    to,
    subject: `Nova assinatura do Vendeuzap: ${info.name}`,
    html: wrap('Nova assinatura', `
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${rows
      .map(([k, v]) => `<tr><td style="padding:6px 0;color:#56657c;width:40%">${escapeHtml(k)}</td><td style="padding:6px 0"><b>${escapeHtml(v)}</b></td></tr>`)
      .join('')}</table>
<p>O acesso do cliente já foi criado e o e-mail de boas-vindas foi enviado.</p>
${button(info.panelUrl, 'Abrir no painel')}`),
    text: `${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nO acesso já foi criado e o e-mail de boas-vindas foi enviado.\n${info.panelUrl}`,
  };
}
