# Pinboard — a Pinterest-style app

Pins, boards, profiles, follow/unfollow, image + video uploads, real-time chat and a light/dark theme.
No external APIs or cloud services: everything runs locally on your machine.

## Run it

Requires Node.js 18+.

```bash
npm install
npm start
```

Open http://localhost:3000, create an account, and you're in. Open a second browser (or a private window),
sign up as another user, and try following, commenting and chatting between the two.

Set `PORT=8080 npm start` to use a different port.

## Features

| Feature | Where |
|---|---|
| Upload pins (images **and videos**, up to 200 MB) with title, description, link | **Create** button, drag & drop supported, upload progress bar |
| Boards | Create from your profile or while creating/saving a pin; save others' pins to your boards; remove pins; delete boards |
| View others' pins | Home feed (infinite scroll), search, pin detail with likes + comments; videos autoplay on hover |
| Profiles | Click any username/avatar; follower/following counts and lists; edit your bio + avatar |
| Follow / unfollow | Profile page, pin detail, follower lists, search results; **Following** tab shows only people you follow |
| Real-time chat | Message icon in the nav (or **Message** on a profile): live delivery over WebSocket, typing indicator, online dots, unread badge |
| Light / dark theme | Sun/moon button in the nav (also on the login page); remembers your choice and follows your OS setting by default |

## Languages used (5)

JavaScript (server + browser), HTML, CSS, JSON (`package.json`, the data file), Markdown (this file).

## How it's built

```
server.js          Express REST API + WebSocket server (ws), multer for uploads
public/index.html  App shell
public/style.css   Styles + theme variables
public/app.js      Single-page app (hash router, no framework)
data/db.json       Created on first run — all users, pins, boards, messages
uploads/           Created on first run — uploaded images and videos
```

Passwords are hashed with scrypt and salted. Sessions are random tokens stored on the server.

## Notes & limits

- Storage is a single JSON file, which is great for demos and small groups. For many users, swap the
  `db` object in `server.js` for SQLite/Postgres.
- Run behind HTTPS in production (the client automatically switches to `wss://`).
- To reset everything, stop the server and delete `data/` and `uploads/`.
