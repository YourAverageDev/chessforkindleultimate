var lichess = require('./_lichess.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var auth = await lichess.requireSession(req);
        if (auth) {
            /* Best-effort token revocation - if this endpoint/shape turns
             * out to be wrong, logging out of *this app* still works fine
             * either way since we delete our own session regardless. */
            try {
                await lichess.lichessFetch(auth.session.accessToken, '/api/token', { method: 'DELETE' });
            } catch (e) { /* ignore - not critical */ }
            await lichess.deleteSession(auth.token);
        }
        return lichess.sendJson(res, 200, { ok: true });
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
