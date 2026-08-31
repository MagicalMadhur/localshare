# LocalShare

A modern, serverless local file and text-sharing web application. Inspired by SSavr.

## Features

- **Automatic Pairing**: Simply open the website on multiple devices connected to the same Wi-Fi network. They will automatically discover each other without needing any pairing codes or QR codes!
- **Text Syncing**: Type or paste text, and it instantly appears on all connected devices.
- **P2P File Transfer**: Send files of any size directly between devices via WebRTC Data Channels. No servers involved in the transfer!
- **No Upload Limits**: Because files are transferred directly and not uploaded to a server, there are no size limits.
- **Static & Serverless**: Can be hosted completely statically on GitHub Pages.

## How it works (Serverless SSavr)

Unlike traditional tools that require a backend server to group users by their IP address, LocalShare achieves this purely on the client side:
1. When you open the app, it fetches your public IP using a free API (`api.ipify.org`).
2. It uses the Web Crypto API to securely hash this IP.
3. This hash is used as a "Room ID" to connect to a public MQTT broker (for WebRTC signaling).
4. Since devices on the same Wi-Fi share the same public IP, they generate the exact same hash and join the same room automatically!
5. Once they discover each other via the broker, they establish a direct WebRTC connection for secure P2P transfers.

## Deployment

This app is designed to be hosted on GitHub Pages. A GitHub Action workflow is included in `.github/workflows/deploy.yml` to automatically deploy it when pushed to the `main` or `master` branch.

## Privacy

Your files and text are **never** uploaded to any server. The MQTT broker is only used to exchange connection metadata (SDP offers/answers) so that your devices can find each other. Once connected, all data flows directly between your devices (P2P).
