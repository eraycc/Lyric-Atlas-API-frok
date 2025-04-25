import r from 'fastify';
let e = [
    'ttml',
    'yrc',
    'lrc',
    'eslrc'
], o = [
    'yrc',
    'lrc',
    'eslrc'
], t = (r)=>!!r && e.includes(r), n = (r, e)=>{
    let o = encodeURIComponent(r);
    return `https://raw.githubusercontent.com/Steve-XMH/amll-ttml-db/main/ncm-lyrics/${o}.${e}`;
}, s = process.env.EXTERNAL_NCM_API_URL, a = (r)=>{
    if (!s) throw Error("External API base URL is not configured.");
    return `${s}?id=${encodeURIComponent(r)}`;
}, i = r({
    logger: !0
});
async function f(r, e) {
    let o = n(r, e);
    i.log.info(`Attempting fetch from GitHub repo for ${e.toUpperCase()}: ${o}`);
    try {
        let r = await fetch(o);
        if (r.ok) {
            let o = await r.text();
            return i.log.info(`Repo fetch success for ${e.toUpperCase()} (status: ${r.status})`), {
                status: 'found',
                format: e,
                content: o
            };
        }
        if (404 === r.status) return i.log.info(`Repo fetch resulted in 404 for ${e.toUpperCase()}`), {
            status: 'notfound',
            format: e
        };
        return i.log.error(`Repo fetch failed for ${e.toUpperCase()} with HTTP status ${r.status}`), {
            status: 'error',
            format: e,
            statusCode: r.status,
            error: Error(`HTTP error ${r.status}`)
        };
    } catch (r) {
        return i.log.error(`Network error during repo fetch for ${e.toUpperCase()}`, r), {
            status: 'error',
            format: e,
            error: r instanceof Error ? r : Error('Unknown fetch error')
        };
    }
}
i.get('/api/search', async (r, e)=>{
    let { id: n, fallback: s, fixedVersion: l } = r.query, c = l?.toLowerCase();
    if (!n) return e.code(400).send({
        error: 'Missing id parameter'
    });
    i.log.info(`Processing request for ID: ${n}, fixed: ${c}, fallback: ${s}`);
    try {
        let r;
        if (t(c)) {
            i.log.info(`Handling fixedVersion request for format: ${c}`);
            let r = await f(n, c);
            if ('found' === r.status) return e.send({
                found: !0,
                id: n,
                format: r.format,
                source: 'repository',
                content: r.content
            });
            {
                if ('notfound' === r.status) return e.code(404).send({
                    found: !1,
                    id: n,
                    error: `Lyrics not found for fixed format: ${c}`
                });
                let o = r.statusCode && r.statusCode >= 500 ? 502 : 500;
                return e.code(o).send({
                    error: `Failed to fetch fixed format ${c}: ${r.error.message}`
                });
            }
        }
        i.log.info("Attempting primary format: TTML from repository");
        let l = await f(n, 'ttml');
        if ('found' === l.status) return i.log.info(`Primary format TTML found in repository for ID: ${n}. Returning.`), e.send({
            found: !0,
            id: n,
            format: l.format,
            source: 'repository',
            content: l.content
        });
        if ('error' === l.status) {
            i.log.error(`Error fetching primary format TTML from repository. Failing request. Error: ${l.error.message}`);
            let r = l.statusCode && l.statusCode >= 500 ? 502 : 500;
            return e.code(r).send({
                error: `Failed to fetch primary format TTML: ${l.error.message}`
            });
        }
        for (let a of (i.log.info("Primary format TTML not found (404) in repository. Proceeding to repository fallbacks."), s ? (r = s.split(',').map((r)=>r.trim().toLowerCase()).filter((r)=>t(r) && 'ttml' !== r), 0 === r.length && s.split(',').length > 0 && i.log.warn(`Fallback query provided ("${s}") but resulted in no valid fallback formats after filtering.`)) : r = o, i.log.info(`Checking repository fallback formats in order: ${r.join(', ') || 'None'}`), r)){
            let r = await f(n, a);
            if ('found' === r.status) return i.log.info(`Repository fallback format ${a.toUpperCase()} found for ID: ${n}. Returning.`), e.send({
                found: !0,
                id: n,
                format: r.format,
                source: 'repository',
                content: r.content
            });
            if ('error' === r.status) {
                i.log.error(`Error fetching repository fallback format ${a.toUpperCase()}. Failing request. Error: ${r.error.message}`);
                let o = r.statusCode && r.statusCode >= 500 ? 502 : 500;
                return e.code(o).send({
                    error: `Failed to fetch repository fallback format ${a.toUpperCase()}: ${r.error.message}`
                });
            }
            i.log.info(`Repository fallback format ${a.toUpperCase()} not found (404). Continuing.`);
        }
        i.log.info(`No lyrics found in repository for ID: ${n}. Trying external API fallback.`);
        let u = a(n);
        try {
            let r, o = await fetch(u);
            if (!o.ok) return i.log.error(`External API fetch failed with status: ${o.status} for URL: ${u}`), e.code(502).send({
                found: !1,
                id: n,
                error: `External API fallback failed with status ${o.status}`
            });
            try {
                r = await o.json();
            } catch (r) {
                return i.log.error(`Failed to parse JSON from external API fallback for ID: ${n}`, r), e.code(502).send({
                    found: !1,
                    id: n,
                    error: 'External API fallback returned invalid JSON.'
                });
            }
            if (r?.yrc?.lyric) return i.log.info(`Found YRC lyrics in external API fallback for ID: ${n}. Returning.`), e.send({
                found: !0,
                id: n,
                format: 'yrc',
                source: 'external',
                content: r.yrc.lyric
            });
            if (r?.lrc?.lyric) return i.log.info(`Found LRC lyrics in external API fallback for ID: ${n}. Returning.`), e.send({
                found: !0,
                id: n,
                format: 'lrc',
                source: 'external',
                content: r.lrc.lyric
            });
            return i.log.info(`No usable lyrics (YRC/LRC) found in external API response for ID: ${n}.`), e.code(404).send({
                found: !1,
                id: n,
                error: 'Lyrics not found in repository or external API'
            });
        } catch (o) {
            i.log.error(`Network error during external API fallback fetch for ID: ${n}`, o);
            let r = o instanceof Error ? o.message : 'Unknown external fetch error';
            return e.code(502).send({
                found: !1,
                id: n,
                error: `External API fallback failed: ${r}`
            });
        }
    } catch (o) {
        i.log.error({
            msg: `Unexpected error during handler execution for ID: ${n}`,
            error: o
        });
        let r = o instanceof Error ? o.message : 'Unknown processing error';
        return e.code(500).send({
            error: `Failed to process lyric request: ${r}`
        });
    }
});
let l = async ()=>{
    s || (console.error("FATAL ERROR: Required environment variable EXTERNAL_NCM_API_URL is not set."), process.exit(1)), console.log(`Using external API URL: ${s}`);
    let r = parseInt(process.env.PORT || '3000', 10);
    try {
        await i.listen({
            port: r,
            host: '0.0.0.0'
        });
    } catch (r) {
        i.log.error(r), process.exit(1);
    }
};
export default async function c(r, e) {
    await i.ready(), i.server.emit('request', r, e);
}
process.env.VERCEL || l();

