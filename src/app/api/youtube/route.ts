import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export const maxDuration = 300; // 5 minutes

const execAsync = promisify(exec);

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const url = searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    const tmpBase = join(tmpdir(), `yt-${Date.now()}`);
    const tmpMp3 = `${tmpBase}.mp3`;

    try {
        const { stderr } = await execAsync(
            `yt-dlp --format "bestaudio" --no-playlist --extract-audio --audio-format mp3 --audio-quality 0 -o "${tmpBase}.%(ext)s" "${url}"`,
            { timeout: 180000 }
        );
        if (stderr) console.error('[yt-dlp stderr]', stderr.slice(0, 500));

        const data = await readFile(tmpMp3);
        unlink(tmpMp3).catch(() => {});

        return new Response(data, {
            headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Disposition': 'attachment; filename="audio.mp3"',
                'Content-Length': String(data.length),
            },
        });
    } catch (err: unknown) {
        unlink(tmpMp3).catch(() => {});
        const message = err instanceof Error ? err.message : '下载失败';
        console.error('[youtube API error]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
