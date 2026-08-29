var lichess = require('./_lichess.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var body = await lichess.readJsonBody(req);
        var code = (body.code || '').toString();
        var verifier = (body.verifier || '').toString();
        var redirectUri = (body.redirectUri || '').toString();

        if (!code || !verifier || !redirectUri) {
            return lichess.sendJson(res, 400, { error: 'bad_request' });
        }

        var tokenData = await lichess.exchangeCodeForToken(code, verifier, redirectUri);
        var accessToken = tokenData.access_token;

        var accountRes = await lichess.lichessFetch(accessToken, '/api/account');
        if (!accountRes.ok) {
            return lichess.sendJson(res, 502, { error: 'lichess_account_fetch_failed', status: accountRes.status, detail: accountRes.data });
        }
        var account = accountRes.data;

        var sessionToken = lichess.randomSessionToken();
        await lichess.saveSession(sessionToken, {
            accessToken: accessToken,
            username: account.username,
            createdAt: Date.now()
        });

        return lichess.sendJson(res, 200, {
            sessionToken: sessionToken,
            username: account.username,
            perfs: account.perfs || {}
        });
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
