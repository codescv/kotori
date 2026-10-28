/**
 * `/api/dict/*` — DictionaryHost. `POST /api/dict/import` accepts either the
 * route-table JSON body (`presetId` / `url` / `filePath` / `bytesBase64`) or a
 * raw `application/zip` / `application/octet-stream` upload with
 * `?fileName=&attribution=&indexUrl=` query parameters (no base64 inflation).
 */
import type { Hono } from 'hono';
import { KotoriError, type DictionaryImportSource } from '@kotori/core';
import { ROUTES, okEnvelope } from '../../shared';
import type { ServerContext } from '../context';
import { errorResponse, invoke, mountGroup, wireRequest } from './api';

const RAW_TYPES = new Set(['application/zip', 'application/octet-stream', 'application/x-zip-compressed']);

export function mountDictRoutes(app: Hono, ctx: ServerContext): void {
  const route = ROUTES['dict.importZip'];
  app.post(route.path, async (c) => {
    try {
      const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!RAW_TYPES.has(contentType)) {
        const wire = await wireRequest(c, 'POST');
        return c.json(okEnvelope(await invoke(ctx, 'dict.importZip', wire)));
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length === 0) throw new KotoriError('invalid-argument', 'Upload body is empty');
      const q = c.req.query();
      const source: DictionaryImportSource = {
        bytes,
        ...(q['fileName'] ? { fileName: q['fileName'] } : {}),
        ...(q['attribution'] ? { attribution: q['attribution'] } : {}),
        ...(q['indexUrl'] ? { indexUrl: q['indexUrl'] } : {}),
      };
      return c.json(okEnvelope(await ctx.host.dict.importZip(source)));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  mountGroup(app, ctx, 'dict', new Set(['dict.importZip']));
}
