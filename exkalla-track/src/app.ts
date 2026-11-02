import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DB } from './db.js';
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
              url: req.url.replace(/\/(webhooks\/evolution|report|feeds\/google-ads)\/[^/?.]+/, '/$1/***'),
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

  registerPublicRoutes(app, db);
  registerApiRoutes(app, db);
  registerAdminRoutes(app, db);
  registerReportRoutes(app, db);
  app.get('/', async (_req, reply) => reply.redirect('/admin'));
  return app;
}
