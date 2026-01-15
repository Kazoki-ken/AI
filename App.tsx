
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry } from './types';
import { SYSTEM_INSTRUCTION } from './constants';
import { decode, decodeAudioData, createPcmBlob } from './utils/audioHelpers';
import Visualizer from './components/Visualizer';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [messages, setMessages] = useState<TranscriptionEntry[]>([]);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  
  const [activeUserText, setActiveUserText] = useState('');
  const [activeModelText, setActiveModelText] = useState('');
  const activeUserTextRef = useRef('');
  const activeModelTextRef = useRef('');

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null); // Added ref for cleanup
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages or active turn changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeUserText, activeModelText]);

  const stopConversation = useCallback(() => {
    // Stop input processor explicitly
    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current.onaudioprocess = null;
      } catch (e) {}
      scriptProcessorRef.current = null;
    }

    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (inputAudioContextRef.current) {
      try { inputAudioContextRef.current.close(); } catch (e) {}
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      try { outputAudioContextRef.current.close(); } catch (e) {}
      outputAudioContextRef.current = null;
    }
    
    // Stop all active audio sources
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();

    nextStartTimeRef.current = 0;
    
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsModelSpeaking(false);
    setActiveUserText('');
    setActiveModelText('');
    activeUserTextRef.current = '';
    activeModelTextRef.current = '';
  }, []);

  const startConversation = async () => {
    try {
      setErrorMessage(null);
      setStatus(ConnectionStatus.CONNECTING);
      
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Kaliti topilmadi. .env faylini tekshiring.");
      }

      const ai = new GoogleGenAI({ apiKey: apiKey });
      
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inCtx;
      outputAudioContextRef.current = outCtx;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err: any) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          throw new Error("Mikrofonga ruxsat berilmadi. Iltimos, brauzer sozlamalaridan mikrofonga ruxsat bering.");
        } else {
          throw new Error("Mikrofonni ulab bo'lmadi: " + err.message);
        }
      }
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (event) => {
              // Guard: stop sending if session is closed
              if (!sessionRef.current) return;

              const inputData = event.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              
              sessionPromise.then((session) => {
                // Double guard inside async
                if (sessionRef.current !== session) return;
                try {
                  session.sendRealtimeInput({ media: pcmBlob });
                } catch (e) {
                  // Ignore errors to prevent console spam when closing
                }
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              const outCtx = outputAudioContextRef.current;
              if (!outCtx) return;

              setIsModelSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              
              const buffer = await decodeAudioData(decode(audioData), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsModelSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              activeUserTextRef.current += text;
              setActiveUserText(activeUserTextRef.current);
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              activeModelTextRef.current += text;
              setActiveModelText(activeModelTextRef.current);
            }

            if (message.serverContent?.turnComplete) {
              const userText = activeUserTextRef.current;
              const modelText = activeModelTextRef.current;
              
              setMessages(prev => {
                const newMsgs = [...prev];
                if (userText) {
                  newMsgs.push({ id: 'u-'+Date.now()+Math.random(), role: 'user', text: userText, timestamp: Date.now() });
                }
                if (modelText) {
                  newMsgs.push({ id: 'm-'+Date.now()+Math.random(), role: 'model', text: modelText, timestamp: Date.now() });
                }
                return newMsgs;
              });
              
              activeUserTextRef.current = '';
              activeModelTextRef.current = '';
              setActiveUserText('');
              setActiveModelText('');
            }

            if (message.serverContent?.interrupted) {
              for (const source of sourcesRef.current.values()) {
                try { source.stop(); } catch (e) {}
                sourcesRef.current.delete(source);
              }
              nextStartTimeRef.current = 0;
              setIsModelSpeaking(false);
            }
          },
          onerror: (err) => {
            console.error(err);
            // Don't show generic error if it's just a closing socket
            if (status === ConnectionStatus.CONNECTED) {
               setErrorMessage("Aloqa uzildi. Internet yoki API kalitni tekshiring.");
               setStatus(ConnectionStatus.ERROR);
            }
          },
          onclose: () => stopConversation()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (error: any) {
      setErrorMessage(error.message);
      setStatus(ConnectionStatus.ERROR);
      stopConversation();
    }
  };

  return (
    <div className="h-screen bg-[#f8fafc] flex flex-col font-sans text-slate-900 overflow-hidden">
      {/* Navbar - Fixed at top */}
      <nav className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shrink-0 shadow-sm z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-red-500 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-sm">
            あ
          </div>
          <div>
            <h1 className="text-lg font-black tracking-tight text-slate-800 leading-none">EasyNihongo</h1>
            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Live Japanese Tutor</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
          <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500' : status === ConnectionStatus.CONNECTING ? 'bg-amber-400' : 'bg-slate-300'}`} />
          <span className="text-[10px] font-bold text-slate-600 uppercase">
            {status === ConnectionStatus.CONNECTED ? 'Bog\'langan' : status === ConnectionStatus.CONNECTING ? 'Ulanmoqda' : 'Offline'}
          </span>
        </div>
      </nav>

      {/* Main Container - Controlled scrolling */}
      <main className="flex-1 flex flex-col max-w-2xl w-full mx-auto overflow-hidden relative p-3 md:p-4 gap-3">
        
        {/* Error - Overlays if exists */}
        {errorMessage && (
          <div className="bg-red-50 border border-red-200 p-3 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300 z-30 shrink-0">
            <p className="text-red-800 font-bold text-xs flex-1">{errorMessage}</p>
            <button onClick={() => setErrorMessage(null)} className="text-red-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        )}

        {/* Chat History Area - Only this part scrolls */}
        <div 
          ref={scrollRef}
          className="flex-1 bg-white rounded-[1.5rem] border border-slate-200 shadow-sm overflow-y-auto px-4 py-5 space-y-4 scroll-smooth custom-scrollbar"
        >
          {messages.length === 0 && !activeUserText && !activeModelText ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-4 border border-dashed border-slate-200">
                <svg className="w-8 h-8 text-slate-200" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
              </div>
              <p className="text-slate-400 text-sm font-medium">Sensei bilan suhbatni boshlang...</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {messages.map((m) => (
                <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`flex items-end gap-2 max-w-[85%] ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                    <div className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold ${m.role === 'user' ? 'bg-blue-100 text-blue-600' : 'bg-red-100 text-red-600'}`}>
                      {m.role === 'user' ? 'S' : '先'}
                    </div>
                    <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed border ${m.role === 'user' ? 'bg-blue-600 text-white border-blue-500 rounded-br-none' : 'bg-slate-50 text-slate-800 border-slate-100 rounded-bl-none'}`}>
                      <p className={m.role === 'model' ? 'japanese-text' : ''}>{m.text}</p>
                    </div>
                  </div>
                </div>
              ))}

              {/* Real-time feedback bubbles */}
              {activeUserText && (
                <div className="flex flex-col items-end opacity-70">
                  <div className="flex items-end gap-2 max-w-[85%] flex-row-reverse">
                    <div className="w-7 h-7 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-[10px] font-bold">S</div>
                    <div className="px-4 py-2.5 rounded-2xl bg-slate-50 text-slate-500 border border-slate-100 rounded-br-none italic text-xs">
                      {activeUserText}...
                    </div>
                  </div>
                </div>
              )}

              {activeModelText && (
                <div className="flex flex-col items-start animate-in fade-in slide-in-from-left-2 duration-200">
                  <div className="flex items-end gap-2 max-w-[85%]">
                    <div className="w-7 h-7 rounded-full bg-red-50 text-red-400 flex items-center justify-center text-[10px] font-bold">先</div>
                    <div className="px-4 py-2.5 rounded-2xl bg-red-50 text-red-900 border border-red-100 rounded-bl-none">
                      <p className="japanese-text text-sm">{activeModelText}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Visualizer - Compact */}
        <div className="shrink-0">
          {status === ConnectionStatus.CONNECTED && (
            <div className="bg-white/50 rounded-2xl p-3 border border-slate-100 backdrop-blur-sm">
               <Visualizer isActive={true} isModelSpeaking={isModelSpeaking} />
            </div>
          )}
        </div>

        {/* Action Button - Always at bottom */}
        <div className="shrink-0 pb-2">
          {status !== ConnectionStatus.CONNECTED ? (
            <button
              onClick={startConversation}
              disabled={status === ConnectionStatus.CONNECTING}
              className="w-full h-16 rounded-2xl bg-slate-900 text-white font-bold text-lg shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-70"
            >
              {status === ConnectionStatus.CONNECTING ? (
                <>
                  <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                  <span>Ulanmoqda...</span>
                </>
              ) : (
                <>
                  <div className="w-8 h-8 bg-red-500 rounded-lg flex items-center justify-center">
                    <svg className="w-4 h-4 fill-current ml-0.5" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  </div>
                  <span>Darsni Boshlash</span>
                </>
              )}
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                onClick={stopConversation}
                className="w-full h-16 bg-white border border-slate-200 text-slate-800 rounded-2xl font-bold text-lg hover:bg-slate-50 active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-sm"
              >
                <div className="w-3 h-3 bg-red-500 rounded-sm"></div>
                Darsni Tugatish
              </button>
              <p className="text-center text-slate-400 text-[9px] font-bold uppercase tracking-[0.2em] animate-pulse">
                 Sensei eshitmoqda...
              </p>
            </div>
          )}
        </div>

      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        @font-face {
          font-family: 'Noto Sans JP';
          font-style: normal;
          font-weight: 400;
          src: url(https://fonts.gstatic.com/s/notosansjp/v52/-Ky77e3ot_H_S-M6N2W4M26p_XpW.woff2) format('woff2');
        }
      `}</style>
    </div>
  );
};

export default App;
