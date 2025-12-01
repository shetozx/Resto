// ================= CONFIGURATION =================
const firebaseConfig = {
  apiKey: "AIzaSyAFhy1xr_kizKJK9l733ysmSqa9y2dLsDU",
  authDomain: "bati5a-shetozx.firebaseapp.com",
  projectId: "bati5a-shetozx",
  storageBucket: "bati5a-shetozx.firebasestorage.app",
  messagingSenderId: "884112333401",
  appId: "1:884112333401:web:33554dc7830fbe64c0af48"
};

const iceServers = {
  iceServers: [
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" }
  ]
};

// ================= STATE MANAGEMENT =================
let db, auth;
let localUserId = null;
let currentRoomId = null;
let currentUserName = "";
let isAdmin = false;
let isMuted = false;
let localStream = null;
let peerConnections = {};
let listeners = [];
let audioContext, analyser;

// ================= INITIALIZATION =================
window.onload = () => {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();

    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get("room");

    auth.onAuthStateChanged((user) => {
      if (user) {
        localUserId = user.uid;
        initializeUser();
        if (roomParam && localStorage.getItem("userName")) {
          document.getElementById("roomCode").value = roomParam;
          joinRoom(true);
        }
      } else {
        auth.signInAnonymously();
      }
    });

  } catch (e) {
    console.error("Initialization error:", e);
    showToast("حدث خطأ في التهيئة", "error");
  }
};

// ================= USER & PROFILE =================
function initializeUser() {
  const savedName = localStorage.getItem("userName");
  if (savedName) {
    currentUserName = savedName;
    updateProfileUI();
  } else {
    openProfileModal();
  }
}

function openProfileModal() {
  document.getElementById("profileModal").classList.remove("hidden");
}

function saveProfile() {
  const n = document.getElementById("profileNameInput").value.trim();
  if (n) {
    currentUserName = n;
    localStorage.setItem("userName", n);
    updateProfileUI();
    document.getElementById("profileModal").classList.add("hidden");
  } else {
    showToast("الرجاء إدخال اسم صحيح", "error");
  }
}

function updateProfileUI() {
  const display = document.getElementById("profileNameDisplay");
  if (display) display.textContent = currentUserName;
  document.getElementById("profileNameInput").value = currentUserName;
}


function wrapWithProxy(url) {
    const PROXY_ENDPOINT = "https://supermod.shetozxneno.workers.dev/?url=";
    return PROXY_ENDPOINT + encodeURIComponent(url);
}



// ================= ROOM LOGIC =================
function manualJoin() {
  joinRoom(false);
}

async function joinRoom(isAuto) {
  if (!currentUserName) return openProfileModal();

  const code = document.getElementById("roomCode").value.trim().toUpperCase();
  const pwd = document.getElementById("roomPassword").value.trim();

  if (!code) return showToast("أدخل كود الغرفة", "error");

  try {
    if (!localStream) localStream = await getAudioStream();

    const roomRef = db.collection("rooms").doc(code);
    const doc = await roomRef.get();

    if (!doc.exists) throw new Error("الغرفة غير موجودة");

    const rData = doc.data();
    if (rData.password && rData.password !== pwd && !isAuto) {
      throw new Error("كلمة المرور خاطئة");
    }

    if (rData.createdBy === localUserId) {
      isAdmin = true;
      document.getElementById("streamBtn").classList.remove("hidden");
    } else {
      isAdmin = false;
    }

    currentRoomId = code;
    window.history.replaceState(null, null, `?room=${code}`);

    // Initialize the new video player system
    VideoPlayer.init(db, currentRoomId, localUserId, isAdmin);

    setupUI(code);

    await roomRef.collection("participants").doc(localUserId).set({
      name: currentUserName,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      muted: false,
      kicked: false,
      reaction: null,
      mutedByAdmin: false,
    });

    setupRoomListeners(roomRef);
    showToast("تم الاتصال بنجاح", "success");

  } catch (e) {
    console.error("Join room error:", e);
    showToast(e.message, "error");
  }
}

async function getAudioStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    initVisualizer(stream);
    return stream;
  } catch (e) {
    console.error("Audio stream error:", e);
    showToast("فشل الوصول للميكروفون", "error");
    throw e;
  }
}

// ================= LISTENERS =================
function setupRoomListeners(roomRef) {
  listeners.push(
    roomRef.collection("participants").onSnapshot((snap) => {
      const activeIds = [];
      snap.forEach((doc) => {
        activeIds.push(doc.id);
        handleParticipantChange(doc);
      });

      document.querySelectorAll('[id^="card-"]').forEach((el) => {
        const id = el.id.replace("card-", "");
        if (!activeIds.includes(id)) {
          el.remove();
          closeConnection(id);
          showToast("غادر أحد المشاركين", "info");
        }
      });
    })
  );

  listeners.push(
    roomRef.collection("participants").doc(localUserId).onSnapshot((doc) => {
      if (doc.exists) {
        const data = doc.data();
        if (data.kicked) {
          leaveRoom(true);
          alert("تم طردك من الغرفة");
        }

        if (data.mutedByAdmin && !isMuted) {
          toggleMute();
          showToast("تم كتم صوتك بواسطة المدير", "warning");
        }
      }
    })
  );

  setupWebRTCSignals(roomRef);

  listeners.push(
    roomRef
      .collection("messages")
      .orderBy("timestamp", "desc")
      .limit(50)
      .onSnapshot(updateChatUI)
  );
}

// ================= PARTICIPANTS & ADMIN =================
function handleParticipantChange(doc) {
  const data = doc.data();
  const id = doc.id;
  const isMe = id === localUserId;

  let card = document.getElementById(`card-${id}`);
  if (!card) {
    card = createCard(id, data, isMe);
    document.getElementById("participantsGrid").appendChild(card);
    if (!isMe) initPeerConnection(id, localUserId < id);
  }
  updateCardStatus(card, data);

  if (data.reaction && data.reaction.ts > Date.now() - 3000) {
    if (card.dataset.lastReactionTs != data.reaction.ts) {
      showReaction(id, data.reaction.emoji);
      card.dataset.lastReactionTs = data.reaction.ts;
    }
  }
}

function createCard(id, data, isMe) {
  const div = document.createElement("div");
  div.id = `card-${id}`;
  div.className = "glass p-4 rounded-2xl flex flex-col items-center relative transition-all hover:bg-white/5 group";

  const muteIconClass = data.mutedByAdmin ? "fa-microphone-slash text-red-500" : "fa-microphone text-white";

  div.innerHTML = `
    <div class="relative mb-3">
        <div class="w-14 h-14 rounded-xl bg-gradient-to-br from-gray-700 to-gray-800 flex items-center justify-center text-xl font-bold text-white shadow-lg">
            ${data.name.charAt(0).toUpperCase()}
        </div>
        <div class="status-dot absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-[#1e293b] ${data.muted ? "bg-red-500" : "bg-green-500"}"></div>
    </div>
    <h4 class="font-bold text-white text-xs mb-1 truncate max-w-[100px]" title="${data.name}">
        ${data.name} ${isMe ? '<span class="text-amber-500">(أنت)</span>' : ""}
    </h4>

    <div class="signal-bars mb-2" id="sig-${id}">
        <div class="signal-bar b1 h-[40%]"></div>
        <div class="signal-bar b2 h-[70%]"></div>
        <div class="signal-bar b3 h-[100%]"></div>
    </div>

    <div id="react-container-${id}" class="absolute top-0 left-0 w-full h-full pointer-events-none overflow-visible"></div>

    ${!isMe ? `<audio id="audio-${id}" autoplay playsinline></audio>` : ""}

    ${
      isAdmin && !isMe
        ? `
    <div class="mt-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer pointer-events-auto z-20">
        <button onclick="adminAction('${id}', 'toggleMute')" id="btn-mute-${id}" 
            class="text-amber-500 bg-black/50 px-2 py-1 rounded hover:bg-white/10 transition-colors" 
            title="${data.mutedByAdmin ? "إلغاء الكتم" : "كتم"}">
           <i class="fas ${muteIconClass} text-xs"></i>
        </button>
        <button onclick="adminAction('${id}', 'kick')" 
            class="text-red-500 bg-black/50 px-2 py-1 rounded hover:bg-white/10 transition-colors" 
            title="طرد">
            <i class="fas fa-ban text-xs"></i>
        </button>
    </div>`
        : ""
    }
`;
  return div;
}

async function adminAction(targetId, action) {
  if (!isAdmin) return;
  if (!confirm("هل أنت متأكد من هذا الإجراء؟")) return;

  const ref = db.collection("rooms").doc(currentRoomId).collection("participants").doc(targetId);

  try {
    if (action === "kick") {
      await ref.update({ kicked: true });
      showToast("تم طرد العضو", "success");
    } else if (action === "toggleMute") {
      const doc = await ref.get();
      if (doc.exists) {
        const currentStatus = doc.data().mutedByAdmin || false;
        await ref.update({ mutedByAdmin: !currentStatus });
        showToast(currentStatus ? "تم إلغاء كتم العضو" : "تم كتم العضو", "success");
      }
    }
  } catch (e) {
    console.error("Admin action error:", e);
    showToast("حدث خطأ", "error");
  }
}

async function sendReaction(emoji) {
  if (!currentRoomId) return;
  try {
    await db.collection("rooms").doc(currentRoomId).collection("participants").doc(localUserId).update({
      reaction: { emoji: emoji, ts: Date.now() },
    });
  } catch (e) {
    console.error("Send reaction error:", e);
  }
}

function showReaction(userId, emoji) {
  const container = document.getElementById(`react-container-${userId}`);
  if (!container) return;

  const el = document.createElement("div");
  el.textContent = emoji;
  el.className = "reaction-item";
  container.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ================= SPEAKER MODE =================
async function toggleSpeakerMode() {
  const btn = document.getElementById("speakerBtn");
  const audios = document.querySelectorAll("audio");
  const isLow = btn.classList.contains("earpiece-active");

  if (!isLow) {
    btn.classList.add("earpiece-active", "text-amber-500");
    btn.innerHTML = '<i class="fas fa-phone-alt"></i>';

    audios.forEach((audio) => (audio.volume = 0.1));
    showToast("وضع المكالمة: ضع الهاتف على أذنك", "info");
  } else {
    btn.classList.remove("earpiece-active", "text-amber-500");
    btn.innerHTML = '<i class="fas fa-volume-up"></i>';

    audios.forEach((audio) => (audio.volume = 1.0));
    showToast("تم تفعيل مكبر الصوت", "info");
  }
}

// ================= ROOM MANAGEMENT =================
window.addEventListener("beforeunload", () => {
  leaveRoom(false);
});

function leaveRoom(reload = true) {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  if (currentRoomId && localUserId) {
    const ref = db.collection("rooms").doc(currentRoomId).collection("participants").doc(localUserId);
    ref.delete().catch((e) => console.error("Delete participant error:", e));
  }

  listeners.forEach((unsubscribe) => {
    try {
      unsubscribe();
    } catch (e) {}
  });
  listeners = [];

  Object.values(peerConnections).forEach((pc) => {
    try {
      pc.close();
    } catch (e) {}
  });
  peerConnections = {};

  // Destroy the player instance
  VideoPlayer.destroy();

  if (reload) {
    window.location.href = window.location.pathname;
  }
}

// ================= STREAMING CONTROLS =================
function toggleStreamModal() {
  document.getElementById("streamModal").classList.toggle("hidden");
}

async function startStream() {
  const url = document.getElementById("streamUrl").value.trim();
  if (!url) {
    showToast("أدخل رابط الفيديو", "error");
    return;
  }

  if (!isAdmin) {
    showToast("غير مسموح - أنت لست مدير الغرفة", "error");
    return;
  }

  try {
    toggleStreamModal();

    const finalURL = wrapWithProxy(url);

    await db.collection("rooms").doc(currentRoomId).update({
      streamConfig: {
        url: finalURL,
        active: true,
        state: {
          time: 0,
          paused: true,
          ts: firebase.firestore.FieldValue.serverTimestamp(),
        },
      },
    });

    showToast("تم بدء البث", "success");
  } catch (e) {
    console.error("Start stream error:", e);
    showToast("فشل بدء البث", "error");
  }
}

async function stopStream() {
  if (!isAdmin) {
    showToast("غير مسموح - أنت لست مدير الغرفة", "error");
    return;
  }

  try {
    toggleStreamModal();

    await db.collection("rooms").doc(currentRoomId).update({
      streamConfig: { active: false, url: "", state: null },
    });

    showToast("تم إيقاف البث", "info");
  } catch (e) {
    console.error("Stop stream error:", e);
    showToast("فشل إيقاف البث", "error");
  }
}

// ================= CHAT SYSTEM =================
function toggleChat() {
  const sb = document.getElementById("chatSidebar");
  const badge = document.getElementById("chatBadge");

  if (sb.classList.contains("-translate-x-full")) {
    sb.classList.remove("-translate-x-full");
    sb.classList.add("translate-x-0");
    badge.classList.add("hidden");
  } else {
    sb.classList.add("-translate-x-full");
    sb.classList.remove("translate-x-0");
  }
}

function updateChatUI(snap) {
  const container = document.getElementById("chatMessages");
  const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;

  container.innerHTML = "";
  const msgs = [];
  snap.forEach((d) => msgs.push(d.data()));
  msgs.reverse().forEach((m) => {
    const isMe = m.senderId === localUserId;
    const div = document.createElement("div");
    div.className = `flex flex-col ${isMe ? "items-end" : "items-start"}`;
    div.innerHTML = `
        <div class="${isMe ? "bg-amber-600/80" : "bg-gray-700/80"} px-3 py-2 rounded-lg text-sm max-w-[85%] break-words text-white">
            ${!isMe ? `<span class="text-[10px] text-amber-400 block mb-0.5">${escapeHtml(m.sender)}</span>` : ""}
            ${escapeHtml(m.text)}
        </div>
    `;
    container.appendChild(div);
  });

  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }

  const sidebar = document.getElementById("chatSidebar");
  if (sidebar.classList.contains("-translate-x-full")) {
    document.getElementById("chatBadge").classList.remove("hidden");
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function sendMessage(e) {
  e.preventDefault();
  const inp = document.getElementById("chatInput");
  const text = inp.value.trim();

  if (!text) return;

  try {
    await db.collection("rooms").doc(currentRoomId).collection("messages").add({
      text: text,
      sender: currentUserName,
      senderId: localUserId,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
    inp.value = "";
  } catch (e) {
    console.error("Send message error:", e);
    showToast("فشل إرسال الرسالة", "error");
  }
}

// ================= WEBRTC =================
function initPeerConnection(remoteId, isInitiator) {
  const pc = new RTCPeerConnection(iceServers);
  peerConnections[remoteId] = pc;

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.ontrack = (e) => {
    const audio = document.getElementById(`audio-${remoteId}`);
    if (audio) {
      audio.srcObject = e.streams[0];
      audio.volume = 1.0;
      audio.play().catch((err) => console.error("Audio play error:", err));
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      db.collection("rooms")
        .doc(currentRoomId)
        .collection("participants")
        .doc(remoteId)
        .collection("candidates")
        .add({
          candidate: e.candidate.toJSON(),
          from: localUserId,
        })
        .catch((err) => console.error("ICE candidate error:", err));
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`Connection state with ${remoteId}:`, pc.iceConnectionState);
    updateSignalBars(remoteId, pc.iceConnectionState);
  };

  if (isInitiator) {
    pc.createOffer()
      .then((offer) => {
        pc.setLocalDescription(offer);
        db.collection("rooms")
          .doc(currentRoomId)
          .collection("participants")
          .doc(remoteId)
          .collection("offers")
          .add({
            offer: { type: offer.type, sdp: offer.sdp },
            from: localUserId,
          })
          .catch((err) => console.error("Offer error:", err));
      })
      .catch((err) => console.error("Create offer error:", err));
  }
}

function updateSignalBars(userId, state) {
  const bars = document.getElementById(`sig-${userId}`);
  if (!bars) return;

  bars.classList.remove("signal-good", "signal-fair", "signal-poor");

  if (state === "connected" || state === "completed") {
    bars.classList.add("signal-good");
  } else if (state === "checking" || state === "new") {
    bars.classList.add("signal-fair");
  } else {
    bars.classList.add("signal-poor");
  }
}

function setupWebRTCSignals(roomRef) {
  const myRef = roomRef.collection("participants").doc(localUserId);

  listeners.push(
    myRef.collection("offers").onSnapshot((snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          let pc = peerConnections[data.from];

          if (!pc) {
            initPeerConnection(data.from, false);
            pc = peerConnections[data.from];
          }

          try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            await roomRef.collection("participants").doc(data.from).collection("answers").add({
              answer: { type: answer.type, sdp: answer.sdp },
              from: localUserId,
            });

            change.doc.ref.delete();
          } catch (e) {
            console.error("Offer handling error:", e);
          }
        }
      });
    })
  );

  listeners.push(
    myRef.collection("answers").onSnapshot((snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          const pc = peerConnections[data.from];

          if (pc) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
              change.doc.ref.delete();
            } catch (e) {
              console.error("Answer handling error:", e);
            }
          }
        }
      });
    })
  );

  listeners.push(
    myRef.collection("candidates").onSnapshot((snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          const pc = peerConnections[data.from];

          if (pc) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
              change.doc.ref.delete();
            } catch (e) {
              console.error("ICE candidate handling error:", e);
            }
          }
        }
      });
    })
  );
}

// ================= UI HELPERS =================
function setupUI(code) {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appScreen").classList.remove("hidden");
  document.getElementById("displayRoomCode").textContent = code;
}

function showToast(msg, type = "info") {
  const c = document.getElementById("toastContainer");
  const el = document.createElement("div");

  const colors = {
    error: "bg-red-600",
    success: "bg-green-600",
    warning: "bg-amber-600",
    info: "bg-blue-600",
  };

  el.className = `p-4 rounded-lg shadow-lg text-white transform transition-all ${colors[type] || colors.info} animate-slide-in`;
  el.innerHTML = `
    <div class="flex items-center gap-2">
        <i class="fas ${
          type === "error"
            ? "fa-exclamation-circle"
            : type === "success"
            ? "fa-check-circle"
            : type === "warning"
            ? "fa-exclamation-triangle"
            : "fa-info-circle"
        }"></i>
        <span>${msg}</span>
    </div>
`;

  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-100%)";
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function copyRoomCode() {
  if (currentRoomId) {
    navigator.clipboard
      .writeText(currentRoomId)
      .then(() => showToast("تم نسخ الكود", "success"))
      .catch(() => showToast("فشل النسخ", "error"));
  }
}

function prepareCreateRoom() {
  document.getElementById("createRoomModal").classList.remove("hidden");
}

async function createRoom() {
  const pwd = document.getElementById("newRoomPassword").value.trim();
  const code = "R-" + Math.random().toString(36).substring(2, 8).toUpperCase();

  try {
    await db.collection("rooms").doc(code).set({
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: localUserId,
      password: pwd || null,
      streamConfig: { active: false, url: "", state: null },
    });

    document.getElementById("roomCode").value = code;
    document.getElementById("roomPassword").value = pwd;
    document.getElementById("createRoomModal").classList.add("hidden");

    await joinRoom(false);
  } catch (e) {
    console.error("Create room error:", e);
    showToast("فشل إنشاء الغرفة", "error");
  }
}

function toggleMute() {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  }

  const btn = document.getElementById("mainMuteBtn");
  btn.className = `w-12 h-12 rounded-full flex items-center justify-center text-xl transition-all shadow-lg ${
    isMuted ? "bg-red-500 text-white hover:bg-red-600" : "bg-white text-black hover:scale-110"
  }`;

  if (currentRoomId) {
    db.collection("rooms")
      .doc(currentRoomId)
      .collection("participants")
      .doc(localUserId)
      .update({ muted: isMuted })
      .catch((e) => console.error("Update mute status error:", e));
  }

  showToast(isMuted ? "تم كتم الصوت" : "تم إلغاء الكتم", isMuted ? "warning" : "success");
}

function updateCardStatus(card, data) {
  const dot = card.querySelector(".status-dot");
  if (dot) {
    dot.className = `status-dot absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-[#1e293b] ${
      data.muted ? "bg-red-500" : "bg-green-500"
    }`;
  }

  const muteBtn = card.querySelector(`[id^="btn-mute-"] i`);
  if (muteBtn) {
    muteBtn.className = `fas ${
      data.mutedByAdmin ? "fa-microphone-slash text-red-500" : "fa-microphone text-white"
    } text-xs`;
  }
}

function closeConnection(id) {
  if (peerConnections[id]) {
    try {
      peerConnections[id].close();
    } catch (e) {
      console.error("Close connection error:", e);
    }
    delete peerConnections[id];
  }
}

function initVisualizer(stream) {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 32;
    src.connect(analyser);

    const bars = document.querySelectorAll("#localVisualizer .bar");
    const arr = new Uint8Array(analyser.frequencyBinCount);

    function anim() {
      if (!isMuted) {
        analyser.getByteFrequencyData(arr);
        const vol = (arr[0] + arr[1] + arr[2]) / 3;
        bars.forEach((b, i) => {
          b.style.height = Math.max(4, (vol / 255) * 24 + i * 4) + "px";
        });
      } else {
        bars.forEach((b) => (b.style.height = "4px"));
      }
      requestAnimationFrame(anim);
    }
    anim();
  } catch (e) {
    console.error("Visualizer error:", e);
  }
}
