# RSA Driving Test Watcher

Sick of checking MyRoadSafety for a driving test date? This does it for you.

Every 7 minutes it goes to the booking page, opens the Location dropdown and checks your test centres. If any of them stops saying "No availability", it beeps until you notice. It also keeps you logged in, so you don't have to keep typing in your authenticator code.

## Setup

**1. Install Tampermonkey**

It's a free browser extension. Get it here: https://www.tampermonkey.net

**2. Install the script**

Click this link and then click **Install**:

https://github.com/mccoolsa/RSA-/raw/main/rsa-test-watcher.user.js

**3. Start it**

- Log in to https://myroadsafety.rsa.ie
- A small box appears in the bottom right corner. Click **Start**.
- Allow notifications if your browser asks.
- Click **Test sound** to make sure you can hear it.

Leave the tab open and use your computer as normal. You can minimise the window.

## Buttons

- **Start / Stop** turns it on and off
- **Check now** checks straight away
- **Test sound** plays the alarm
- **Silence** stops the alarm

## Sound not playing?

The browser mutes the page after it reloads until you click on it. To fix this in Firefox, click the padlock next to the web address, then Permissions > Autoplay > **Allow Audio and Video**.

If you see 🔇 in the box, sound is blocked.

## Discord alerts (optional)

If you want a ping on your phone when a date comes up:

1. In Discord, go to your server's Settings > Integrations > Webhooks > New Webhook, then copy the webhook URL.
2. Open Tampermonkey > Dashboard and click on the script to edit it.
3. Find the line `const DISCORD_WEBHOOK = '';` near the top and paste your URL between the quotes.
4. Press Ctrl+S to save and reload the RSA page.
5. Click **Test Discord** in the box to check it works.

Keep your webhook URL private. Anyone who has it can post in your channel.

## Good to know

- Only tested on Firefox. It should work in any browser with Tampermonkey (Chrome, Edge etc.) but I haven't tried them.
- It reads whatever centres are in your dropdown, however many there are. It won't check the ones hidden under "More locations".
- If you get logged out, it plays a lower beep so you know to log back in.
- It only looks for dates. You still book the test yourself.
