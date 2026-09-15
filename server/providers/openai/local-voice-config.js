import { GEV_REALTIME_TOOLS } from './tools.js';

/**
 * GET /api/voice/local-config
 * The same described function tools the Realtime session receives, plus
 * whether an OpenAI key is configured. Never exposes the key itself.
 */
function createLocalVoiceConfigHandler({
  resolveApiKey = () => process.env.OPENAI_API_KEY,
  tools = GEV_REALTIME_TOOLS,
} = {}) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        openaiConfigured: Boolean(resolveApiKey()),
        tools,
      }),
    );
  };
}

export { createLocalVoiceConfigHandler };
