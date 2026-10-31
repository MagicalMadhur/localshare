// Configuration
const STUN_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};
const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
];
const CHUNK_SIZE = 64 * 1024; // 64 KB for WebRTC DataChannel

// State
let myPeerId = generateId();
let roomId = null;
let cryptoKey = null;
let mqttClient = null;
let currentBrokerIndex = 0;
let connectionTimer = null;
let isConnected = false;
let peers = {}; // mapping peerId -> { pc, dataChannel }
let receiveBuffers = {}; // file transfer buffers
let typingTimeout = null;
let isUpdatingFromNetwork = false;
let filesCatalog = []; // Shared 7-day files
let lastDeletedFile = null;
let undoTimer = null;
let toastTimeout = null;

// UI Elements
const statusDot = document.querySelector('.status-dot');
const statusText = document.getElementById('statusText');
const sharedText = document.getElementById('sharedText');
const textSaveStatus = document.getElementById('textSaveStatus');
const textSaveMsg = document.getElementById('textSaveMsg');
const copyBtn = document.getElementById('copyBtn');
const clearBtn = document.getElementById('clearBtn');
const copyToast = document.getElementById('copyToast');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const transfersContainer = document.getElementById('transfersContainer');
const filesListContainer = document.getElementById('filesListContainer');
const emptyFilesMsg = document.getElementById('emptyFilesMsg');
const catalogSummary = document.getElementById('catalogSummary');
const catalogCount = document.getElementById('catalogCount');
const catalogTotalSize = document.getElementById('catalogTotalSize');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const deleteAllBtn = document.getElementById('deleteAllBtn');
const activeUploadsContainer = document.getElementById('activeUploadsContainer');
const undoToast = document.getElementById('undoToast');
const undoToastMsg = document.getElementById('undoToastMsg');
const undoToastBtn = document.getElementById('undoToastBtn');

// Image Preview Modal Elements & State
let currentPreviewIndex = -1;
let previewImagesList = [];
const imagePreviewModal = document.getElementById('imagePreviewModal');
const previewBackdrop = document.getElementById('previewBackdrop');
const previewFileName = document.getElementById('previewFileName');
const previewFileMeta = document.getElementById('previewFileMeta');
const previewImage = document.getElementById('previewImage');
const previewSpinner = document.getElementById('previewSpinner');
const previewDownloadBtn = document.getElementById('previewDownloadBtn');
const previewOpenTabBtn = document.getElementById('previewOpenTabBtn');
const previewCloseBtn = document.getElementById('previewCloseBtn');
const previewPrevBtn = document.getElementById('previewPrevBtn');
const previewNextBtn = document.getElementById('previewNextBtn');

// --- Initialization ---

async function init() {
    try {
        updateStatus('Getting IP...', 'connecting');
        const ip = await getPublicIP();
        
        // Derive Room ID and Crypto Key from IP
        roomId = await hashString(ip);
        cryptoKey = await deriveKey(ip);
        
        updateStatus('Connecting to network...', 'connecting');
        setupMQTT(0);
    } catch (err) {
        console.error('Init error:', err);
        updateStatus('Initialization failed', 'error');
    }
}

function isIPv4(ip) {
    if (!ip || typeof ip !== 'string') return false;
    const parts = ip.trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => {
        const num = Number(part);
        return Number.isInteger(num) && num >= 0 && num <= 255 && String(num) === part;
    });
}

async function getPublicIP() {
    try {
        const cached = sessionStorage.getItem('localshare_cached_ip');
        if (cached && isIPv4(cached)) return cached.trim();
        sessionStorage.removeItem('localshare_cached_ip');
    } catch (e) {}

    const fetchCF = async () => {
        const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(3000) });
        const text = await res.text();
        const match = text.match(/^ip=(.+)$/m);
        if (match && match[1] && isIPv4(match[1])) return match[1].trim();
        throw new Error('No IPv4 in trace');
    };

    const fetchIpify = async () => {
        const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
        const data = await res.json();
        if (data && data.ip && isIPv4(data.ip)) return data.ip.trim();
        throw new Error('No IPv4 in ipify');
    };

    const fetchIcanhaz = async () => {
        const res = await fetch('https://ipv4.icanhazip.com', { signal: AbortSignal.timeout(3000) });
        const text = await res.text();
        if (text && isIPv4(text.trim())) return text.trim();
        throw new Error('No IPv4 in icanhaz');
    };

    try {
        // Race IPv4 endpoints in parallel
        const ip = await Promise.any([fetchCF(), fetchIpify(), fetchIcanhaz()]);
        try {
            sessionStorage.setItem('localshare_cached_ip', ip);
        } catch (e) {}
        console.log(`[LocalShare] Detected router IPv4: ${ip}`);
        return ip;
    } catch (err) {
        console.warn('All primary IPv4 racing failed, trying fallback...', err);
        const res = await fetch('https://ipv4.icanhazip.com');
        const text = await res.text();
        const ip = text.trim();
        if (isIPv4(ip)) {
            try { sessionStorage.setItem('localshare_cached_ip', ip); } catch (e) {}
            return ip;
        }
        throw new Error('Could not resolve valid IPv4 address');
    }
}

async function hashString(str) {
    const msgBuffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

// --- Encryption (Web Crypto API) ---

async function deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]
    );
    // Use a static salt based on the app name for consistent derivation across devices
    const salt = enc.encode("LocalShareSalt");
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}

async function encryptText(text) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, cryptoKey, enc.encode(text)
    );
    // Combine IV and Ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return combined;
}

async function decryptText(combinedArray) {
    try {
        const iv = combinedArray.slice(0, 12);
        const ciphertext = combinedArray.slice(12);
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv }, cryptoKey, ciphertext
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        console.error("Decryption failed", e);
        return null;
    }
}

// --- Utilities ---

function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

function updateStatus(text, state) {
    statusText.textContent = text;
    statusDot.className = `status-dot ${state}`;
}

function setSaveStatus(state, msg) {
    textSaveStatus.className = `save-status ${state}`;
    textSaveMsg.textContent = msg;
}

function updateConnectionCount() {
    const count = Object.keys(peers).filter(id => peers[id].dataChannel && peers[id].dataChannel.readyState === 'open').length;
    if (count > 0) {
        updateStatus(`Files: Ready | Connected to ${count} device(s)`, 'connected');
    } else {
        updateStatus('Connected to network', 'connected');
    }
}

// --- Signaling & PubSub (MQTT) ---

function setupMQTT(brokerIndex = 0) {
    if (mqttClient) {
        try {
            mqttClient.removeAllListeners();
            mqttClient.end(true);
        } catch (e) {}
        mqttClient = null;
    }

    isConnected = false;
    currentBrokerIndex = brokerIndex % MQTT_BROKERS.length;
    const currentBroker = MQTT_BROKERS[currentBrokerIndex];
    console.log(`Connecting to MQTT broker: ${currentBroker}`);
    updateStatus('Connecting to network...', 'connecting');

    if (connectionTimer) clearTimeout(connectionTimer);

    // If broker connection hangs or fails to connect in 6 seconds, switch to next broker
    connectionTimer = setTimeout(() => {
        if (!isConnected) {
            console.warn(`Connection to ${currentBroker} timed out, switching to fallback broker...`);
            setupMQTT(currentBrokerIndex + 1);
        }
    }, 6000);

    try {
        mqttClient = mqtt.connect(currentBroker, {
            connectTimeout: 5000,
            reconnectPeriod: 4000,
            clientId: 'localshare_' + myPeerId + '_' + Math.random().toString(16).substring(2, 6)
        });
    } catch (err) {
        console.error('MQTT connect error:', err);
        setupMQTT(currentBrokerIndex + 1);
        return;
    }

    mqttClient.on('connect', () => {
        isConnected = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        console.log(`Connected to broker: ${currentBroker}`);
        
        const baseTopic = `localshare/room/${roomId}`;
        
        // Subscribe to signaling and text updates
        mqttClient.subscribe(baseTopic, () => {
            updateConnectionCount(); 
            broadcastSignaling({ type: 'hello', peerId: myPeerId });
        });
        
        // Subscribe to text persistence topic
        mqttClient.subscribe(`${baseTopic}/text`, () => {
            setSaveStatus('saved', 'Synced securely to network');
        });

        // Subscribe to 7-day files catalog persistence topic
        mqttClient.subscribe(`${baseTopic}/files`, () => {
            console.log('Subscribed to files catalog topic');
        });
    });

    mqttClient.on('message', async (topic, message) => {
        const textTopic = `localshare/room/${roomId}/text`;
        const filesTopic = `localshare/room/${roomId}/files`;
        
        // Handle persistent 7-day files catalog messages
        if (topic === filesTopic) {
            const arrayBuf = new Uint8Array(message);
            if (arrayBuf.length > 0) {
                const decryptedPayload = await decryptText(arrayBuf);
                if (decryptedPayload !== null) {
                    try {
                        const data = JSON.parse(decryptedPayload);
                        const list = Array.isArray(data.files) ? data.files : [];
                        const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
                        const now = Date.now();
                        filesCatalog = list.filter(f => (now - f.timestamp) <= sevenDaysInMs);
                        renderFilesList();
                    } catch (e) {
                        console.error('Failed to parse files catalog payload', e);
                    }
                }
            } else {
                filesCatalog = [];
                renderFilesList();
            }
            return;
        }

        // Handle persistent text messages
        if (topic === textTopic) {
            // message is a Buffer
            const arrayBuf = new Uint8Array(message);
            if (arrayBuf.length > 0) {
                const decryptedPayload = await decryptText(arrayBuf);
                if (decryptedPayload !== null) {
                    let data;
                    try {
                        data = JSON.parse(decryptedPayload);
                    } catch (e) {
                        // Backwards compatibility for old raw text
                        data = { text: decryptedPayload, timestamp: Date.now() };
                    }

                    const ageInMs = Date.now() - data.timestamp;
                    const twoDaysInMs = 2 * 24 * 60 * 60 * 1000;

                    if (ageInMs > twoDaysInMs) {
                        // Data is expired! Clear it from our screen and the network.
                        if (sharedText.value !== '') {
                            isUpdatingFromNetwork = true;
                            sharedText.value = '';
                            isUpdatingFromNetwork = false;
                        }
                        publishText('');
                        setSaveStatus('saved', 'Expired data cleared');
                    } else {
                        if (sharedText.value !== data.text) {
                            isUpdatingFromNetwork = true;
                            sharedText.value = data.text;
                            isUpdatingFromNetwork = false;
                            setSaveStatus('saved', 'Synced securely to network');
                        }
                    }
                }
            }
            return;
        }

        // Handle signaling messages
        try {
            const data = JSON.parse(message.toString());
            if (data.sender === myPeerId) return; // Ignore own messages
            if (data.target && data.target !== myPeerId) return; // Ignore messages for others

            handleSignalingMessage(data);
        } catch (e) {
            console.error('Invalid MQTT signaling message', e);
        }
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Error:', err);
        if (!isConnected) {
            if (connectionTimer) clearTimeout(connectionTimer);
            setupMQTT(currentBrokerIndex + 1);
        } else {
            updateStatus('Reconnecting...', 'connecting');
        }
    });

    mqttClient.on('close', () => {
        if (!isConnected) {
            if (connectionTimer) clearTimeout(connectionTimer);
            setTimeout(() => {
                if (!isConnected) {
                    setupMQTT(currentBrokerIndex + 1);
                }
            }, 1000);
        }
    });
}

async function publishText(text) {
    if (!mqttClient || !mqttClient.connected) return;
    
    setSaveStatus('saving', 'Saving securely...');
    
    try {
        const payload = JSON.stringify({
            text: text,
            timestamp: Date.now()
        });
        
        const encrypted = await encryptText(payload);
        // Publish with retain: true so latecomers get the text instantly
        mqttClient.publish(`localshare/room/${roomId}/text`, encrypted, { retain: true, qos: 1 }, (err) => {
            if (!err) {
                setSaveStatus('saved', 'Saved securely');
            } else {
                setSaveStatus('error', 'Failed to save');
            }
        });
    } catch (e) {
        console.error("Encryption failed before publishing", e);
        setSaveStatus('error', 'Encryption failed');
    }
}

function broadcastSignaling(payload) {
    if (!mqttClient || !mqttClient.connected) return;
    payload.sender = myPeerId;
    mqttClient.publish(`localshare/room/${roomId}`, JSON.stringify(payload));
}

function sendSignaling(targetPeerId, payload) {
    if (!mqttClient || !mqttClient.connected) return;
    payload.sender = myPeerId;
    payload.target = targetPeerId;
    mqttClient.publish(`localshare/room/${roomId}`, JSON.stringify(payload));
}

// --- WebRTC (File Transfers) ---

async function handleSignalingMessage(msg) {
    const sender = msg.sender;

    if (msg.type === 'hello') {
        if (myPeerId > sender) {
            createPeerConnection(sender, true);
        }
    } else if (msg.type === 'offer') {
        const pc = createPeerConnection(sender, false);
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignaling(sender, { type: 'answer', sdp: pc.localDescription });
    } else if (msg.type === 'answer') {
        if (peers[sender] && peers[sender].pc) {
            await peers[sender].pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
    } else if (msg.type === 'candidate') {
        if (peers[sender] && peers[sender].pc) {
            try {
                await peers[sender].pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch (e) {
                console.error('Error adding ICE candidate', e);
            }
        }
    }
}

function createPeerConnection(remotePeerId, isInitiator) {
    if (peers[remotePeerId]) return peers[remotePeerId].pc;

    const pc = new RTCPeerConnection(STUN_SERVERS);
    peers[remotePeerId] = { pc, dataChannel: null };

    pc.onicecandidate = event => {
        if (event.candidate) {
            sendSignaling(remotePeerId, { type: 'candidate', candidate: event.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            console.log(`Peer ${remotePeerId} disconnected`);
            delete peers[remotePeerId];
            updateConnectionCount();
        }
    };

    if (isInitiator) {
        const dc = pc.createDataChannel('localshare', { });
        setupDataChannel(remotePeerId, dc);
        
        pc.createOffer().then(offer => {
            return pc.setLocalDescription(offer);
        }).then(() => {
            sendSignaling(remotePeerId, { type: 'offer', sdp: pc.localDescription });
        }).catch(e => console.error(e));
    } else {
        pc.ondatachannel = event => {
            setupDataChannel(remotePeerId, event.channel);
        };
    }

    return pc;
}

function setupDataChannel(remotePeerId, dc) {
    peers[remotePeerId].dataChannel = dc;
    dc.binaryType = 'arraybuffer'; 

    dc.onopen = () => {
        console.log(`DataChannel open with ${remotePeerId}`);
        updateConnectionCount();
    };

    dc.onclose = () => {
        console.log(`DataChannel closed with ${remotePeerId}`);
        delete peers[remotePeerId];
        updateConnectionCount();
    };

    dc.onmessage = event => {
        if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                handleDataMessage(remotePeerId, msg);
            } catch (e) {
                console.error("Failed to parse data channel message:", e);
            }
        } else if (event.data instanceof ArrayBuffer) {
            handleFileChunk(remotePeerId, event.data);
        }
    };
}

// --- Data Transfer (Metadata) ---

function broadcastDataMessage(msgObj) {
    const msgStr = JSON.stringify(msgObj);
    Object.values(peers).forEach(peer => {
        if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
            peer.dataChannel.send(msgStr);
        }
    });
}

function handleDataMessage(sender, msg) {
    if (msg.type === 'file-start') {
        receiveBuffers[msg.fileId] = {
            metadata: msg.metadata,
            chunks: [],
            receivedBytes: 0,
            uiElement: createTransferUI(msg.metadata.name, msg.metadata.size, 'receiving')
        };
    } else if (msg.type === 'file-end') {
        finishFileReceive(msg.fileId);
    }
}

// --- File Transfer (Binary over WebRTC) ---

async function sendFiles(files) {
    for (const file of files) {
        await sendSingleFile(file);
    }
}

async function sendSingleFile(file) {
    if (Object.keys(peers).length === 0) {
        alert("Both devices must be online simultaneously for file transfers. No peers connected.");
        return;
    }

    const fileId = generateId();
    const metadata = { name: file.name, size: file.size, type: file.type };
    
    broadcastDataMessage({ type: 'file-start', fileId, metadata });
    
    const uiElement = createTransferUI(file.name, file.size, 'sending');
    const progressBar = uiElement.querySelector('.progress-bar');
    
    const arrayBuffer = await file.arrayBuffer();
    let offset = 0;
    const startTime = Date.now();

    const activeChannels = Object.values(peers)
        .map(p => p.dataChannel)
        .filter(dc => dc && dc.readyState === 'open');

    if (activeChannels.length === 0) return;

    return new Promise((resolve) => {
        function sendNextChunk() {
            while (offset < arrayBuffer.byteLength) {
                const isBufferFull = activeChannels.some(dc => dc.bufferedAmount > CHUNK_SIZE * 4);
                
                if (isBufferFull) {
                    setTimeout(sendNextChunk, 10);
                    return;
                }

                const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
                
                const fileIdBytes = new TextEncoder().encode(fileId.padEnd(8, ' '));
                const combined = new Uint8Array(fileIdBytes.byteLength + chunk.byteLength);
                combined.set(fileIdBytes, 0);
                combined.set(new Uint8Array(chunk), fileIdBytes.byteLength);

                activeChannels.forEach(dc => {
                    try { dc.send(combined.buffer); } catch (e) { console.error("Send error:", e); }
                });

                offset += chunk.byteLength;
                
                const percent = (offset / arrayBuffer.byteLength) * 100;
                progressBar.style.width = `${percent}%`;

                const elapsedSeconds = (Date.now() - startTime) / 1000;
                if (elapsedSeconds > 0) {
                    const speed = formatBytes(offset / elapsedSeconds) + '/s';
                    uiElement.querySelector('.speed').textContent = speed;
                }
            }

            progressBar.style.width = '100%';
            uiElement.classList.add('done');
            uiElement.querySelector('.speed').textContent = 'Completed';
            broadcastDataMessage({ type: 'file-end', fileId });
            resolve();
        }

        sendNextChunk();
    });
}

function handleFileChunk(sender, buffer) {
    const fileIdBytes = buffer.slice(0, 8);
    const fileId = new TextDecoder().decode(fileIdBytes).trim();
    const chunkData = buffer.slice(8);

    const receiving = receiveBuffers[fileId];
    if (receiving) {
        receiving.chunks.push(chunkData);
        receiving.receivedBytes += chunkData.byteLength;
        
        const percent = (receiving.receivedBytes / receiving.metadata.size) * 100;
        receiving.uiElement.querySelector('.progress-bar').style.width = `${percent}%`;
    }
}

function finishFileReceive(fileId) {
    const receiving = receiveBuffers[fileId];
    if (receiving) {
        const blob = new Blob(receiving.chunks, { type: receiving.metadata.type });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = receiving.metadata.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        receiving.chunks = [];
        
        receiving.uiElement.classList.add('done');
        receiving.uiElement.querySelector('.speed').textContent = 'Downloaded';
        receiving.uiElement.querySelector('.progress-bar').style.width = '100%';
    }
}


// --- UI Events ---

sharedText.addEventListener('input', () => {
    if (isUpdatingFromNetwork) return; // Prevent loop
    
    setSaveStatus('saving', 'Saving...');
    
    // Debounce publishing to MQTT to avoid spamming the network
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        publishText(sharedText.value);
    }, 500); // Wait 500ms after last keystroke
});

copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(sharedText.value).then(() => {
        copyToast.classList.remove('hidden');
        setTimeout(() => copyToast.classList.add('hidden'), 2000);
    });
});

clearBtn.addEventListener('click', () => {
    sharedText.value = '';
    publishText('');
});

// --- 7-Day Cloud File Sharing (Filebin Anonymous Backend) ---

async function publishFilesCatalog() {
    if (!mqttClient || !mqttClient.connected) return;
    try {
        const payload = JSON.stringify({
            files: filesCatalog,
            timestamp: Date.now()
        });
        const encrypted = await encryptText(payload);
        mqttClient.publish(`localshare/room/${roomId}/files`, encrypted, { retain: true, qos: 1 });
    } catch (e) {
        console.error('Failed to publish files catalog', e);
    }
}

async function handleIncomingFiles(files) {
    if (!files || files.length === 0) return;
    for (const file of files) {
        if (file.size > 100 * 1024 * 1024) {
            // Over 100 MB: use direct P2P transfer
            alert(`"${file.name}" is ${formatBytes(file.size)} (> 100 MB).\nSending directly via live P2P (requires both devices to be online).`);
            sendSingleFile(file);
        } else {
            // 100 MB or under: upload to 7-day cloud storage
            await uploadCloudFile(file);
        }
    }
}

function uploadToStoCare(file, onProgress) {
    return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://ul.sto.care');
        xhr.upload.onprogress = e => {
            if (e.lengthComputable && onProgress) {
                onProgress(e.loaded, e.total);
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data && data.url) {
                        if (onProgress) onProgress(file.size, file.size);
                        resolve({
                            url: data.url,
                            provider: 'stocare'
                        });
                        return;
                    }
                } catch (e) {}
            }
            reject(new Error('StoCare returned HTTP ' + xhr.status));
        };
        xhr.onerror = () => reject(new Error('StoCare network error'));
        xhr.ontimeout = () => reject(new Error('StoCare timeout'));
        // Dynamic timeout based on file size: minimum 3 minutes, or 30 KB/s transfer time
        xhr.timeout = Math.max(180000, Math.ceil(file.size / 30000) * 1000);
        xhr.send(fd);
    });
}

async function uploadToStoCareWithRetry(file, onProgress, maxAttempts = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await uploadToStoCare(file, onProgress);
        } catch (err) {
            lastErr = err;
            console.warn(`StoCare upload attempt ${attempt} failed:`, err);
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, 1200 * attempt));
            }
        }
    }
    throw lastErr;
}

async function uploadToGofile(file, onProgress) {
    let server = 'store8';
    try {
        const sRes = await fetch('https://api.gofile.io/servers');
        if (sRes.ok) {
            const sData = await sRes.json();
            if (sData?.data?.servers?.[0]?.name) {
                server = sData.data.servers[0].name;
            }
        }
    } catch (e) {
        console.warn('Gofile server lookup fallback to store8', e);
    }

    return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `https://${server}.gofile.io/contents/uploadfile`);
        xhr.upload.onprogress = e => {
            if (e.lengthComputable && onProgress) {
                onProgress(e.loaded, e.total);
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.status === 'ok' && data.data && data.data.downloadPage) {
                        if (onProgress) onProgress(file.size, file.size);
                        resolve({
                            url: data.data.downloadPage,
                            provider: 'gofile'
                        });
                        return;
                    }
                } catch (e) {}
            }
            reject(new Error('Gofile returned HTTP ' + xhr.status));
        };
        xhr.onerror = () => reject(new Error('Gofile network error'));
        xhr.ontimeout = () => reject(new Error('Gofile timeout'));
        xhr.timeout = Math.max(180000, Math.ceil(file.size / 30000) * 1000);
        xhr.send(fd);
    });
}

function uploadToTmpfiles(file, onProgress) {
    return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://tmpfiles.org/api/v1/upload');
        xhr.upload.onprogress = e => {
            if (e.lengthComputable && onProgress) {
                onProgress(e.loaded, e.total);
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.status === 'success' && data.data && data.data.url) {
                        const rawUrl = data.data.url;
                        const dlUrl = rawUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
                        if (onProgress) onProgress(file.size, file.size);
                        resolve({
                            url: dlUrl,
                            provider: 'tmpfiles'
                        });
                        return;
                    }
                } catch (e) {}
            }
            reject(new Error('Tmpfiles returned HTTP ' + xhr.status));
        };
        xhr.onerror = () => reject(new Error('Tmpfiles network error'));
        xhr.ontimeout = () => reject(new Error('Tmpfiles timeout'));
        xhr.timeout = Math.max(180000, Math.ceil(file.size / 30000) * 1000);
        xhr.send(fd);
    });
}

async function uploadCloudFile(file) {
    const uploadId = 'up_' + generateId();
    const uploadEl = createActiveUploadUI(uploadId, file.name, file.size);
    const progressBar = uploadEl ? uploadEl.querySelector('.progress-bar') : null;
    const speedText = uploadEl ? uploadEl.querySelector('.speed') : null;

    const updateProgress = (loaded, total, label = 'Cloudflare edge') => {
        const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (speedText) {
            speedText.textContent = `${label} · ${formatBytes(loaded)} / ${formatBytes(total)} (${pct}%)`;
        }
    };

    try {
        let result = null;
        try {
            updateProgress(0, file.size, 'Cloudflare edge');
            result = await uploadToStoCareWithRetry(file, (loaded, total) => updateProgress(loaded, total, 'Cloudflare edge'));
        } catch (scErr) {
            console.warn('StoCare upload failed after retries, trying backup cloud provider (Gofile)...', scErr);
            try {
                updateProgress(0, file.size, 'Backup cloud');
                result = await uploadToGofile(file, (loaded, total) => updateProgress(loaded, total, 'Backup cloud'));
            } catch (gfErr) {
                console.warn('Gofile upload failed, trying Tmpfiles fallback...', gfErr);
                updateProgress(0, file.size, 'Tmpfiles fallback');
                result = await uploadToTmpfiles(file, (loaded, total) => updateProgress(loaded, total, 'Tmpfiles fallback'));
            }
        }

        const fileObj = {
            id: generateId(),
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream',
            url: result.url,
            provider: result.provider,
            timestamp: Date.now()
        };

        if (uploadEl) {
            uploadEl.classList.add('done');
            if (progressBar) progressBar.style.width = '100%';
            if (speedText) speedText.textContent = 'Upload complete!';
            await new Promise(r => setTimeout(r, 400));
            uploadEl.remove();
        }

        // Update local catalog and broadcast
        filesCatalog = filesCatalog.filter(f => f.name !== file.name);
        filesCatalog.unshift(fileObj);
        publishFilesCatalog();
        renderFilesList();
    } catch (err) {
        console.error('All cloud upload providers failed:', err);
        if (uploadEl) uploadEl.remove();
        alert(`Cloud upload for "${file.name}" encountered an issue. Falling back to direct P2P transfer.`);
        sendSingleFile(file);
    }
}

function downloadFile(fileId) {
    const file = filesCatalog.find(f => f.id === fileId);
    if (!file) return;
    if (file.provider === 'gofile') {
        window.open(file.url, '_blank');
        return;
    }
    const a = document.createElement('a');
    a.href = file.url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function loadJSZip() {
    if (typeof JSZip !== 'undefined') return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = () => resolve(window.JSZip);
        s.onerror = () => reject(new Error('Failed to load JSZip'));
        document.head.appendChild(s);
    });
}

async function downloadAllZip() {
    if (!filesCatalog || filesCatalog.length === 0) return;

    const originalText = downloadAllBtn ? downloadAllBtn.innerHTML : '';
    if (downloadAllBtn) {
        downloadAllBtn.disabled = true;
        downloadAllBtn.textContent = 'Preparing .zip...';
    }

    try {
        await loadJSZip();
        const zip = new JSZip();
        for (let i = 0; i < filesCatalog.length; i++) {
            const file = filesCatalog[i];
            if (downloadAllBtn) downloadAllBtn.textContent = `Fetching (${i + 1}/${filesCatalog.length})...`;
            try {
                const res = await fetch(file.url);
                const blob = await res.blob();
                zip.file(file.name, blob);
            } catch (e) {
                console.warn('Failed to fetch file for zip:', file.name, e);
            }
        }

        if (downloadAllBtn) downloadAllBtn.textContent = 'Generating .zip...';
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipUrl = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = zipUrl;
        a.download = `LocalShare-files-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(zipUrl), 30000);
    } catch (err) {
        console.error('Client zip error:', err);
        for (const file of filesCatalog) {
            downloadFile(file.id);
            await new Promise(r => setTimeout(r, 400));
        }
    } finally {
        if (downloadAllBtn) {
            downloadAllBtn.disabled = false;
            downloadAllBtn.innerHTML = originalText;
        }
    }
}

async function deleteCloudFile(fileId) {
    const file = filesCatalog.find(f => f.id === fileId);
    if (!file) return;

    if (currentPreviewIndex !== -1 && previewImagesList[currentPreviewIndex]?.id === fileId) {
        closeImagePreview();
    }

    // Stash for undo
    lastDeletedFile = file;
    filesCatalog = filesCatalog.filter(f => f.id !== fileId);
    publishFilesCatalog();
    renderFilesList();

    // Show undo toast
    showUndoToast(file.name, async () => {
        // User clicked Undo
        if (lastDeletedFile) {
            filesCatalog.unshift(lastDeletedFile);
            lastDeletedFile = null;
            publishFilesCatalog();
            renderFilesList();
        }
    });

    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
        lastDeletedFile = null;
    }, 5500);
}

async function deleteAllCloudFiles() {
    if (filesCatalog.length === 0) return;
    if (!confirm('Are you sure you want to delete all shared files?')) return;

    filesCatalog = [];
    publishFilesCatalog();
    renderFilesList();
}

function showUndoToast(fileName, onUndo) {
    if (!undoToast) return;
    undoToastMsg.textContent = `${fileName} deleted`;
    undoToast.classList.remove('hidden');

    const handleUndo = () => {
        undoToast.classList.add('hidden');
        undoToastBtn.removeEventListener('click', handleUndo);
        if (toastTimeout) clearTimeout(toastTimeout);
        onUndo();
    };

    undoToastBtn.onclick = handleUndo;

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        undoToast.classList.add('hidden');
        undoToastBtn.onclick = null;
    }, 5000);
}

function renderFilesList() {
    if (!filesListContainer) return;

    const totalCount = filesCatalog.length;
    if (totalCount === 0) {
        if (emptyFilesMsg) emptyFilesMsg.classList.remove('hidden');
        if (catalogSummary) catalogSummary.classList.add('hidden');
        if (downloadAllBtn) downloadAllBtn.classList.add('hidden');
        if (deleteAllBtn) deleteAllBtn.classList.add('hidden');
        filesListContainer.innerHTML = '';
        if (emptyFilesMsg) filesListContainer.appendChild(emptyFilesMsg);
        return;
    }

    if (emptyFilesMsg) emptyFilesMsg.classList.add('hidden');
    if (catalogSummary) catalogSummary.classList.remove('hidden');
    if (downloadAllBtn) downloadAllBtn.classList.remove('hidden');
    if (deleteAllBtn) deleteAllBtn.classList.remove('hidden');

    const totalBytes = filesCatalog.reduce((sum, f) => sum + (f.size || 0), 0);
    catalogCount.textContent = `Your files ${totalCount}`;
    catalogTotalSize.textContent = formatBytes(totalBytes);

    filesListContainer.innerHTML = '';

    filesCatalog.forEach(file => {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.dataset.id = file.id;

        const { category, label, isImage } = getFileCategory(file.name, file.type);

        const iconHtml = (isImage && file.url) ? `
            <div class="file-icon-box image has-thumbnail" title="Click to preview">
                <img src="${escapeHtml(file.url)}" alt="${escapeHtml(file.name)}" class="file-thumbnail-img" loading="lazy" onerror="this.style.display='none'; this.parentElement.classList.remove('has-thumbnail'); this.parentElement.textContent='${label}';" />
            </div>
        ` : `
            <div class="file-icon-box ${category}">${label}</div>
        `;

        const previewBtnHtml = isImage ? `
            <button class="file-action-btn preview" title="Preview image">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            </button>
        ` : '';

        card.innerHTML = `
            <div class="file-card-main ${isImage ? 'clickable' : ''}" title="${isImage ? 'Click to preview' : ''}">
                ${iconHtml}
                <div class="file-details">
                    <div class="file-title" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                    <div class="file-submeta">
                        <span>${formatBytes(file.size)}</span>
                        <span>•</span>
                        <span>${timeAgo(file.timestamp)}</span>
                    </div>
                </div>
            </div>
            <div class="file-actions">
                ${previewBtnHtml}
                <button class="file-action-btn download" title="Download">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </button>
                <button class="file-action-btn delete" title="Delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `;

        if (isImage) {
            const cardMain = card.querySelector('.file-card-main');
            if (cardMain) cardMain.onclick = () => openImagePreview(file.id);
            const prevBtn = card.querySelector('.file-action-btn.preview');
            if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); openImagePreview(file.id); };
        }

        card.querySelector('.download').onclick = (e) => { e.stopPropagation(); downloadFile(file.id); };
        card.querySelector('.delete').onclick = (e) => { e.stopPropagation(); deleteCloudFile(file.id); };

        filesListContainer.appendChild(card);
    });
}

function getFileCategory(filename, mimeType = '') {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext) || mimeType.startsWith('image/')) {
        return { category: 'image', label: ext.substring(0, 3).toUpperCase() || 'IMG', isImage: true };
    }
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
        return { category: 'archive', label: 'ZIP', isImage: false };
    }
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'ogg', 'm4a'].includes(ext) || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
        return { category: 'media', label: ext.substring(0, 3).toUpperCase() || 'MED', isImage: false };
    }
    if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'xlsx', 'csv', 'pptx'].includes(ext)) {
        return { category: 'document', label: ext.substring(0, 3).toUpperCase() || 'DOC', isImage: false };
    }
    return { category: 'default', label: ext.substring(0, 3).toUpperCase() || 'FILE', isImage: false };
}

function timeAgo(timestamp) {
    if (!timestamp) return 'just now';
    const elapsed = Date.now() - timestamp;
    const sec = Math.floor(elapsed / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function createActiveUploadUI(id, name, size) {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'transfer-item';
    el.innerHTML = `
        <div class="transfer-info">
            <div class="file-name" title="${escapeHtml(name)}">
                ☁ Uploading: ${escapeHtml(name)}
            </div>
            <div class="file-meta">
                <span>${formatBytes(size)}</span>
                <span class="speed">Connecting to Cloudflare edge...</span>
            </div>
        </div>
        <div class="progress-bar-container">
            <div class="progress-bar" style="width: 0%;"></div>
        </div>
    `;
    activeUploadsContainer.prepend(el);
    return el;
}

dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleIncomingFiles(Array.from(e.dataTransfer.files));
    }
});

fileInput.addEventListener('change', e => {
    if (fileInput.files.length) {
        handleIncomingFiles(Array.from(fileInput.files));
        fileInput.value = '';
    }
});

window.addEventListener('paste', e => {
    if (document.activeElement === sharedText) return;
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        e.preventDefault();
        handleIncomingFiles(Array.from(e.clipboardData.files));
    }
});

if (downloadAllBtn) {
    downloadAllBtn.addEventListener('click', downloadAllZip);
}
if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', deleteAllCloudFiles);
}

function createTransferUI(name, size, type = 'sending') {
    const el = document.createElement('div');
    el.className = 'transfer-item';
    el.innerHTML = `
        <div class="transfer-info">
            <div class="file-name" title="${name}">
                ${type === 'sending' ? '↑' : '↓'} ${name}
            </div>
            <div class="file-meta">
                <span>${formatBytes(size)}</span>
                <span class="speed">Starting...</span>
            </div>
        </div>
        <div class="progress-bar-container">
            <div class="progress-bar"></div>
        </div>
    `;
    transfersContainer.prepend(el);
    return el;
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// --- In-App Image Preview (Google Drive Style) ---

function openImagePreview(fileId) {
    if (!imagePreviewModal) return;

    previewImagesList = filesCatalog.filter(f => {
        const cat = getFileCategory(f.name, f.type);
        return cat.isImage && f.url;
    });

    currentPreviewIndex = previewImagesList.findIndex(f => f.id === fileId);
    if (currentPreviewIndex === -1) return;

    renderActivePreview();
    imagePreviewModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function renderActivePreview() {
    if (currentPreviewIndex < 0 || currentPreviewIndex >= previewImagesList.length) return;
    const file = previewImagesList[currentPreviewIndex];

    if (previewFileName) {
        previewFileName.textContent = file.name;
        previewFileName.title = file.name;
    }
    if (previewFileMeta) {
        previewFileMeta.textContent = `${formatBytes(file.size)} • ${timeAgo(file.timestamp)}`;
    }

    if (previewSpinner) previewSpinner.classList.remove('hidden');
    if (previewImage) {
        previewImage.style.opacity = '0';
        previewImage.onload = () => {
            if (previewSpinner) previewSpinner.classList.add('hidden');
            previewImage.style.opacity = '1';
        };
        previewImage.onerror = () => {
            if (previewSpinner) previewSpinner.classList.add('hidden');
            previewImage.style.opacity = '1';
        };
        previewImage.src = file.url;
        previewImage.alt = file.name;
    }

    // Prev / Next button visibility
    if (previewImagesList.length > 1) {
        if (previewPrevBtn) previewPrevBtn.classList.remove('hidden');
        if (previewNextBtn) previewNextBtn.classList.remove('hidden');
    } else {
        if (previewPrevBtn) previewPrevBtn.classList.add('hidden');
        if (previewNextBtn) previewNextBtn.classList.add('hidden');
    }

    if (previewDownloadBtn) {
        previewDownloadBtn.onclick = () => downloadFile(file.id);
    }
    if (previewOpenTabBtn) {
        previewOpenTabBtn.onclick = () => window.open(file.url, '_blank');
    }
}

function closeImagePreview() {
    if (!imagePreviewModal) return;
    imagePreviewModal.classList.add('hidden');
    document.body.style.overflow = '';
    if (previewImage) previewImage.src = '';
    currentPreviewIndex = -1;
}

function showPrevImage() {
    if (previewImagesList.length <= 1) return;
    currentPreviewIndex = (currentPreviewIndex - 1 + previewImagesList.length) % previewImagesList.length;
    renderActivePreview();
}

function showNextImage() {
    if (previewImagesList.length <= 1) return;
    currentPreviewIndex = (currentPreviewIndex + 1) % previewImagesList.length;
    renderActivePreview();
}

if (previewCloseBtn) previewCloseBtn.onclick = closeImagePreview;
if (previewBackdrop) previewBackdrop.onclick = closeImagePreview;
if (previewPrevBtn) previewPrevBtn.onclick = (e) => { e.stopPropagation(); showPrevImage(); };
if (previewNextBtn) previewNextBtn.onclick = (e) => { e.stopPropagation(); showNextImage(); };

window.addEventListener('keydown', e => {
    if (imagePreviewModal && !imagePreviewModal.classList.contains('hidden')) {
        if (e.key === 'Escape') {
            closeImagePreview();
        } else if (e.key === 'ArrowLeft') {
            showPrevImage();
        } else if (e.key === 'ArrowRight') {
            showNextImage();
        }
    }
});

// Start application
init();
