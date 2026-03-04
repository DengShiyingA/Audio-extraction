import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const url = searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    const tmpFile = join(tmpdir(), `yt-${Date.now()}.webm`);

    try {
        await execAsync(
            `yt-dlp --format "bestaudio" --no-playlist -o "${tmpFile}" "${url}"`,
            { timeout: 120000 }
        );

        const data = await readFile(tmpFile);
        unlink(tmpFile).catch(() => {});

        return new Response(data, {
            headers: {
                'Content-Type': 'audio/webm',
                'Content-Disposition': 'attachment; filename="audio.webm"',
                'Content-Length': String(data.length),
            },
        });
    } catch (err: unknown) {
        unlink(tmpFile).catch(() => {});
        const message = err instanceof Error ? err.message : '下载失败';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
