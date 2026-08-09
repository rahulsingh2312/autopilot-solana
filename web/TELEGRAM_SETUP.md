# Waitlist → Telegram

Signups from `/launch` are sent to a Telegram chat by `src/app/api/waitlist/route.ts`.
It needs two environment variables. Both come out of Telegram itself, so this is a
five-minute manual setup that cannot be scripted from here.

## Why it is not just "@fwmutg"

Two Telegram Bot API facts decide the shape of this:

1. A bot **cannot start a conversation**. The recipient has to message the bot
   first, or every send fails with `403: bot can't initiate conversation with a user`.
2. `chat_id` accepts an `@name` **only for public channels and supergroups**, never
   for a person. For a private chat it must be the numeric id.

So the username alone is not enough. Steps 2 and 3 below exist to turn it into an id.

## 1. Make the bot

In Telegram, message [@BotFather](https://t.me/BotFather):

```
/newbot
```

Give it a name and a username. BotFather replies with a token that looks like
`8123456789:AAH...`. That is `TELEGRAM_BOT_TOKEN`.

## 2. Have @fwmutg message the bot

Open the new bot's link (`https://t.me/<your_bot_username>`) **from the @fwmutg
account** and press Start. Nothing happens visibly; it just opens the channel the
bot is allowed to send on.

## 3. Read the numeric chat id

With the token from step 1:

```sh
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" \
  | python3 -m json.tool | grep -A3 '"chat"'
```

Look for `"id"` inside `"chat"` — a number like `1234567890`, negative for groups.
That is `TELEGRAM_CHAT_ID`.

If `getUpdates` returns an empty `result`, step 2 did not happen.

## 4. Set them

Local, in `web/.env.local`:

```sh
TELEGRAM_BOT_TOKEN=8123456789:AAH...
TELEGRAM_CHAT_ID=1234567890
```

Production:

```sh
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add TELEGRAM_CHAT_ID production
```

Redeploy after adding them. Neither is `NEXT_PUBLIC_`, so they stay server-side;
a bot token in the browser bundle is a bot anyone can hijack.

## 5. Check it

```sh
curl -s localhost:3000/api/waitlist \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","wallet":"test"}'
```

Expect `{"ok":true}` and a message in Telegram. On failure the server log carries
Telegram's own reason; `chat not found` means step 2 was skipped or the id is wrong.

## Behaviour without the variables

In development the route still appends to `web/.data/waitlist.ndjson`, so the form
works before any of this is set up. **In production that fallback is off** — if
Telegram is not configured the route returns 500 rather than telling someone they
joined a list nothing recorded. That is deliberate. The old file-only version
returned success on a laptop and failed on Vercel, which is how the live waitlist
was quietly dropping signups.

## Worth knowing

The endpoint is public and now triggers an outbound message per request, so it is
spammable: a script can fill the chat. Nothing here rate-limits it. If that starts
happening, put the route behind Vercel Firewall rate limiting, or add a hidden
honeypot field to the form and drop any request that fills it in.
