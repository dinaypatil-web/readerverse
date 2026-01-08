import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Play, Pause, SkipForward, SkipBack, Settings, X, Check, 
  List, Loader2, BookOpen, Trash2, Plus, Clock, Info, AlertCircle, 
  Zap, ZoomIn, ZoomOut, Maximize2, FileText, Headphones, Bookmark, Cpu, ChevronRight, Volume2, Globe,
  Shield, Sparkles, Mic2, Layers, Search, MoreHorizontal, Layout
} from 'lucide-react';
import e from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import { GoogleGenAI, Modality } from "@google/genai";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.mjs`;

// --- Types ---
type TtsProvider = 'system' | 'gemini' | 'google-cloud' | 'minimax';

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
const DB_NAME = 'ReaderVerse_V45_BACKGROUND';
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
    <div className="reader-text leading-[1.8] text-left mb-12" style={{ fontSize: `${fontSize}px` }}>
      {block.words.map((word, wIdx) => {
        const globalIdx = block.wordStartIndex + wIdx;
        const isCurrent = currentWordIndex === globalIdx;
        return (
          <span 
            key={wIdx} 
            ref={isCurrent ? activeWordRef : null}
            onClick={() => onWordClick(globalIdx)}
            className={`word-highlight relative inline-block mr-[0.28em] px-1.5 py-0.5 rounded-lg cursor-pointer select-none touch-manipulation ${
              isCurrent 
                ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400 font-bold scale-110 z-20 shadow-[0_0_20px_rgba(37,99,235,0.15)] ring-1 ring-blue-600/20' 
                : 'opacity-70 hover:opacity-100 dark:text-zinc-300'
            }`}
          >
            {word}
          </span>
        );
      })}
    </div>
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
        const viewport = page.getViewport({ scale: scale * 1.5 });
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
    <div ref={containerRef} className="relative mb-12 shadow-2xl mx-auto bg-white dark:bg-zinc-800 rounded-3xl overflow-hidden border-4 border-white dark:border-zinc-700">
      <canvas ref={canvasRef} className="block mx-auto max-w-full h-auto" />
      <div className="absolute top-4 right-4 bg-white/50 backdrop-blur-md px-3 py-1 rounded-full text-[10px] font-black opacity-40 uppercase tracking-widest border border-white/20">P.{pageNum}</div>
    </div>
  );
});

// --- Parsing Functions ---

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
  onStatus("Inhaling Manuscript...");
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
    if (i % 5 === 0) onStatus(`Processing Narrative... ${Math.round((i/spineItems.length)*100)}%`);
  }
  return { displayBlocks, chapters: chapters.sort((a,b) => a.startIndex - b.startIndex), metadata };
}

async function extractPdf(buffer: ArrayBuffer, onStatus: (s: string) => void): Promise<{ displayBlocks: TextBlock[]; chapters: ChapterEntry[]; metadata: any }> {
  onStatus("Mapping PDF Layers...");
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
    if (i % 10 === 0) onStatus(`Layering Page ${i}/${pdf.numPages}...`);
  }
  return { displayBlocks, chapters, metadata: await pdf.getMetadata() };
}

// --- App Component ---

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
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>('system');

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
  const heartbeatRef = useRef<HTMLAudioElement | null>(null);
  const wakeLockRef = useRef<any>(null);

  // Background audio anchor (Heartbeat)
  useEffect(() => {
    const audio = new Audio();
    audio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA== ";
    audio.loop = true;
    audio.preload = "auto";
    heartbeatRef.current = audio;
    return () => { 
      audio.pause(); 
      audio.src = ""; 
    };
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

  const saveProgress = useCallback(() => {
    if (activeBook) updateBookProgress(activeBook.id, wordIdxRef.current);
  }, [activeBook]);

  const initAudioContext = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
  }, []);

  const warmUpSpeech = useCallback(() => {
    try { 
      window.speechSynthesis.cancel(); 
      const utt = new SpeechSynthesisUtterance(""); 
      utt.volume = 0; 
      window.speechSynthesis.speak(utt); 
    } catch (e) {}
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

  // --- Logic for Playback Routing (System Media Player Integration) ---

  const jumpTo = (idx: number) => {
    initAudioContext(); 
    speechSessionIdRef.current++; 
    window.speechSynthesis.cancel();
    if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch(e){}
    const safeIdx = Math.max(0, Math.min(idx, totalWords - 1));
    wordIdxRef.current = safeIdx; 
    setCurrentWordIndex(safeIdx); 
    saveProgress();
    if (isPlayingRef.current) setTimeout(speak, 50);
  };

  const togglePlayback = useCallback(() => {
    initAudioContext(); 
    warmUpSpeech();
    if (isPlayingRef.current) {
      setIsPlaying(false); 
      isPlayingRef.current = false;
      window.speechSynthesis.cancel();
      if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch(e){}
      speechSessionIdRef.current++;
      if (heartbeatRef.current) heartbeatRef.current.pause();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      releaseWakeLock();
      saveProgress();
    } else {
      setIsPlaying(true); 
      isPlayingRef.current = true;
      speechSessionIdRef.current++;
      if (heartbeatRef.current) heartbeatRef.current.play().catch(()=>{});
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      acquireWakeLock();
      speak();
    }
  }, [saveProgress, acquireWakeLock, releaseWakeLock]);

  // Media Session - System Controls Sync
  useEffect(() => {
    if ('mediaSession' in navigator && activeBook) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: activeBook.title,
        artist: activeBook.author,
        album: currentChapter?.title || 'Library',
        artwork: [
          { src: 'https://cdn-icons-png.flaticon.com/512/3389/3389081.png', sizes: '512x512', type: 'image/png' },
          { src: 'https://cdn-icons-png.flaticon.com/512/3389/3389081.png', sizes: '192x192', type: 'image/png' }
        ]
      });

      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

      // Lock screen / Media hub progress tracking
      try {
        if ('setPositionState' in navigator.mediaSession) {
          navigator.mediaSession.setPositionState({
            duration: Math.max(totalWords, 1),
            playbackRate: playbackSpeed,
            position: currentWordIndex
          });
        }
      } catch (e) {}

      // Action Handlers
      navigator.mediaSession.setActionHandler('play', () => togglePlayback());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayback());
      navigator.mediaSession.setActionHandler('stop', () => {
        setIsPlaying(false);
        isPlayingRef.current = false;
        window.speechSynthesis.cancel();
        speechSessionIdRef.current++;
      });
      
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        const next = activeBook.chapters.find(c => c.startIndex > wordIdxRef.current + 5);
        if (next) jumpTo(next.startIndex);
      });

      navigator.mediaSession.setActionHandler('previoustrack', () => {
        const prevs = activeBook.chapters.filter(c => c.startIndex < wordIdxRef.current - 10);
        if (prevs.length) jumpTo(prevs[prevs.length - 1].startIndex);
      });

      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) jumpTo(Math.floor(details.seekTime));
      });

      navigator.mediaSession.setActionHandler('seekbackward', () => jumpTo(wordIdxRef.current - 100));
      navigator.mediaSession.setActionHandler('seekforward', () => jumpTo(wordIdxRef.current + 100));
    }
  }, [activeBook, isPlaying, currentChapter, totalWords, playbackSpeed, currentWordIndex, togglePlayback]);

  // --- TTS Engine Core ---

  const speakNeuralGemini = useCallback(async (text: string, sessionId: number, onEnd: () => void) => {
    try {
      if (sessionId !== speechSessionIdRef.current) return;
      // Initialize GoogleGenAI right before use with process.env.API_KEY directly
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
      let lastW = 0; 
      const start = Date.now();
      
      syncIntervalRef.current = window.setInterval(() => {
        if (sessionId !== speechSessionIdRef.current) { clearInterval(syncIntervalRef.current!); return; }
        const cur = Math.floor(((Date.now() - start) / 1000) / wDur);
        if (cur > lastW && cur < words.length) { 
          lastW = cur; 
          setCurrentWordIndex(wordIdxRef.current + cur); 
        }
      }, 50);

      src.onended = () => { 
        if (syncIntervalRef.current) clearInterval(syncIntervalRef.current); 
        if (sessionId === speechSessionIdRef.current) onEnd(); 
      };
      src.start();
    } catch (e) { throw e; }
  }, [playbackSpeed, initAudioContext]);

  const speak = useCallback(async () => {
    if (!activeBook || !isPlayingRef.current) return;
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    
    const sId = speechSessionIdRef.current;
    // Added missing activeBook argument to findBlockIdx
    const bIdx = findBlockIdx(wordIdxRef.current, activeBook);
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
        setTimeout(() => { if (sId === speechSessionIdRef.current) speak(); }, 15);
      } else {
        setIsPlaying(false); 
        isPlayingRef.current = false;
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      }
    };

    if (ttsProvider === 'gemini' && process.env.API_KEY) {
      try { await speakNeuralGemini(text, sId, finish); return; } catch { setTtsProvider('system'); }
    } else if (ttsProvider === 'google-cloud' || ttsProvider === 'minimax') {
        try { await speakNeuralGemini(text, sId, finish); return; } catch { setTtsProvider('system'); }
    }

    // Default System TTS
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    const v = availableVoices.find(x => x.voiceURI === selectedVoiceURI) || availableVoices[0];
    if (v) utt.voice = v;
    utt.rate = playbackSpeed;

    utt.onboundary = (e) => {
      if (sId !== speechSessionIdRef.current || e.name !== 'word') return;
      const count = text.substring(0, e.charIndex).trim().split(/\s+/).filter(w => w.length > 0).length;
      const global = block.wordStartIndex + offset + count;
      if (global >= wordIdxRef.current) { 
        wordIdxRef.current = global; 
        setCurrentWordIndex(global); 
      }
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
  }, [activeBook, availableVoices, selectedVoiceURI, playbackSpeed, totalWords, ttsProvider, speakNeuralGemini, saveProgress]);

  // --- Handlers & Lifecycle ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setIsLoading(true); setLoadingStatus("Illuminating Manuscript...");
    try {
      const buffer = await file.arrayBuffer();
      const ext = file.name.split('.').pop()?.toLowerCase();
      let res;
      if (ext === 'epub') res = await extractEpub(buffer, setLoadingStatus);
      else if (ext === 'pdf') res = await extractPdf(buffer, setLoadingStatus);
      else { 
        const txt = await file.text();
        const words = txt.split(/\s+/).filter(w => w.length > 0); 
        res = { displayBlocks: [{ words, wordStartIndex: 0, wordCount: words.length }], chapters: [], metadata: { title: file.name } }; 
      }
      const b: Book = { id: crypto.randomUUID(), title: res.metadata?.title || file.name, author: res.metadata?.creator || 'Unknown', displayBlocks: res.displayBlocks, chapters: res.chapters, type: ext as any || 'txt', fileData: ext === 'pdf' ? buffer : undefined, lastIndex: 0 };
      const db = await initDB(); 
      const tx = db.transaction(STORE_BOOKS, 'readwrite'); 
      tx.objectStore(STORE_BOOKS).put(b);
      setBooks(p => [...p, b]); 
      setActiveBook(b); 
      jumpTo(0); 
      setView('reader');
    } catch { setErrorMsg("Composition Error."); } finally { setIsLoading(false); }
  };

  const openBook = (b: Book) => { setActiveBook(b); jumpTo(b.lastIndex || 0); setView('reader'); };

  useEffect(() => {
    if (view === 'reader' && readerMode === 'reflow' && activeWordRef.current && scrollContainerRef.current) {
      if (scrollRequestRef.current) cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = requestAnimationFrame(() => {
        const c = scrollContainerRef.current; 
        const w = activeWordRef.current;
        if (!c || !w) return;
        const target = c.getBoundingClientRect().bottom - 380;
        const cur = w.getBoundingClientRect().top + w.getBoundingClientRect().height / 2;
        if (Math.abs(cur - target) > 40) c.scrollTo({ top: c.scrollTop + (cur - target), behavior: isPlayingRef.current ? 'smooth' : 'auto' });
      });
    }
  }, [currentWordIndex, view, readerMode]);

  const activeTheme = { light: "bg-zinc-50 text-zinc-900", dark: "bg-zinc-950 text-zinc-100", sepia: "bg-[#fdf8ed] text-[#4d3a2b]" }[theme];

  return (
    <div className={`fixed inset-0 flex flex-col transition-all duration-700 overflow-hidden select-none touch-none ${activeTheme}`}>
      
      {isLoading && (
        <div className="fixed inset-0 z-[200] bg-white dark:bg-zinc-950 flex flex-col items-center justify-center animate-in fade-in duration-500">
          <div className="relative w-24 h-24 mb-10">
            <div className="absolute inset-0 bg-blue-600/20 rounded-full animate-ping" />
            <div className="relative w-full h-full bg-blue-600 rounded-full flex items-center justify-center text-white shadow-3xl">
              <Loader2 className="w-10 h-10 animate-spin" />
            </div>
          </div>
          <h2 className="text-sm font-black uppercase tracking-[0.5em] opacity-40 animate-pulse">{loadingStatus}</h2>
        </div>
      )}

      {errorMsg && (
        <div className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-xl flex items-center justify-center p-8">
          <div className="bg-white dark:bg-zinc-900 rounded-[3rem] p-12 max-w-xs w-full shadow-4xl text-center border border-white/20">
            <AlertCircle className="w-16 h-16 text-red-500 mb-8 mx-auto" />
            <p className="text-sm font-bold opacity-60 mb-10 leading-relaxed">{errorMsg}</p>
            <button onClick={() => setErrorMsg(null)} className="w-full py-5 bg-blue-600 text-white font-black rounded-3xl shadow-xl active:scale-95 transition-all uppercase tracking-widest">Acknowledge</button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="h-20 flex items-center justify-between px-8 z-50 glass">
        <div className="flex items-center gap-6">
          <button onClick={() => { 
            saveProgress(); 
            setIsPlaying(false); 
            isPlayingRef.current = false; 
            speechSessionIdRef.current++; 
            window.speechSynthesis.cancel(); 
            if (heartbeatRef.current) heartbeatRef.current.pause(); 
            setView('library'); 
          }} className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-2xl active:scale-90 transition-all">
            <BookOpen size={24} />
          </button>
          <div className="overflow-hidden">
            <h1 className="text-[12px] font-black opacity-30 uppercase truncate max-w-[120px] tracking-[0.2em]">{view === 'reader' && activeBook ? activeBook.title : 'ReaderVerse'}</h1>
            {view === 'reader' && (
                <div className="text-[12px] font-black text-blue-600 truncate max-w-[160px] uppercase tracking-tighter flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-pulse" />
                    {readerMode === 'pdf' ? `P.${currentPage}` : (currentChapter?.title || 'Manuscript')}
                </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {view === 'reader' && (
            <>
              <button onClick={() => setIsSidebarOpen(true)} className="w-12 h-12 flex items-center justify-center rounded-2xl bg-zinc-500/5 hover:bg-zinc-500/10 active:scale-90 transition-all"><List size={22} /></button>
              <button onClick={() => setIsSettingsOpen(true)} className="w-12 h-12 flex items-center justify-center rounded-2xl bg-zinc-500/5 hover:bg-zinc-500/10 active:scale-90 transition-all"><Settings size={22} /></button>
            </>
          )}
          {view === 'library' && (
            <label className="h-12 bg-blue-600 text-white rounded-2xl shadow-2xl cursor-pointer flex items-center gap-3 px-6 active:scale-95 transition-all group">
              <Plus size={20} className="group-hover:rotate-90 transition-transform" /> 
              <span className="text-[12px] font-black uppercase tracking-widest">Library</span>
              <input type="file" className="hidden" accept=".epub,.pdf,.txt" onChange={handleFileUpload} />
            </label>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative">
        {view === 'library' ? (
          <div className="h-full overflow-y-auto p-10 no-scrollbar">
            <div className="max-w-5xl mx-auto space-y-12">
               <div className="flex items-center justify-between opacity-40 border-b pb-6 border-zinc-500/10">
                  <h2 className="text-[12px] font-black uppercase tracking-[0.4em]">Current Collection</h2>
                  <Layout size={18} />
               </div>
               <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 pb-40">
                {books.map((b, i) => (
                  <div key={b.id} onClick={() => openBook(b)} style={{ animationDelay: `${i * 100}ms` }} className={`group p-8 rounded-[3.5rem] border transition-all active:scale-[0.97] animate-in slide-in-from-bottom duration-500 ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800 shadow-3xl hover:border-zinc-700' : 'bg-white border-zinc-100 shadow-2xl hover:border-blue-200'}`}>
                    <div className="flex justify-between items-start mb-8">
                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${b.type === 'pdf' ? 'bg-red-500/10 text-red-500' : 'bg-blue-600/10 text-blue-600'}`}>
                            {b.type === 'pdf' ? <FileText size={28} /> : <BookOpen size={28} />}
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); removeBookFromDB(b.id); setBooks(p => p.filter(x => x.id !== b.id)); }} className="opacity-0 group-hover:opacity-40 p-3 hover:bg-red-500/10 hover:text-red-500 rounded-full transition-all"><Trash2 size={20}/></button>
                    </div>
                    <h3 className="text-2xl font-black leading-[1.2] line-clamp-2 mb-3 tracking-tight group-hover:text-blue-600 transition-colors">{b.title}</h3>
                    <p className="text-xs font-bold opacity-40 uppercase mb-8 truncate">{b.author}</p>
                    <div className="flex items-center justify-between pt-6 border-t border-zinc-500/5">
                        <span className="text-[10px] font-black opacity-30 uppercase tracking-widest">{b.type}</span>
                        {b.lastIndex ? <div className="text-[10px] font-black text-blue-600 flex items-center gap-1.5"><Bookmark size={10} /> {Math.floor(b.lastIndex/1000)}k</div> : null}
                    </div>
                  </div>
                ))}
               </div>
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {readerMode === 'reflow' ? (
              <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-24 no-scrollbar scroll-smooth">
                <article className="max-w-2xl mx-auto space-y-16 pb-[500px]">
                  {/* Fixed missing activeBook argument to findBlockIdx */}
                  {activeBook?.displayBlocks.slice(Math.max(0, findBlockIdx(currentWordIndex, activeBook)-3), Math.min(activeBook.displayBlocks.length, findBlockIdx(currentWordIndex, activeBook)+8)).map((b) => (
                    <WordBlock key={`${b.wordStartIndex}`} block={b} currentWordIndex={currentWordIndex} onWordClick={jumpTo} fontSize={fontSize} activeWordRef={activeWordRef} />
                  ))}
                </article>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-6 py-12 bg-zinc-100 dark:bg-zinc-950 no-scrollbar">
                {pdfInstanceRef.current && (
                  <div className="max-w-4xl mx-auto">
                    {Array.from({ length: pdfInstanceRef.current.numPages }).map((_, i) => (
                      <PDFPage key={i} pdf={pdfInstanceRef.current!} pageNum={i + 1} scale={pdfScale} onVisible={setCurrentPage} />
                    ))}
                  </div>
                )}
              </div>
            )}
            
            {/* Floating Control Hub */}
            <div className="absolute bottom-12 left-0 right-0 px-8 z-50 pointer-events-none">
              <div className={`max-w-xl mx-auto p-6 rounded-[4.5rem] shadow-[0_32px_80px_rgba(0,0,0,0.15)] glass pointer-events-auto border-4 border-white dark:border-zinc-800`}>
                {readerMode === 'reflow' ? (
                  <>
                    <div className="w-full h-2 bg-zinc-500/10 rounded-full mb-8 overflow-hidden">
                      <div className="h-full bg-blue-600 transition-all duration-300 shadow-[0_0_20px_rgba(37,99,235,0.6)]" style={{ width: `${(currentWordIndex / Math.max(1, totalWords)) * 100}%` }} />
                    </div>
                    <div className="flex items-center justify-between px-2">
                      <button onClick={() => setIsSettingsOpen(true)} className="w-14 h-14 rounded-3xl bg-zinc-500/5 flex items-center justify-center font-black text-xs active:scale-90 hover:bg-zinc-500/10 transition-all">{playbackSpeed}x</button>
                      <div className="flex items-center gap-10">
                        <button onClick={() => {
                          const prevs = activeBook?.chapters.filter(c => c.startIndex < wordIdxRef.current - 10);
                          if (prevs?.length) jumpTo(prevs[prevs.length - 1].startIndex);
                        }} className="opacity-30 hover:opacity-100 active:scale-90 transition-all"><SkipBack size={32} fill="currentColor" /></button>
                        <button onClick={togglePlayback} className="w-24 h-24 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-[0_25px_50px_rgba(37,99,235,0.4)] hover:scale-105 active:scale-95 transition-all group">
                          {isPlaying 
                            ? <Pause size={40} fill="currentColor" className="group-active:scale-90 transition-transform" /> 
                            : <Play size={40} fill="currentColor" className="ml-2 group-active:scale-90 transition-transform" />}
                        </button>
                        <button onClick={() => {
                          const next = activeBook?.chapters.find(c => c.startIndex > wordIdxRef.current + 5);
                          if (next) jumpTo(next.startIndex);
                        }} className="opacity-30 hover:opacity-100 active:scale-90 transition-all"><SkipForward size={32} fill="currentColor" /></button>
                      </div>
                      <button className="w-14 h-14 flex items-center justify-center opacity-30 active:scale-90 transition-all"><Volume2 size={26} /></button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between px-4">
                    <div className="flex items-center gap-4">
                      <button onClick={() => setPdfScale(s => Math.max(0.5, s - 0.25))} className="w-14 h-14 bg-zinc-500/5 rounded-3xl flex items-center justify-center active:scale-90 hover:bg-zinc-500/10 transition-all"><ZoomOut size={22}/></button>
                      <span className="text-[12px] font-black w-14 text-center">{Math.round(pdfScale * 100)}%</span>
                      <button onClick={() => setPdfScale(s => Math.min(3.5, s + 0.25))} className="w-14 h-14 bg-zinc-500/5 rounded-3xl flex items-center justify-center active:scale-90 hover:bg-zinc-500/10 transition-all"><ZoomIn size={22}/></button>
                    </div>
                    <button onClick={() => setReaderMode('reflow')} className="h-16 px-8 bg-blue-600 text-white rounded-3xl flex items-center gap-3 text-[12px] font-black shadow-2xl active:scale-95 hover:bg-blue-700 transition-all uppercase tracking-widest"><Headphones size={24} /> Listen</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Sidebar - Milestones */}
      {isSidebarOpen && (
        <div className="fixed inset-0 z-[100] flex animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-md" onClick={() => setIsSidebarOpen(false)} />
          <div className={`relative w-[85%] max-w-sm h-full flex flex-col shadow-5xl animate-in slide-in-from-left duration-500 glass`}>
            <div className="p-10 border-b border-zinc-500/5 flex items-center justify-between">
              <h2 className="text-sm font-black uppercase tracking-[0.4em] opacity-40">Milestones</h2>
              <button onClick={() => setIsSidebarOpen(false)} className="p-4 bg-zinc-500/5 rounded-full hover:bg-zinc-500/10 transition-all"><X size={24} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-3 no-scrollbar custom-scrollbar">
              {activeBook?.chapters.length ? activeBook.chapters.map((c, i) => (
                <button key={i} onClick={() => { jumpTo(c.startIndex); setIsSidebarOpen(false); }} className={`w-full text-left p-6 rounded-[2.5rem] text-[11px] font-bold transition-all ${currentChapter === c ? 'bg-blue-600 text-white shadow-2xl scale-[1.02]' : 'opacity-40 bg-zinc-500/5 hover:opacity-100 hover:scale-[1.01]'}`}>
                   <span className="truncate pr-4 uppercase tracking-tighter block">{c.title}</span>
                </button>
              )) : <div className="p-20 text-center opacity-10 text-[10px] font-black tracking-widest uppercase">Void</div>}
            </div>
          </div>
        </div>
      )}

      {/* Settings Panel */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[110] flex items-end animate-in fade-in duration-500">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={() => setIsSettingsOpen(false)} />
          <div className={`relative w-full rounded-t-[5rem] p-10 pb-20 border-t border-white/10 animate-in slide-in-from-bottom duration-500 overflow-y-auto max-h-[92vh] no-scrollbar shadow-5xl glass`}>
             <div className="w-12 h-1.5 bg-zinc-500/10 rounded-full mx-auto mb-10" />
             <div className="flex justify-between items-center mb-12">
               <h2 className="text-3xl font-black uppercase tracking-[0.2em] opacity-60">Architect</h2>
               <button onClick={() => setIsSettingsOpen(false)} className="p-5 bg-zinc-500/10 rounded-full active:scale-90 transition-all"><X size={28} /></button>
             </div>
             
             <div className="max-w-2xl mx-auto space-y-14">
                <div className="space-y-6">
                  <span className="text-[11px] font-black opacity-30 uppercase tracking-[0.5em] block">Neural Core Provider</span>
                  <div className="grid grid-cols-2 gap-4">
                    <button onClick={() => setTtsProvider('system')} className={`flex flex-col items-center justify-center gap-4 p-8 rounded-[3rem] border-2 transition-all ${ttsProvider === 'system' ? 'border-blue-600 bg-blue-600 text-white shadow-2xl' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40 hover:opacity-100'}`}>
                      <Globe size={32} /> <span className="text-[12px] font-black uppercase tracking-widest">System</span>
                    </button>
                    <button onClick={() => setTtsProvider('gemini')} className={`flex flex-col items-center justify-center gap-4 p-8 rounded-[3rem] border-2 transition-all ${ttsProvider === 'gemini' ? 'border-blue-600 bg-blue-600 text-white shadow-2xl' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40 hover:opacity-100'}`}>
                      <Zap size={32} /> <span className="text-[12px] font-black uppercase tracking-widest">Neural AI</span>
                    </button>
                    <button onClick={() => setTtsProvider('google-cloud')} className={`flex flex-col items-center justify-center gap-4 p-8 rounded-[3rem] border-2 transition-all ${ttsProvider === 'google-cloud' ? 'border-blue-600 bg-blue-600 text-white shadow-2xl' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40 hover:opacity-100'}`}>
                      <Layers size={32} /> <span className="text-[12px] font-black uppercase tracking-widest">Cloud V1</span>
                    </button>
                    <button onClick={() => setTtsProvider('minimax')} className={`flex flex-col items-center justify-center gap-4 p-8 rounded-[3rem] border-2 transition-all ${ttsProvider === 'minimax' ? 'border-blue-600 bg-blue-600 text-white shadow-2xl' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40 hover:opacity-100'}`}>
                      <Mic2 size={32} /> <span className="text-[12px] font-black uppercase tracking-widest">Elite Max</span>
                    </button>
                  </div>
                </div>

                {ttsProvider === 'system' && (
                  <div className="space-y-6">
                    <span className="text-[11px] font-black opacity-30 uppercase tracking-[0.5em] block">Vocal Matrix</span>
                    <div className="relative">
                        <select value={selectedVoiceURI} onChange={(e) => { setSelectedVoiceURI(e.target.value); initAudioContext(); warmUpSpeech(); }} className="w-full p-6 pr-12 rounded-[2.5rem] text-sm font-bold appearance-none bg-zinc-500/5 border-2 border-transparent focus:border-blue-600 outline-none shadow-inner transition-all truncate">
                        {availableVoices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name.replace(/(Microsoft |Google |Natural )/g, '')} ({v.lang})</option>)}
                        </select>
                        <ChevronRight className="absolute right-6 top-1/2 -translate-y-1/2 rotate-90 opacity-40 pointer-events-none" />
                    </div>
                  </div>
                )}

                <div className="space-y-6">
                   <span className="text-[11px] font-black opacity-30 uppercase tracking-[0.5em] block">Environment Gradient</span>
                   <div className="grid grid-cols-3 gap-4">
                      {(['light', 'dark', 'sepia'] as const).map(t => (
                        <button key={t} onClick={() => setTheme(t)} className={`py-6 rounded-3xl text-[13px] font-black capitalize border-2 transition-all ${theme === t ? 'border-blue-600 bg-blue-600 text-white shadow-2xl scale-105' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40 hover:opacity-100'}`}>{t}</button>
                      ))}
                   </div>
                </div>

                <div className="space-y-8">
                  <div className="flex justify-between items-center"><span className="text-[11px] font-black opacity-30 uppercase tracking-[0.5em]">Sync Speed</span><span className="text-lg font-black text-blue-600 bg-blue-600/10 px-4 py-1 rounded-full">{playbackSpeed}x</span></div>
                  <input type="range" min="0.5" max="3.0" step="0.1" value={playbackSpeed} onChange={e => setPlaybackSpeed(parseFloat(e.target.value))} className="w-full h-2 rounded-full appearance-none accent-blue-600" />
                  <div className="flex justify-between px-1 opacity-20 text-[10px] font-black uppercase tracking-widest"><span>Adagio</span><span>Presto</span></div>
                </div>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

// --- Rendering ---
function findBlockIdx(wIdx: number, activeBook: Book | null) {
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
}

createRoot(document.getElementById('root')!).render(<App />);