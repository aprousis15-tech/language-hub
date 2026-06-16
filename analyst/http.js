// analyst/http.js — a tiny zero-dependency HTTPS+JSON helper.
//
// Why hand-rolled instead of `fetch` or an SDK:
//   - Your local Node is 17.x, which doesn't ship a global `fetch` (that
//     landed in Node 18). Rather than force an `npm install`, we use the
//     built-in `https` module — so this whole tool runs with ZERO installed
//     dependencies. Nothing to install, nothing to break, nothing to pay for.
//   - It also keeps the agent provider-agnostic: the same helper talks to
//     Groq (the model) and Supabase (the data) — both are just HTTPS + JSON.

const https = require('https');

/**
 * Make an HTTPS request and parse the JSON body.
 * @returns {Promise<{status:number, json:any, text:string, headers:object}>}
 */
function httpJson(method, urlStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', ...headers },
    };
    if (data) opts.headers['content-length'] = Buffer.byteLength(data);

    const req = https.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, text: chunks, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { httpJson };
