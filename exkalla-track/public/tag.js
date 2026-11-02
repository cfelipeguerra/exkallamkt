/*!
 * Exkalla Track — tag de site.
 * Instale antes de </body>:
 *   <script src="https://SEU-DOMINIO/t.js?c=SLUG-DO-CLIENTE" async></script>
 *
 * O que faz:
 *  1. Guarda (first-touch, 30 dias) fbclid, gclid, gbraid, wbraid e UTMs da página de entrada.
 *  2. Ao clicar em qualquer link de WhatsApp (wa.me, api.whatsapp.com, whatsapp://),
 *     gera um código curto, anexa-o à mensagem pré-preenchida e envia os dados do
 *     clique (incluindo cookies _fbp, _fbc e _ga) para o servidor.
 *  3. Quando o lead manda a mensagem, o servidor reconhece o código e liga a conversa ao clique.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var src = new URL(script.src);
  var CLIENT = src.searchParams.get('c');
  var ENDPOINT = src.origin + '/api/click';
  var INVISIBLE = src.searchParams.get('inv') === '1';
  var KEY = 'xk_attr_' + CLIENT;
  var TTL = 30 * 24 * 3600 * 1000;
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var PARAMS = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  if (!CLIENT) return;

  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // 1. Atribuição first-touch (um novo clique em anúncio substitui o anterior)
  var qs = new URLSearchParams(location.search);
  var saved = null;
  try { saved = JSON.parse(load(KEY) || 'null'); } catch (e) {}
  if (saved && Date.now() - saved.ts > TTL) saved = null;
  var hasClickId = qs.get('fbclid') || qs.get('gclid') || qs.get('gbraid') || qs.get('wbraid');
  if (!saved || hasClickId || (!saved.utm_source && qs.get('utm_source'))) {
    var attr = { ts: Date.now(), landing: location.href, referrer: document.referrer || null };
    PARAMS.forEach(function (p) { if (qs.get(p)) attr[p] = qs.get(p); });
    if (hasClickId || qs.get('utm_source') || !saved) { saved = attr; store(KEY, JSON.stringify(saved)); }
  }

  function gaIds() {
    var ga = cookie('_ga');
    var clientId = ga ? ga.split('.').slice(-2).join('.') : null;
    var sessionId = null;
    var all = document.cookie.split('; ');
    for (var i = 0; i < all.length; i++) {
      if (all[i].indexOf('_ga_') === 0) {
        var v = all[i].split('=')[1] || '';
        var m = v.match(/^GS2\.\d+\.s(\d+)/) || v.match(/^GS1\.\d+\.(\d+)/);
        if (m) { sessionId = m[1]; break; }
      }
    }
    return { clientId: clientId, sessionId: sessionId };
  }

  function newCode() {
    var out = '';
    var arr = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    for (var i = 0; i < 6; i++) out += ALPHABET[arr[i] % 32];
    return out;
  }

  function invisible(code) {
    var bits = '';
    for (var i = 0; i < code.length; i++) bits += ('00000' + ALPHABET.indexOf(code[i]).toString(2)).slice(-5);
    return '⁠' + bits.replace(/0/g, '​').replace(/1/g, '‌') + '⁠';
  }

  function tagText(text, code) {
    text = text || 'Olá!';
    return INVISIBLE ? text + invisible(code) : text + ' (cód. XK-' + code + ')';
  }

  function send(code) {
    var g = gaIds();
    var a = saved || {};
    var fbc = cookie('_fbc') || (a.fbclid ? 'fb.1.' + a.ts + '.' + a.fbclid : null);
    var payload = {
      client: CLIENT, ref: code, fbc: fbc, fbp: cookie('_fbp'), fbclid: a.fbclid || null,
      gclid: a.gclid || null, gbraid: a.gbraid || null, wbraid: a.wbraid || null,
      ga_client_id: g.clientId, ga_session_id: g.sessionId,
      utm_source: a.utm_source || null, utm_medium: a.utm_medium || null, utm_campaign: a.utm_campaign || null,
      utm_content: a.utm_content || null, utm_term: a.utm_term || null,
      page_url: location.href, landing_url: a.landing || null, referrer: a.referrer || document.referrer || null
    };
    var body = JSON.stringify(payload);
    // text/plain evita preflight de CORS e permite sendBeacon
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return;
    try { fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
  }

  function rewrite(href, code) {
    try {
      if (/^whatsapp:/i.test(href)) {
        var u0 = new URL(href.replace(/^whatsapp:\/\//i, 'https://x/'));
        u0.searchParams.set('text', tagText(u0.searchParams.get('text'), code));
        return 'whatsapp://send' + u0.search.replace(/\+/g, '%20');
      }
      var u = new URL(href, location.href);
      u.searchParams.set('text', tagText(u.searchParams.get('text'), code));
      // URLSearchParams codifica espaço como "+"; usamos %20, que todo cliente do WhatsApp entende
      u.search = u.search.replace(/\+/g, '%20');
      return u.toString();
    } catch (e) { return href; }
  }

  var WA = /(wa\.me\/|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|^whatsapp:)/i;

  /** Gera a URL rastreada para widgets customizados: ExkallaTrack.whatsappUrl('5511999999999', 'Olá') */
  window.ExkallaTrack = {
    whatsappUrl: function (number, text) {
      var code = newCode();
      send(code);
      return 'https://wa.me/' + String(number).replace(/\D/g, '') + '?text=' + encodeURIComponent(tagText(text, code));
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!el) return;
    var href = el.getAttribute('href') || '';
    if (!WA.test(href) || el.getAttribute('data-xk') === 'done') return;
    var code = newCode();
    el.setAttribute('href', rewrite(href, code));
    send(code);
    // Evita marcar duas vezes no mesmo clique; libera para um novo código depois
    el.setAttribute('data-xk', 'done');
    setTimeout(function () { el.removeAttribute('data-xk'); el.setAttribute('href', href); }, 1500);
  }, true);
})();
