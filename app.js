// Configuration
const STUN_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};
const MQTT_BROKER = 'wss://test.mosquitto.org:8081'; // Public WebSocket MQTT broker
const CHUNK_SIZE = 64 * 1024; // 64 KB for WebRTC DataChannel

// State
let myPeerId = generateId();
let roomId = null;
let cryptoKey = null;
let mqttClient = null;
let peers = {}; // mapping peerId -> { pc, dataChannel }
let receiveBuffers = {}; // file transfer buffers
let typingTimeout = null;
let isUpdatingFromNetwork = false;

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

// --- Initialization ---

async function init() {
    try {
        updateStatus('Getting IP...', 'connecting');
        const ip = await getPublicIP();
        
        // Derive Room ID and Crypto Key from IP
        roomId = await hashString(ip);
        cryptoKey = await deriveKey(ip);
        
        updateStatus('Connecting to network...', 'connecting');
        setupMQTT();
    } catch (err) {
        console.error('Init error:', err);
        updateStatus('Initialization failed', 'error');
    }
}

async function getPublicIP() {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    return data.ip;
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
        updateStatus('Files: Waiting for peer | Text: Synced to network', 'connecting');
    }
}

// --- Signaling & PubSub (MQTT) ---

function setupMQTT() {
    mqttClient = mqtt.connect(MQTT_BROKER);

    mqttClient.on('connect', () => {
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
    });

    mqttClient.on('message', async (topic, message) => {
        const textTopic = `localshare/room/${roomId}/text`;
        
        // Handle persistent text messages
        if (topic === textTopic) {
            // message is a Buffer
            const arrayBuf = new Uint8Array(message);
            if (arrayBuf.length > 0) {
                const decryptedText = await decryptText(arrayBuf);
                if (decryptedText !== null && sharedText.value !== decryptedText) {
                    isUpdatingFromNetwork = true;
                    sharedText.value = decryptedText;
                    isUpdatingFromNetwork = false;
                    setSaveStatus('saved', 'Synced securely to network');
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
        updateStatus('Network disconnected', 'error');
    });
}

async function publishText(text) {
    if (!mqttClient || !mqttClient.connected) return;
    
    setSaveStatus('saving', 'Saving securely...');
    
    try {
        const encrypted = await encryptText(text);
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
        sendFiles(e.dataTransfer.files);
    }
});

fileInput.addEventListener('change', e => {
    if (fileInput.files.length) {
        sendFiles(fileInput.files);
    }
});

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
