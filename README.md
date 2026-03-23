# Clone Drone Relay

WebSocket relay server for Clone Drone Twitch Spawn Mod.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variable: `RELAY_SECRET` = any random string you want
4. Railway gives you a URL like `your-relay.railway.app`

## Local testing

```
npm install
node server.js
```

Then connect your mod to `ws://localhost:8080` instead of the Railway URL.

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | Port to listen on (Railway sets this automatically) |
| `RELAY_SECRET` | Secret string mods must provide to connect (optional but recommended) |
