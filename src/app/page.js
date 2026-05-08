"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

function buildMessage(sender, text, isSystem = false) {
  return {
    id: `${Date.now()}-${Math.random()}`,
    sender,
    text,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    isSystem,
  };
}

export default function Home() {
  const [status, setStatus] = useState("Connecting...");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isVideoCall, setIsVideoCall] = useState(false);
  const [remoteVideoConnected, setRemoteVideoConnected] = useState(false);
  const [isMirrored, setIsMirrored] = useState(false);
  const [streamState, setStreamState] = useState("none"); // none, connecting, connected
  const [connectionQuality, setConnectionQuality] = useState("none"); // none, strong, mid, poor
  
  const socketRef = useRef(null);
  const chatEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  const peerConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  const initializeMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      localStreamRef.current = stream;
      return stream;
    } catch (err) {
      console.error("Error accessing media:", err);
      alert("Could not access camera/microphone");
      return null;
    }
  };

  const flushPendingCandidates = async () => {
    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
    while (pendingCandidatesRef.current.length) {
      const candidate = pendingCandidatesRef.current.shift();
      if (!candidate) continue;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error("Error adding queued ICE candidate:", err);
      }
    }
  };

  const addIceCandidateSafely = async (candidate) => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }

    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("Error adding ICE candidate:", err);
    }
  };

  const startVideoCall = async () => {
    if (!socketRef.current || !isConnected) return;

    // If peer already exists, just signal ready
    if (peerConnectionRef.current) {
      socketRef.current.emit("video-call-start");
      return;
    }

    const stream = await initializeMedia();
    if (!stream) return;

    setIsVideoCall(true);
    const pc = await setupPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socketRef.current.emit("video-call-start");
    socketRef.current.emit("offer", offer);
  };

  const stopVideoCall = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    pendingCandidatesRef.current = [];

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    setIsVideoCall(false);
    setRemoteVideoConnected(false);
    setStreamState("none");
    setConnectionQuality("none");
    if (socketRef.current) {
      socketRef.current.emit("video-call-stop");
    }
  };

  const setupPeerConnection = async () => {
    const peerConnection = new RTCPeerConnection({ iceServers: peerConfig.iceServers });
    peerConnectionRef.current = peerConnection;
    setStreamState("connecting");

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStreamRef.current);
      });
    }

    peerConnection.ontrack = (event) => {
      console.log("Received remote track:", event);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
        setRemoteVideoConnected(true);
        setStreamState("connected");
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit("ice-candidate", event.candidate);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log("Connection state:", peerConnection.connectionState);
      if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
        stopVideoCall();
      }
    };

    // Monitor connection quality
    const monitorQuality = async () => {
      try {
        const stats = await peerConnection.getStats();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            const packetsLost = report.packetsLost || 0;
            const packetsReceived = report.packetsReceived || 1;
            const lossRate = packetsLost / (packetsLost + packetsReceived);
            const jitter = report.jitter || 0;

            if (lossRate < 0.02 && jitter < 0.05) {
              setConnectionQuality("strong");
            } else if (lossRate < 0.1 && jitter < 0.15) {
              setConnectionQuality("mid");
            } else {
              setConnectionQuality("poor");
            }
          }
        });
      } catch (err) {
        console.error("Error monitoring quality:", err);
      }
    };

    const qualityInterval = setInterval(monitorQuality, 1000);
    peerConnection.addEventListener(
      "connectionstatechange",
      () => {
        if (peerConnection.connectionState === "closed") {
          clearInterval(qualityInterval);
        }
      }
    );

    return peerConnection;
  };

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;

    socket.on("connect", () => {
      setIsConnected(true);
      setStatus("Searching for a stranger...");
    });

    socket.on("waiting", () => {
      setStatus("Waiting for stranger...");
      setMessages((prev) => [...prev, buildMessage("System", "Waiting for someone else to connect...", true)]);
    });

    socket.on("matched", async () => {
      setStatus("Stranger connected!");
      setMessages([buildMessage("System", "Matched! Say hi.", true)]);
      
      // Create peer connection on match
      const stream = await initializeMedia();
      if (stream) {
        setIsVideoCall(true);
        const pc = await setupPeerConnection();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit("offer", offer);
      }
    });

    socket.on("message", (messageText) => {
      setMessages((prev) => [...prev, buildMessage("Stranger", messageText)]);
    });

    socket.on("typing", () => {
      setIsTyping(true);
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      typingTimeoutRef.current = setTimeout(() => setIsTyping(false), 1200);
    });

    socket.on("video-call-start", async () => {
      setIsVideoCall(true);
      if (!localStreamRef.current) {
        const stream = await initializeMedia();
        if (!stream) return;
      }
      const pc = await setupPeerConnection();
    });

    socket.on("offer", async (offer) => {
      setIsVideoCall(true);
      if (!localStreamRef.current) {
        const stream = await initializeMedia();
        if (!stream) return;
      }
      let pc = peerConnectionRef.current;
      if (!pc) {
        pc = await setupPeerConnection();
      }
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", answer);
    });

    socket.on("answer", async (answer) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingCandidates();
      }
    });

    socket.on("ice-candidate", async (candidate) => {
      await addIceCandidateSafely(candidate);
    });

    socket.on("video-call-stop", () => {
      stopVideoCall();
    });

    socket.on("partner-disconnected", () => {
      setStatus("Stranger disconnected. Searching again...");
      setMessages((prev) => [...prev, buildMessage("System", "Stranger disconnected. Searching for a new partner...", true)]);
      if (isVideoCall) {
        stopVideoCall();
      }
      socket.emit("search-again");
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
      setStatus("Disconnected from server");
      setMessages((prev) => [...prev, buildMessage("System", "Connection lost. Refresh to reconnect.", true)]);
      if (isVideoCall) {
        stopVideoCall();
      }
    });

    return () => {
      socket.off("connect");
      socket.off("waiting");
      socket.off("matched");
      socket.off("message");
      socket.off("typing");
      socket.off("video-call-start");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
      socket.off("video-call-stop");
      socket.off("partner-disconnected");
      socket.off("disconnect");
      socket.disconnect();
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (isVideoCall && localStreamRef.current && localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [isVideoCall]);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isTyping]);

  const sendMessage = () => {
    if (!message.trim() || !socketRef.current || !isConnected) return;

    socketRef.current.emit("message", message);
    setMessages((prev) => [...prev, buildMessage("You", message)]);
    setMessage("");
  };

  const handleInputChange = (value) => {
    setMessage(value);
    if (!socketRef.current || !isConnected) return;
    socketRef.current.emit("typing");
  };

  const handleNext = () => {
    if (!socketRef.current || !isConnected) return;
    if (isVideoCall) {
      stopVideoCall();
    }
    setMessages([buildMessage("System", "Finding a new stranger...", true)]);
    setStatus("Searching for a stranger...");
    socketRef.current.emit("search-again");
  };

  const buttonDisabled = !message.trim() || !isConnected;

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6">
      <div className="flex items-center justify-between w-full mb-4">
        <h1 className="text-5xl font-bold text-center flex-1">Hello OMVi</h1>
        <div
          className={`text-3xl px-4 py-2 rounded-lg ${
            connectionQuality === "strong"
              ? "bg-green-900 text-green-400"
              : connectionQuality === "mid"
              ? "bg-orange-900 text-orange-400"
              : connectionQuality === "poor"
              ? "bg-red-900 text-red-400"
              : "bg-gray-800 text-gray-400"
          }`}
          title={`Signal: ${connectionQuality || "none"}`}
        >
          📶
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-400">{status}</p>

      {isVideoCall && (
        <div className="w-full max-w-7xl mb-4 flex gap-6 h-[calc(100vh-200px)]">
          <div className="w-1/2 flex flex-col gap-4">
            <div className="rounded-lg overflow-hidden bg-slate-950 border border-gray-700 relative h-64">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-cover bg-black ${
                  isMirrored ? "scale-x-[-1]" : ""
                }`}
              />
              <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                <p className="text-xs text-white bg-black/60 px-2 py-1 rounded">You</p>
                <button
                  onClick={() => setIsMirrored(!isMirrored)}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded text-xs"
                  title="Mirror camera"
                >
                  🔄
                </button>
              </div>
            </div>
            <div className="rounded-lg overflow-hidden bg-slate-950 border border-gray-700 h-64">
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover bg-black"
              />
              <p className="text-xs text-center text-gray-400 p-2">
                {remoteVideoConnected ? "Stranger" : "Waiting for video..."}
              </p>
            </div>
          </div>

          <div className="w-1/2 border border-gray-700 rounded-xl p-4 overflow-y-auto bg-slate-950">
            {messages.length === 0 ? (
              <div className="text-gray-500">No messages yet.</div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`mb-3 rounded-xl px-4 py-3 ${msg.isSystem ? "bg-gray-800 text-gray-300" : msg.sender === "You" ? "bg-blue-600 text-white self-end" : "bg-gray-700 text-white"}`}
                >
                  <div className="flex items-center justify-between gap-2 text-sm opacity-80 mb-1">
                    <span>{msg.isSystem ? "System" : msg.sender}</span>
                    <span>{msg.time}</span>
                  </div>
                  <div>{msg.text}</div>
                </div>
              ))
            )}
            {isTyping && (
              <div className="text-sm italic text-gray-300">Stranger is typing...</div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>
      )}

      {!isVideoCall && (
        <div className="w-full max-w-2xl h-96 border border-gray-700 rounded-xl p-4 overflow-y-auto mb-4 bg-slate-950">
          {messages.length === 0 ? (
            <div className="text-gray-500">No messages yet.</div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`mb-3 rounded-xl px-4 py-3 ${msg.isSystem ? "bg-gray-800 text-gray-300" : msg.sender === "You" ? "bg-blue-600 text-white self-end" : "bg-gray-700 text-white"}`}
              >
                <div className="flex items-center justify-between gap-2 text-sm opacity-80 mb-1">
                  <span>{msg.isSystem ? "System" : msg.sender}</span>
                  <span>{msg.time}</span>
                </div>
                <div>{msg.text}</div>
              </div>
            ))
          )}
          {isTyping && (
            <div className="text-sm italic text-gray-300">Stranger is typing...</div>
          )}
          <div ref={chatEndRef} />
        </div>
      )}

      <div className="flex w-full max-w-2xl gap-2 items-center">
        <button
          onClick={() => alert("😊 Emoji picker - coming soon!")}
          className="bg-gray-700 hover:bg-gray-600 px-4 py-3 rounded-lg text-lg"
          title="Emoji"
        >
          😊
        </button>
        <button
          onClick={() => alert("🎨 Stickers - coming soon!")}
          className="bg-gray-700 hover:bg-gray-600 px-4 py-3 rounded-lg text-lg"
          title="Stickers"
        >
          🎨
        </button>
        <button
          onClick={() => alert("🎬 GIF search - coming soon!")}
          className="bg-gray-700 hover:bg-gray-600 px-4 py-3 rounded-lg text-lg"
          title="GIF"
        >
          🎬
        </button>
        <input
          type="text"
          placeholder={isConnected ? "Type a message..." : "Connecting to server..."}
          value={message}
          onChange={(e) => handleInputChange(e.target.value)}
          className="flex-1 px-4 py-3 rounded-lg bg-gray-900 border border-gray-700 outline-none"
          disabled={!isConnected}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <button
          onClick={sendMessage}
          className="bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 rounded-lg"
          disabled={buttonDisabled}
        >
          Send
        </button>
        <button
          onClick={() => {
            if (isVideoCall) {
              stopVideoCall();
            } else {
              startVideoCall();
            }
          }}
          className={`px-6 py-3 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
            isVideoCall ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700"
          }`}
          disabled={!isConnected}
        >
          {isVideoCall ? "Stop Video" : "Video Call"}
        </button>
        <button
          onClick={handleNext}
          className="bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 rounded-lg"
          disabled={!isConnected}
        >
          Next
        </button>
      </div>
    </main>
  );
}
