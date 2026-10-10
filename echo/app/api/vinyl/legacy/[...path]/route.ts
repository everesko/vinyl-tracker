import { handle } from '@/lib/server/http';
import { legacyVinylRequest } from '@/lib/server/vinyl';

type Context = { params: Promise<{ path: string[] }> };
async function request(request: Request, context: Context) {
  return handle(async () => legacyVinylRequest(request, (await context.params).path));
}
export { request as GET, request as HEAD, request as POST, request as DELETE };
