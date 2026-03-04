import { NextResponse } from 'next/server';

let cachedClientId: string | null = null;
let clientIdTime: number = 0;

async function getClientId() {
    // Use cached client ID for up to 12 hours
    if (cachedClientId && Date.now() - clientIdTime < 12 * 60 * 60 * 1000) {
        return cachedClientId;
    }

    try {
        const res = await fetch('https://soundcloud.com/');
        const html = await res.text();
        const scriptRegex = /<script[^>]+src="([^"]+)"/g;
        let match;
        const scriptUrls = [];
        while ((match = scriptRegex.exec(html)) !== null) {
            if (match[1].includes('sndcdn.com')) {
                scriptUrls.push(match[1]);
            }
        }
        // Fetch all scripts in parallel (last ones most likely to have client_id)
        const results = await Promise.all(
            scriptUrls.slice(-5).map(u => fetch(u).then(r => r.text()).catch(() => ''))
        );
        for (let i = results.length - 1; i >= 0; i--) {
            const clientMatch = results[i].match(/client_id:"([A-Za-z0-9_-]{32})/);
            if (clientMatch) {
                cachedClientId = clientMatch[1];
                clientIdTime = Date.now();
                return cachedClientId;
            }
        }
    } catch (error) {
        console.error('Failed to get client_id', error);
    }

    // High probability fallback
    return '1IzwHiVxAHeYKAMqN0IIGD3ZARgJy2kl';
}

export async function POST(req: Request) {
    try {
        const { url: rawInput } = await req.json();
        if (!rawInput) {
            return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        }

        // Extract URL from pasted share text (e.g. "《歌名》@汽水音乐 https://qishui.douyin.com/s/xxx/")
        const urlMatch = rawInput.match(/https?:\/\/[^\s，。]+/);
        let url = urlMatch ? urlMatch[0].trim().replace(/\/$/, '') : rawInput.trim();

        // Follow short-link redirects for qishui.douyin.com/s/ URLs
        if (url.includes('qishui.douyin.com/s/') || url.includes('qishui.douyin.com/s')) {
            const redirectRes = await fetch(url, {
                method: 'GET',
                redirect: 'manual',
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            url = redirectRes.headers.get('location') || redirectRes.url || url;
        }

        let m3u8Url = url;

        // SC URL RESOLUTION
        if (url.includes('soundcloud.com')) {
            const clientId = await getClientId();
            const resolveUrl = `https://api-widget.soundcloud.com/resolve?url=${encodeURIComponent(url)}&format=json&client_id=${clientId}`;

            const resolveRes = await fetch(resolveUrl);
            if (!resolveRes.ok) {
                throw new Error(`Failed to resolve SoundCloud URL: ${resolveRes.statusText}`);
            }
            const trackData = await resolveRes.json();

            let transcodings = [];
            if (trackData.media && trackData.media.transcodings) {
                transcodings = trackData.media.transcodings;
            } else if (trackData.tracks && trackData.tracks[0]?.media?.transcodings) {
                // If a playlist URL was pasted, take first track
                transcodings = trackData.tracks[0].media.transcodings;
            } else {
                throw new Error('No media streams found in resolved SoundCloud track.');
            }

            // Prioritize HLS but specifically avoid 'audio/mpegurl' which sometimes 404s on widgets
            let target = transcodings.find((t: any) => t.format.protocol === 'hls' && t.format.mime_type === 'audio/mpeg');
            if (!target) {
                target = transcodings.find((t: any) => t.format.protocol === 'hls' && t.format.mime_type.includes('audio/mp4'));
            }
            if (!target) {
                target = transcodings.find((t: any) => t.format.protocol === 'hls');
            }
            if (!target) {
                target = transcodings[0];
            }

            if (!target || !target.url) {
                throw new Error('Could not find suitable audio stream from SoundCloud.');
            }

            let reqUrl = target.url + '?client_id=' + clientId;
            console.log('Fetching stream URL:', reqUrl);

            const streamRes = await fetch(reqUrl);
            if (!streamRes.ok) {
                const text = await streamRes.text();
                throw new Error(`Failed to get M3U8 payload from SoundCloud stream endpoint: ${streamRes.status} ${streamRes.statusText} - ${text}`);
            }
            const streamData = await streamRes.json();

            if (!streamData.url) {
                throw new Error('Could not get actual M3U8 URL from SoundCloud.');
            }

            m3u8Url = streamData.url;
        } else if (url.includes('music.douyin.com/qishui') || url.includes('douyinvod.com')) {
            // Qishui Music (Douyin Music) URL RESOLUTION
            let qishuiUrl = url;

            if (url.includes('music.douyin.com/qishui')) {
                const res = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
                    }
                });
                const html = await res.text();

                const regex = /_ROUTER_DATA = ({[\s\S]*?});?\n/;
                const match = html.match(regex);

                if (!match) {
                    throw new Error('Failed to parse qishui HTML for routing data');
                }

                const data = JSON.parse(match[1]);
                const trackPage = data.loaderData.track_page;

                if (!trackPage || !trackPage.audioWithLyricsOption || !trackPage.audioWithLyricsOption.url) {
                    throw new Error('Could not find audio streaming URL in qishui payload');
                }

                qishuiUrl = trackPage.audioWithLyricsOption.url;
            }

            // Qishui gives us an MP4/M4A video/audio stream URL, not an M3U8 list.
            // So we can just return this directly as a segment of 1.
            return NextResponse.json({ segments: [qishuiUrl], raw: qishuiUrl, isSingleFile: true });
        } else if (url.includes('v.douyin.com') || url.includes('douyin.com/video/') || url.includes('douyin.com/share/video') || url.includes('douyin.com/share/music') || url.includes('iesdouyin.com/share/video') || url.includes('iesdouyin.com/share/music')) {
            const fetchWithTimeout = (u: string, opts: RequestInit = {}, ms = 10000) => {
                const ctrl = new AbortController();
                setTimeout(() => ctrl.abort(), ms);
                return fetch(u, { ...opts, signal: ctrl.signal });
            };
            const douyinUA = 'com.ss.android.ugc.aweme/110101 (Linux; U; Android 10; en_US; Pixel 4; Build/QQ3A.200805.001; Cronet/TTNetVersion:6c7b701a 2020-07-28 QuicVersion:0144d358 2020-03-27)';

            let resolvedUrl = url;

            // Follow short-link redirect — use manual mode to only read Location header (faster)
            if (url.includes('v.douyin.com')) {
                const redirectRes = await fetchWithTimeout(url, {
                    method: 'GET',
                    redirect: 'manual',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                    }
                });
                resolvedUrl = redirectRes.headers.get('location') || url;
            }

            // Handle music page links (share/music/)
            const musicIdMatch = resolvedUrl.match(/share\/music\/(\d+)/);
            if (musicIdMatch) {
                const musicId = musicIdMatch[1];
                const musicApiUrl = `https://api.amemv.com/aweme/v1/music/detail/?music_id=${musicId}&version_code=110101&version_name=11.1.0`;
                const musicRes = await fetchWithTimeout(musicApiUrl, { headers: { 'User-Agent': douyinUA } });
                if (musicRes.ok) {
                    const musicData = await musicRes.json();
                    const musicUrls: string[] = musicData?.music_info?.play_url?.url_list ?? [];
                    const musicUrl = musicUrls.find((u: string) => u.startsWith('http'));
                    if (musicUrl) {
                        return NextResponse.json({ segments: [musicUrl], raw: musicUrl, isSingleFile: true, format: 'mp3' });
                    }
                }
                throw new Error('无法获取该抖音音乐的下载链接。');
            }

            // Extract video ID
            const videoIdMatch = resolvedUrl.match(/video\/(\d+)/) ||
                resolvedUrl.match(/aweme_id=(\d+)/) ||
                resolvedUrl.match(/\/(\d{15,19})\//);
            if (!videoIdMatch) {
                throw new Error(`无法解析抖音视频ID，实际地址：${resolvedUrl}`);
            }
            const videoId = videoIdMatch[1];

            // Use Douyin mobile API to get music info directly
            const mobileApiUrl = `https://api.amemv.com/aweme/v1/feed/?aweme_id=${videoId}&version_code=110101&version_name=11.1.0`;
            const apiRes = await fetchWithTimeout(mobileApiUrl, { headers: { 'User-Agent': douyinUA } });
            if (apiRes.ok) {
                const apiData = await apiRes.json();
                const aweme = apiData?.aweme_list?.[0];
                const musicUrls: string[] = aweme?.music?.play_url?.url_list ?? [];
                const musicUrl = musicUrls.find((u: string) => u.startsWith('http'));
                if (musicUrl) {
                    return NextResponse.json({ segments: [musicUrl], raw: musicUrl, isSingleFile: true, format: 'mp3' });
                }
            }

            throw new Error('无法从该抖音视频中提取音乐，该视频可能没有背景音乐、已删除或设为私密。');

        }


        // Standard M3U8 Fetching
        const response = await fetch(m3u8Url);
        if (!response.ok) {
            throw new Error(`Failed to fetch m3u8: ${response.status} ${response.statusText}`);
        }

        const text = await response.text();

        // Check if it's a playlist of playlists (master playlist)
        if (text.includes('#EXT-X-STREAM-INF')) {
            // Just grab the first stream and fetch it instead
            const lines = text.split('\n');
            for (const line of lines) {
                if (line && !line.startsWith('#')) {
                    const nestedUrl = line.startsWith('http') ? line : m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1) + line;
                    const nestedRes = await fetch(nestedUrl);
                    const nestedText = await nestedRes.text();
                    return parseSegments(nestedText, nestedUrl);
                }
            }
        }

        return parseSegments(text, m3u8Url);

    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

function parseSegments(text: string, sourceUrl: string) {
    const lines = text.split('\n');
    const segments: string[] = [];
    const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1);

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
            if (trimmedLine.startsWith('http')) {
                segments.push(trimmedLine);
            } else {
                segments.push(baseUrl + trimmedLine);
            }
        }
    }
    return NextResponse.json({ segments, raw: text });
}
