import { corsHeaders, json } from './lib.js';
import { route } from './router.js';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    const isGichulRequest = new URL(request.url).pathname.startsWith('/api/gichul/');
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: isGichulRequest ? { ...cors, 'cache-control': 'no-store' } : cors,
      });
    }

    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) headers.set(name, value);
      if (isGichulRequest) headers.set('cache-control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      // 내부 예외는 Worker 로그에만 남기고 SQL·환경 정보는 클라이언트에 노출하지 않는다.
      console.error('unhandled_request_error', error);
      return json(
        { error: '서버 오류' },
        500,
        isGichulRequest ? { ...cors, 'cache-control': 'no-store' } : cors,
      );
    }
  },
};
