var lichess = require('./_lichess.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var auth = await lichess.requireSession(req);
        if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

        var accountRes = await lichess.lichessFetch(auth.session.accessToken, '/api/account');
        if (!accountRes.ok) {
            return lichess.sendJson(res, 502, { error: 'lichess_account_fetch_failed', status: accountRes.status });
        }

        return lichess.sendJson(res, 200, {
            username: accountRes.data.username,
            perfs: accountRes.data.perfs || {}
        });
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
