import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../agent/server.ts';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
  maxDuration: 300,
};

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  return handleRequest(req, res);
}
