import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerApiRoutes } from './routes/api.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerReportRoutes } from './routes/report.js';

export async function buildApp(db: DB, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          serializers: {
            // Não registra os tokens secretos que fazem parte de algumas URLs
            req: (req) => ({
              method: req.method,
              url: req.url.replace(/\/(webhooks\/evolution|report|feeds\/google-ads|entrar)\/[^/?.]+/, '/$1/***'),
            }),
          },
        }
      : false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });
  await app.register(formbody);
  await app.register(cors, { origin: (origin, cb) => cb(null, true), methods: ['POST'] });
  // A tag do site envia text/plain (sendBeacon sem preflight)
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  // JSON guardando o corpo original: a Stripe assina o texto exato do webhook
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      const err = new Error('JSON inválido') as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  registerPublicRoutes(app, db);
  registerApiRoutes(app, db);
  registerAccountRoutes(app, db);
  registerAdminRoutes(app, db);
  registerReportRoutes(app, db);
  app.get('/', async (_req, reply) => reply.redirect('/admin'));
  return app;
}
