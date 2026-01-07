import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Play, Pause, SkipForward, SkipBack, Settings, X, Check, 
  List, Loader2, BookOpen, Trash2, Plus, Clock, Info, AlertCircle, 
  Zap, ZoomIn, ZoomOut, Maximize2, FileText, Headphones, Bookmark
} from 'lucide-react';
import e from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';

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
  lastPosition: number;
  type: 'epub' | 'pdf' | 'txt' | 'demo';
  fileData?: ArrayBuffer;
}

// --- Persistence ---
const DB_NAME = 'ReaderVerse_V15_ULTRA';
const STORE_NAME = 'books';

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (ev: any) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveBookToDB = async (book: Book) => {
  const db = await initDB();
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(book);
};

const getBooks = async (): Promise<Book[]> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
  });
};

const removeBookFromDB = async (id: string) => {
  const db = await initDB();
  db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
};

// --- Specialized Components ---

const WordBlock = memo(({ block, currentWordIndex, onWordClick, fontSize, activeWordRef }: { 
  block: TextBlock, 
  currentWordIndex: number, 
  onWordClick: (idx: number) => void,
  fontSize: number,
  activeWordRef: React.RefObject<HTMLSpanElement | null>
}) => {
  return (
    <p className="font-serif leading-relaxed text-left transition-all duration-300" style={{ fontSize: `${fontSize}px` }}>
      {block.words.map((word, wIdx) => {
        const globalIdx = block.wordStartIndex + wIdx;
        const isCurrent = currentWordIndex === globalIdx;
        return (
          <span 
            key={wIdx} 
            ref={isCurrent ? activeWordRef : null}
            onClick={() => onWordClick(globalIdx)}
            className={`inline-block mr-[0.25em] px-1 py-0.5 rounded-lg transition-all duration-150 cursor-pointer select-none ${isCurrent ? 'bg-blue-600 text-white shadow-lg scale-110 font-bold z-10' : 'opacity-70'}`}
          >
            {word}
          </span>
        );
      })}
    </p>
  );
}, (prev, next) => {
  const prevWasActive = prev.currentWordIndex >= prev.block.wordStartIndex && prev.currentWordIndex < prev.block.wordStartIndex + prev.block.wordCount;
  const nextIsActive = next.currentWordIndex >= next.block.wordStartIndex && next.currentWordIndex < next.block.wordStartIndex + next.block.wordCount;
  if (!prevWasActive && !nextIsActive) return true;
  return prev.currentWordIndex === next.currentWordIndex && prev.fontSize === next.fontSize;
});

const PDFPage = memo(({ pdf, pageNum, scale, onVisible }: { pdf: pdfjsLib.PDFDocumentProxy, pageNum: number, scale: number, onVisible: (n: number) => void }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onVisible(pageNum);
    }, { threshold: 0.3 });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [pageNum, onVisible]);

  useEffect(() => {
    let renderTask: any;
    const render = async () => {
      if (!canvasRef.current) return;
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      renderTask = page.render({ canvasContext: context, viewport });
      await renderTask.promise;

      if (textLayerRef.current) {
        textLayerRef.current.innerHTML = '';
        textLayerRef.current.style.width = `${viewport.width}px`;
        textLayerRef.current.style.height = `${viewport.height}px`;
        const textContent = await page.getTextContent();
        pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayerRef.current,
          viewport: viewport,
        });
      }
    };
    render();
    return () => renderTask?.cancel();
  }, [pdf, pageNum, scale]);

  return (
    <div ref={containerRef} className="relative mb-8 shadow-2xl mx-auto flex flex-col items-center bg-white dark:bg-zinc-800 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700 transition-transform duration-300">
      <div className="relative" style={{ width: 'fit-content' }}>
        <canvas ref={canvasRef} />
        <div ref={textLayerRef} className="absolute inset-0 pointer-events-auto text-transparent selection:bg-blue-600/30" />
      </div>
      <div className="py-3 text-[10px] font-black opacity-30 uppercase tracking-[0.2em]">P.{pageNum}</div>
    </div>
  );
});

// --- Utility & Parsers ---

function walkNodes(node: Node, results: string[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    const val = node.textContent?.trim();
    if (val && val.length > 0) results.push(String(val));
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node as Element).tagName.toUpperCase();
    if (['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'SVG', 'NOSCRIPT'].includes(tag)) return;
    for (let i = 0; i < node.childNodes.length; i++) walkNodes(node.childNodes[i], results);
    if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BR', 'TR', 'BLOCKQUOTE'].includes(tag)) results.push("\n");
  }
}

async function extractEpub(buffer: ArrayBuffer, onStatus: (s: string) => void): Promise<{ displayBlocks: TextBlock[]; chapters: ChapterEntry[]; metadata: any }> {
  const book = e(buffer);
  onStatus("Unpacking Manuscript...");
  await book.opened;
  const metadata = await (book as any).loaded.metadata;
  const navigation = await (book as any).loaded.navigation;
  const toc = navigation ? (navigation.toc || []) : [];
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
      let rawHtml: string | null = await book.archive.getText(url);
      if (!rawHtml) continue;
      
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, "text/html");
      const foundTextParts: string[] = [];
      walkNodes(doc.body || doc.documentElement, foundTextParts);
      
      const itemHref = item.href?.split('#')[0].replace(/^\.\//, '');
      const matchingToc = toc.find((t: any) => {
        const tocHref = t.href?.split('#')[0].replace(/^\.\//, '');
        return itemHref === tocHref || itemHref.endsWith(tocHref) || tocHref.endsWith(itemHref);
      });

      if (matchingToc) {
        chapters.push({ title: matchingToc.label?.trim() || `Chapter ${chapters.length + 1}`, startIndex: totalWordCount });
      }
      
      const chapterText = foundTextParts.join(" ").replace(/\s+/g, ' ').trim();
      if (chapterText.length > 0) {
        const paragraphs = chapterText.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
        paragraphs.forEach(pText => {
          const words = pText.split(/\s+/).filter(w => w.length > 0);
          if (words.length > 0) {
            displayBlocks.push({ words, wordStartIndex: totalWordCount, wordCount: words.length });
            totalWordCount += words.length;
          }
        });
      }
    } catch (err) { console.warn(`Extraction error:`, err); }
    if (i % 5 === 0) { onStatus(`Indexing ${i}/${spineItems.length}...`); await new Promise(r => setTimeout(r, 0)); }
  }
  return { displayBlocks, chapters, metadata };
}

async function extractPdf(buffer: ArrayBuffer, onStatus: (s: string) => void): Promise<{ displayBlocks: TextBlock[]; chapters: ChapterEntry[]; metadata: any }> {
  onStatus("Indexing PDF...");
  const pdf = await pdfjsLib.getDocument({ data: buffer, useSystemFonts: true }).promise;
  const displayBlocks: TextBlock[] = [];
  const chapters: ChapterEntry[] = [];
  let totalWordCount = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    onStatus(`Page ${i}/${pdf.numPages}`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it: any) => it.str).join(" ").replace(/\s+/g, ' ').trim();
    if (pageText) {
      const words = pageText.split(/\s+/).filter(w => w.length > 0);
      if (words.length > 0) {
        displayBlocks.push({ words, wordStartIndex: totalWordCount, wordCount: words.length });
        if (i === 1 || i % 10 === 0) {
          chapters.push({ title: `Page ${i}`, startIndex: totalWordCount, pageNumber: i });
        }
        totalWordCount += words.length;
      }
    }
    page.cleanup();
  }
  return { displayBlocks, chapters, metadata: await pdf.getMetadata() };
}

// --- Main Application ---

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

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const pdfInstanceRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const isPlayingRef = useRef(false);
  const currentWordIndexRef = useRef(0);

  // Cross-browser voice loading with intensive mobile support
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      // Prioritize high-quality neural voices
      const sorted = voices
        .filter(v => v.lang.startsWith('en'))
        .sort((a, b) => {
          const keywords = ['Microsoft', 'Edge', 'Google', 'Natural', 'Premium'];
          const aPrio = keywords.findIndex(k => a.name.includes(k));
          const bPrio = keywords.findIndex(k => b.name.includes(k));
          return (aPrio === -1 ? 99 : aPrio) - (bPrio === -1 ? 99 : bPrio);
        });

      setAvailableVoices(sorted);
      if (sorted.length > 0 && !selectedVoiceURI) {
        setSelectedVoiceURI(sorted[0].voiceURI);
      }
    };
    
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    const interval = setInterval(() => {
      if (window.speechSynthesis.getVoices().length > 0) {
        loadVoices();
        clearInterval(interval);
      }
    }, 800);

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
      clearInterval(interval);
    };
  }, [selectedVoiceURI]);

  useEffect(() => {
    getBooks().then(stored => {
      setBooks(stored);
      if (stored.length === 0) {
        setBooks([{
          id: 'demo', title: 'ReaderVerse Ultra Sync', author: 'Team ReaderVerse',
          displayBlocks: [{ words: "Welcome. This pro edition features precision auto-scroll and seamless continuous reading. Tap a word or hit play to begin.".split(" "), wordStartIndex: 0, wordCount: 20 }],
          chapters: [{ title: 'Intro', startIndex: 0 }], lastPosition: 0, type: 'demo'
        }]);
      }
    });
  }, []);

  useEffect(() => {
    if (activeBook?.type === 'pdf' && activeBook.fileData) {
      pdfjsLib.getDocument({ data: activeBook.fileData }).promise.then(p => {
        pdfInstanceRef.current = p;
      });
      setReaderMode('pdf');
    } else {
      setReaderMode('reflow');
    }
  }, [activeBook]);

  // Precision Auto-Scroll: word being read shall appear 3 lines above the audio control
  useEffect(() => {
    if (view === 'reader' && readerMode === 'reflow' && activeWordRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const word = activeWordRef.current;
      const containerRect = container.getBoundingClientRect();
      const wordRect = word.getBoundingClientRect();
      
      // Control bar is approx 240px from bottom on mobile. 
      // 3 lines of text is approx 90px.
      // Word center should be approx 330px above container bottom.
      const targetFromBottom = 330; 
      const targetY = containerRect.bottom - targetFromBottom;
      const currentY = wordRect.top + (wordRect.height / 2);
      
      if (Math.abs(currentY - targetY) > 30) {
        const scrollDiff = currentY - targetY;
        container.scrollTo({
          top: container.scrollTop + scrollDiff,
          behavior: 'smooth'
        });
      }
    }
  }, [currentWordIndex, view, readerMode]);

  const totalWords = useMemo(() => {
    if (!activeBook) return 0;
    const lastBlock = activeBook.displayBlocks[activeBook.displayBlocks.length - 1];
    return lastBlock ? lastBlock.wordStartIndex + lastBlock.wordCount : 0;
  }, [activeBook]);

  const currentChapter = useMemo(() => {
    if (!activeBook) return null;
    let activeChapter = activeBook.chapters[0];
    for (const ch of activeBook.chapters) {
      if (currentWordIndex >= ch.startIndex) {
        activeChapter = ch;
      } else {
        break;
      }
    }
    return activeChapter;
  }, [activeBook, currentWordIndex]);

  const findBlockForWord = useCallback((wordIdx: number) => {
    if (!activeBook) return 0;
    let low = 0, high = activeBook.displayBlocks.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const b = activeBook.displayBlocks[mid];
      if (wordIdx >= b.wordStartIndex && wordIdx < b.wordStartIndex + b.wordCount) return mid;
      if (wordIdx < b.wordStartIndex) high = mid - 1;
      else low = mid + 1;
    }
    return 0;
  }, [activeBook]);

  const saveProgress = useCallback((idx: number) => {
    if (!activeBook) return;
    activeBook.lastPosition = idx;
    saveBookToDB(activeBook);
    setBooks(prev => prev.map(b => b.id === activeBook.id ? { ...b, lastPosition: idx } : b));
  }, [activeBook]);

  // Stable speak function that pulls latest ref values
  const speakCurrentBlock = useCallback(() => {
    if (!activeBook || !isPlayingRef.current) return;
    window.speechSynthesis.cancel();
    
    const indexAtStart = currentWordIndexRef.current;
    const blockIdx = findBlockForWord(indexAtStart);
    const block = activeBook.displayBlocks[blockIdx];
    if (!block) return;

    const relativeWordIdx = indexAtStart - block.wordStartIndex;
    const wordsSlice = block.words.slice(relativeWordIdx);
    const textToSpeak = wordsSlice.join(" ");

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    const voice = availableVoices.find(v => v.voiceURI === selectedVoiceURI);
    if (voice) utterance.voice = voice;
    utterance.rate = playbackSpeed;

    // Normalizing boundary events for all engines
    utterance.onboundary = (event) => {
      if (event.name === 'word') {
        const charIdx = event.charIndex;
        // Robust word mapping logic for non-Microsoft engines
        const textBefore = textToSpeak.substring(0, charIdx).trim();
        const wordsBeforeCount = textBefore.length > 0 ? textBefore.split(/\s+/).length : 0;
        const newGlobalIndex = block.wordStartIndex + relativeWordIdx + wordsBeforeCount;
        
        if (newGlobalIndex > currentWordIndexRef.current) {
          currentWordIndexRef.current = newGlobalIndex;
          setCurrentWordIndex(newGlobalIndex);
          if (newGlobalIndex % 15 === 0) saveProgress(newGlobalIndex);
        }
      }
    };

    utterance.onend = () => {
      if (isPlayingRef.current) {
        const nextWordIndex = block.wordStartIndex + block.wordCount;
        if (nextWordIndex < totalWords) {
          currentWordIndexRef.current = nextWordIndex;
          setCurrentWordIndex(nextWordIndex);
          saveProgress(nextWordIndex);
          
          // Continuous Reading & Chapter Bookmarking
          const nextCh = activeBook.chapters.find(c => c.startIndex === nextWordIndex);
          if (nextCh) {
            console.log(`Bookmarking next chapter: ${nextCh.title}`);
          }

          // Mobile-friendly recursive call
          setTimeout(() => {
            if (isPlayingRef.current) speakCurrentBlock();
          }, 100);
        } else {
          setIsPlaying(false);
          isPlayingRef.current = false;
        }
      }
    };

    utterance.onerror = (e) => {
      console.warn('TTS Engine Error:', e);
      if (isPlayingRef.current) {
         setTimeout(speakCurrentBlock, 500); // Retry after error
      }
    };

    window.speechSynthesis.speak(utterance);
  }, [activeBook, availableVoices, selectedVoiceURI, playbackSpeed, findBlockForWord, totalWords, saveProgress]);

  const togglePlayback = () => {
    if (isPlaying) {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
      isPlayingRef.current = false;
      saveProgress(currentWordIndexRef.current);
    } else {
      setIsPlaying(true);
      isPlayingRef.current = true;
      speakCurrentBlock();
    }
  };

  const jumpToWord = (idx: number) => {
    currentWordIndexRef.current = idx;
    setCurrentWordIndex(idx);
    saveProgress(idx);
    if (isPlayingRef.current) {
      window.speechSynthesis.cancel();
      setTimeout(speakCurrentBlock, 150);
    }
  };

  const seek = (amount: number) => {
    const next = Math.max(0, Math.min(totalWords - 1, currentWordIndexRef.current + amount));
    jumpToWord(next);
  };

  const handleFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    setIsLoading(true);
    setLoadingStatus("Decompressing Ebook...");
    try {
      const buffer = await file.arrayBuffer();
      const ext = file.name.split('.').pop()?.toLowerCase();
      let extracted;
      if (ext === 'epub') extracted = await extractEpub(buffer, setLoadingStatus);
      else if (ext === 'pdf') extracted = await extractPdf(buffer, setLoadingStatus);
      else {
        const text = await file.text();
        const words = text.split(/\s+/).filter(w => w.length > 0);
        extracted = { displayBlocks: [{ words, wordStartIndex: 0, wordCount: words.length }] as TextBlock[], chapters: [], metadata: { title: file.name } };
      }
      const newBook: Book = {
        id: crypto.randomUUID(),
        title: extracted.metadata?.title || file.name,
        author: extracted.metadata?.creator || 'Unknown Author',
        displayBlocks: extracted.displayBlocks,
        chapters: extracted.chapters,
        lastPosition: 0,
        type: ext as any || 'txt',
        fileData: ext === 'pdf' ? buffer : undefined
      };
      await saveBookToDB(newBook);
      setBooks(prev => [...prev, newBook]);
      setActiveBook(newBook);
      setView('reader');
      currentWordIndexRef.current = 0;
      setCurrentWordIndex(0);
    } catch (err: any) { setErrorMsg(err.message || "Failed to parse document."); } 
    finally { setIsLoading(false); }
  };

  const visibleBlocks = useMemo(() => {
    if (!activeBook) return [];
    const currentBlockIdx = findBlockForWord(currentWordIndex);
    return activeBook.displayBlocks.slice(Math.max(0, currentBlockIdx - 10), Math.min(activeBook.displayBlocks.length, currentBlockIdx + 25));
  }, [activeBook, currentWordIndex, findBlockForWord]);

  const themeClasses = {
    light: "bg-[#fcfcfd] text-[#1a1a1b] border-zinc-200",
    dark: "bg-[#0b0c0d] text-[#f0f0f0] border-zinc-800",
    sepia: "bg-[#f4ebd4] text-[#4d3a2b] border-[#e4d4b8]"
  }[theme];

  return (
    <div className={`fixed inset-0 flex flex-col transition-colors duration-700 overflow-hidden ${themeClasses}`}>
      
      {isLoading && (
        <div className="fixed inset-0 z-[200] bg-black/95 backdrop-blur-3xl flex flex-col items-center justify-center text-white animate-in fade-in">
          <Loader2 className="w-16 h-16 animate-spin text-blue-500 mb-8" />
          <h2 className="text-3xl font-black mb-2 tracking-tighter">ReaderVerse Pro</h2>
          <p className="opacity-40 text-[11px] tracking-[0.3em] uppercase font-bold">{loadingStatus}</p>
        </div>
      )}

      {errorMsg && (
        <div className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-xl flex items-center justify-center p-8">
          <div className="bg-white dark:bg-zinc-900 rounded-[3rem] p-10 max-w-sm w-full shadow-4xl text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mb-6 mx-auto" />
            <p className="text-sm opacity-60 mb-8">{errorMsg}</p>
            <button onClick={() => setErrorMsg(null)} className="w-full py-4 bg-blue-600 text-white font-black rounded-2xl active:scale-95 transition-all">Retry</button>
          </div>
        </div>
      )}

      <header className={`h-20 flex items-center justify-between px-6 border-b z-50 transition-all ${themeClasses}`}>
        <div className="flex items-center gap-4">
          <div onClick={() => { window.speechSynthesis.cancel(); isPlayingRef.current = false; setView('library'); }} className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-xl cursor-pointer active:scale-90 transition-all">
            <BookOpen size={20} />
          </div>
          <div className="overflow-hidden">
            <h1 className="text-xs font-black tracking-tight truncate max-w-[120px] leading-tight opacity-40 uppercase">{view === 'reader' && activeBook ? activeBook.title : 'ReaderVerse'}</h1>
            {view === 'reader' && (
              <div className="text-[10px] font-bold text-blue-600 truncate max-w-[160px] flex items-center gap-1.5 animate-in slide-in-from-left duration-300">
                <Bookmark size={10} className="fill-blue-600" />
                {readerMode === 'pdf' ? `Page ${currentPage}` : (currentChapter?.title || 'Main Story')}
              </div>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {view === 'reader' && (
            <>
              {activeBook?.type === 'pdf' && (
                <button 
                  onClick={() => setReaderMode(prev => prev === 'pdf' ? 'reflow' : 'pdf')} 
                  className={`p-2.5 rounded-xl transition-all ${readerMode === 'pdf' ? 'bg-blue-600 text-white shadow-lg' : 'bg-black/5 dark:bg-white/5'}`}
                >
                  {readerMode === 'pdf' ? <Headphones size={20} /> : <FileText size={20} />}
                </button>
              )}
              <button onClick={() => setIsSidebarOpen(true)} className="p-2.5 rounded-xl bg-black/5 dark:bg-white/5 active:scale-90 transition-all"><List size={20} /></button>
              <button onClick={() => setIsSettingsOpen(true)} className="p-2.5 rounded-xl bg-black/5 dark:bg-white/5 active:scale-90 transition-all"><Settings size={20} /></button>
            </>
          )}
          {view === 'library' && (
            <label className="p-2.5 bg-blue-600 text-white rounded-xl shadow-lg cursor-pointer flex items-center gap-2 px-5 active:scale-95 transition-all">
              <Plus size={18} /> <span className="text-[10px] font-black uppercase tracking-widest">Library</span>
              <input type="file" className="hidden" accept=".epub,.pdf,.txt" onChange={handleFile} />
            </label>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative">
        {view === 'library' ? (
          <div className="h-full overflow-y-auto p-6 no-scrollbar animate-in slide-in-from-bottom duration-500">
            <div className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-6">
              {books.map(book => (
                <div key={book.id} onClick={() => { setActiveBook(book); currentWordIndexRef.current = book.lastPosition || 0; setCurrentWordIndex(book.lastPosition || 0); setView('reader'); }} className={`group p-6 rounded-[2.5rem] border-2 cursor-pointer transition-all active:scale-[0.98] ${theme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-zinc-100'}`}>
                  <div className="flex items-center justify-between mb-6">
                    <div className="w-10 h-10 bg-blue-600/10 text-blue-600 rounded-xl flex items-center justify-center font-black text-[10px] uppercase tracking-widest">{book.type}</div>
                    <button onClick={(e) => { e.stopPropagation(); removeBookFromDB(book.id); setBooks(b => b.filter(x => x.id !== book.id)); }} className="text-red-500 opacity-0 group-hover:opacity-40 hover:!opacity-100 p-2 transition-all"><Trash2 size={18}/></button>
                  </div>
                  <h3 className="text-xl font-black mb-1 line-clamp-2 tracking-tight transition-colors group-hover:text-blue-600">{book.title}</h3>
                  <p className="text-[9px] uppercase font-bold tracking-[0.3em] opacity-30">{book.author}</p>
                  <div className="mt-5 flex items-center gap-2 opacity-20">
                    <Clock size={10} />
                    <span className="text-[8px] font-black uppercase tracking-widest">Saved Progress: {book.lastPosition} words</span>
                  </div>
                </div>
              ))}
              {books.length === 0 && (
                <div className="col-span-full py-32 text-center opacity-20 font-black uppercase tracking-[0.4em]">Shelf Empty</div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {readerMode === 'reflow' ? (
              <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-20 no-scrollbar scroll-smooth">
                <article className="max-w-xl mx-auto space-y-12 pb-[550px]">
                  {visibleBlocks.map((block, i) => (
                    <WordBlock 
                      key={`${block.wordStartIndex}-${i}`} 
                      block={block} 
                      currentWordIndex={currentWordIndex} 
                      onWordClick={jumpToWord} 
                      fontSize={fontSize} 
                      activeWordRef={activeWordRef}
                    />
                  ))}
                </article>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-4 py-8 bg-zinc-100 dark:bg-zinc-950 no-scrollbar scroll-smooth">
                {pdfInstanceRef.current && (
                  <div className="max-w-4xl mx-auto flex flex-col items-center">
                    {Array.from({ length: pdfInstanceRef.current.numPages }).map((_, i) => (
                      <PDFPage 
                        key={i} 
                        pdf={pdfInstanceRef.current!} 
                        pageNum={i + 1} 
                        scale={pdfScale} 
                        onVisible={setCurrentPage} 
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            
            <div className="absolute bottom-10 left-0 right-0 px-4 z-50 pointer-events-none">
              <div className={`max-w-md mx-auto pointer-events-auto backdrop-blur-3xl border p-5 rounded-[4rem] shadow-4xl animate-in slide-in-from-bottom duration-500 ${theme === 'dark' ? 'bg-zinc-900/95 border-zinc-800' : 'bg-white/95 border-zinc-200'}`}>
                {readerMode === 'reflow' ? (
                  <>
                    <div className="w-full h-1.5 bg-black/5 dark:bg-white/10 rounded-full mb-6 overflow-hidden">
                      <div className="h-full bg-blue-600 transition-all duration-300 shadow-[0_0_15px_rgba(37,99,235,0.7)]" style={{ width: `${(currentWordIndex / Math.max(1, totalWords)) * 100}%` }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <button onClick={() => setIsSettingsOpen(true)} className="w-12 h-12 rounded-2xl bg-black/5 flex items-center justify-center hover:bg-black/10 active:scale-90 transition-all">
                        <span className="text-[10px] font-black">{playbackSpeed}x</span>
                      </button>
                      <div className="flex items-center gap-6">
                        <button onClick={() => seek(-15)} className="opacity-30 active:scale-90 transition-all hover:opacity-60"><SkipBack size={30} fill="currentColor" /></button>
                        <button onClick={togglePlayback} className="w-16 h-16 bg-blue-600 text-white rounded-[2.5rem] flex items-center justify-center shadow-2xl active:scale-90 transition-all">
                          {isPlaying ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" className="ml-1" />}
                        </button>
                        <button onClick={() => seek(15)} className="opacity-30 active:scale-90 transition-all hover:opacity-60"><SkipForward size={30} fill="currentColor" /></button>
                      </div>
                      <div className="w-12 h-12 flex flex-col items-center justify-center">
                        <Clock size={16} className="opacity-20 mb-1" />
                        <span className="text-[8px] font-black opacity-30">{Math.ceil((totalWords - currentWordIndex) / 165)}m</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between px-3">
                    <div className="flex items-center gap-3">
                      <button onClick={() => setPdfScale(s => Math.max(0.5, s - 0.25))} className="p-3 bg-black/5 rounded-2xl active:scale-90"><ZoomOut size={18}/></button>
                      <span className="text-[10px] font-black w-10 text-center tracking-tighter">{Math.round(pdfScale * 100)}%</span>
                      <button onClick={() => setPdfScale(s => Math.min(3.5, s + 0.25))} className="p-3 bg-black/5 rounded-2xl active:scale-90"><ZoomIn size={18}/></button>
                    </div>
                    <div className="flex items-center gap-2">
                       <button onClick={() => setPdfScale(1.0)} className="p-3 bg-black/5 rounded-2xl active:scale-90"><Maximize2 size={18}/></button>
                       <div className="h-8 w-[1px] bg-black/10 mx-2" />
                       <button onClick={() => setReaderMode('reflow')} className="p-3.5 bg-blue-600 text-white rounded-2xl flex items-center gap-2 shadow-lg active:scale-95 transition-all">
                         <Headphones size={18} /> <span className="text-[10px] font-black uppercase">Reflow</span>
                       </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {isSidebarOpen && (
        <div className="fixed inset-0 z-[100] flex">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)} />
          <div className={`relative w-[85%] max-w-xs h-full flex flex-col animate-in slide-in-from-left duration-400 ${themeClasses}`}>
            <div className="p-8 border-b flex items-center justify-between">
              <h2 className="text-xl font-black tracking-tighter">Manuscript Index</h2>
              <button onClick={() => setIsSidebarOpen(false)} className="p-2 bg-black/5 rounded-full"><X size={20} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar">
              {activeBook?.chapters.length ? activeBook.chapters.map((c, i) => {
                const isActive = currentChapter?.startIndex === c.startIndex;
                return (
                  <button key={i} onClick={() => { 
                    if (readerMode === 'pdf' && c.pageNumber) {
                       const container = document.querySelector('.flex-1.overflow-y-auto.px-4');
                       const targetPage = container?.querySelectorAll('.relative.mb-8')[c.pageNumber - 1];
                       targetPage?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    } else {
                       jumpToWord(c.startIndex);
                    }
                    setIsSidebarOpen(false); 
                  }} className={`w-full text-left p-6 rounded-[2rem] text-[10px] font-bold transition-all ${isActive ? 'bg-blue-600 text-white shadow-xl' : 'opacity-40 bg-black/5 dark:bg-white/5 hover:opacity-100'}`}>
                    <div className="flex justify-between items-center gap-4">
                      <span className="truncate">{c.title}</span>
                      {isActive && <Bookmark size={12} className="fill-white" />}
                      {c.pageNumber && <span className="opacity-50 text-[8px] whitespace-nowrap tracking-widest">P.{c.pageNumber}</span>}
                    </div>
                  </button>
                );
              }) : <div className="p-10 text-center opacity-20 text-[10px] font-black uppercase tracking-[0.3em]">No Chapters Found</div>}
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 z-[110] flex items-end justify-center">
          <div className="absolute inset-0 bg-black/85 backdrop-blur-lg" onClick={() => setIsSettingsOpen(false)} />
          <div className={`relative w-full rounded-t-[4rem] p-10 border-t animate-in slide-in-from-bottom duration-400 ${themeClasses}`}>
            <div className="flex items-center justify-between mb-10">
              <h2 className="text-2xl font-black tracking-tighter">Voice & Style</h2>
              <button onClick={() => setIsSettingsOpen(false)} className="p-3 bg-black/5 rounded-full hover:bg-black/10 transition-all"><X size={20} /></button>
            </div>
            <div className="space-y-10">
              <div>
                <span className="text-[10px] font-black opacity-20 uppercase tracking-[0.3em] block mb-5">Interface Atmosphere</span>
                <div className="grid grid-cols-3 gap-4">
                  {(['light', 'dark', 'sepia'] as const).map(t => (
                    <button key={t} onClick={() => setTheme(t)} className={`py-4 rounded-2xl capitalize font-black text-xs border-2 transition-all ${theme === t ? 'border-blue-600 bg-blue-600 text-white shadow-lg' : 'border-black/5 opacity-40 hover:opacity-70'}`}>{t}</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-4"><span className="text-[10px] font-black opacity-20 uppercase tracking-[0.3em]">Temporal Rate</span> <span className="text-sm font-black text-blue-600">{playbackSpeed}x</span></div>
                <input type="range" min="0.5" max="3.0" step="0.1" value={playbackSpeed} onChange={e => setPlaybackSpeed(parseFloat(e.target.value))} className="w-full accent-blue-600 h-2.5 bg-black/5 rounded-full appearance-none cursor-pointer" />
              </div>
              <div className="pb-12">
                <span className="text-[10px] font-black opacity-20 uppercase block mb-5 tracking-[0.3em]">Neural Identity Discovery</span>
                <div className="max-h-52 overflow-y-auto space-y-2 no-scrollbar pr-1 custom-scrollbar">
                  {availableVoices.length === 0 ? (
                    <div className="py-6 text-center opacity-30 text-[10px] font-black uppercase animate-pulse">Scanning System Core...</div>
                  ) : availableVoices.map(voice => (
                    <button key={voice.voiceURI} onClick={() => setSelectedVoiceURI(voice.voiceURI)} className={`w-full flex items-center justify-between p-4 rounded-2xl text-[10px] font-black border-2 transition-all ${selectedVoiceURI === voice.voiceURI ? 'border-blue-600 bg-blue-600/5 text-blue-600 shadow-sm' : 'border-black/5 opacity-40 hover:opacity-100'}`}>
                      <div className="flex flex-col items-start truncate pr-4">
                        <span className="truncate">{voice.name}</span>
                        <span className="text-[7px] opacity-40 uppercase tracking-widest">{voice.lang}</span>
                      </div>
                      {selectedVoiceURI === voice.voiceURI && <Check size={16} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
