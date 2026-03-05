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
    const direct = searchParams.get('direct') === '1';
    const cookiesParam = searchParams.get('cookies'); // e.g. 'qq' → /root/cookies/qq.txt

    if (!url) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    const tmpBase = join(tmpdir(), `yt-${Date.now()}`);
    const tmpMp3 = `${tmpBase}.mp3`;

    try {
        if (direct) {
            // Direct URL (e.g. Kuaishou mp4): download with ffmpeg and extract audio
            const tmpInput = `${tmpBase}.mp4`;
            await execAsync(
                `curl -sL -o "${tmpInput}" --referer "https://www.kuaishou.com/" "${url}"`,
                { timeout: 120000 }
            );
            await execAsync(
                `ffmpeg -i "${tmpInput}" -vn -acodec libmp3lame -q:a 2 "${tmpMp3}"`,
                { timeout: 120000 }
            );
            unlink(tmpInput).catch(() => {});
        } else {
            // yt-dlp based extraction (YouTube, Netease, QQ Music, etc.)
            const cookiesFlag = cookiesParam ? `--cookies /root/cookies/${cookiesParam}.txt` : '';
            const { stderr } = await execAsync(
                `yt-dlp ${cookiesFlag} --format "bestaudio" --no-playlist -o "${tmpBase}.%(ext)s" "${url}"`,
                { timeout: 120000 }
            );
            if (stderr) console.error('[yt-dlp stderr]', stderr.slice(0, 500));

            // Find the output file (extension varies by platform)
            const { stdout: lsOut } = await execAsync(`ls "${tmpBase}."* 2>/dev/null || true`);
            const outFile = lsOut.trim().split('\n')[0];
            if (!outFile) throw new Error('yt-dlp did not produce an output file');

            const ext = outFile.split('.').pop() || 'webm';
            const mimeMap: Record<string, string> = {
                webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4',
                mp3: 'audio/mpeg', ogg: 'audio/ogg',
            };

            // Stream the file to the client
            const { createReadStream } = await import('fs');
            const { stat } = await import('fs/promises');
            const fileSize = (await stat(outFile)).size;
            const stream = createReadStream(outFile);
            const nodeStream = stream as unknown as ReadableStream;

            // Clean up after stream ends
            stream.on('close', () => unlink(outFile).catch(() => {}));

            return new Response(nodeStream, {
                headers: {
                    'Content-Type': mimeMap[ext] || 'audio/webm',
                    'Content-Disposition': `attachment; filename="audio.${ext}"`,
                    'Content-Length': String(fileSize),
                    'Accept-Ranges': 'bytes',
                },
            });
        }

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
