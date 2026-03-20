# Proxyout Super Tuff Private Chat

Local web chat app for Google Chrome with:
- Login + registration (username + password)
- Registration requires **real First + Last name** (fake names rejected)
- Profile picture upload + username change (real name locked)
- User search + user list sidebar
- Real-time 1:1 messaging (WebSocket)
- Voice/video calling via WebRTC (server used only for signaling)
- Press **Tab** to toggle the chat UI open/closed

## Run it on `http://localhost:3000` (Node.js)

### Prerequisite

You need **Node.js** installed (your terminal currently doesn’t have `node`/`npm` available).

### Start

1. Open PowerShell in:
   `C:\Users\hanie\Downloads\proxyout-super-tuff-private-chat`
2. Run:
```bash
npm install
npm start
```
3. Open Chrome to:
- `http://localhost:3000`

## WebRTC note

Chrome allows WebRTC voice/video calls for local development on `localhost`.

## Data storage

This demo stores users and message history in JSON files under `data/`.

