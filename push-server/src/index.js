/*
 * Servidor de notificaciones push de "Mis Clientes" (Cloudflare Worker, plan gratis).
 *
 * - Cada dispositivo que activa las notificaciones tiene un código secreto (token) propio.
 * - La app le manda un RESUMEN MÍNIMO: nombre del cliente + fechas en que vence cada alerta
 *   + cantidad de bonos pendientes. Nunca teléfonos, montos ni notas.
 * - Cada hora revisa qué dispositivos eligieron esa hora para el aviso diario y, si hay alertas,
 *   les manda un push "vacío". El Service Worker del iPhone recibe el push y pide el detalle a /alertas.
 *   (Así no hace falta cifrar el contenido del push.)
 *
 * Datos en KV:  acc:<token> -> { sub, snap, hora, tz, creado }
 * Secretos:     VAPID_PRIVATE_JWK  (clave privada, solo en Cloudflare)
 * Variables:    VAPID_PUBLIC, VAPID_SUBJECT, ALLOWED_ORIGINS
 */

const MAX_CUENTAS = 10;          // protege los límites gratis de KV
const MAX_BYTES = 200_000;       // tamaño máximo de un resumen

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const permitido = env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': permitido ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    try {
      if (url.pathname === '/vapid') return json({ publicKey: env.VAPID_PUBLIC });

      // Partidos próximos (datos públicos, se actualizan solos una vez por día)
      if (url.pathname === '/partidos') {
        let datos = await env.KV.get('partidos', 'json');
        const viejo = !datos || (Date.now() - Date.parse(datos.actualizado)) > 20 * 3600 * 1000;
        if (viejo && env.FOOTBALL_DATA_KEY) {
          try { datos = await actualizarPartidos(env); } catch (e) { if (!datos) return json({ error: 'No se pudieron traer los partidos: ' + e.message }, 502); }
        }
        if (!datos) return json({ error: env.FOOTBALL_DATA_KEY ? 'sin datos todavía' : 'falta configurar la clave de football-data.org', partidos: [] }, 503);
        return json(datos);
      }

      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: 'token inválido' }, 401);
      const key = 'acc:' + token;

      // Activar / actualizar suscripción de este dispositivo
      if (url.pathname === '/subscribe' && req.method === 'POST') {
        const body = await leer(req);
        if (!body.sub || !/^https:\/\//.test(body.sub.endpoint || '')) return json({ error: 'suscripción inválida' }, 400);
        let acc = await env.KV.get(key, 'json');
        if (!acc) {
          const { keys } = await env.KV.list({ prefix: 'acc:' });
          if (keys.length >= MAX_CUENTAS) return json({ error: 'límite de dispositivos alcanzado' }, 403);
          acc = { creado: new Date().toISOString() };
        }
        acc.sub = body.sub;
        if (Number.isInteger(body.hora) && body.hora >= 0 && body.hora <= 23) acc.hora = body.hora;
        if (Number.isInteger(body.tz)) acc.tz = body.tz;
        if (body.snap) acc.snap = body.snap;
        await env.KV.put(key, JSON.stringify(acc));
        return json({ ok: true });
      }

      const acc = await env.KV.get(key, 'json');
      if (!acc) return json({ error: 'no activado' }, 404);

      // Actualizar el resumen (lo manda la app cuando cambian los datos)
      if (url.pathname === '/sync' && req.method === 'POST') {
        const body = await leer(req);
        if (body.snap) acc.snap = body.snap;
        if (Number.isInteger(body.hora) && body.hora >= 0 && body.hora <= 23) acc.hora = body.hora;
        if (Number.isInteger(body.tz)) acc.tz = body.tz;
        await env.KV.put(key, JSON.stringify(acc));
        return json({ ok: true });
      }

      // El Service Worker pide qué mostrar cuando llega un push
      if (url.pathname === '/alertas') {
        const avisos = calcularAvisos(acc);
        if (acc.prueba) { delete acc.prueba; await env.KV.put(key, JSON.stringify(acc));
          avisos.unshift({ title: '✅ Notificaciones activadas', body: avisos.length ? 'Así te van a llegar los avisos. Estas son tus alertas de hoy:' : 'Funciona. Hoy no tenés alertas pendientes.', tag: 'prueba' }); }
        return json({ avisos });
      }

      // Enviar una notificación de prueba ahora
      if (url.pathname === '/test' && req.method === 'POST') {
        acc.prueba = true;
        await env.KV.put(key, JSON.stringify(acc));
        const r = await enviarPush(acc.sub, env);
        const detalle = r.ok ? '' : (await r.text().catch(() => '')).slice(0, 300);
        if (r.status === 404 || r.status === 410) await env.KV.delete(key); // suscripción vencida: hay que reactivar
        return json({ ok: r.ok, status: r.status, detalle });
      }

      // Desactivar este dispositivo
      if (url.pathname === '/unsubscribe' && req.method === 'POST') {
        await env.KV.delete(key);
        return json({ ok: true });
      }

      return json({ error: 'no encontrado' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
  },

  // Cron: cada hora en punto
  async scheduled(event, env, ctx) {
    ctx.waitUntil(revisarTodos(env));
    // Una vez por día (09:00 UTC = 05:00 en Bolivia) se renueva la lista de partidos
    if (new Date(event.scheduledTime || Date.now()).getUTCHours() === 9 && env.FOOTBALL_DATA_KEY) {
      ctx.waitUntil(actualizarPartidos(env).catch(() => {}));
    }
  },
};

/* ---------- Partidos (football-data.org, plan gratis) ---------- */
// Competiciones incluidas en el plan gratis que interesan
const COMPETICIONES = ['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'PPL'];
const DIAS_ADELANTE = 60;

async function actualizarPartidos(env) {
  const desde = new Date().toISOString().slice(0, 10);
  const hasta = new Date(Date.now() + DIAS_ADELANTE * 86400000).toISOString().slice(0, 10);
  const partidos = [], errores = [];
  for (const code of COMPETICIONES) {   // 7 consultas: dentro del límite de 10 por minuto
    const r = await fetch(`https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${desde}&dateTo=${hasta}`, {
      headers: { 'X-Auth-Token': env.FOOTBALL_DATA_KEY },
    });
    if (!r.ok) { errores.push(`${code}: ${r.status}`); continue; }
    const j = await r.json();
    for (const m of j.matches || []) {
      if (['FINISHED', 'CANCELLED', 'AWARDED'].includes(m.status)) continue;
      partidos.push({
        id: m.id, f: m.utcDate, c: code, comp: j.competition?.name || code,
        etapa: m.stage, j: m.matchday,
        l: [m.homeTeam?.name || '', m.homeTeam?.shortName || ''],
        v: [m.awayTeam?.name || '', m.awayTeam?.shortName || ''],
        st: m.status,
      });
    }
  }
  if (!partidos.length && errores.length) throw new Error(errores.join(', '));
  const datos = { actualizado: new Date().toISOString(), partidos, errores };
  await env.KV.put('partidos', JSON.stringify(datos));
  return datos;
}

async function leer(req) {
  const txt = await req.text();
  if (txt.length > MAX_BYTES) throw new Error('datos demasiado grandes');
  return JSON.parse(txt || '{}');
}

// Fecha y hora local del dispositivo (tz = minutos a sumar a UTC, ej. Bolivia = -240)
function ahoraLocal(tz) {
  const d = new Date(Date.now() + (tz || 0) * 60000);
  return { fecha: d.toISOString().slice(0, 10), hora: d.getUTCHours() };
}

function calcularAvisos(acc) {
  const s = acc.snap;
  if (!s || !Array.isArray(s.c)) return [];
  const hoy = ahoraLocal(acc.tz).fecha;
  const lista = arr => arr.slice(0, 4).join(', ') + (arr.length > 4 ? '…' : '');
  const avisos = [];

  // c: [nombre, contactoVence, riesgoDesde, prioridadRiesgo, bonosPendientes]
  const riesgo = s.c.filter(x => x[2] && x[2] <= hoy).sort((a, b) => (b[3] || 0) - (a[3] || 0));
  if (riesgo.length) avisos.push({ title: `🔥 ${riesgo.length} cliente${riesgo.length > 1 ? 's' : ''} en riesgo`, body: `Bajaron su ritmo de carga: ${lista(riesgo.map(x => x[0]))}`, tag: 'riesgo', tab: 'riesgo' });

  const sinContacto = s.c.filter(x => x[1] && x[1] <= hoy);
  if (sinContacto.length) avisos.push({ title: `⏰ ${sinContacto.length} para contactar`, body: `Sin contacto hace más de ${s.dias} días: ${lista(sinContacto.map(x => x[0]))}`, tag: 'contacto', tab: 'pend' });

  const bonos = s.c.reduce((t, x) => t + (x[4] || 0), 0);
  if (bonos) avisos.push({ title: `🎁 ${bonos} bono${bonos > 1 ? 's' : ''} pendiente${bonos > 1 ? 's' : ''}`, body: `Total a pagar: Bs ${bonos * (s.bm || 30)}`, tag: 'bonos', tab: 'ranking' });

  return avisos;
}

async function revisarTodos(env) {
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'acc:', cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      const acc = await env.KV.get(k.name, 'json');
      if (!acc || !acc.sub) continue;
      const { hora } = ahoraLocal(acc.tz);
      if (hora !== (acc.hora ?? 9)) continue;
      if (!calcularAvisos(acc).length) continue;
      const r = await enviarPush(acc.sub, env);
      if (r.status === 404 || r.status === 410) await env.KV.delete(k.name); // el iPhone dio de baja la suscripción
    }
  } while (cursor);
}

/* ---------- Web Push (VAPID, sin contenido cifrado) ---------- */

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlTxt = s => b64url(new TextEncoder().encode(s));

async function vapidJWT(audience, env) {
  // El secreto puede venir con un BOM (U+FEFF) o saltos de línea si se cargó desde PowerShell: se limpian antes de leerlo.
  const jwk = JSON.parse(String(env.VAPID_PRIVATE_JWK).replace(/^﻿/, '').trim());
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64urlTxt(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64urlTxt(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT }));
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(firma)}`;
}

async function enviarPush(sub, env) {
  const endpoint = new URL(sub.endpoint);
  const jwt = await vapidJWT(endpoint.origin, env);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      'TTL': '43200',
      'Urgency': 'high',
      'Content-Length': '0',
    },
  });
}
