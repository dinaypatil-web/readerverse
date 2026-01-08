import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Play, Pause, SkipForward, SkipBack, Settings, X, Check, 
  List, Loader2, BookOpen, Trash2, Plus, Clock, Info, AlertCircle, 
  Zap, ZoomIn, ZoomOut, Maximize2, FileText, Headphones, Bookmark, Cpu, ChevronRight, Volume2, Globe
} from 'lucide-react';
import e from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import { GoogleGenAI, Modality } from "@google/genai";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.mjs`;

// --- Types ---
interface ChapterEntry {
  title: string;
  startIndex: number;
  pageNumber?: number;
}

interface TextBlock {
  words: string[];
  wordStartIndex: number;
  wordCount: number;
}

interface Book {
  id: string;
  title: string;
  author: string;
  displayBlocks: TextBlock[];
  chapters: ChapterEntry[];
  type: 'epub' | 'pdf' | 'txt' | 'demo';
  fileData?: ArrayBuffer;
  lastIndex?: number; 
}

// --- Persistence ---
const DB_NAME = 'ReaderVerse_V42_STABLE';
const STORE_BOOKS = 'books';

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (ev: any) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_BOOKS)) {
          db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } catch (e) {
      reject(e);
    }
  });
};

const updateBookProgress = async (bookId: string, index: number) => {
  const db = await initDB();
  const tx = db.transaction(STORE_BOOKS, 'readwrite');
  const store = tx.objectStore(STORE_BOOKS);
  const req = store.get(bookId);
  req.onsuccess = () => {
    const book = req.result;
    if (book) {
      book.lastIndex = index;
      store.put(book);
    }
  };
};

const getBooks = async (): Promise<Book[]> => {
  try {
    const db = await initDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_BOOKS, 'readonly');
      const req = tx.objectStore(STORE_BOOKS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
};

const removeBookFromDB = async (id: string) => {
  const db = await initDB();
  db.transaction(STORE_BOOKS, 'readwrite').objectStore(STORE_BOOKS).delete(id);
};

// --- Audio Utilities ---
function decodeBase64(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const buffer = ctx.createBuffer(1, dataInt16.length, 24000);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < dataInt16.length; i++) {
    channelData[i] = dataInt16[i] / 32768.0;
  }
  return buffer;
}

// --- Components ---

const WordBlock = memo(({ block, currentWordIndex, onWordClick, fontSize, activeWordRef }: { 
  block: TextBlock, 
  currentWordIndex: number, 
  onWordClick: (idx: number) => void,
  fontSize: number,
  activeWordRef: React.RefObject<HTMLSpanElement | null>
}) => {
  return (
    <p className="font-serif leading-relaxed text-left will-change-transform mb-8" style={{ fontSize: `${fontSize}px` }}>
      {block.words.map((word, wIdx) => {
        const globalIdx = block.wordStartIndex + wIdx;
        const isCurrent = currentWordIndex === globalIdx;
        return (
          <span 
            key={wIdx} 
            ref={isCurrent ? activeWordRef : null}
            onClick={() => onWordClick(globalIdx)}
            className={`relative inline-block mr-[0.22em] px-1.5 py-0.5 rounded-lg transition-all duration-75 cursor-pointer select-none touch-manipulation ${isCurrent ? 'bg-blue-600 text-white font-bold shadow-xl scale-110 z-20' : 'opacity-60 hover:opacity-100'}`}
          >
            {word}
          </span>
        );
      })}
    </p>
  );
}, (prev, next) => {
  const prevIsVisible = prev.currentWordIndex >= prev.block.wordStartIndex && prev.currentWordIndex < prev.block.wordStartIndex + prev.block.wordCount;
  const nextIsVisible = next.currentWordIndex >= next.block.wordStartIndex && next.currentWordIndex < next.block.wordStartIndex + next.block.wordCount;
  if (!prevIsVisible && !nextIsVisible) return true;
  return prev.currentWordIndex === next.currentWordIndex && prev.fontSize === next.fontSize;
});

const PDFPage = memo(({ pdf, pageNum, scale, onVisible }: { pdf: pdfjsLib.PDFDocumentProxy, pageNum: number, scale: number, onVisible: (n: number) => void }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onVisible(pageNum);
    }, { threshold: 0.1 });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [pageNum, onVisible]);

  useEffect(() => {
    let renderTask: any;
    const render = async () => {
      if (!canvasRef.current) return;
      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return;
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
        page.cleanup();
      } catch (e) {}
    };
    render();
    return () => { if (renderTask) renderTask.cancel(); };
  }, [pdf, pageNum, scale]);

  return (
    <div ref={containerRef} className="relative mb-6 shadow-lg mx-auto bg-white dark:bg-zinc-800 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700">
      <canvas ref={canvasRef} className="block mx-auto max-w-full h-auto" />
      <div className="py-2 text-[8px] font-bold opacity-30 text-center bg-zinc-50 dark:bg-zinc-900/50 uppercase tracking-widest">P.{pageNum}</div>
    </div>
  );
});

// --- Logic ---

function walkNodes(node: Node, results: string[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    const val = node.textContent?.trim();
    if (val) results.push(val);
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node as Element).tagName.toUpperCase();
    if (['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'SVG', 'NOSCRIPT'].includes(tag)) return;
    for (let i = 0; i < node.childNodes.length; i++) walkNodes(node.childNodes[i], results);
    if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BR', 'TR', 'BLOCKQUOTE'].includes(tag)) {
      results.push(" [[PARA_BREAK]] ");
    }
  }
}

async function extractEpub(buffer: ArrayBuffer, onStatus: (s: string) => void): Promise<{ displayBlocks: TextBlock[]; chapters: ChapterEntry[]; metadata: any }> {
  const book = e(buffer);
  onStatus("Opening EPUB...");
  await book.opened;
  const metadata = await (book as any).loaded.metadata;
  const navigation = await (book as any).loaded.navigation;
  const toc = navigation?.toc || [];
  
  const getCanonical = (p: string) => p?.split('#')[0].replace(/(\.\.\/|\.\/)/g, '').toLowerCase() || '';
  const chapters: ChapterEntry[] = [];
  const displayBlocks: TextBlock[] = [];
  let totalWordCount = 0;
  
  const spine = (book as any).spine;
  const spineItems: any[] = [];
  spine.each((item: any) => spineItems.push(item));
  
  for (let i = 0; i < spineItems.length; i++) {
    const item = spineItems[i];
    try {
      const url = item.url || item.href;
      const rawHtml = await book.archive.getText(url);
      if (!rawHtml) continue;
      const doc = new DOMParser().parseFromString(rawHtml, "text/html");
      const itemHref = getCanonical(item.href || '');
      
      const matches = toc.filter((t: any) => {
        const tHref = getCanonical(t.href || '');
        return itemHref === tHref || itemHref.endsWith(tHref) || tHref.endsWith(itemHref);
      });

      for (const match of matches) {
        chapters.push({ title: match.label?.trim() || `Chapter ${chapters.length + 1}`, startIndex: totalWordCount });
      }

      const parts: string[] = [];
      walkNodes(doc.body || doc.documentElement, parts);
      const contentStr = parts.join(" ").replace(/\s+/g, ' ');
      const splitParas = contentStr.split('[[PARA_BREAK]]');
      let spineWordCount = 0;
      for (const p of splitParas) {
        const words = p.trim().split(/\s+/).filter(w => w.length > 0);
        if (words.length > 0) {
          displayBlocks.push({ 
            words, 
            wordStartIndex: totalWordCount + spineWordCount, 
            wordCount: words.length 
          });
          spineWordCount += words.length;
        }
      }
      totalWordCount += spineWordCount;
    } catch (e) {
      console.error("Spine error", e);
    }
    if (i % 5 === 0) onStatus(`Processing ${i+1}/${spineItems.length}...`);
  }
  return { displayBlocks, chapters: chapters.sort((a,b) => a.startIndex - b.startIndex), metadata };
}

async function extractPdf(buffer: ArrayBuffer, onStatus: (s: string) => void): Promise<{ displayBlocks: TextBlock[]; chapters: ChapterEntry[]; metadata: any }> {
  onStatus("Rendering PDF Layout...");
  const pdf = await pdfjsLib.getDocument({ data: buffer, useSystemFonts: true }).promise;
  const displayBlocks: TextBlock[] = [];
  const chapters: ChapterEntry[] = [];
  let totalWords = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it: any) => it.str).join(" ").replace(/\s+/g, ' ').trim();
    if (text) {
      const words = text.split(/\s+/).filter(w => w.length > 0);
      displayBlocks.push({ words, wordStartIndex: totalWords, wordCount: words.length });
      if (i === 1 || i % 10 === 0) chapters.push({ title: `Page ${i}`, startIndex: totalWords, pageNumber: i });
      totalWords += words.length;
    }
    page.cleanup();
  }
  return { displayBlocks, chapters, metadata: await pdf.getMetadata() };
}

// --- App ---

const App = () => {
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [view, setView] = useState<'library' | 'reader'>('library');
  const [readerMode, setReaderMode] = useState<'reflow' | 'pdf'>('reflow');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [fontSize, setFontSize] = useState(20);
  const [pdfScale, setPdfScale] = useState(1.0);
  const [currentPage, setCurrentPage] = useState(1);
  const [theme, setTheme] = useState<'light' | 'dark' | 'sepia'>('light');
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string>("");
  const [useNeuralTTS, setUseNeuralTTS] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const pdfInstanceRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const isPlayingRef = useRef(false);
  const wordIdxRef = useRef(0);
  const scrollRequestRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const speechSessionIdRef = useRef(0);
  const boundaryFiredRef = useRef(false);
  const heartbeatRef = useRef<HTMLAudioElement | null>(null);
  const wakeLockRef = useRef<any>(null);

  // Silent audio anchor for background persistence
  useEffect(() => {
    const audio = new Audio();
    audio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA== ";
    audio.loop = true;
    heartbeatRef.current = audio;
    return () => { audio.pause(); audio.src = ""; };
  }, []);

  const acquireWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator) {
      try {
        // @ts-ignore
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch (err) { console.warn('WakeLock failed', err); }
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().then(() => { wakeLockRef.current = null; });
    }
  }, []);

  useEffect(() => {
    if (isPlaying) acquireWakeLock(); else releaseWakeLock();
    return () => releaseWakeLock();
  }, [isPlaying, acquireWakeLock, releaseWakeLock]);

  const saveProgress = useCallback(() => {
    if (activeBook) updateBookProgress(activeBook.id, wordIdxRef.current);
  }, [activeBook]);

  const initAudioContext = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
  }, []);

  const warmUpSpeech = useCallback(() => {
    try { window.speechSynthesis.cancel(); const utt = new SpeechSynthesisUtterance(""); utt.volume = 0; window.speechSynthesis.speak(utt); } catch (e) {}
  }, []);

  const totalWords = useMemo(() => {
    if (!activeBook) return 0;
    const last = activeBook.displayBlocks[activeBook.displayBlocks.length - 1];
    return last ? last.wordStartIndex + last.wordCount : 0;
  }, [activeBook]);

  const currentChapter = useMemo(() => {
    if (!activeBook?.chapters.length) return null;
    return [...activeBook.chapters].reverse().find(c => c.startIndex <= currentWordIndex) || activeBook.chapters[0];
  }, [activeBook, currentWordIndex]);

  // Handle System Media Controls (Background Persistence)
  useEffect(() => {
    if ('mediaSession' in navigator && activeBook) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: activeBook.title,
        artist: activeBook.author,
        album: currentChapter?.title || 'ReaderVerse',
        artwork: [
          { src: 'https://cdn-icons-png.flaticon.com/512/3389/3389081.png', sizes: '512x512', type: 'image/png' }
        ]
      });

      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

      navigator.mediaSession.setActionHandler('play', () => togglePlayback());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayback());
      
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        const nextCh = activeBook.chapters.find(c => c.startIndex > wordIdxRef.current + 1);
        if (nextCh) jumpTo(nextCh.startIndex);
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        const prevChs = activeBook.chapters.filter(c => c.startIndex < wordIdxRef.current - 5);
        if (prevChs.length) jumpTo(prevChs[prevChs.length - 1].startIndex);
      });
    }
  }, [activeBook, isPlaying, currentChapter]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && isPlaying) {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isPlaying, acquireWakeLock]);

  useEffect(() => {
    const loadVoices = () => {
      let voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const filtered = voices.filter(v => v.lang.toLowerCase().includes('en')).sort((a,b) => a.name.includes('Natural') ? -1 : 1);
      setAvailableVoices(filtered);
      if (filtered.length && !selectedVoiceURI) setSelectedVoiceURI(filtered[0].voiceURI);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    const t = setInterval(loadVoices, 1000);
    return () => { window.speechSynthesis.onvoiceschanged = null; clearInterval(t); };
  }, [selectedVoiceURI]);

  useEffect(() => {
    getBooks().then(stored => {
      setBooks(stored);
      if (!stored.length) {
        setBooks([{ id: 'demo', title: 'ReaderVerse Pro', author: 'ElevenReaders Studio', displayBlocks: [{ words: "Neural-grade flow enabled. Tap any word to jump. Reading is now effortless.".split(" "), wordStartIndex: 0, wordCount: 12 }], chapters: [{ title: 'Intro', startIndex: 0 }], type: 'demo' }]);
      }
    });
  }, []);

  const findBlockIdx = useCallback((wIdx: number) => {
    if (!activeBook?.displayBlocks.length) return 0;
    const blocks = activeBook.displayBlocks;
    let l = 0, r = blocks.length - 1;
    while (l <= r) {
      const m = (l + r) >>> 1;
      const b = blocks[m];
      if (wIdx >= b.wordStartIndex && wIdx < (b.wordStartIndex + b.wordCount)) return m;
      if (wIdx < b.wordStartIndex) r = m - 1; else l = m + 1;
    }
    return Math.max(0, Math.min(blocks.length - 1, l));
  }, [activeBook]);

  const speakNeural = useCallback(async (text: string, sessionId: number, onEnd: () => void) => {
    try {
      if (sessionId !== speechSessionIdRef.current) return;
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const res = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text }] }],
        config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } },
      });
      if (sessionId !== speechSessionIdRef.current) return;
      const b64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64) throw new Error();
      initAudioContext();
      const ctx = audioCtxRef.current!;
      const buffer = await decodeAudioData(decodeBase64(b64), ctx);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = playbackSpeed;
      src.connect(ctx.destination);
      audioSourceRef.current = src;
      const words = text.split(/\s+/).filter(w => w.length > 0);
      const wDur = (buffer.duration / playbackSpeed) / words.length;
      let lastW = 0; const start = Date.now();
      syncIntervalRef.current = window.setInterval(() => {
        if (sessionId !== speechSessionIdRef.current) { clearInterval(syncIntervalRef.current!); return; }
        const cur = Math.floor(((Date.now() - start) / 1000) / wDur);
        if (cur > lastW && cur < words.length) { lastW = cur; setCurrentWordIndex(wordIdxRef.current + cur); }
      }, 50);
      src.onended = () => { if (syncIntervalRef.current) clearInterval(syncIntervalRef.current); if (sessionId === speechSessionIdRef.current) onEnd(); };
      src.start();
    } catch (e) { throw e; }
  }, [playbackSpeed, initAudioContext]);

  const speak = useCallback(async () => {
    if (!activeBook || !isPlayingRef.current) return;
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    
    const sId = speechSessionIdRef.current;
    const bIdx = findBlockIdx(wordIdxRef.current);
    const block = activeBook.displayBlocks[bIdx];
    if (!block) return;
    
    const offset = Math.max(0, wordIdxRef.current - block.wordStartIndex);
    const text = block.words.slice(offset).join(" ").trim();
    
    const finish = () => {
      if (sId !== speechSessionIdRef.current) return;
      const next = block.wordStartIndex + block.wordCount;
      if (next < totalWords && isPlayingRef.current) {
        wordIdxRef.current = next;
        setCurrentWordIndex(next);
        saveProgress();
        setTimeout(() => { if (sId === speechSessionIdRef.current) speak(); }, 10);
      } else {
        setIsPlaying(false); isPlayingRef.current = false;
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      }
    };

    if (useNeuralTTS && process.env.API_KEY) {
      try { await speakNeural(text, sId, finish); return; } catch { setUseNeuralTTS(false); }
    }

    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    const v = availableVoices.find(x => x.voiceURI === selectedVoiceURI) || availableVoices[0];
    if (v) utt.voice = v;
    utt.rate = playbackSpeed;
    boundaryFiredRef.current = false;

    syncIntervalRef.current = window.setInterval(() => {
      if (sId !== speechSessionIdRef.current) { clearInterval(syncIntervalRef.current!); return; }
      if (!boundaryFiredRef.current) { /* smoothing logic */ }
    }, 100);

    utt.onboundary = (e) => {
      if (sId !== speechSessionIdRef.current || e.name !== 'word') return;
      boundaryFiredRef.current = true;
      const count = text.substring(0, e.charIndex).trim().split(/\s+/).filter(w => w.length > 0).length;
      const global = block.wordStartIndex + offset + count;
      if (global >= wordIdxRef.current) { wordIdxRef.current = global; setCurrentWordIndex(global); }
    };
    utt.onstart = () => { 
      if (sId === speechSessionIdRef.current) { 
        if (heartbeatRef.current) heartbeatRef.current.play().catch(()=>{}); 
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      } 
    };
    utt.onend = () => { if (sId === speechSessionIdRef.current) finish(); };
    utt.onerror = () => { if (sId === speechSessionIdRef.current) finish(); };
    window.speechSynthesis.speak(utt);
  }, [activeBook, availableVoices, selectedVoiceURI, playbackSpeed, findBlockIdx, totalWords, useNeuralTTS, speakNeural, saveProgress]);

  const togglePlayback = () => {
    initAudioContext(); warmUpSpeech();
    if (isPlaying) {
      setIsPlaying(false); isPlayingRef.current = false;
      window.speechSynthesis.cancel();
      if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch(e){}
      speechSessionIdRef.current++;
      if (heartbeatRef.current) heartbeatRef.current.pause();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      saveProgress();
    } else {
      setIsPlaying(true); isPlayingRef.current = true;
      speechSessionIdRef.current++;
      if (heartbeatRef.current) heartbeatRef.current.play().catch(()=>{});
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      speak();
    }
  };

  const jumpTo = (idx: number) => {
    initAudioContext(); speechSessionIdRef.current++; window.speechSynthesis.cancel();
    if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch(e){}
    wordIdxRef.current = idx; setCurrentWordIndex(idx); saveProgress();
    if (isPlayingRef.current) setTimeout(speak, 50);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setIsLoading(true); setLoadingStatus("Deconstructing...");
    try {
      const buffer = await file.arrayBuffer();
      const ext = file.name.split('.').pop()?.toLowerCase();
      let res;
      if (ext === 'epub') res = await extractEpub(buffer, setLoadingStatus);
      else if (ext === 'pdf') res = await extractPdf(buffer, setLoadingStatus);
      else { const words = (await file.text()).split(/\s+/).filter(w => w.length > 0); res = { displayBlocks: [{ words, wordStartIndex: 0, wordCount: words.length }], chapters: [], metadata: { title: file.name } }; }
      const b: Book = { id: crypto.randomUUID(), title: res.metadata?.title || file.name, author: res.metadata?.creator || 'Unknown', displayBlocks: res.displayBlocks, chapters: res.chapters, type: ext as any || 'txt', fileData: ext === 'pdf' ? buffer : undefined, lastIndex: 0 };
      const db = await initDB(); const tx = db.transaction(STORE_BOOKS, 'readwrite'); tx.objectStore(STORE_BOOKS).put(b);
      setBooks(p => [...p, b]); setActiveBook(b); jumpTo(0); setView('reader');
    } catch { setErrorMsg("Import failed."); } finally { setIsLoading(false); }
  };

  const openBook = (b: Book) => { setActiveBook(b); jumpTo(b.lastIndex || 0); setView('reader'); };

  useEffect(() => {
    if (view === 'reader' && readerMode === 'reflow' && activeWordRef.current && scrollContainerRef.current) {
      if (scrollRequestRef.current) cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = requestAnimationFrame(() => {
        const c = scrollContainerRef.current; const w = activeWordRef.current;
        if (!c || !w) return;
        const target = c.getBoundingClientRect().bottom - 280;
        const cur = w.getBoundingClientRect().top + w.getBoundingClientRect().height / 2;
        if (Math.abs(cur - target) > 40) c.scrollTo({ top: c.scrollTop + (cur - target), behavior: isPlayingRef.current ? 'smooth' : 'auto' });
      });
    }
  }, [currentWordIndex, view, readerMode]);

  const activeTheme = { light: "bg-zinc-50 text-zinc-900", dark: "bg-zinc-950 text-zinc-100", sepia: "bg-[#f4ebd1] text-[#4d3a2b]" }[theme];

  return (
    <div className={`fixed inset-0 flex flex-col transition-colors duration-500 overflow-hidden select-none touch-none ${activeTheme}`}>
      {isLoading && (
        <div className="fixed inset-0 z-[200] bg-zinc-950/95 flex flex-col items-center justify-center text-white animate-in fade-in">
          <Loader2 className="w-12 h-12 animate-spin text-blue-500 mb-8" />
          <h2 className="text-xl font-black uppercase tracking-widest">{loadingStatus}</h2>
        </div>
      )}

      {errorMsg && (
        <div className="fixed inset-0 z-[300] bg-black/80 flex items-center justify-center p-8">
          <div className="bg-white dark:bg-zinc-900 rounded-[3rem] p-10 max-w-xs w-full shadow-4xl text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mb-6 mx-auto" />
            <p className="text-sm font-bold opacity-80 mb-10">{errorMsg}</p>
            <button onClick={() => setErrorMsg(null)} className="w-full py-4 bg-blue-600 text-white font-black rounded-2xl">Dismiss</button>
          </div>
        </div>
      )}

      <header className="h-16 flex items-center justify-between px-5 border-b z-50">
        <div className="flex items-center gap-4">
          <button onClick={() => { saveProgress(); setIsPlaying(false); isPlayingRef.current = false; speechSessionIdRef.current++; window.speechSynthesis.cancel(); if (heartbeatRef.current) heartbeatRef.current.pause(); setView('library'); }} className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow active:scale-90">
            <BookOpen size={18} />
          </button>
          <div className="overflow-hidden">
            <h1 className="text-[10px] font-black opacity-40 uppercase truncate max-w-[90px]">{view === 'reader' && activeBook ? activeBook.title : 'ReaderVerse'}</h1>
            {view === 'reader' && <div className="text-[10px] font-black text-blue-600 truncate max-w-[130px] uppercase">{readerMode === 'pdf' ? `P.${currentPage}` : (currentChapter?.title || 'INDEX')}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view === 'reader' && (
            <>
              <button onClick={() => setIsSidebarOpen(true)} className="p-2.5 rounded-xl bg-zinc-500/10"><List size={18} /></button>
              <button onClick={() => setIsSettingsOpen(true)} className="p-2.5 rounded-xl bg-zinc-500/10"><Settings size={18} /></button>
            </>
          )}
          {view === 'library' && (
            <label className="p-2.5 bg-blue-600 text-white rounded-xl shadow cursor-pointer flex items-center gap-2 px-4 active:scale-95">
              <Plus size={16} /> <span className="text-[10px] font-black uppercase">Import</span>
              <input type="file" className="hidden" accept=".epub,.pdf,.txt" onChange={handleFileUpload} />
            </label>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative">
        {view === 'library' ? (
          <div className="h-full overflow-y-auto p-6 no-scrollbar">
            <div className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-4 pb-28">
              {books.map(b => (
                <div key={b.id} onClick={() => openBook(b)} className={`p-6 rounded-[2.5rem] border-2 transition-all active:scale-[0.98] ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-zinc-100 shadow-md'}`}>
                   <div className="flex justify-between items-center mb-4">
                     <span className="text-[9px] font-black uppercase text-blue-600 bg-blue-600/10 px-3 py-1 rounded-full">{b.type}</span>
                     <button onClick={(e) => { e.stopPropagation(); removeBookFromDB(b.id); setBooks(p => p.filter(x => x.id !== b.id)); }} className="opacity-20 hover:opacity-100 p-2 text-red-500"><Trash2 size={16}/></button>
                   </div>
                   <h3 className="text-lg font-black leading-tight line-clamp-2 mb-1">{b.title}</h3>
                   {b.lastIndex ? <div className="text-[8px] font-black opacity-30 uppercase flex items-center gap-1"><Bookmark size={8} /> {Math.floor(b.lastIndex/1000)}k words in</div> : null}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {readerMode === 'reflow' ? (
              <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-14 no-scrollbar scroll-smooth">
                <article className="max-w-xl mx-auto space-y-12 pb-[400px]">
                  {activeBook?.displayBlocks.slice(Math.max(0, findBlockIdx(currentWordIndex)-2), Math.min(activeBook.displayBlocks.length, findBlockIdx(currentWordIndex)+6)).map((b, i) => (
                    <WordBlock key={`${b.wordStartIndex}`} block={b} currentWordIndex={currentWordIndex} onWordClick={jumpTo} fontSize={fontSize} activeWordRef={activeWordRef} />
                  ))}
                </article>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-4 py-8 bg-zinc-100 dark:bg-zinc-900 no-scrollbar">
                {pdfInstanceRef.current && (
                  <div className="max-w-3xl mx-auto">
                    {Array.from({ length: pdfInstanceRef.current.numPages }).map((_, i) => (
                      <PDFPage key={i} pdf={pdfInstanceRef.current!} pageNum={i + 1} scale={pdfScale} onVisible={setCurrentPage} />
                    ))}
                  </div>
                )}
              </div>
            )}
            
            <div className="absolute bottom-8 left-0 right-0 px-5 z-50">
              <div className={`max-w-md mx-auto border p-5 rounded-[3.5rem] shadow-3xl ${theme === 'dark' ? 'bg-zinc-900/95 border-zinc-800' : 'bg-white/95 border-zinc-100'}`}>
                {readerMode === 'reflow' ? (
                  <>
                    <div className="w-full h-1 bg-zinc-500/10 rounded-full mb-6 overflow-hidden">
                      <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${(currentWordIndex / Math.max(1, totalWords)) * 100}%` }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <button onClick={() => setIsSettingsOpen(true)} className="w-11 h-11 rounded-2xl bg-zinc-500/5 flex items-center justify-center font-black text-[10px] active:scale-90">{playbackSpeed}x</button>
                      <div className="flex items-center gap-6">
                        <button onClick={() => {
                          const prev = activeBook?.chapters.filter(c => c.startIndex < wordIdxRef.current - 5);
                          if (prev?.length) jumpTo(prev[prev.length - 1].startIndex);
                        }} className="opacity-20 active:scale-90"><SkipBack size={26} fill="currentColor" /></button>
                        <button onClick={togglePlayback} className="w-16 h-16 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-2xl active:scale-90">
                          {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" className="ml-1" />}
                        </button>
                        <button onClick={() => {
                          const next = activeBook?.chapters.find(c => c.startIndex > wordIdxRef.current + 1);
                          if (next) jumpTo(next.startIndex);
                        }} className="opacity-20 active:scale-90"><SkipForward size={26} fill="currentColor" /></button>
                      </div>
                      <div className="w-11 h-11 flex items-center justify-center opacity-20"><Volume2 size={18} /></div>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between px-2">
                    <div className="flex items-center gap-3">
                      <button onClick={() => setPdfScale(s => Math.max(0.5, s - 0.25))} className="p-3 bg-zinc-500/5 rounded-2xl"><ZoomOut size={16}/></button>
                      <span className="text-[10px] font-black w-12 text-center">{Math.round(pdfScale * 100)}%</span>
                      <button onClick={() => setPdfScale(s => Math.min(3.0, s + 0.25))} className="p-3 bg-zinc-500/5 rounded-2xl"><ZoomIn size={16}/></button>
                    </div>
                    <button onClick={() => setReaderMode('reflow')} className="px-5 py-3 bg-blue-600 text-white rounded-2xl flex items-center gap-2 text-[10px] font-black shadow-lg"><Headphones size={16} /> LISTEN</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {isSidebarOpen && (
        <div className="fixed inset-0 z-[100] flex animate-in fade-in">
          <div className="absolute inset-0 bg-black/30" onClick={() => setIsSidebarOpen(false)} />
          <div className={`relative w-[85%] max-w-xs h-full flex flex-col shadow-5xl ${activeTheme}`}>
            <div className="p-7 border-b flex items-center justify-between">
              <h2 className="text-sm font-black uppercase tracking-widest">Index</h2>
              <button onClick={() => setIsSidebarOpen(false)} className="p-2 bg-zinc-500/10 rounded-full"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-1.5 no-scrollbar">
              {activeBook?.chapters.length ? activeBook.chapters.map((c, i) => (
                <button key={i} onClick={() => { jumpTo(c.startIndex); setIsSidebarOpen(false); }} className={`w-full text-left p-5 rounded-2xl text-[10px] font-bold transition-all ${currentChapter === c ? 'bg-blue-600 text-white shadow-xl' : 'opacity-40 bg-zinc-500/5'}`}>
                   <span className="truncate pr-4 uppercase tracking-tighter">{c.title}</span>
                </button>
              )) : <div className="p-16 text-center opacity-10 text-[9px] font-black">Empty</div>}
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 z-[110] flex items-end animate-in fade-in">
          <div className="absolute inset-0 bg-black/40" onClick={() => setIsSettingsOpen(false)} />
          <div className={`relative w-full rounded-t-[3.5rem] p-8 pb-12 border-t animate-in slide-in-from-bottom ${activeTheme}`}>
             <div className="flex justify-between items-center mb-8">
               <h2 className="text-xl font-black uppercase tracking-[0.1em]">Settings</h2>
               <button onClick={() => setIsSettingsOpen(false)} className="p-3 bg-zinc-500/10 rounded-full"><X size={20} /></button>
             </div>
             <div className="space-y-10">
                <div className="space-y-4">
                  <div className="flex justify-between items-center"><span className="text-[10px] font-black opacity-30 uppercase tracking-[0.3em]">Voice Profile</span><Globe size={14} className="opacity-30" /></div>
                  <select value={selectedVoiceURI} onChange={(e) => { setSelectedVoiceURI(e.target.value); initAudioContext(); warmUpSpeech(); }} className="w-full p-4 rounded-2xl text-xs font-bold appearance-none bg-zinc-500/5 border-2 border-transparent focus:border-blue-600 outline-none">
                    {availableVoices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name.replace(/(Microsoft |Google |Natural )/g, '')} ({v.lang})</option>)}
                  </select>
                </div>
                <div className="space-y-4">
                   <div className="flex justify-between items-center"><span className="text-[10px] font-black opacity-30 uppercase tracking-[0.3em]">Neural Core</span>
                     <button onClick={() => { setUseNeuralTTS(!useNeuralTTS); initAudioContext(); warmUpSpeech(); }} className={`px-4 py-2 rounded-full text-[9px] font-black uppercase flex items-center gap-2 ${useNeuralTTS ? 'bg-blue-600 text-white' : 'bg-zinc-500/10 opacity-40'}`}>
                        {useNeuralTTS ? <Zap size={12} fill="white" /> : <Cpu size={12} />} Neural
                     </button>
                   </div>
                   <div className="grid grid-cols-3 gap-3">
                      {(['light', 'dark', 'sepia'] as const).map(t => <button key={t} onClick={() => setTheme(t)} className={`py-4 rounded-2xl text-[11px] font-black capitalize border-2 ${theme === t ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-500/5 opacity-40'}`}>{t}</button>)}
                   </div>
                </div>
                <div>
                  <div className="flex justify-between items-center mb-4"><span className="text-[10px] font-black opacity-30 uppercase tracking-[0.3em]">Speed</span><span className="text-xs font-black text-blue-600">{playbackSpeed}x</span></div>
                  <input type="range" min="0.5" max="2.5" step="0.1" value={playbackSpeed} onChange={e => setPlaybackSpeed(parseFloat(e.target.value))} className="w-full h-1.5 bg-blue-600/10 rounded-full appearance-none accent-blue-600" />
                </div>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
