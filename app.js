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

async function getPublicIP() {
    try {
        const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
        const data = await res.json();
        return data.ip;
    } catch (e) {
        console.warn('Primary IP service failed, trying fallback...', e);
        const res = await fetch('https://icanhazip.com', { signal: AbortSignal.timeout(4000) });
        const text = await res.text();
        return text.trim();
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

async function uploadCloudFile(file) {
    const binId = 'ls-' + roomId;
    const uploadUrl = `https://filebin.net/${binId}/${encodeURIComponent(file.name)}`;
    const uploadId = 'up_' + generateId();
    
    const uploadEl = createActiveUploadUI(uploadId, file.name, file.size);

    try {
        const res = await fetch(uploadUrl, {
            method: 'POST',
            body: file,
            headers: {
                'Content-Type': file.type || 'application/octet-stream'
            }
        });

        if (!res.ok) throw new Error('Upload returned ' + res.status);

        const data = await res.json();
        const fileObj = {
            id: generateId(),
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream',
            url: `https://filebin.net/${binId}/${encodeURIComponent(file.name)}`,
            timestamp: Date.now()
        };

        if (uploadEl) uploadEl.remove();

        // Update local catalog and broadcast
        filesCatalog = filesCatalog.filter(f => f.name !== file.name);
        filesCatalog.unshift(fileObj);
        publishFilesCatalog();
        renderFilesList();
    } catch (err) {
        console.error('Filebin upload error:', err);
        if (uploadEl) uploadEl.remove();
        alert(`Cloud upload for "${file.name}" encountered an issue. Falling back to direct P2P transfer.`);
        sendSingleFile(file);
    }
}

function downloadFile(fileId) {
    const file = filesCatalog.find(f => f.id === fileId);
    if (!file) return;
    window.open(file.url, '_blank');
}

function downloadAllZip() {
    const binId = 'ls-' + roomId;
    window.open(`https://filebin.net/archive/${binId}/zip`, '_blank');
}

async function deleteCloudFile(fileId) {
    const file = filesCatalog.find(f => f.id === fileId);
    if (!file) return;

    const binId = 'ls-' + roomId;
    const deleteUrl = `https://filebin.net/${binId}/${encodeURIComponent(file.name)}`;

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
    undoTimer = setTimeout(async () => {
        if (lastDeletedFile && lastDeletedFile.id === fileId) {
            try {
                await fetch(deleteUrl, { method: 'DELETE' });
            } catch (e) {
                console.warn('Filebin delete error:', e);
            }
            lastDeletedFile = null;
        }
    }, 5500);
}

async function deleteAllCloudFiles() {
    if (filesCatalog.length === 0) return;
    if (!confirm('Are you sure you want to delete all shared files?')) return;

    const binId = 'ls-' + roomId;
    try {
        await fetch(`https://filebin.net/${binId}`, { method: 'DELETE' });
    } catch (e) {}

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

        const { category, label } = getFileCategory(file.name, file.type);

        card.innerHTML = `
            <div class="file-card-main">
                <div class="file-icon-box ${category}">${label}</div>
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
                <button class="file-action-btn download" title="Download">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </button>
                <button class="file-action-btn delete" title="Delete">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `;

        card.querySelector('.download').onclick = () => downloadFile(file.id);
        card.querySelector('.delete').onclick = () => deleteCloudFile(file.id);

        filesListContainer.appendChild(card);
    });
}

function getFileCategory(filename, mimeType = '') {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext) || mimeType.startsWith('image/')) {
        return { category: 'image', label: ext.substring(0, 3).toUpperCase() || 'IMG' };
    }
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
        return { category: 'archive', label: 'ZIP' };
    }
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'ogg', 'm4a'].includes(ext) || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
        return { category: 'media', label: ext.substring(0, 3).toUpperCase() || 'MED' };
    }
    if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'xlsx', 'csv', 'pptx'].includes(ext)) {
        return { category: 'document', label: ext.substring(0, 3).toUpperCase() || 'DOC' };
    }
    return { category: 'default', label: ext.substring(0, 3).toUpperCase() || 'FILE' };
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
                <span class="speed">Saving to cloud (7 days)...</span>
            </div>
        </div>
        <div class="progress-bar-container">
            <div class="progress-bar" style="width: 75%; animation: pulse 1s infinite alternate;"></div>
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


// Start application
init();
