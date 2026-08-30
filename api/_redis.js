/* _redis.js - thin wrapper around Upstash Redis's REST API (no npm dependency
 * at all - just Node's built-in global fetch, available on Vercel's Node 18+
 * runtime). Works with either the "Vercel KV" quick-create flow (env vars
 * KV_REST_API_URL / KV_REST_API_TOKEN) or a directly-connected Upstash Redis
 * integration (UPSTASH_REDIS_REST_URL / _TOKEN) - whichever is present in the
 * project's environment variables is used. Shared by every API route in this
 * project that needs storage (api/_room.js for room-code play, api/uc/_uc.js
 * for Ultimate Chess Matchmaking).
 */

function getCreds() {
    var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
        throw new Error('No KV store configured. Add "Vercel KV" (or an Upstash Redis integration) to this project in the Vercel dashboard Storage tab.');
    }
    return { url: url, token: token };
}

async function redisCommand(commandArray) {
    var creds = getCreds();
    var res = await fetch(creds.url, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + creds.token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(commandArray)
    });
    var data = await res.json();
    if (data.error) { throw new Error('KV error: ' + data.error); }
    return data.result;
}

module.exports = {
    redisCommand: redisCommand
};
