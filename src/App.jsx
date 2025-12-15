import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  limit, 
  serverTimestamp 
} from 'firebase/firestore';
import { 
  Mic, Radio, Volume2, Power, Activity 
} from 'lucide-react';

// --- CONFIGURATION ---
// 1. Paste your Firebase config object here
const firebaseConfig = {
  apiKey: "AIzaSyBCG7uEPsS3NZWK2V13cTbzmDvOPhW90Sk",
  authDomain: "global-walkie-talkie.firebaseapp.com",
  projectId: "global-walkie-talkie",
  storageBucket: "global-walkie-talkie.firebasestorage.app",
  messagingSenderId: "516439116084",
  appId: "1:516439116084:web:8a572c26c559181e6bbd61"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Simple beep generator
const playRogerBeep = (ctx) => {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(2000, ctx.currentTime);
  osc.frequency.setValueAtTime(1000, ctx.currentTime + 0.1);
  gain.gain.setValueAtTime(0.1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.2);
};

export default function WalkieTalkieApp() {
  const [user, setUser] = useState(null);
  const [isOn, setIsOn] = useState(false);
  const [frequency, setFrequency] = useState(105.50);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isReceiving, setIsReceiving] = useState(false);
  const [lastMessageId, setLastMessageId] = useState(null);
  const [volume, setVolume] = useState(0.8);
  const [statusText, setStatusText] = useState("OFFLINE");
  
  const audioContextRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  
  // Auth
  useEffect(() => {
    signInAnonymously(auth).catch(console.error);
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // Power Toggle & Audio Context
  const togglePower = async () => {
    if (isOn) {
      setIsOn(false);
      setStatusText("OFFLINE");
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    } else {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new AudioContext();
        await navigator.mediaDevices.getUserMedia({ audio: true });
        setIsOn(true);
        setStatusText("STANDBY");
        playRogerBeep(audioContextRef.current);
      } catch (err) {
        alert("Microphone access is required.");
      }
    }
  };

  // Listen for Messages
  useEffect(() => {
    if (!user || !isOn) return;
    const collectionRef = collection(db, 'walkie_messages');
    const q = query(collectionRef, orderBy('createdAt', 'desc'), limit(50));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          if (Math.abs(data.frequency - frequency) > 0.01) return;
          if (data.userId === user.uid) return;
          
          const msgTime = data.createdAt?.toMillis() || Date.now();
          if (Date.now() - msgTime > 30000) return; 

          if (data.id === lastMessageId) return;
          setLastMessageId(data.id);
          queueAudio(data.audioBase64);
        }
      });
    });
    return () => unsubscribe();
  }, [user, isOn, frequency, lastMessageId]);

  // Audio Queue
  const queueAudio = (base64String) => {
    audioQueueRef.current.push(base64String);
    processQueue();
  };

  const processQueue = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0 || !audioContextRef.current) return;
    isPlayingRef.current = true;
    setIsReceiving(true);
    setStatusText(`RECEIVING ${frequency.toFixed(1)}`);

    try {
      const base64Audio = audioQueueRef.current.shift();
      const arrayBuffer = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0)).buffer;
      const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
      const source = audioContextRef.current.createBufferSource();
      const gainNode = audioContextRef.current.createGain();
      
      source.buffer = audioBuffer;
      gainNode.gain.value = volume;
      source.connect(gainNode);
      gainNode.connect(audioContextRef.current.destination);
      
      source.onended = () => {
        setTimeout(() => {
          if (audioQueueRef.current.length === 0) {
            playRogerBeep(audioContextRef.current);
            setIsReceiving(false);
            setStatusText("STANDBY");
          }
          isPlayingRef.current = false;
          processQueue();
        }, 300);
      };
      source.start(0);
    } catch (error) {
      isPlayingRef.current = false;
      setIsReceiving(false);
      processQueue();
    }
  };

  // Transmission
  const startTransmission = async (e) => {
    e.preventDefault();
    if (!isOn || !user || isReceiving) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      chunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm;codecs=opus' });
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
          const base64String = reader.result.split(',')[1];
          await addDoc(collection(db, 'walkie_messages'), {
            userId: user.uid,
            frequency: parseFloat(frequency),
            audioBase64: base64String,
            createdAt: serverTimestamp(),
          });
          playRogerBeep(audioContextRef.current);
        };
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorderRef.current.start();
      setIsTransmitting(true);
      setStatusText("TRANSMITTING...");
    } catch (err) {
      setStatusText("MIC ERROR");
    }
  };

  const stopTransmission = (e) => {
    e.preventDefault();
    if (mediaRecorderRef.current && isTransmitting) {
      mediaRecorderRef.current.stop();
      setIsTransmitting(false);
      setStatusText("STANDBY");
    }
  };

  const adjustFrequency = (delta) => {
    if (!isOn) return;
    setFrequency(prev => {
      const newFreq = parseFloat((prev + delta).toFixed(1));
      return newFreq < 87.5 ? 87.5 : newFreq > 108.0 ? 108.0 : newFreq;
    });
  };

  return (
    <div className="min-h-screen bg-neutral-900 text-white flex items-center justify-center p-4 font-mono select-none">
      <div className="relative bg-neutral-800 rounded-[3rem] p-6 shadow-2xl border-4 border-neutral-700 w-full max-w-sm flex flex-col gap-6">
        {/* Antenna */}
        <div className="absolute -top-24 right-10 w-4 h-24 bg-neutral-700 rounded-t-full border-r-2 border-white/10"></div>
        
        {/* Header */}
        <div className="flex justify-between items-start z-10 mt-2">
           <div className="flex flex-col gap-1">
             <div className="text-xs text-neutral-500 tracking-widest font-bold">MODEL X-200</div>
             <div className="flex items-center gap-2">
               <div className={`w-3 h-3 rounded-full ${isOn ? (isTransmitting ? 'bg-red-500 animate-pulse' : (isReceiving ? 'bg-green-500 animate-pulse' : 'bg-green-500/50')) : 'bg-red-900'}`}></div>
               <span className="text-xs text-neutral-400">{isOn ? 'PWR ON' : 'PWR OFF'}</span>
             </div>
           </div>
           <button onClick={togglePower} className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${isOn ? 'bg-green-500/20 border-green-500 text-green-500' : 'bg-neutral-700 border-neutral-600 text-neutral-500'}`}><Power size={20} /></button>
        </div>

        {/* Display */}
        <div className={`relative bg-[#7da88c] rounded-lg p-4 border-4 border-neutral-600 transition-opacity duration-500 ${isOn ? 'opacity-100' : 'opacity-20'}`}>
          <div className="flex justify-between items-end border-b-2 border-black/10 pb-1 mb-2">
            <span className="text-black/60 text-xs font-bold">FM TRANSCEIVER</span>
            <Activity size={16} className="text-black/60" />
          </div>
          <div className="flex justify-center items-baseline gap-1 my-2">
            <span className="text-5xl font-black text-black/80 tracking-tighter">{frequency.toFixed(1)}</span>
            <span className="text-sm font-bold text-black/60">MHz</span>
          </div>
          <div className="flex justify-between items-center text-xs font-bold text-black/60 mt-2">
            <span>CH: {Math.floor((frequency - 87.5) * 2)}</span>
            <span>{statusText}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="space-y-6 z-10">
          <div className="bg-neutral-900/50 rounded-xl p-3 border border-neutral-700/50">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-neutral-400 font-bold flex items-center gap-2"><Radio size={14} /> FREQ</label>
              <div className="flex gap-1">
                 <button disabled={!isOn} onClick={() => adjustFrequency(-0.1)} className="p-1 px-2 bg-neutral-700 rounded text-xs">-</button>
                 <button disabled={!isOn} onClick={() => adjustFrequency(0.1)} className="p-1 px-2 bg-neutral-700 rounded text-xs">+</button>
              </div>
            </div>
            <input type="range" min="87.5" max="108.0" step="0.1" value={frequency} onChange={(e) => isOn && setFrequency(parseFloat(e.target.value))} disabled={!isOn} className="w-full accent-orange-500 h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer" />
          </div>

          <div className="flex items-center gap-3 px-2">
             <Volume2 size={16} className="text-neutral-500" />
             <input type="range" min="0" max="1" step="0.1" value={volume} onChange={(e) => setVolume(parseFloat(e.target.value))} disabled={!isOn} className="w-full accent-neutral-500 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer" />
          </div>

          <button
              onMouseDown={startTransmission}
              onMouseUp={stopTransmission}
              onMouseLeave={stopTransmission}
              onTouchStart={startTransmission}
              onTouchEnd={stopTransmission}
              disabled={!isOn}
              className={`relative w-full h-24 rounded-xl flex flex-col items-center justify-center gap-2 font-bold tracking-wider text-sm transition-all duration-100 border-b-4 ${isOn ? (isTransmitting ? 'bg-orange-600 border-orange-800 translate-y-1 text-white' : 'bg-orange-500 border-orange-700 hover:bg-orange-400 text-white shadow-lg') : 'bg-neutral-700 border-neutral-800 text-neutral-500 cursor-not-allowed'}`}
            >
              <Mic size={24} className={isTransmitting ? 'animate-bounce' : ''} />
              <span>{isTransmitting ? 'TRANSMITTING' : 'PUSH TO TALK'}</span>
            </button>
        </div>
      </div>
    </div>
  );
}