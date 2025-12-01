// player.js (Updated Version with Protected URLs Support)

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
    lastAdminState: null, // Store the last known state from admin

    // 1. Initialize the player system
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

    // 2. Setup Plyr instance and its event listeners
    setupPlayer() {
        const videoElement = document.getElementById('player');
        // Ensure native fullscreen is preferred and works on all devices
        const config = {
            controls: [
                'play-large', 'play', 'progress', 'current-time', 
                'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'
            ],
            // Use 'native' for fullscreen to ensure it works on mobile devices
            fullscreen: { enabled: true, fallback: true, iosNative: true }, 
            clickToPlay: false,
            keyboard: { focused: false, global: false },
        };

        this.player = new Plyr(videoElement, config);

        // UI Indicators
        this.player.on('waiting', () => document.getElementById("bufferingIndicator").style.opacity = "1");
        this.player.on('canplay', () => document.getElementById("bufferingIndicator").style.opacity = "0");
        this.player.on('playing', () => {
            document.getElementById("bufferingIndicator").style.opacity = "0";
            if (!this.isAdmin) this.checkLiveStatus(); // Update live button status
        });
        this.player.on('timeupdate', () => {
            if (!this.isAdmin && !this.player.paused) this.checkLiveStatus(); // Check on time update
        });
        this.player.on('pause', () => {
            if (!this.isAdmin) this.checkLiveStatus(); // Also check on pause
        });
        this.player.on('error', e => console.error("Player error:", e));
    },

    // 3. Apply UI changes based on user role
    applyRolePermissions() {
        const playerContainer = this.player.elements.container;
        const liveButton = document.getElementById('liveButton');

        if (this.isAdmin) {
            playerContainer.classList.remove('player-user-view');
            if(liveButton) liveButton.classList.add('hidden'); // Admin doesn't need live button
            this.setupAdminControls();
        } else {
            playerContainer.classList.add('player-user-view');
            // Show button for users if stream is active
            if (this.lastAdminState && this.currentUrl) {
                if(liveButton) liveButton.classList.remove('hidden');
            } else {
                if(liveButton) liveButton.classList.add('hidden');
            }
        }
    },

    // 4. For Admins: Push state to Firestore
    setupAdminControls() {
        const updateState = () => {
            if (this.isSyncing || !this.isAdmin || !this.player) return;

            const state = {
                paused: this.player.paused,
                time: this.player.currentTime,
                ts: firebase.firestore.FieldValue.serverTimestamp()
            };

            this.db.collection("rooms").doc(this.roomId).update({ "streamConfig.state": state })
                .catch(e => console.error("Admin: Error updating state", e));
        };

        this.player.on('play', updateState);
        this.player.on('pause', updateState);
        this.player.on('seeked', updateState);

        // More frequent updates for smoother experience
        if (this.syncInterval) clearInterval(this.syncInterval);
        this.syncInterval = setInterval(() => {
            if (this.player && !this.player.paused && this.isAdmin) {
                updateState();
            }
        }, 3000); // Update every 3 seconds
    },

    // 5. Listen to Firestore for stream data
    listenForSync() {
        if (this.roomUnsubscribe) this.roomUnsubscribe();
        this.roomUnsubscribe = this.db.collection("rooms").doc(this.roomId).onSnapshot(doc => {
            if (doc.exists) {
                const data = doc.data();
                if (data && data.streamConfig) {
                    this.handleStreamData(data.streamConfig);
                }
            }
        });
    },

    // 6. Process incoming stream data
    handleStreamData(config) {
        const cinemaContainer = document.getElementById('cinemaContainer');
        const liveButton = document.getElementById('liveButton');

        if (!config || !config.active) {
            cinemaContainer.classList.add('hidden');
            if(liveButton) liveButton.classList.add('hidden');
            if (this.player) this.player.stop();
            this.currentUrl = null;
            this.lastAdminState = null;
            return;
        }

        // If stream is active, show the player
        cinemaContainer.classList.remove('hidden');
        if (!this.isAdmin && liveButton) liveButton.classList.remove('hidden');

        // Load new video source if URL changes
        if (this.currentUrl !== config.url) {
            this.loadSource(config.url);
        }

        // Store the latest state and sync for non-admins
        if (config.state) {
            // Convert Firestore Timestamp to milliseconds
            const state = { ...config.state };
            if (state.ts && typeof state.ts.toMillis === 'function') {
                state.ts = state.ts.toMillis();
            }
            this.lastAdminState = state; // Always keep the latest state

            if (!this.isAdmin) {
                this.syncToState(state);
            }
        }
    },

    // 7. Load new source into the player
    loadSource(url) {
        console.log(`Loading new source: ${url}`);
        this.currentUrl = url;
        const videoElement = this.player.elements.media;

        if (this.hls) this.hls.destroy();

        // Check if URL needs special referrer (like hakunaymatata CDN)
        const needsReferrer = url.includes('hakunaymatata.com') || url.includes('lok-lok');

        if (url.endsWith('.m3u8') && Hls.isSupported()) {
            const hlsConfig = needsReferrer ? {
                xhrSetup: (xhr) => {
                    xhr.setRequestHeader('Referer', 'https://lok-lok.cc/');
                }
            } : {};
            
            this.hls = new Hls(hlsConfig);
            this.hls.loadSource(url);
            this.hls.attachMedia(videoElement);
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            this.player.source = {
                type: 'video',
                sources: [{ src: url, provider: 'youtube' }],
            };
        } else {
            // For direct MP4 files that need referrer, use blob approach
            if (needsReferrer) {
                this.loadProtectedVideo(url, videoElement);
            } else {
                this.player.source = {
                    type: 'video',
                    sources: [{ src: url }],
                };
            }
        }
    },

    // Load videos that require specific referrer
    async loadProtectedVideo(url, videoElement) {
        try {
            const response = await fetch(url, {
                method: 'GET',
                mode: 'cors',
                credentials: 'omit',
                headers: {
                    'Referer': 'https://lok-lok.cc/'
                }
            });

            if (!response.ok) throw new Error('Failed to load video');

            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            
            this.player.source = {
                type: 'video',
                sources: [{ src: blobUrl }],
            };
        } catch (error) {
            console.error('Error loading protected video:', error);
            // Fallback: try direct load anyway
            this.player.source = {
                type: 'video',
                sources: [{ src: url }],
            };
        }
    },

    // 8. Core synchronization logic for users
    syncToState(state) {
        if (!state || typeof state.ts !== 'number' || !this.player || this.isAdmin) return;

        const now = Date.now();
        // Allow sync if it's the first time or enough time has passed
        if (now - this.lastSyncTime < 2000 && this.player.currentTime > 0) return;
        this.lastSyncTime = now;

        this.isSyncing = true;

        try {
            const { expectedTime, isServerPaused } = this.calculateLivePoint();
            const localTime = this.player.currentTime;
            const timeDiff = Math.abs(localTime - expectedTime);

            // Major change: Always try to play if server is not paused.
            // This ensures users entering the room get immediate playback.
            if (!isServerPaused) {
                // The `play()` promise can be rejected if the user hasn't interacted with the page.
                // Modern browsers require a user gesture.
                const playPromise = this.player.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.warn("Autoplay was prevented. User must interact with the page first.", error);
                        // We might need a "Click to Play" overlay if autoplay fails consistently.
                        // For now, we assume user has clicked to join the room, which counts as interaction.
                    });
                }
            } else if (isServerPaused && !this.player.paused) {
                this.player.pause();
            }

            // Sync time if difference is significant (e.g., > 2 seconds)
            // This happens on join or if the user falls behind.
            if (timeDiff > 2.0) {
                const syncIndicator = document.getElementById('syncIndicator');
                syncIndicator.style.opacity = '1';
                setTimeout(() => syncIndicator.style.opacity = '0', 2000);
                this.player.currentTime = expectedTime;
            }

            this.checkLiveStatus(); // Update live button after sync
        } catch (e) {
            console.error("Error during syncToState:", e);
        } finally {
            setTimeout(() => { this.isSyncing = false; }, 500);
        }
    },

    // 9. Setup for the "LIVE" button
    setupLiveButton() {
        const liveButton = document.getElementById('liveButton');
        if (liveButton && !this.isAdmin) {
            liveButton.addEventListener('click', () => this.jumpToLive());
        }
    },

    // 10. Logic for the "LIVE" button to jump to the live point
    jumpToLive() {
        if (!this.player || this.isAdmin || !this.lastAdminState) return;

        this.isSyncing = true;
        const syncIndicator = document.getElementById('syncIndicator');
        syncIndicator.style.opacity = '1';

        const { expectedTime } = this.calculateLivePoint();
        this.player.currentTime = expectedTime;

        // If admin's stream is playing, user's should play too
        if (!this.lastAdminState.paused) {
            this.player.play();
        }

        this.checkLiveStatus(); // Button should turn red now
        setTimeout(() => {
            syncIndicator.style.opacity = '0';
            this.isSyncing = false;
        }, 1500);
    },

    // 11. Calculate the theoretical "live" point in time
    calculateLivePoint() {
        const state = this.lastAdminState;
        if (!state) return { expectedTime: 0, isServerPaused: true };

        const serverTime = state.time;
        const isServerPaused = state.paused;
        let expectedTime = serverTime;

        if (!isServerPaused) {
            // Latency Compensation
            const latency = (Date.now() - state.ts) / 1000;
            expectedTime = serverTime + latency;
        }

        return { expectedTime, isServerPaused };
    },

    // 12. Check if the user is in sync and update the LIVE button
    checkLiveStatus() {
        if (this.isAdmin || !this.player || !this.lastAdminState) return;

        const liveButton = document.getElementById('liveButton');
        if (!liveButton) return;

        const { expectedTime, isServerPaused } = this.calculateLivePoint();
        const localTime = this.player.currentTime;
        const timeDiff = Math.abs(localTime - expectedTime);

        // If server is paused, user is "live" if they are also paused near the correct time
        if (isServerPaused) {
             if (this.player.paused && timeDiff < 1.5) {
                liveButton.classList.remove('is-delayed'); // "Live" (Red)
             } else {
                liveButton.classList.add('is-delayed'); // "Not Live" (Gray)
             }
             return;
        }

        // If server is playing, user is "live" if they are close in time
        if (timeDiff > 2.5) { // 2.5 second buffer
            liveButton.classList.add('is-delayed'); // "Not Live" (Gray)
        } else {
            liveButton.classList.remove('is-delayed'); // "Live" (Red)
        }
    },

    // 13. Clean up resources
    destroy() {
        if (this.roomUnsubscribe) this.roomUnsubscribe();
        if (this.syncInterval) clearInterval(this.syncInterval);
        if (this.player) this.player.destroy();
        if (this.hls) this.hls.destroy();

        this.player = null;
        this.hls = null;
        this.roomId = null;
        this.currentUrl = null;
        this.roomUnsubscribe = null;
        this.lastAdminState = null;
    }
};
