import { NextResponse } from 'next/server';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const targetUrl = searchParams.get('url');

    if (!targetUrl) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    // If the URL is a relative internal path (e.g. /api/youtube?url=...), call localhost directly
    const resolvedUrl = targetUrl.startsWith('/')
        ? `http://localhost:${process.env.PORT || 3000}${targetUrl}`
        : targetUrl;

    try {
        const response = await fetch(resolvedUrl, { redirect: 'follow' });

        if (!response.ok) {
            throw new Error(`Failed to fetch segment: ${response.statusText}`);
        }

        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
        const headers: Record<string, string> = {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000',
        };
        const contentLength = response.headers.get('Content-Length');
        if (contentLength) headers['Content-Length'] = contentLength;

        // Pass back the binary stream
        return new Response(response.body, {
            status: response.status,
            headers,
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
