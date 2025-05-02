import { Hono as o } from 'hono';
import { cors as e } from 'hono/cors';
import { searchLyrics as r } from './lyricService.js';
let n = process.env.EXTERNAL_NCM_API_URL;
n || console.error("FATAL ERROR: Required environment variable EXTERNAL_NCM_API_URL is not set.");
let s = new o(), t = {
    info: (...o)=>console.info(...o),
    warn: (...o)=>console.warn(...o),
    error: (...o)=>console.error(...o),
    debug: (...o)=>console.debug ? console.debug(...o) : console.log('[DEBUG]', ...o)
};
s.use('/api/*', e({
    origin: '*',
    allowMethods: [
        'GET',
        'OPTIONS'
    ],
    allowHeaders: [
        'Content-Type',
        'Authorization'
    ],
    exposeHeaders: [
        'Content-Range',
        'X-Content-Range'
    ],
    maxAge: 86400,
    credentials: !0
})), s.get('/api/search', async (o)=>{
    let e = o.req.query('id'), s = o.req.query('fallback'), l = o.req.query('fixedVersion');
    if (!n) return console.error("RUNTIME ERROR: EXTERNAL_NCM_API_URL is not set."), o.status(500), o.json({
        found: !1,
        id: e,
        error: 'Server configuration error.'
    });
    if (!e) return o.status(400), o.json({
        found: !1,
        error: 'Missing id parameter'
    });
    console.log(`Hono API: Received request for ID: ${e}, fixed: ${l}, fallback: ${s}`);
    try {
        let n = await r(e, {
            fixedVersion: l,
            fallback: s,
            logger: t
        });
        if (n.found) return console.log(`Hono API: Found lyrics for ID: ${e}, Format: ${n.format}, Source: ${n.source}`), o.json(n);
        {
            let r = n.statusCode || 404;
            return console.log(`Hono API: Lyrics not found or error for ID: ${e}. Status: ${r}, Error: ${n.error}`), o.status(r), o.json(n);
        }
    } catch (n) {
        console.error({
            msg: `Unexpected error during API handler execution for ID: ${e}`,
            error: n
        });
        let r = n instanceof Error ? n.message : 'Unknown processing error';
        return o.status(500), o.json({
            found: !1,
            id: e,
            error: `Failed to process lyric request: ${r}`
        });
    }
});
export default s;
import { serve as l } from '@hono/node-server';
if ('production' !== process.env.NODE_ENV && !process.env.VERCEL) {
    console.log(`Using external API URL: ${n}`);
    let o = parseInt(process.env.PORT || '3000', 10), e = l({
        fetch: s.fetch,
        port: o
    }, (o)=>{
        console.log(`Server is running on http://localhost:${o.port}`);
    });
    process.on('SIGINT', ()=>{
        console.log('\nGracefully shutting down...'), e.close(()=>{
            console.log('Server closed.'), process.exit(0);
        });
    });
}

