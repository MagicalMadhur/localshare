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
let mqttClient = null;
let peers = {}; // mapping peerId -> { pc, dataChannel }
let receiveBuffers = {}; // file transfer buffers

// UI Elements
const statusDot = document.querySelector('.status-dot');
const statusText = document.getElementById('statusText');
const sharedText = document.getElementById('sharedText');
const copyBtn = document.getElementById('copyBtn');
const copyToast = document.getElementById('copyToast');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const transfersContainer = document.getElementById('transfersContainer');

// --- Initialization ---

async function init() {
    try {
        updateStatus('Getting IP...', 'connecting');
        const ip = await getPublicIP();
        roomId = await hashString(ip);
        
        updateStatus('Connecting to signaling server...', 'connecting');
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

function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

function updateStatus(text, state) {
    statusText.textContent = text;
    statusDot.className = `status-dot ${state}`;
}

function updateConnectionCount() {
    const count = Object.keys(peers).filter(id => peers[id].dataChannel && peers[id].dataChannel.readyState === 'open').length;
    if (count > 0) {
        updateStatus(`Connected to ${count} device(s)`, 'connected');
    } else {
        updateStatus('Looking for peers on this network...', 'connecting');
    }
}

// --- Signaling (MQTT) ---

function setupMQTT() {
    // using mqtt global from mqtt.min.js
    mqttClient = mqtt.connect(MQTT_BROKER);

    mqttClient.on('connect', () => {
        const topic = `localshare/room/${roomId}`;
        mqttClient.subscribe(topic, () => {
            updateConnectionCount(); // Will show "Looking for peers"
            // Announce presence
            broadcastSignaling({ type: 'hello', peerId: myPeerId });
        });
    });

    mqttClient.on('message', (topic, message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.sender === myPeerId) return; // Ignore own messages
            if (data.target && data.target !== myPeerId) return; // Ignore messages for others

            handleSignalingMessage(data);
        } catch (e) {
            console.error('Invalid MQTT message', e);
        }
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Error:', err);
        updateStatus('Signaling disconnected', 'error');
    });
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

// --- WebRTC ---

async function handleSignalingMessage(msg) {
    const sender = msg.sender;

    if (msg.type === 'hello') {
        // New peer joined. I will initiate connection to them.
        // To avoid both initiating, let the one with higher peerId initiate.
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
        const dc = pc.createDataChannel('localshare', {
            // Using reliable ordered delivery by default
        });
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
    // Necessary for large file transfers (receiving binary data)
    dc.binaryType = 'arraybuffer'; 

    dc.onopen = () => {
        console.log(`DataChannel open with ${remotePeerId}`);
        updateConnectionCount();
        
        // If we have text, sync it to the new peer
        if (sharedText.value) {
            broadcastText(sharedText.value);
        }
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
            // It's a file chunk
            handleFileChunk(remotePeerId, event.data);
        }
    };
}

// --- Data Transfer (Text & Metadata) ---

function broadcastDataMessage(msgObj) {
    const msgStr = JSON.stringify(msgObj);
    Object.values(peers).forEach(peer => {
        if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
            peer.dataChannel.send(msgStr);
        }
    });
}

function broadcastText(text) {
    broadcastDataMessage({ type: 'text', content: text });
}

function handleDataMessage(sender, msg) {
    if (msg.type === 'text') {
        if (sharedText.value !== msg.content) {
            sharedText.value = msg.content;
        }
    } else if (msg.type === 'file-start') {
        // Initialize file receiving
        receiveBuffers[msg.fileId] = {
            metadata: msg.metadata,
            chunks: [],
            receivedBytes: 0,
            uiElement: createTransferUI(msg.metadata.name, msg.metadata.size, 'receiving')
        };
    } else if (msg.type === 'file-end') {
        // Finish file receiving
        finishFileReceive(msg.fileId);
    }
}

// --- File Transfer (Binary) ---

async function sendFiles(files) {
    for (const file of files) {
        await sendSingleFile(file);
    }
}

async function sendSingleFile(file) {
    if (Object.keys(peers).length === 0) {
        alert("No devices connected yet.");
        return;
    }

    const fileId = generateId();
    const metadata = { name: file.name, size: file.size, type: file.type };
    
    // Broadcast file start
    broadcastDataMessage({ type: 'file-start', fileId, metadata });
    
    const uiElement = createTransferUI(file.name, file.size, 'sending');
    const progressBar = uiElement.querySelector('.progress-bar');
    
    const arrayBuffer = await file.arrayBuffer();
    let offset = 0;
    const startTime = Date.now();

    // Determine how many connected peers
    const activeChannels = Object.values(peers)
        .map(p => p.dataChannel)
        .filter(dc => dc && dc.readyState === 'open');

    if (activeChannels.length === 0) return;

    return new Promise((resolve) => {
        function sendNextChunk() {
            while (offset < arrayBuffer.byteLength) {
                // Check if any channel's buffered amount is too high (backpressure)
                const isBufferFull = activeChannels.some(dc => dc.bufferedAmount > CHUNK_SIZE * 4);
                
                if (isBufferFull) {
                    // Wait for the buffer to drain a bit
                    // Setting a small timeout to let the event loop process data
                    setTimeout(sendNextChunk, 10);
                    return;
                }

                const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
                
                // Prepend fileId to the chunk so receiver knows which file it belongs to
                // We use a simple protocol: first 8 bytes (string chars) are fileId, then binary data
                const fileIdBytes = new TextEncoder().encode(fileId.padEnd(8, ' '));
                const combined = new Uint8Array(fileIdBytes.byteLength + chunk.byteLength);
                combined.set(fileIdBytes, 0);
                combined.set(new Uint8Array(chunk), fileIdBytes.byteLength);

                activeChannels.forEach(dc => {
                    try { dc.send(combined.buffer); } catch (e) { console.error("Send error:", e); }
                });

                offset += chunk.byteLength;
                
                // Update UI progress
                const percent = (offset / arrayBuffer.byteLength) * 100;
                progressBar.style.width = `${percent}%`;

                // Calculate speed
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                if (elapsedSeconds > 0) {
                    const speed = formatBytes(offset / elapsedSeconds) + '/s';
                    uiElement.querySelector('.speed').textContent = speed;
                }
            }

            // Finished reading
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
    // Extract fileId (first 8 bytes)
    const fileIdBytes = buffer.slice(0, 8);
    const fileId = new TextDecoder().decode(fileIdBytes).trim();
    const chunkData = buffer.slice(8);

    const receiving = receiveBuffers[fileId];
    if (receiving) {
        receiving.chunks.push(chunkData);
        receiving.receivedBytes += chunkData.byteLength;
        
        // Update UI
        const percent = (receiving.receivedBytes / receiving.metadata.size) * 100;
        receiving.uiElement.querySelector('.progress-bar').style.width = `${percent}%`;
    }
}

function finishFileReceive(fileId) {
    const receiving = receiveBuffers[fileId];
    if (receiving) {
        // Reassemble blob
        const blob = new Blob(receiving.chunks, { type: receiving.metadata.type });
        const url = URL.createObjectURL(blob);
        
        // Automatically download or provide link
        const a = document.createElement('a');
        a.href = url;
        a.download = receiving.metadata.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Clean up memory
        receiving.chunks = [];
        
        // Update UI
        receiving.uiElement.classList.add('done');
        receiving.uiElement.querySelector('.speed').textContent = 'Downloaded';
        receiving.uiElement.querySelector('.progress-bar').style.width = '100%';
    }
}


// --- UI Events ---

sharedText.addEventListener('input', () => {
    broadcastText(sharedText.value);
});

copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(sharedText.value).then(() => {
        copyToast.classList.remove('hidden');
        setTimeout(() => copyToast.classList.add('hidden'), 2000);
    });
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
