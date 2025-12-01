// ===========================================
// Cloudflare Worker Proxy Wrapper
// ===========================================
const PROXY_ENDPOINT = "https://supermod.shetozxneno.workers.dev/?url=";

function wrapWithProxy(url) {
    const needsProxy =
        url.includes("hakunaymatata") ||
        url.includes("lok-lok") ||
        url.includes("shetozx") ||
        url.includes("sign=") ||
        url.includes("token=") ||
        url.includes(".mp4") ||
        url.includes(".m3u8");

    return needsProxy
        ? PROXY_ENDPOINT + encodeURIComponent(url)
        : url;
}

// ===========================================
// FINAL PLAYER SYSTEM WITH PROXY SUPPORT
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
        this.lastAdminState = null;

        this.setupPlayer();
        this.applyRolePermissions();
        this.listenForSync();
        this.setupLiveButton();
    },

    setupPlayer() {
        const videoElement = document.getElementById('player');
        this.player = new Plyr(videoElement, {
            controls: [
                'play-large', 'play', 'progress', 'current-time',
                'mute', 'volume', 'captions', 'settings',
                'pip', 'airplay', 'fullscreen'
            ],
            fullscreen: { enabled: true, fallback: true, iosNative: true },
            clickToPlay: false,
            keyboard: { focused: false, global: false },
        });

        this.player.on('waiting', () => document.getElementById("bufferingIndicator").style.opacity = "1");
        this.player.on('canplay', () => document.getElementById("bufferingIndicator").style.opacity = "0");

        this.player.on('playing', () => {
            document.getElementById("bufferingIndicator").style.opacity = "0";
            if (!this.isAdmin) this.checkLiveStatus();
        });

        this.player.on('timeupdate', () => {
            if (!this.isAdmin && !this.player.paused) this.checkLiveStatus();
        });

        this.player.on('pause', () => {
            if (!this.isAdmin) this.checkLiveStatus();
        });

        this.player.on('error', e => console.error("Player error:", e));
    },

    applyRolePermissions() {
        const container = this.player.elements.container;
        const liveButton = document.getElementById('liveButton');

        if (this.isAdmin) {
            container.classList.remove('player-user-view');
            if (liveButton) liveButton.classList.add('hidden');
            this.setupAdminControls();
        } else {
            container.classList.add('player-user-view');
            if (this.lastAdminState && this.currentUrl) {
                liveButton.classList.remove('hidden');
            }
        }
    },

    setupAdminControls() {
        const updateState = () => {
            if (!this.isAdmin || !this.player) return;

            this.db.collection("rooms").doc(this.roomId).update({
                "streamConfig.state": {
                    paused: this.player.paused,
                    time: this.player.currentTime,
                    ts: firebase.firestore.FieldValue.serverTimestamp()
                }
            });
        };

        this.player.on('play', updateState);
        this.player.on('pause', updateState);
        this.player.on('seeked', updateState);

        if (this.syncInterval) clearInterval(this.syncInterval);
        this.syncInterval = setInterval(() => {
            if (!this.player.paused && this.isAdmin) updateState();
        }, 3000);
    },

    listenForSync() {
        if (this.roomUnsubscribe) this.roomUnsubscribe();

        this.roomUnsubscribe = this.db.collection("rooms")
            .doc(this.roomId)
            .onSnapshot(doc => {
                if (doc.exists) this.handleStreamData(doc.data().streamConfig);
            });
    },

    handleStreamData(config) {
        const cinema = document.getElementById("cinemaContainer");
        const liveButton = document.getElementById("liveButton");

        if (!config || !config.active) {
            cinema.classList.add("hidden");
            if (liveButton) liveButton.classList.add("hidden");
            if (this.player) this.player.stop();
            this.currentUrl = null;
            this.lastAdminState = null;
            return;
        }

        cinema.classList.remove("hidden");
        if (!this.isAdmin) liveButton.classList.remove("hidden");

        if (this.currentUrl !== config.url) this.loadSource(config.url);

        if (config.state) {
            const s = config.state;
            s.ts = s.ts?.toMillis?.() ?? Date.now();
            this.lastAdminState = s;

            if (!this.isAdmin) this.syncToState(s);
        }
    },

    loadSource(url) {
        console.log("Loading original:", url);

        const finalURL = wrapWithProxy(url);
        console.log("Using:", finalURL);

        this.currentUrl = finalURL;

        const videoEl = this.player.elements.media;
        if (this.hls) this.hls.destroy();

        if (finalURL.endsWith(".m3u8") && Hls.isSupported()) {
            this.hls = new Hls();
            this.hls.loadSource(finalURL);
            this.hls.attachMedia(videoEl);
            return;
        }

        if (url.includes("youtube.com") || url.includes("youtu.be")) {
            this.player.source = {
                type: 'video',
                sources: [{ src: url, provider: "youtube" }]
            };
            return;
        }

        this.player.source = {
            type: "video",
            sources: [{ src: finalURL, type: "video/mp4" }]
        };
    },

    syncToState(state) {
        if (this.isAdmin || !this.player) return;

        const now = Date.now();
        if (now - this.lastSyncTime < 1500) return;
        this.lastSyncTime = now;

        this.isSyncing = true;
        try {
            const { expectedTime, isServerPaused } = this.calculateLivePoint();
            const diff = Math.abs(this.player.currentTime - expectedTime);

            if (!isServerPaused) this.player.play();
            else this.player.pause();

            if (diff > 2) {
                this.player.currentTime = expectedTime;
                const sync = document.getElementById("syncIndicator");
                sync.style.opacity = "1";
                setTimeout(() => sync.style.opacity = "0", 1000);
            }

            this.checkLiveStatus();
        } catch (e) {
            console.error(e);
        }

        setTimeout(() => (this.isSyncing = false), 300);
    },

    calculateLivePoint() {
        const st = this.lastAdminState;
        if (!st) return { expectedTime: 0, isServerPaused: true };

        let expected = st.time;
        if (!st.paused) expected += (Date.now() - st.ts) / 1000;

        return {
            expectedTime: expected,
            isServerPaused: st.paused
        };
    },

    setupLiveButton() {
        const btn = document.getElementById("liveButton");
        if (!btn || this.isAdmin) return;

        btn.addEventListener("click", () => this.jumpToLive());
    },

    jumpToLive() {
        if (this.isAdmin || !this.lastAdminState) return;

        const { expectedTime } = this.calculateLivePoint();
        this.player.currentTime = expectedTime;
        if (!this.lastAdminState.paused) this.player.play();
        this.checkLiveStatus();
    },

    checkLiveStatus() {
        if (this.isAdmin || !this.lastAdminState) return;

        const btn = document.getElementById("liveButton");
        const { expectedTime, isServerPaused } = this.calculateLivePoint();
        const diff = Math.abs(this.player.currentTime - expectedTime);

        if (isServerPaused) {
            diff < 1.5 ? btn.classList.remove("is-delayed") : btn.classList.add("is-delayed");
            return;
        }

        diff < 2.5
            ? btn.classList.remove("is-delayed")
            : btn.classList.add("is-delayed");
    },

    destroy() {
        if (this.roomUnsubscribe) this.roomUnsubscribe();
        if (this.syncInterval) clearInterval(this.syncInterval);
        if (this.player) this.player.destroy();
        if (this.hls) this.hls.destroy();

        this.player = null;
    }
};
