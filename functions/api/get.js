export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const slug = url.searchParams.get('slug');

    if (!slug) {
        return new Response(
            JSON.stringify({ success: false, error: 'Missing slug parameter' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const raw = await env.MY_KV.get(`post:${slug}`);
    if (!raw) {
        return new Response(
            JSON.stringify({ success: false, error: 'Post not found' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return new Response(
            JSON.stringify({ success: false, error: 'Corrupted post data' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    return new Response(
        JSON.stringify({ success: true, data }),
        {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60'
            }
        }
    );
}
