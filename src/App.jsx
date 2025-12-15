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
  doc,
  setDoc,
  onSnapshot, 
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  serverTimestamp 
} from 'firebase/firestore';
import { 
  Mic, Radio, Volume2, Power, Activity, Wifi, RefreshCw 
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

// STUN servers help two devices find each other over the internet
const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

export default function WalkieTalkieApp() {
  const [user, setUser] = useState(null);
  const [isOn, setIsOn] = useState(false);
  const [frequency, setFrequency] = useState(105.50);
  const [isTalking, setIsTalking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("DISCONNECTED"); // DISCONNECTED, CONNECTING, CONNECTED
  const [volume, setVolume] = useState(1.0);
  
  // WebRTC Refs
  const pc = useRef(null);
  const localStream = useRef(null);
  const remoteStream = useRef(null);
  const unsubscribeRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Auth
  useEffect(() => {
    signInAnonymously(auth).catch(console.error);
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // --- Audio / WebRTC Setup ---
  
  const setupAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream.current = stream;
      
      // Mute initially (PTT logic)
      stream.getAudioTracks().forEach(track => {
        track.enabled = false;
      });

      return stream;
    } catch (err) {
      console.error("Mic error:", err);
      alert("Microphone access needed!");
      return null;
    }
  };

  const createPeerConnection = () => {
    const newPc = new RTCPeerConnection(servers);
    
    // Push local tracks to peer connection
    if (localStream.current) {
        localStream.current.getTracks().forEach((track) => {
            newPc.addTrack(track, localStream.current);
        });
    }

    // Handle remote tracks
    newPc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.current.addTrack(track);
      });
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream.current;
        // Ensure audio plays (sometimes browsers block auto-play)
        remoteAudioRef.current.play().catch(e => console.log("Autoplay blocked", e));
      }
    };

    newPc.onconnectionstatechange = () => {
        console.log("Connection State:", newPc.connectionState);
        if (newPc.connectionState === 'connected') {
            setConnectionStatus("CONNECTED");
        } else if (newPc.connectionState === 'disconnected' || newPc.connectionState === 'failed') {
            setConnectionStatus("DISCONNECTED");
            hangUp();
        }
    };

    return newPc;
  };

  // --- Signaling (The "Handshake") ---

  const joinFrequency = async () => {
    if (!user) return;
    setStatus("TUNING...");
    
    // Prepare streams
    remoteStream.current = new MediaStream();
    const stream = await setupAudio();
    if (!stream) return;

    pc.current = createPeerConnection();

    // Call ID is based on frequency (e.g., "freq_105_5")
    const callId = `freq_${frequency.toFixed(1).replace('.', '_')}`;
    const callDocRef = doc(db, 'walkie_channels', callId);
    const offerCandidates = collection(callDocRef, 'offerCandidates');
    const answerCandidates = collection(callDocRef, 'answerCandidates');

    const callDoc = await getDoc(callDocRef);

    if (!callDoc.exists() || !callDoc.data().offer) {
        // --- I AM THE CALLER (HOST) ---
        console.log("Creating room...");
        
        pc.current.onicecandidate = (event) => {
            if(event.candidate) {
                addDoc(offerCandidates, event.candidate.toJSON());
            }
        };

        const offerDescription = await pc.current.createOffer();
        await pc.current.setLocalDescription(offerDescription);

        const offer = {
            sdp: offerDescription.sdp,
            type: offerDescription.type,
            hostId: user.uid,
            timestamp: serverTimestamp()
        };

        await setDoc(callDocRef, { offer });
        setStatus("WAITING FOR PEER...");

        // Listen for Answer
        unsubscribeRef.current = onSnapshot(callDocRef, (snapshot) => {
            const data = snapshot.data();
            if (!pc.current.currentRemoteDescription && data?.answer) {
                const answerDescription = new RTCSessionDescription(data.answer);
                pc.current.setRemoteDescription(answerDescription);
                setStatus("CONNECTING...");
            }
        });

        // Listen for Remote ICE Candidates
        onSnapshot(answerCandidates, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added') {
                    const candidate = new RTCIceCandidate(change.doc.data());
                    pc.current.addIceCandidate(candidate);
                }
            });
        });

    } else {
        // --- I AM THE ANSWERER (GUEST) ---
        console.log("Joining room...");
        setStatus("CONNECTING...");
        
        const data = callDoc.data();
        // Check if room is stale (older than 1 hour)
        // (Simple safety check, optional)

        pc.current.onicecandidate = (event) => {
            if(event.candidate) {
                addDoc(answerCandidates, event.candidate.toJSON());
            }
        };

        await pc.current.setRemoteDescription(new RTCSessionDescription(data.offer));
        
        const answerDescription = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answerDescription);

        const answer = {
            type: answerDescription.type,
            sdp: answerDescription.sdp,
            guestId: user.uid
        };

        await updateDoc(callDocRef, { answer });

        // Listen for Remote ICE Candidates
        onSnapshot(offerCandidates, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added') {
                    const candidate = new RTCIceCandidate(change.doc.data());
                    pc.current.addIceCandidate(candidate);
                }
            });
        });
    }
  };

  const hangUp = async () => {
    // Stop tracks
    if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
    }
    
    // Close PC
    if (pc.current) {
        pc.current.close();
        pc.current = null;
    }

    // Stop Listening
    if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
    }
    
    setConnectionStatus("DISCONNECTED");
  };

  // --- Reset Channel (Nuclear Option) ---
  const resetChannel = async () => {
      const callId = `freq_${frequency.toFixed(1).replace('.', '_')}`;
      try {
          await deleteDoc(doc(db, 'walkie_channels', callId));
          hangUp();
          alert(`Frequency ${frequency} reset. Try connecting again.`);
      } catch (e) {
          console.error("Error resetting:", e);
      }
  };

  // --- UI Interactions ---

  const togglePower = () => {
    if (isOn) {
      setIsOn(false);
      hangUp();
    } else {
      setIsOn(true);
      joinFrequency();
    }
  };

  // PTT Logic: Enable mic track only when button held
  const startTalk = (e) => {
    e.preventDefault(); // Prevent touch selection
    if (!isOn) return;
    setIsTalking(true);
    if (localStream.current) {
        localStream.current.getAudioTracks().forEach(track => track.enabled = true);
    }
  };

  const stopTalk = (e) => {
    e.preventDefault();
    if (!isOn) return;
    setIsTalking(false);
    if (localStream.current) {
        localStream.current.getAudioTracks().forEach(track => track.enabled = false);
    }
  };

  const adjustFrequency = (delta) => {
    if (connectionStatus !== 'DISCONNECTED') {
        if(!confirm("Changing frequency will disconnect the current call. Continue?")) return;
        hangUp();
    }
    setFrequency(prev => {
      const newFreq = parseFloat((prev + delta).toFixed(1));
      return newFreq < 87.5 ? 87.5 : newFreq > 108.0 ? 108.0 : newFreq;
    });
    // In a real app, we'd auto-rejoin here, but let's make user toggle power for simplicity/stability
    setIsOn(false); 
  };

  const setStatus = (status) => {
      setConnectionStatus(status);
  };

  // Helper for UI status text
  const getStatusDisplay = () => {
      if (!isOn) return "OFFLINE";
      if (connectionStatus === 'CONNECTED') return "LIVE LINK";
      return connectionStatus;
  };

  return (
    <div className="min-h-screen bg-neutral-900 text-white flex items-center justify-center p-4 font-mono select-none">
      
      {/* Hidden Audio Element for Remote Stream */}
      <audio ref={remoteAudioRef} autoPlay />

      <div className="relative bg-neutral-800 rounded-[3rem] p-6 shadow-2xl border-4 border-neutral-700 w-full max-w-sm flex flex-col gap-6">
        
        {/* Antenna */}
        <div className="absolute -top-24 right-10 w-4 h-24 bg-neutral-700 rounded-t-full border-r-2 border-white/10"></div>
        
        {/* Header */}
        <div className="flex justify-between items-start z-10 mt-2">
           <div className="flex flex-col gap-1">
             <div className="text-xs text-neutral-500 tracking-widest font-bold">MODEL X-RTC (FULL DUPLEX)</div>
             <div className="flex items-center gap-2">
               <div className={`w-3 h-3 rounded-full transition-colors duration-300 ${isOn ? (connectionStatus === 'CONNECTED' ? 'bg-green-400 shadow-[0_0_10px_#4ade80]' : 'bg-yellow-500 animate-pulse') : 'bg-red-900'}`}></div>
               <span className="text-xs text-neutral-400">{isOn ? 'PWR ON' : 'PWR OFF'}</span>
             </div>
           </div>
           <button onClick={togglePower} className={`w-12 h-12 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${isOn ? 'bg-green-500/20 border-green-500 text-green-500' : 'bg-neutral-700 border-neutral-600 text-neutral-500'}`}><Power size={20} /></button>
        </div>

        {/* Display */}
        <div className={`relative bg-[#7da88c] rounded-lg p-4 border-4 border-neutral-600 transition-opacity duration-500 ${isOn ? 'opacity-100' : 'opacity-20'}`}>
          <div className="flex justify-between items-end border-b-2 border-black/10 pb-1 mb-2">
            <span className="text-black/60 text-xs font-bold flex items-center gap-1">
                {connectionStatus === 'CONNECTED' ? <Wifi size={14} className="text-black/70"/> : <Activity size={14} className="text-black/50"/>}
                {connectionStatus === 'CONNECTED' ? 'SIGNAL: STRONG' : 'SEARCHING...'}
            </span>
            <button onClick={resetChannel} className="text-black/40 hover:text-black/80" title="Reset Frequency"><RefreshCw size={12}/></button>
          </div>
          <div className="flex justify-center items-baseline gap-1 my-2">
            <span className="text-5xl font-black text-black/80 tracking-tighter">{frequency.toFixed(1)}</span>
            <span className="text-sm font-bold text-black/60">MHz</span>
          </div>
          <div className="flex justify-between items-center text-xs font-bold text-black/60 mt-2">
            <span>CH: {Math.floor((frequency - 87.5) * 2)}</span>
            <span className={connectionStatus === 'CONNECTED' ? 'animate-pulse' : ''}>{getStatusDisplay()}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="space-y-6 z-10">
          <div className="bg-neutral-900/50 rounded-xl p-3 border border-neutral-700/50">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-neutral-400 font-bold flex items-center gap-2"><Radio size={14} /> FREQ TUNER</label>
              <div className="flex gap-1">
                 <button disabled={!isOn} onClick={() => adjustFrequency(-0.1)} className="p-1 px-2 bg-neutral-700 rounded text-xs">-</button>
                 <button disabled={!isOn} onClick={() => adjustFrequency(0.1)} className="p-1 px-2 bg-neutral-700 rounded text-xs">+</button>
              </div>
            </div>
            <input type="range" min="87.5" max="108.0" step="0.1" value={frequency} onChange={(e) => { if(isOn) adjustFrequency(parseFloat(e.target.value) - frequency) }} disabled={!isOn} className="w-full accent-orange-500 h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer" />
          </div>

          <div className="flex items-center gap-3 px-2">
             <Volume2 size={16} className="text-neutral-500" />
             <input type="range" min="0" max="1" step="0.1" value={volume} onChange={(e) => {
                 const v = parseFloat(e.target.value);
                 setVolume(v);
                 if(remoteAudioRef.current) remoteAudioRef.current.volume = v;
             }} disabled={!isOn} className="w-full accent-neutral-500 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer" />
          </div>

          <button
              onMouseDown={startTalk}
              onMouseUp={stopTalk}
              onMouseLeave={stopTalk}
              onTouchStart={startTalk}
              onTouchEnd={stopTalk}
              disabled={!isOn || connectionStatus !== 'CONNECTED'}
              className={`relative w-full h-24 rounded-xl flex flex-col items-center justify-center gap-2 font-bold tracking-wider text-sm transition-all duration-100 border-b-4 
                ${isOn 
                    ? (connectionStatus !== 'CONNECTED' 
                        ? 'bg-neutral-600 border-neutral-700 text-neutral-400 cursor-wait'
                        : (isTalking 
                            ? 'bg-orange-600 border-orange-800 translate-y-1 text-white shadow-inner' 
                            : 'bg-orange-500 border-orange-700 hover:bg-orange-400 text-white shadow-lg cursor-pointer'))
                    : 'bg-neutral-700 border-neutral-800 text-neutral-500 cursor-not-allowed'}
              `}
            >
              <Mic size={24} className={isTalking ? 'animate-bounce' : ''} />
              <span>{connectionStatus !== 'CONNECTED' ? 'WAITING FOR SIGNAL...' : (isTalking ? 'TRANSMITTING' : 'HOLD TO SPEAK')}</span>
            </button>
        </div>
        
        {/* Instructions overlay for first time */}
        {!isOn && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 bg-black/80 text-white text-xs p-4 rounded-xl text-center backdrop-blur-sm border border-white/10">
                <p className="mb-2 font-bold text-green-400">FULL DUPLEX MODE</p>
                <p>1. Turn Power ON.</p>
                <p>2. Wait for "LIVE LINK".</p>
                <p>3. Hold button to speak.</p>
                <p className="mt-2 text-neutral-400 italic">Both users can speak at once.</p>
            </div>
        )}

      </div>
    </div>
  );
}