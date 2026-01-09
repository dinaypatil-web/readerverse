import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Play, Pause, SkipForward, SkipBack, Settings, X, 
  List, Loader2, BookOpen, Trash2, Plus, FileText, Headphones, Bookmark, ChevronRight, Volume2, Globe, Zap, Trash, Check
} from 'lucide-react';
import e from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import { GoogleGenAI, Modality } from "@google/genai";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.mjs`;

// --- Types ---
type TtsProvider = 'system' | 'gemini';

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

interface UserBookmark {
  id: string;
  index: number;
  label: string;
  timestamp: number;
}

interface Book {
  id: string;
  title: string;
  author: string;
  displayBlocks: TextBlock[];
  chapters: ChapterEntry[];
  bookmarks: UserBookmark[];
  type: 'epub' | 'pdf' | 'txt' | 'demo';
  fileData?: ArrayBuffer;
  lastIndex?: number; 
}

// --- Persistence ---
const DB_NAME = 'ReaderVerse_V53_BOOKMARKS';
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

const saveBookToDB = async (book: Book) => {
  const db = await initDB();
  const tx = db.transaction(STORE_BOOKS, 'readwrite');
  tx.objectStore(STORE_BOOKS).put(book);
};

const getBooks = async (): Promise<Book[]> => {
  try {
    const db = await initDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_BOOKS, 'readonly');
      const req = tx.objectStore(STORE_BOOKS).getAll();
      req.onsuccess = () => resolve(req.result.map((b: any) => ({ ...b, bookmarks: b.bookmarks || [] })));
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
            className={`word-highlight relative inline-block mr-[0.28em] px-1.5 py-0.5 rounded-lg cursor-pointer select-none touch-manipulation transition-all duration-75 ${
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
  const isTargetBlock = (idx: number, b: TextBlock) => idx >= b.wordStartIndex && idx < b.wordStartIndex + b.wordCount;
  const prevWasIn = isTargetBlock(prev.currentWordIndex, prev.block);
  const nextIsIn = isTargetBlock(next.currentWordIndex, next.block);
  if (!prevWasIn && !nextIsIn) return prev.fontSize === next.fontSize;
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
  onStatus("Reading EPUB...");
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
    if (i % 5 === 0) onStatus(`Processing... ${Math.round((i/spineItems.length)*100)}%`);
  }
  return { displayBlocks, chapters: chapters.sort((a,b) => a.startIndex - b.startIndex), metadata };
}

async function extractPdf(buffer: ArrayBuffer, onStatus: (s: string) => void): Promise<{ displayBlocks: TextBlock[]; chapters: ChapterEntry[]; metadata: any }> {
  onStatus("Mapping PDF...");
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
    if (i % 10 === 0) onStatus(`Parsing PDF ${i}/${pdf.numPages}...`);
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
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('reader_font_size') || '20'));
  const [pdfScale, setPdfScale] = useState(1.0);
  const [currentPage, setCurrentPage] = useState(1);
  const [theme, setTheme] = useState<'light' | 'dark' | 'sepia'>(() => (localStorage.getItem('reader_theme') as any) || 'light');
  const [playbackSpeed, setPlaybackSpeed] = useState(() => parseFloat(localStorage.getItem('reader_speed') || '1.0'));
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string>(() => localStorage.getItem('reader_voice') || "");
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>(() => (localStorage.getItem('reader_provider') as any) || 'system');
  const [sidebarTab, setSidebarTab] = useState<'chapters' | 'bookmarks'>('chapters');

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const pdfInstanceRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const isPlayingRef = useRef(false);
  const wasPlayingBeforeInterruption = useRef(false);
  const wordIdxRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const speechSessionIdRef = useRef(0);
  const heartbeatRef = useRef<HTMLAudioElement | null>(null);
  const lastSavedIndexRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Settings Persistence
  useEffect(() => localStorage.setItem('reader_font_size', fontSize.toString()), [fontSize]);
  useEffect(() => localStorage.setItem('reader_theme', theme), [theme]);
  useEffect(() => localStorage.setItem('reader_speed', playbackSpeed.toString()), [playbackSpeed]);
  useEffect(() => localStorage.setItem('reader_provider', ttsProvider), [ttsProvider]);
  useEffect(() => { if (selectedVoiceURI) localStorage.setItem('reader_voice', selectedVoiceURI); }, [selectedVoiceURI]);

  // Screen Wake Lock Logic
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.debug('Wake lock acquired');
        wakeLockRef.current.addEventListener('release', () => {
          console.debug('Wake lock released');
        });
      }
    } catch (err) {
      console.error(`${err.name}, ${err.message}`);
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      await wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  }, []);

  // Background audio anchor (Heartbeat)
  useEffect(() => {
    const audio = new Audio();
    audio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA== ";
    audio.loop = true;
    audio.preload = "auto";
    heartbeatRef.current = audio;
    return () => { if (heartbeatRef.current) { heartbeatRef.current.pause(); heartbeatRef.current.src = ""; } };
  }, []);

  // Optimized Voice Loading
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        const sorted = voices.filter(v => v.lang !== "").sort((a, b) => {
          const isNatural = (n: string) => n.includes('Natural') || n.includes('Online') || n.includes('Google') || n.includes('Premium');
          const aN = isNatural(a.name);
          const bN = isNatural(b.name);
          if (aN && !bN) return -1;
          if (!aN && bN) return 1;
          return a.name.localeCompare(b.name);
        });
        setAvailableVoices(sorted);
        
        // If no voice is selected yet, or selected voice no longer exists, choose a high quality default
        if (!selectedVoiceURI) {
          const pref = sorted.find(v => v.default) || sorted.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Premium'))) || sorted[0];
          if (pref) setSelectedVoiceURI(pref.voiceURI);
        }
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    const poll = setInterval(loadVoices, 500);
    return () => { clearInterval(poll); window.speechSynthesis.onvoiceschanged = null; };
  }, [selectedVoiceURI]);

  useEffect(() => {
    getBooks().then(setBooks);
  }, []);

  const totalWordsCount = useMemo(() => {
    if (!activeBook) return 0;
    const blocks = activeBook.displayBlocks;
    const last = blocks[blocks.length - 1];
    return last ? last.wordStartIndex + last.wordCount : 0;
  }, [activeBook]);

  const currentChapter = useMemo(() => {
    if (!activeBook?.chapters.length) return null;
    const chapters = activeBook.chapters;
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (chapters[i].startIndex <= currentWordIndex) return chapters[i];
    }
    return chapters[0];
  }, [activeBook, currentWordIndex]);

  const saveProgressImmediate = useCallback(() => {
    if (activeBook) {
      updateBookProgress(activeBook.id, wordIdxRef.current);
      lastSavedIndexRef.current = wordIdxRef.current;
    }
  }, [activeBook]);

  const saveProgressThrottled = useCallback(() => {
    if (activeBook && Math.abs(wordIdxRef.current - lastSavedIndexRef.current) > 200) {
      saveProgressImmediate();
    }
  }, [activeBook, saveProgressImmediate]);

  const initAudioContext = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
  }, []);

  const updateMediaSessionPosition = useCallback(() => {
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(totalWordsCount, 1),
          playbackRate: playbackSpeed,
          position: Math.min(wordIdxRef.current, totalWordsCount)
        });
      } catch (e) {}
    }
  }, [totalWordsCount, playbackSpeed]);

  const speakNeuralGemini = useCallback(async (text: string, sessionId: number, onEnd: () => void) => {
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
      let lastW = 0; 
      const start = Date.now();
      syncIntervalRef.current = window.setInterval(() => {
        if (sessionId !== speechSessionIdRef.current) { clearInterval(syncIntervalRef.current!); return; }
        const cur = Math.floor(((Date.now() - start) / 1000) / wDur);
        if (cur > lastW && cur < words.length) { 
          lastW = cur; 
          const global = wordIdxRef.current + cur;
          setCurrentWordIndex(global); 
          if (cur % 8 === 0) updateMediaSessionPosition();
        }
      }, 50);
      src.onended = () => { 
        if (syncIntervalRef.current) clearInterval(syncIntervalRef.current); 
        if (sessionId === speechSessionIdRef.current) onEnd(); 
      };
      src.start();
    } catch (e) { throw e; }
  }, [playbackSpeed, initAudioContext, updateMediaSessionPosition]);

  const speak = useCallback(async () => {
    if (!activeBook || !isPlayingRef.current) return;
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    const sId = speechSessionIdRef.current;
    const bIdx = findBlockIdx(wordIdxRef.current, activeBook);
    const block = activeBook.displayBlocks[bIdx];
    if (!block) return;
    const offset = Math.max(0, wordIdxRef.current - block.wordStartIndex);
    const text = block.words.slice(offset).join(" ").trim();
    
    const finish = () => {
      if (sId !== speechSessionIdRef.current) return;
      const next = block.wordStartIndex + block.wordCount;
      if (next < totalWordsCount && isPlayingRef.current) {
        wordIdxRef.current = next;
        setCurrentWordIndex(next);
        saveProgressThrottled();
        setTimeout(() => { if (sId === speechSessionIdRef.current) speak(); }, 15);
      } else {
        setIsPlaying(false); isPlayingRef.current = false;
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        if (heartbeatRef.current) heartbeatRef.current.pause();
        releaseWakeLock();
        saveProgressImmediate();
      }
    };

    if (ttsProvider === 'gemini' && process.env.API_KEY) {
      try { await speakNeuralGemini(text, sId, finish); return; } catch { setTtsProvider('system'); }
    }

    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    const v = availableVoices.find(x => x.voiceURI === selectedVoiceURI) || availableVoices.find(v => v.default) || availableVoices[0];
    if (v) utt.voice = v;
    utt.rate = playbackSpeed;
    utt.onboundary = (e) => {
      if (sId !== speechSessionIdRef.current || e.name !== 'word') return;
      const subStr = text.substring(0, e.charIndex).trim();
      const count = subStr ? subStr.split(/\s+/).length : 0;
      const global = block.wordStartIndex + offset + count;
      if (global >= wordIdxRef.current) { 
        wordIdxRef.current = global; 
        setCurrentWordIndex(global); 
        updateMediaSessionPosition();
      }
    };
    utt.onstart = () => {
      if (sId === speechSessionIdRef.current) {
        if (heartbeatRef.current) heartbeatRef.current.play().catch(()=>{});
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        requestWakeLock();
      }
    };
    utt.onend = () => { if (sId === speechSessionIdRef.current) finish(); };
    utt.onerror = () => { if (sId === speechSessionIdRef.current) finish(); };
    window.speechSynthesis.speak(utt);
  }, [activeBook, availableVoices, selectedVoiceURI, playbackSpeed, totalWordsCount, ttsProvider, speakNeuralGemini, saveProgressThrottled, updateMediaSessionPosition, requestWakeLock, releaseWakeLock, saveProgressImmediate]);

  const togglePlayback = useCallback(() => {
    initAudioContext();
    if (isPlayingRef.current) {
      setIsPlaying(false); isPlayingRef.current = false;
      window.speechSynthesis.cancel();
      if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch(e){}
      speechSessionIdRef.current++;
      if (heartbeatRef.current) heartbeatRef.current.pause();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      saveProgressImmediate();
      releaseWakeLock();
    } else {
      setIsPlaying(true); isPlayingRef.current = true;
      speechSessionIdRef.current++;
      if (heartbeatRef.current) heartbeatRef.current.play().catch(()=>{});
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      requestWakeLock();
      speak();
    }
  }, [speak, initAudioContext, saveProgressImmediate, requestWakeLock, releaseWakeLock]);

  const jumpTo = useCallback((idx: number) => {
    initAudioContext();
    speechSessionIdRef.current++;
    window.speechSynthesis.cancel();
    if (audioSourceRef.current) try { audioSourceRef.current.stop(); } catch(e){}
    const safeIdx = Math.max(0, Math.min(idx, totalWordsCount - 1));
    wordIdxRef.current = safeIdx;
    setCurrentWordIndex(safeIdx);
    updateMediaSessionPosition();
    if (activeBook) updateBookProgress(activeBook.id, safeIdx);
    if (isPlayingRef.current) setTimeout(speak, 50);
  }, [totalWordsCount, speak, activeBook, initAudioContext, updateMediaSessionPosition]);

  // System Interruption Handler (Phone Calls / Interrupted Backgrounding)
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        if (isPlayingRef.current) {
          wasPlayingBeforeInterruption.current = true;
          togglePlayback();
          wasPlayingBeforeInterruption.current = true;
        }
      } else if (document.visibilityState === 'visible') {
        if (wakeLockRef.current !== null && isPlayingRef.current) {
          await requestWakeLock();
        }
        if (wasPlayingBeforeInterruption.current) {
          wasPlayingBeforeInterruption.current = false;
          togglePlayback();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [requestWakeLock, togglePlayback]);

  const addBookmark = useCallback(() => {
    if (!activeBook) return;
    const idx = wordIdxRef.current;
    const bIdx = findBlockIdx(idx, activeBook);
    const block = activeBook.displayBlocks[bIdx];
    const offset = Math.max(0, idx - block.wordStartIndex);
    const snippet = block.words.slice(offset, offset + 10).join(" ") + "...";
    
    const newBookmark: UserBookmark = {
      id: crypto.randomUUID(),
      index: idx,
      label: snippet,
      timestamp: Date.now()
    };

    const updatedBook = { ...activeBook, bookmarks: [...(activeBook.bookmarks || []), newBookmark] };
    setActiveBook(updatedBook);
    saveBookToDB(updatedBook);
    setBooks(prev => prev.map(b => b.id === activeBook.id ? updatedBook : b));
  }, [activeBook]);

  const deleteBookmark = useCallback((id: string) => {
    if (!activeBook) return;
    const updatedBook = { ...activeBook, bookmarks: activeBook.bookmarks.filter(bm => bm.id !== id) };
    setActiveBook(updatedBook);
    saveBookToDB(updatedBook);
    setBooks(prev => prev.map(b => b.id === activeBook.id ? updatedBook : b));
  }, [activeBook]);

  // MediaSession Handlers
  useEffect(() => {
    if ('mediaSession' in navigator && activeBook) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: activeBook.title,
        artist: activeBook.author,
        album: currentChapter?.title || 'Manuscript',
        artwork: [{ src: 'https://cdn-icons-png.flaticon.com/512/3389/3389081.png', sizes: '512x512', type: 'image/png' }]
      });
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      updateMediaSessionPosition();
      
      // Hardware Control Handlers
      navigator.mediaSession.setActionHandler('play', togglePlayback);
      navigator.mediaSession.setActionHandler('pause', togglePlayback);
      navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime !== undefined) jumpTo(Math.floor(d.seekTime)); });
      navigator.mediaSession.setActionHandler('seekbackward', () => jumpTo(wordIdxRef.current - 500));
      navigator.mediaSession.setActionHandler('seekforward', () => jumpTo(wordIdxRef.current + 500));
      
      // Bluetooth Skipping
      navigator.mediaSession.setActionHandler('previoustrack', () => jumpTo(wordIdxRef.current - 1000));
      navigator.mediaSession.setActionHandler('nexttrack', () => jumpTo(wordIdxRef.current + 1000));
      
      // Stop Handler
      navigator.mediaSession.setActionHandler('stop', () => {
        if (isPlayingRef.current) togglePlayback();
      });
    }
  }, [activeBook, isPlaying, currentChapter, updateMediaSessionPosition, togglePlayback, jumpTo]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setIsLoading(true); setLoadingStatus("Optimizing narrative...");
    try {
      const buffer = await file.arrayBuffer();
      const ext = file.name.split('.').pop()?.toLowerCase();
      let res;
      if (ext === 'epub') res = await extractEpub(buffer, setLoadingStatus);
      else if (ext === 'pdf') res = await extractPdf(buffer, setLoadingStatus);
      else {
        const txt = await file.text();
        const ws = txt.split(/\s+/).filter(w => w.length > 0);
        res = { displayBlocks: [{ words: ws, wordStartIndex: 0, wordCount: ws.length }], chapters: [], metadata: { title: file.name } };
      }
      const b: Book = { 
        id: crypto.randomUUID(), 
        title: res.metadata?.title || file.name, 
        author: res.metadata?.creator || 'Unknown', 
        displayBlocks: res.displayBlocks, 
        chapters: res.chapters, 
        bookmarks: [],
        type: ext as any || 'txt', 
        fileData: ext === 'pdf' ? buffer : undefined, 
        lastIndex: 0 
      };
      await saveBookToDB(b);
      setBooks(p => [...p, b]); setActiveBook(b); jumpTo(0); setView('reader');
      if (ext === 'pdf') {
         pdfInstanceRef.current = await pdfjsLib.getDocument({ data: buffer }).promise;
         setReaderMode('pdf');
      } else setReaderMode('reflow');
    } catch { setErrorMsg("Import failed."); } finally { setIsLoading(false); }
  };

  const openBook = async (b: Book) => {
    setActiveBook(b); jumpTo(b.lastIndex || 0); setView('reader');
    if (b.type === 'pdf' && b.fileData) {
      pdfInstanceRef.current = await pdfjsLib.getDocument({ data: b.fileData }).promise;
      setReaderMode('pdf');
    } else setReaderMode('reflow');
  };

  // Performance Scroll Update
  useEffect(() => {
    if (view === 'reader' && readerMode === 'reflow' && activeWordRef.current && scrollContainerRef.current) {
      const c = scrollContainerRef.current;
      const w = activeWordRef.current;
      const targetY = c.getBoundingClientRect().bottom - 450;
      const currentY = w.getBoundingClientRect().top;
      if (Math.abs(currentY - targetY) > 50) {
        c.scrollTo({ top: c.scrollTop + (currentY - targetY), behavior: isPlaying ? 'smooth' : 'auto' });
      }
    }
  }, [currentWordIndex, view, readerMode, isPlaying]);

  const activeTheme = { light: "bg-zinc-50 text-zinc-900", dark: "bg-zinc-950 text-zinc-100", sepia: "bg-[#fdf8ed] text-[#4d3a2b]" }[theme];

  // Windowed Rendering for Reader Performance
  const visibleBlocks = useMemo(() => {
    if (!activeBook) return [];
    const idx = findBlockIdx(currentWordIndex, activeBook);
    return activeBook.displayBlocks.slice(Math.max(0, idx - 10), Math.min(activeBook.displayBlocks.length, idx + 20));
  }, [activeBook, currentWordIndex]);

  return (
    <div className={`fixed inset-0 flex flex-col transition-all duration-700 overflow-hidden select-none touch-none ${activeTheme}`}>
      {isLoading && (
        <div className="fixed inset-0 z-[200] bg-white dark:bg-zinc-950 flex flex-col items-center justify-center animate-in fade-in duration-500">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-6" />
          <h2 className="text-sm font-black uppercase tracking-widest opacity-40">{loadingStatus}</h2>
        </div>
      )}
      
      {errorMsg && (
        <div className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-md flex items-center justify-center p-8">
          <div className="bg-white dark:bg-zinc-900 rounded-[3rem] p-10 shadow-2xl text-center">
            <p className="text-sm font-bold opacity-60 mb-6">{errorMsg}</p>
            <button onClick={() => setErrorMsg(null)} className="px-8 py-3 bg-blue-600 text-white rounded-2xl font-black uppercase">Dismiss</button>
          </div>
        </div>
      )}

      <header className="h-20 flex items-center justify-between px-8 z-50 glass">
        <div className="flex items-center gap-6">
          <button onClick={() => { 
            setIsPlaying(false); 
            isPlayingRef.current = false; 
            window.speechSynthesis.cancel(); 
            if (heartbeatRef.current) heartbeatRef.current.pause();
            saveProgressImmediate();
            releaseWakeLock();
            setView('library'); 
          }} className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-xl active:scale-90 transition-all hover:scale-105"><BookOpen size={24} /></button>
          <div className="overflow-hidden">
            <h1 className="text-[12px] font-black opacity-30 uppercase truncate max-w-[120px] tracking-widest">{view === 'reader' && activeBook ? activeBook.title : 'ReaderVerse'}</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {view === 'reader' && (
            <>
              <button onClick={() => setIsSidebarOpen(true)} className="w-12 h-12 flex items-center justify-center rounded-2xl bg-zinc-500/5 hover:bg-zinc-500/10 transition-all"><List size={22} /></button>
              <button onClick={addBookmark} className="w-12 h-12 flex items-center justify-center rounded-2xl bg-zinc-500/5 hover:bg-zinc-500/10 transition-all text-blue-600"><Bookmark size={22} fill="currentColor" /></button>
              <button onClick={() => setIsSettingsOpen(true)} className="w-12 h-12 flex items-center justify-center rounded-2xl bg-zinc-500/5 hover:bg-zinc-500/10 transition-all"><Settings size={22} /></button>
            </>
          )}
          {view === 'library' && (
            <label className="h-12 bg-blue-600 text-white rounded-2xl shadow-xl cursor-pointer flex items-center gap-3 px-6 active:scale-95 transition-all">
              <Plus size={20} /> <span className="text-[12px] font-black uppercase tracking-widest">Import</span>
              <input type="file" className="hidden" accept=".epub,.pdf,.txt" onChange={handleFileUpload} />
            </label>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative">
        {view === 'library' ? (
          <div className="h-full overflow-y-auto p-10 no-scrollbar">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 pb-32">
              {books.map(b => (
                <div key={b.id} onClick={() => openBook(b)} className="p-8 rounded-[3.5rem] border bg-white dark:bg-zinc-900 dark:border-zinc-800 shadow-xl active:scale-95 transition-all group cursor-pointer hover:shadow-2xl">
                  <div className="flex justify-between mb-8">
                    <div className="w-14 h-14 bg-blue-600/10 text-blue-600 rounded-2xl flex items-center justify-center"><BookOpen size={28} /></div>
                    <button onClick={(e) => { e.stopPropagation(); removeBookFromDB(b.id); setBooks(p => p.filter(x => x.id !== b.id)); }} className="opacity-0 group-hover:opacity-40 p-3 hover:text-red-500 transition-all"><Trash2 size={20}/></button>
                  </div>
                  <h3 className="text-xl font-black mb-2 line-clamp-2">{b.title}</h3>
                  <div className="flex justify-between items-center">
                    <p className="text-[10px] font-black opacity-30 uppercase tracking-widest">{b.type}</p>
                    {b.bookmarks?.length > 0 && <div className="flex items-center gap-1 opacity-40 text-[10px] font-black uppercase"><Bookmark size={10} fill="currentColor"/> {b.bookmarks.length}</div>}
                  </div>
                </div>
              ))}
              {books.length === 0 && (
                <div className="col-span-full py-40 text-center flex flex-col items-center opacity-20">
                    <BookOpen size={64} className="mb-6" />
                    <span className="uppercase font-black tracking-widest text-sm">Library Empty</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {readerMode === 'reflow' ? (
              <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-24 no-scrollbar scroll-smooth">
                <article className="max-w-2xl mx-auto space-y-16 pb-[450px]">
                  {visibleBlocks.map(b => (
                    <WordBlock key={b.wordStartIndex} block={b} currentWordIndex={currentWordIndex} onWordClick={jumpTo} fontSize={fontSize} activeWordRef={activeWordRef} />
                  ))}
                </article>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-6 py-12 bg-zinc-100 dark:bg-zinc-950 no-scrollbar">
                {pdfInstanceRef.current && Array.from({ length: pdfInstanceRef.current.numPages }).map((_, i) => (
                  <PDFPage key={i} pdf={pdfInstanceRef.current!} pageNum={i + 1} scale={pdfScale} onVisible={setCurrentPage} />
                ))}
              </div>
            )}
            
            <div className="absolute bottom-10 left-0 right-0 px-6 z-50 pointer-events-none flex justify-center">
              <div className="w-full max-w-lg glass pointer-events-auto rounded-full border border-white/20 dark:border-white/5 shadow-[0_25px_60px_rgba(0,0,0,0.15)] overflow-hidden flex flex-col">
                <div className="w-full h-[3px] bg-zinc-500/10 flex">
                   <div 
                    className="h-full bg-blue-600 transition-all duration-300 shadow-[0_0_8px_rgba(37,99,235,0.6)]" 
                    style={{ width: `${(currentWordIndex / Math.max(1, totalWordsCount)) * 100}%` }} 
                   />
                </div>

                <div className="px-3 py-2.5 flex items-center justify-between gap-1">
                  <button 
                    onClick={() => setIsSettingsOpen(true)} 
                    className="h-10 px-4 rounded-full bg-zinc-500/5 flex items-center justify-center active:scale-95 transition-all group"
                  >
                    <span className="text-[10px] font-black text-blue-600/60 group-hover:text-blue-600">{playbackSpeed}x</span>
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button 
                        onClick={() => jumpTo(wordIdxRef.current - 500)} 
                        className="w-10 h-10 flex items-center justify-center rounded-full opacity-40 hover:opacity-100 active:scale-90 transition-all"
                    >
                        <SkipBack size={20} fill="currentColor" />
                    </button>
                    
                    <button 
                        onClick={togglePlayback} 
                        className="w-14 h-14 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-lg active:scale-95 transition-all hover:bg-blue-500"
                    >
                      {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-0.5" />}
                    </button>
                    
                    <button 
                        onClick={() => jumpTo(wordIdxRef.current + 500)} 
                        className="w-10 h-10 flex items-center justify-center rounded-full opacity-40 hover:opacity-100 active:scale-90 transition-all"
                    >
                        <SkipForward size={20} fill="currentColor" />
                    </button>
                  </div>

                  <button 
                    onClick={addBookmark}
                    className="w-10 h-10 flex items-center justify-center rounded-full bg-zinc-500/5 text-blue-600 active:scale-95 transition-all"
                  >
                    <Bookmark size={20} fill="currentColor" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {isSidebarOpen && (
        <div className="fixed inset-0 z-[100] flex animate-in fade-in">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-md" onClick={() => setIsSidebarOpen(false)} />
          <div className="relative w-[85%] max-w-sm h-full flex flex-col shadow-2xl animate-in slide-in-from-left glass">
            <div className="p-10 border-b border-zinc-500/5 flex justify-between items-center">
              <div className="flex gap-4">
                <button 
                  onClick={() => setSidebarTab('chapters')} 
                  className={`text-[11px] font-black uppercase tracking-widest transition-all ${sidebarTab === 'chapters' ? 'text-blue-600 scale-110' : 'opacity-30'}`}
                >
                  Chapters
                </button>
                <button 
                  onClick={() => setSidebarTab('bookmarks')} 
                  className={`text-[11px] font-black uppercase tracking-widest transition-all ${sidebarTab === 'bookmarks' ? 'text-blue-600 scale-110' : 'opacity-30'}`}
                >
                  Bookmarks
                </button>
              </div>
              <button onClick={() => setIsSidebarOpen(false)} className="p-3 bg-zinc-500/5 rounded-full"><X size={20}/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar no-scrollbar">
              {sidebarTab === 'chapters' ? (
                activeBook?.chapters.map((c, i) => (
                  <button key={i} onClick={() => { jumpTo(c.startIndex); setIsSidebarOpen(false); }} className={`w-full text-left p-6 rounded-[2.5rem] text-[11px] font-bold transition-all ${currentChapter === c ? 'bg-blue-600 text-white shadow-xl scale-[1.02]' : 'opacity-40 bg-zinc-500/5 hover:opacity-100'}`}>
                    {c.title}
                  </button>
                ))
              ) : (
                <>
                  {(!activeBook?.bookmarks || activeBook.bookmarks.length === 0) && (
                    <div className="py-20 text-center opacity-20 uppercase font-black tracking-widest text-[10px]">No Bookmarks</div>
                  )}
                  {activeBook?.bookmarks?.sort((a,b) => b.timestamp - a.timestamp).map((bm) => (
                    <div key={bm.id} className="relative group">
                      <button onClick={() => { jumpTo(bm.index); setIsSidebarOpen(false); }} className="w-full text-left p-6 pr-12 rounded-[2.5rem] bg-zinc-500/5 hover:bg-zinc-500/10 transition-all">
                        <p className="text-[10px] font-black opacity-30 uppercase tracking-widest mb-2">{new Date(bm.timestamp).toLocaleDateString()}</p>
                        <p className="text-[11px] font-bold italic line-clamp-2 opacity-80 leading-relaxed">"{bm.label}"</p>
                      </button>
                      <button 
                        onClick={() => deleteBookmark(bm.id)} 
                        className="absolute right-4 top-1/2 -translate-y-1/2 p-2 opacity-0 group-hover:opacity-40 hover:!opacity-100 text-red-500 transition-all"
                      >
                        <Trash size={16} />
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 z-[110] flex items-end animate-in fade-in">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={() => setIsSettingsOpen(false)} />
          <div className="relative w-full rounded-t-[5rem] p-10 pb-20 border-t border-white/10 animate-in slide-in-from-bottom glass max-h-[90vh] overflow-y-auto no-scrollbar shadow-5xl">
             <div className="w-12 h-1.5 bg-zinc-500/10 rounded-full mx-auto mb-10" />
             <div className="flex justify-between items-center mb-12">
               <h2 className="text-2xl font-black uppercase tracking-widest opacity-60">Architect</h2>
               <button onClick={() => setIsSettingsOpen(false)} className="p-4 bg-zinc-500/10 rounded-full active:scale-90 transition-all"><X size={24}/></button>
             </div>
             <div className="max-w-xl mx-auto space-y-12 pb-10">
                <div className="space-y-6">
                  <span className="text-[11px] font-black opacity-30 uppercase tracking-widest block">Neural Provider</span>
                  <div className="grid grid-cols-2 gap-4">
                    <button onClick={() => setTtsProvider('system')} className={`flex flex-col items-center gap-3 p-6 rounded-3xl border-2 transition-all ${ttsProvider === 'system' ? 'border-blue-600 bg-blue-600 text-white shadow-xl' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40'}`}>
                        <Globe size={24} />
                        <span className="text-xs font-black uppercase">System</span>
                    </button>
                    <button onClick={() => setTtsProvider('gemini')} className={`flex flex-col items-center gap-3 p-6 rounded-3xl border-2 transition-all ${ttsProvider === 'gemini' ? 'border-blue-600 bg-blue-600 text-white shadow-xl' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40'}`}>
                        <Zap size={24} />
                        <span className="text-xs font-black uppercase">Neural AI</span>
                    </button>
                  </div>
                </div>
                {ttsProvider === 'system' && (
                  <div className="space-y-6">
                    <div className="flex justify-between items-center">
                        <span className="text-[11px] font-black opacity-30 uppercase tracking-widest block">Vocal Matrix (App Default)</span>
                        <span className="text-[10px] font-black text-blue-600 bg-blue-600/10 px-3 py-1 rounded-full uppercase">{availableVoices.length} Voices</span>
                    </div>
                    <div className="relative group">
                        <select 
                          value={selectedVoiceURI} 
                          onChange={e => { setSelectedVoiceURI(e.target.value); initAudioContext(); }} 
                          className="w-full p-6 pr-12 rounded-[2.5rem] bg-zinc-500/5 border-2 border-transparent focus:border-blue-600 outline-none font-bold appearance-none dark:text-white transition-all truncate shadow-inner"
                        >
                          {availableVoices.length === 0 ? <option>Initializing Matrix...</option> : availableVoices.map(v => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                              {v.default ? '★ ' : ''}{v.name.replace(/(Microsoft |Google |Natural |Online |Premium )/g, '')} ({v.lang}) {v.default ? '(System Default)' : ''}
                            </option>
                          ))}
                        </select>
                        <ChevronRight className="absolute right-6 top-1/2 -translate-y-1/2 rotate-90 opacity-40 pointer-events-none" />
                    </div>
                    <p className="text-[10px] font-bold opacity-30 text-center uppercase tracking-widest">Selected voice is now the default for all books on this device.</p>
                  </div>
                )}
                <div className="space-y-6">
                  <div className="flex justify-between items-center"><span className="text-[11px] font-black opacity-30 uppercase tracking-widest">Typeface Size</span><span className="text-xl font-black text-blue-600">{fontSize}px</span></div>
                  <input type="range" min="14" max="32" step="1" value={fontSize} onChange={e => setFontSize(parseInt(e.target.value))} className="w-full h-2 rounded-full appearance-none accent-blue-600 bg-zinc-500/10" />
                </div>
                <div className="space-y-6">
                   <span className="text-[11px] font-black opacity-30 uppercase tracking-widest block">Theme Gradient</span>
                   <div className="grid grid-cols-3 gap-4">
                      {(['light', 'dark', 'sepia'] as const).map(t => (
                        <button key={t} onClick={() => setTheme(t)} className={`py-4 rounded-2xl text-xs font-black capitalize border-2 transition-all ${theme === t ? 'border-blue-600 bg-blue-600 text-white shadow-xl scale-105' : 'border-zinc-500/5 bg-zinc-500/5 opacity-40'}`}>{t}</button>
                      ))}
                   </div>
                </div>
                <div className="space-y-6">
                  <div className="flex justify-between items-center"><span className="text-[11px] font-black opacity-30 uppercase tracking-widest">Pace</span><span className="text-xl font-black text-blue-600">{playbackSpeed}x</span></div>
                  <input type="range" min="0.5" max="3.0" step="0.1" value={playbackSpeed} onChange={e => setPlaybackSpeed(parseFloat(e.target.value))} className="w-full h-2 rounded-full appearance-none accent-blue-600 bg-zinc-500/10" />
                </div>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);