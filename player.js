// ===========================================
// Cloudflare Worker Proxy Wrapper (FINAL FIXED)
// ===========================================
const PROXY_ENDPOINT = "https://supermod.shetozxneno.workers.dev/?url=";

function wrapWithProxy(url) {
    // لا تعيد لفّ الروابط التي بدأت بالبروكسي بالفعل
    if (url.startsWith(PROXY_ENDPOINT)) {
        return url;
    }

    const needsProxy =
        url.includes("hakunaymatata") ||
        url.includes("lok-lok") ||
        url.includes("sign=") ||
        url.includes("token=") ||
        url.includes(".mp4") ||
        url.includes(".m3u8");

    return needsProxy
        ? PROXY_ENDPOINT + encodeURIComponent(url)
        : url;
}

// ===========================================
// PLAYER SYSTEM
// ===========================================
const VideoPlayer = {
    player: null,
    db: null,
    roomId: null,
    userId: null,
    isAdmin: false,
    isSyncing: false,
    lastSyncTime: 0,
    syncInterval: null,
    hls: null,
    roomUnsubscribe: null,
    currentUrl: null,
    lastAdminState: null,

    init(db, roomId, userId, isAdmin) {
        this.db = db;
        this.roomId = roomId;
        this.userId = userId;
        this.isAdmin = isAdmin;

        this.setupPlayer();
        this.applyRolePermissions();
        this.listenForSync();
        this.setupLiveButton();
    },

    // ============= PLAYER SETUP =============
    setupPlayer() {
        const videoEl = document.getElementById('player');

        this.player = new Plyr(videoEl, {
            controls: [
                'play-large', 'play', 'progress', 'current-time',
                'mute', 'volume', 'captions', 'settings',
                'pip', 'airplay', 'fullscreen'
            ],
            fullscreen: { enabled: true, fallback: true, iosNative: true },
            clickToPlay: false,
            keyboard: { focused: false, global: false },
        });

        this.player.on('waiting', () => {
            document.getElementById("bufferingIndicator").style.opacity = "1";
        });

        this.player.on('canplay', () => {
            document.getElementById("bufferingIndicator").style.opacity = "0";
        });

        this.player.on('playing', () => {
            if (!this.isAdmin) this.checkLiveStatus();
        });

        this.player.on('pause', () => {
            if (!this.isAdmin) this.checkLiveStatus();
        });

        this.player.on('error', (e) => {
            console.error("PLAYER ERROR:", e);
        });
    },

    // ============= PERMISSIONS =============
    applyRolePermissions() {
        const c = this.player.elements.container;
        const liveBtn = document.getElementById('liveButton');

        if (this.isAdmin) {
            c.classList.remove('player-user-view');
            liveBtn.classList.add('hidden');
            this.setupAdminControls();
        } else {
            c.classList.add('player-user-view');
        }
    },

    // ============= ADMIN CONTROLS =============
    setupAdminControls() {
        const updateState = () => {
            if (!this.isAdmin) return;

            this.db.collection("rooms").doc(this.roomId).update({
                "streamConfig.state": {
                    paused: this.player.paused,
                    time: this.player.currentTime,
                    ts: firebase.firestore.FieldValue.serverTimestamp(),
                },
            });
        };

        this.player.on("play", updateState);
        this.player.on("pause", updateState);
        this.player.on("seeked", updateState);

        if (this.syncInterval) clearInterval(this.syncInterval);

        this.syncInterval = setInterval(() => {
            if (this.isAdmin && !this.player.paused) updateState();
        }, 3000);
    },

    // ============= FIRESTORE SYNC LISTENER =============
    listenForSync() {
        if (this.roomUnsubscribe) this.roomUnsubscribe();

        this.roomUnsubscribe = this.db
            .collection("rooms")
            .doc(this.roomId)
            .onSnapshot((doc) => {
                const config = doc.data()?.streamConfig;
                this.handleStreamData(config);
            });
    },

    // ============= HANDLE STREAM CONFIG =============
    handleStreamData(config) {
        const cinema = document.getElementById("cinemaContainer");
        const liveBtn = document.getElementById("liveButton");

        if (!config || !config.active) {
            cinema.classList.add("hidden");
            liveBtn.classList.add("hidden");
            this.player.stop();
            this.currentUrl = null;
            this.lastAdminState = null;
            return;
        }

        cinema.classList.remove("hidden");
        if (!this.isAdmin) liveBtn.classList.remove("hidden");

        // الإصلاح: منع إعادة تحميل نفس الرابط مرة أخرى
        if (!this.currentUrl || this.currentUrl !== config.url) {
            this.loadSource(config.url);
        }

        if (config.state) {
            const s = config.state;
            s.ts = s.ts?.toMillis?.() ?? Date.now();
            this.lastAdminState = s;

            if (!this.isAdmin) this.syncToState(s);
        }
    },

    // ============= LOAD VIDEO WITH PROXY FIX =============
    loadSource(url) {
        console.log("Loading ORIGINAL:", url);

        const finalURL = wrapWithProxy(url);
        console.log("Using:", finalURL);

        this.currentUrl = finalURL;

        const video = this.player.elements.media;

        if (this.hls) this.hls.destroy();

        // HLS
        if (finalURL.endsWith(".m3u8") && Hls.isSupported()) {
            this.hls = new Hls();
            this.hls.loadSource(finalURL);
            this.hls.attachMedia(video);
            return;
        }

        // YouTube
        if (url.includes("youtube.com") || url.includes("youtu.be")) {
            this.player.source = {
                type: "video",
                sources: [{ src: url, provider: "youtube" }],
            };
            return;
        }

        // MP4
        this.player.source = {
            type: "video",
            sources: [{ src: finalURL, type: "video/mp4" }],
        };
    },

    // ============= SYNC USERS =============
    syncToState(state) {
        if (this.isAdmin) return;

        const now = Date.now();
        if (now - this.lastSyncTime < 1500) return;
        this.lastSyncTime = now;

        const { expectedTime, isServerPaused } = this.calculateLivePoint();

        if (isServerPaused) this.player.pause();
        else this.player.play();

        const diff = Math.abs(this.player.currentTime - expectedTime);

        if (diff > 2.0) {
            this.player.currentTime = expectedTime;

            const sync = document.getElementById("syncIndicator");
            sync.style.opacity = "1";
            setTimeout(() => (sync.style.opacity = "0"), 1000);
        }
    },

    calculateLivePoint() {
        const s = this.lastAdminState;

        if (!s) return { expectedTime: 0, isServerPaused: true };

        let expected = s.time;

        if (!s.paused) {
            expected += (Date.now() - s.ts) / 1000;
        }

        return {
            expectedTime: expected,
            isServerPaused: s.paused,
        };
    },

    // ============= LIVE BUTTON =============
    setupLiveButton() {
        const btn = document.getElementById("liveButton");
        if (this.isAdmin) return;

        btn.addEventListener("click", () => this.jumpToLive());
    },

    jumpToLive() {
        if (this.isAdmin || !this.lastAdminState) return;

        const { expectedTime } = this.calculateLivePoint();
        this.player.currentTime = expectedTime;

        if (!this.lastAdminState.paused) this.player.play();
    },

    // ============= DESTROY =============
    destroy() {
        if (this.roomUnsubscribe) this.roomUnsubscribe();
        if (this.syncInterval) clearInterval(this.syncInterval);
        if (this.hls) this.hls.destroy();
        if (this.player) this.player.destroy();
    },
};
