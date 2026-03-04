'use client';

import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, Loader2, Link2, Check, AlertCircle, XCircle, Music } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<
    'idle' | 'parsing' | 'downloading' | 'combining' | 'converting' | 'done' | 'error'
  >('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [convertLog, setConvertLog] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [finalAudioUrl, setFinalAudioUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState('audio.mp3');
  const [audioFormat, setAudioFormat] = useState<string>('mp3');
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const ffmpegLogRef = useRef<((e: { message: string }) => void) | null>(null);

  const startProcess = async () => {
    if (!url.trim()) return;

    try {
      setStatus('parsing');
      setErrorMsg('');
      setFinalAudioUrl(null);

      const parseRes = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!parseRes.ok) {
        const errData = await parseRes.json();
        throw new Error(errData.error || 'Failed to parse playlist');
      }

      const { segments, isSingleFile, format, isServerStream } = await parseRes.json();

      if (!segments || segments.length === 0) {
        throw new Error('无法从链接中找到音频内容。');
      }

      if (isSingleFile) {
        setStatus('downloading');
        setProgress({ current: 0, total: 1 });

        // Internal API paths (e.g. /api/youtube) are fetched directly; external URLs go through proxy
        const fetchUrl = (isServerStream || segments[0].startsWith('/api/')) ? segments[0] : `/api/proxy?url=${encodeURIComponent(segments[0])}`;
        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

        // Detect actual format from Content-Type header
        const ct = res.headers.get('Content-Type') || '';
        let detectedExt = format || 'm4a';
        if (ct.includes('audio/mpeg') || ct.includes('mp3')) detectedExt = 'mp3';
        else if (ct.includes('audio/mp4') || ct.includes('m4a') || ct.includes('aac')) detectedExt = 'm4a';
        else if (ct.includes('video/mp4') || ct.includes('mpeg4')) detectedExt = 'mp4';
        // If server explicitly said mp3/mp4/webm, trust that over Content-Type
        if (format === 'mp3') detectedExt = 'mp3';
        if (format === 'mp4') detectedExt = 'mp4';
        if (format === 'webm' || ct.includes('audio/webm') || ct.includes('video/webm')) detectedExt = 'webm';

        const buf = await res.arrayBuffer();
        setProgress({ current: 1, total: 1 });

        // MP4 video → convert to MP3 via ffmpeg.wasm
        if (detectedExt === 'mp4') {
          setAudioFormat('mp3');
          setStatus('converting');

          try {
            setConvertLog('正在加载转换引擎（约20MB，仅首次需要）...');
            if (!ffmpegRef.current) ffmpegRef.current = new FFmpeg();
            const ffmpeg = ffmpegRef.current;

            if (!ffmpeg.loaded) {
              const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
              await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
              });
            }

            const logHandler = ({ message }: { message: string }) => setConvertLog(message);
            if (ffmpegLogRef.current) ffmpeg.off('log', ffmpegLogRef.current);
            ffmpegLogRef.current = logHandler;
            ffmpeg.on('log', logHandler);

            setConvertLog('写入视频文件...');
            await ffmpeg.writeFile('input.mp4', new Uint8Array(buf));

            setConvertLog('提取音频轨道并编码为 MP3...');
            await ffmpeg.exec(['-i', 'input.mp4', '-vn', '-acodec', 'libmp3lame', '-q:a', '2', 'output.mp3']);

            const mp3Data = await ffmpeg.readFile('output.mp3') as Uint8Array;
            await ffmpeg.deleteFile('input.mp4').catch(() => { });
            await ffmpeg.deleteFile('output.mp3').catch(() => { });

            setFinalAudioUrl(URL.createObjectURL(new Blob([mp3Data.buffer as ArrayBuffer], { type: 'audio/mpeg' })));
            setStatus('done');
            return;
          } catch (ffmpegErr) {
            // Conversion failed — fall back to saving raw MP4
            console.warn('ffmpeg conversion failed, falling back to MP4:', ffmpegErr);
            setConvertLog('转换失败，将直接保存视频...');
            setAudioFormat('mp4');
            setFinalAudioUrl(URL.createObjectURL(new Blob([buf], { type: 'video/mp4' })));
            setStatus('done');
            return;
          }
        }

        // Audio file (mp3 / m4a / webm) → use directly
        const mimeMap: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm' };
        const mime = mimeMap[detectedExt] || ct || 'audio/mp4';
        setAudioFormat(detectedExt);
        setStatus('combining');
        setFinalAudioUrl(URL.createObjectURL(new Blob([buf], { type: mime })));
        setStatus('done');
        return;
      }


      setAudioFormat('mp3');

      setStatus('downloading');
      setProgress({ current: 0, total: segments.length });

      const segmentBuffers: ArrayBuffer[] = [];
      const concurrency = 5;
      for (let i = 0; i < segments.length; i += concurrency) {
        const batch = segments.slice(i, i + concurrency);
        const batchPromises = batch.map(async (segmentUrl: string) => {
          const proxiedUrl = `/api/proxy?url=${encodeURIComponent(segmentUrl)}`;
          const res = await fetch(proxiedUrl);
          if (!res.ok) throw new Error(`Status ${res.status}: Failed to fetch segment`);
          const buf = await res.arrayBuffer();
          return buf;
        });

        const batchResults = await Promise.all(batchPromises);
        segmentBuffers.push(...batchResults);

        setProgress(prev => ({ ...prev, current: Math.min(prev.current + concurrency, segments.length) }));
      }

      setStatus('combining');
      // TS segments are video/mp2t; aac segments are audio/aac
      // Use octet-stream so download is driven by file extension, not MIME
      const finalBlob = new Blob(segmentBuffers, { type: 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(finalBlob);

      setFinalAudioUrl(objectUrl);
      setStatus('done');
    } catch (err: unknown) {
      let message = '发生未知错误';
      if (err instanceof Error) message = err.message;
      else if (typeof err === 'string') message = err;
      else if (typeof err === 'number') message = `操作失败 (退出码: ${err})`;
      else if (err && typeof err === 'object' && 'message' in err) message = String((err as { message: unknown }).message);
      console.error('Extraction error:', err);
      setErrorMsg(message);
      setStatus('error');
    }
  };


  const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const easeOvershoot = [0.16, 1, 0.3, 1] as const;

  return (
    <main className="min-h-screen bg-[#f5f5f7] text-[#1d1d1f] font-sans selection:bg-[#2997ff] selection:text-white flex flex-col items-center justify-center p-6 lg:p-12 relative overflow-hidden">

      {/* Subtle Background Glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-[radial-gradient(ellipse,rgba(41,151,255,0.12)_0%,transparent_70%)] pointer-events-none -z-10" />

      <div className="w-full max-w-4xl flex flex-col items-center">

        {/* Header Section */}
        <div className="text-center mb-16">
          {/* Label */}
          <motion.h2
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.9, ease: easeOvershoot }}
            className="text-sm md:text-base font-semibold tracking-[0.2em] text-[#2997ff] uppercase mb-4"
          >
            AudioExtractor Pro
          </motion.h2>

          {/* Headline lines */}
          <motion.h1
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 1, ease: easeOvershoot, delay: 0.1 }}
            className="text-6xl md:text-8xl lg:text-9xl font-bold tracking-tighter text-[#1d1d1f] pb-2"
          >
            提取音频。
          </motion.h1>
          <motion.h1
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 1, ease: easeOvershoot, delay: 0.2 }}
            className="text-6xl md:text-8xl lg:text-9xl font-bold tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-[#2997ff] to-[#0071e3] pb-2"
          >
            从未如此Pro。
          </motion.h1>

          {/* Subtitle */}
          <motion.p
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.9, ease: easeOvershoot, delay: 0.35 }}
            className="text-xl md:text-2xl text-[#6e6e73] max-w-2xl mx-auto font-medium tracking-tight leading-relaxed mt-8"
          >
            支持直接粘贴 SoundCloud、汽水音乐、抖音视频分享链接，以及 m3u8 播放列表网址，即可完成音频解析和下载。
          </motion.p>
        </div>

        {/* Input & Action Area */}
        <motion.div
          initial={{ y: 40, opacity: 0, scale: 0.95 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: easeOvershoot, delay: 0.3 }}
          className="w-full max-w-2xl relative z-10"
        >
          <div className="relative flex flex-col sm:flex-row items-center bg-white/80 backdrop-blur-3xl hover:bg-white transition-all rounded-[2.5rem] sm:rounded-full p-2 border border-black/10 shadow-xl focus-within:ring-2 focus-within:ring-[#2997ff] focus-within:border-transparent">
            <div className="hidden sm:flex pl-6 pointer-events-none text-[#6e6e73]">
              <Link2 className="w-6 h-6" />
            </div>
            <div className="relative w-full sm:flex-1">
              <input
                type="text"
                placeholder=""
                className="w-full bg-transparent border-none py-5 pl-6 pr-14 sm:pl-4 sm:pr-14 text-lg md:text-xl text-[#1d1d1f] placeholder-[#6e6e73] focus:outline-none focus:ring-0 font-medium"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoComplete="off"
                spellCheck="false"
              />
              <AnimatePresence>
                {url && (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.2 }}
                    onClick={() => setUrl('')}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-[#6e6e73] hover:text-[#1d1d1f] transition-colors"
                    aria-label="清除链接"
                  >
                    <XCircle className="w-6 h-6" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
            <button
              onClick={startProcess}
              disabled={!url.trim() || status === 'parsing' || status === 'downloading' || status === 'combining' || status === 'converting'}
              className="w-full sm:w-auto mt-2 sm:mt-0 px-10 py-5 rounded-full font-semibold text-xl bg-[#2997ff] text-white hover:bg-[#0077ed] disabled:bg-[#d1d1d6] disabled:text-white transition-all flex items-center justify-center space-x-2 shrink-0 active:scale-95"
            >
              {status === 'idle' || status === 'done' || status === 'error' ? (
                <span>提取音频</span>
              ) : (
                <>
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <span>处理中</span>
                </>
              )}
            </button>
          </div>
        </motion.div>

        {/* Status Area */}
        <div className="w-full max-w-2xl mt-8">
          <AnimatePresence mode="popLayout">
            {status !== 'idle' && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.5, ease: easeOvershoot }}
                className="bg-white/90 backdrop-blur-xl rounded-[2.5rem] p-8 md:p-12 border border-black/8 shadow-xl"
              >
                {/* State: Parsing */}
                {status === 'parsing' && (
                  <div className="flex flex-col items-center justify-center space-y-6 py-8">
                    <Loader2 className="w-12 h-12 animate-spin text-[#2997ff]" />
                    <span className="text-2xl font-medium text-[#1d1d1f] tracking-tight">正在极速解析播放列表...</span>
                  </div>
                )}

                {/* State: Error */}
                {status === 'error' && (
                  <div className="flex flex-col items-center justify-center space-y-4 py-6 text-center">
                    <div className="w-20 h-20 rounded-full bg-red-500/10 flex items-center justify-center mb-2">
                      <AlertCircle className="w-10 h-10 text-red-500" />
                    </div>
                    <span className="text-3xl font-semibold text-[#1d1d1f] tracking-tight">提取未能完成。</span>
                    <p className="text-lg text-[#6e6e73] font-medium break-all max-w-lg mt-2">
                      {errorMsg}
                    </p>
                  </div>
                )}

                {/* State: Converting MP4 → MP3 */}
                {status === 'converting' && (
                  <div className="flex flex-col items-center justify-center space-y-6 py-8">
                    <div className="w-20 h-20 rounded-full bg-[#2997ff]/10 flex items-center justify-center">
                      <Music className="w-10 h-10 text-[#2997ff] animate-pulse" />
                    </div>
                    <span className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">正在提取音频...</span>
                    <p className="text-sm text-[#6e6e73] font-mono text-center max-w-md break-all leading-relaxed">{convertLog}</p>
                  </div>
                )}

                {/* State: Downloading/Combining */}
                {(status === 'downloading' || status === 'combining') && (
                  <div className="space-y-8 py-6">
                    <div className="flex items-end justify-between">
                      <span className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">
                        {status === 'downloading' ? '正在下载高质量切片' : '正在合成最终音频'}
                      </span>
                      <span className="text-5xl font-bold text-[#1d1d1f] tracking-tighter">{percentage}%</span>
                    </div>

                    <div className="h-3 w-full bg-[#e5e5ea] rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-[#2997ff] to-[#58a9ff]"
                        initial={{ width: 0 }}
                        animate={{ width: `${percentage}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>

                    <div className="text-base text-[#6e6e73] font-medium flex justify-between tracking-tight">
                      <span>处理进度</span>
                      <span>已完成 {progress.current} / {progress.total}</span>
                    </div>
                  </div>
                )}

                {/* State: Done */}
                {status === 'done' && finalAudioUrl && (
                  <div className="space-y-10 py-6 flex flex-col items-center text-center">
                    <div className="relative">
                      <div className="absolute inset-0 bg-[#2997ff] blur-2xl opacity-20 rounded-full"></div>
                      <div className="w-24 h-24 rounded-full bg-[#2997ff]/10 flex items-center justify-center relative z-10 ring-1 ring-[#2997ff]/50">
                        <Check className="w-12 h-12 text-[#2997ff]" />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h3 className="text-4xl font-bold text-[#1d1d1f] tracking-tight">大功告成。</h3>
                      <p className="text-[#6e6e73] text-xl font-medium tracking-tight">您的音频已完美重构并准备就绪。</p>
                    </div>

                    <div className="w-full bg-[#f5f5f7] p-6 rounded-3xl border border-black/8 shadow-inner">
                      <audio
                        controls
                        controlsList="nodownload nofullscreen"
                        src={finalAudioUrl ?? undefined}
                        className="w-full h-14"
                      />
                    </div>

                    <button
                      onClick={() => {
                        if (!finalAudioUrl) return;
                        const ext = audioFormat || 'mp3';
                        const a = document.createElement('a');
                        a.href = finalAudioUrl;
                        a.download = `audio_${Date.now()}.${ext}`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                      }}
                      className="w-full py-5 bg-[#2997ff] hover:bg-[#0077ED] text-white rounded-full font-semibold text-2xl transition-all active:scale-95 flex items-center justify-center space-x-3 shadow-[0_0_40px_rgba(41,151,255,0.3)] hover:shadow-[0_0_60px_rgba(41,151,255,0.4)]"
                    >
                      <Download className="w-6 h-6" />
                      <span>保存至本地设备</span>
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 1 }}
          className="text-center text-[#6e6e73] text-sm mt-20 max-w-lg font-medium"
        >
          注意：此工具仅用于学习交流，请勿用于下载受限制的内容。
        </motion.p>
      </div>
    </main>
  );
}
